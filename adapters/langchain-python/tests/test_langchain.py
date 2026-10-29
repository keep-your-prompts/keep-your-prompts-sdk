"""Runs against the real langchain-core (PromptTemplate, ChatPromptTemplate, RunnableLambda)."""

from __future__ import annotations

import pytest
from keepyourprompts import MissingVariableError
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder, PromptTemplate
from langchain_core.runnables import RunnableLambda

import keepyourprompts_langchain as kl
from conftest import CASES

TRIAGE_SHA = "f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf"


def test_to_fstring_escapes_and_converts():
    assert kl.to_fstring("Hi {{ name }}, {x} {{{{y}} }}") == ("Hi {name}, {{x}} {{{{y}}}} }}}}", ["name"])
    assert kl.to_fstring("no vars {}") == ("no vars {{}}", [])
    assert kl.to_fstring("use {{{{name}} syntax") == ("use {{{{name}}}} syntax", [])


@pytest.mark.parametrize("case", [c for c in CASES["render"] if "error" not in c and not c.get("lenient")])
def test_formats_like_the_core_sdk(case):
    conv = kl.to_fstring(case["template"])
    t = PromptTemplate(template=conv.template, input_variables=conv.input_variables, template_format="f-string")
    assert t.format(**{v: case["vars"][v] for v in conv.input_variables}) == case["out"]


def test_strict_missing_variables(prompts):
    t = kl.load_prompt_template(prompts, "greeting")
    with pytest.raises(KeyError):
        t.invoke({"name": "Ana"})
    with pytest.raises(MissingVariableError):
        prompts.render("greeting", name="Ana")


def test_load_prompt_template(prompts):
    t = kl.load_prompt_template(prompts, "triage", tags=["support"])
    assert t.input_variables == ["company"]
    assert t.format(company="Acme") == prompts.render("triage", company="Acme")
    assert t.metadata == {"kyp.prompt.name": "triage", "kyp.prompt.version": 7, "kyp.prompt.sha256": TRIAGE_SHA}
    assert t.tags == ["support"]
    p = kl.load_prompt_template(prompts, "greeting", partial_variables={"company": "Acme"})
    assert p.input_variables == ["name"]
    assert p.format(name="Ana") == "Hello Ana, welcome to Acme."


def test_load_chat_prompt_template(prompts):
    t = kl.load_chat_prompt_template(prompts, "triage", messages=[MessagesPlaceholder("history"), ("human", "{input}")])
    msgs = t.format_messages(company="Acme", history=[AIMessage("earlier")], input="hi")
    assert isinstance(msgs[0], SystemMessage)
    assert msgs[0].content == "You are a support agent for Acme. Literal {{braces}} stay."
    assert isinstance(msgs[1], AIMessage)
    assert isinstance(msgs[2], HumanMessage)
    assert t.metadata["kyp.prompt.version"] == 7
    h = kl.load_chat_prompt_template(prompts, "greeting", role="human", partial_variables={"company": "Acme"})
    assert h.input_variables == ["name"]
    assert h.format_messages(name="Bo")[0].content == "Hello Bo, welcome to Acme."


def test_kyp_message_composes(prompts):
    t = ChatPromptTemplate.from_messages(
        [kl.kyp_message(prompts, "system", "triage"), kl.kyp_message(prompts, "human", "greeting")]
    )
    assert [m.content for m in t.format_messages(company="Acme", name="Bo")] == [
        "You are a support agent for Acme. Literal {{braces}} stay.",
        "Hello Bo, welcome to Acme.",
    ]


def test_metadata_reaches_callbacks(prompts):
    seen = []

    class Recorder(BaseCallbackHandler):
        def on_chain_start(self, serialized, inputs, *, metadata=None, **kwargs):
            seen.append(metadata or {})

    kl.load_prompt_template(prompts, "triage").invoke({"company": "A"}, {"callbacks": [Recorder()]})
    assert seen[0]["kyp.prompt.name"] == "triage"
    assert seen[0]["kyp.prompt.version"] == 7


def test_pull(prompts):
    kl.set_default_client(None)
    with pytest.raises(RuntimeError, match="set_default_client"):
        kl.pull("triage")
    kl.set_default_client(prompts)
    try:
        assert isinstance(kl.pull("triage"), ChatPromptTemplate)
        text = kl.pull("triage", chat=False)
        assert isinstance(text, PromptTemplate)
        assert text.format(company="X") == prompts.render("triage", company="X")
        with pytest.raises(KeyError):
            kl.pull("nope")
    finally:
        kl.set_default_client(None)


def test_live_prompt_follows_deploys(live):
    chain = kl.live_prompt("greeting", client=live.client, chat=False) | RunnableLambda(lambda v: v.to_string())
    vars_ = {"name": "Ana", "company": "Acme"}
    assert chain.invoke(vars_) == "Hello Ana, welcome to Acme."
    live.deploy("v13")
    assert chain.invoke(vars_) == "Hi Ana! Acme is glad you are here."


async def test_live_prompt_async(live):
    chain = kl.live_prompt("triage", client=live.client)
    value = await chain.ainvoke({"company": "Acme"})
    assert value.to_messages()[0].content.startswith("You are a support agent for Acme.")
