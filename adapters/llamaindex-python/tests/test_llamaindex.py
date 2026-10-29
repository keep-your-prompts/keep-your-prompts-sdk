"""Runs against the real llama-index-core: PromptTemplate, ChatPromptTemplate, RichPromptTemplate, a response
synthesizer with MockLLM, and update_prompts / get_prompts."""

from __future__ import annotations

import pytest
from keepyourprompts import MissingVariableError
from llama_index.core import get_response_synthesizer
from llama_index.core.base.llms.types import ChatMessage, MessageRole
from llama_index.core.llms import MockLLM
from llama_index.core.prompts import ChatPromptTemplate, PromptTemplate, RichPromptTemplate

import keepyourprompts_llamaindex as kli
from conftest import CASES, RAG

RENDER = [c for c in CASES["render"] if "error" not in c and not c.get("lenient")]


def _client_for(text):
    class One:
        def __init__(self, t):
            from keepyourprompts import Prompt, template_variables

            self.p = Prompt("t", 1, "0" * 64, tuple(template_variables(t)), t)

        def prompt(self, name):
            return self.p

    return One(text)


@pytest.mark.parametrize("case", RENDER)
def test_prompt_template_formats_like_the_core_sdk(case):
    t = kli.load_prompt_template(_client_for(case["template"]), "t")
    assert isinstance(t, PromptTemplate)
    assert t.format(**case["vars"]) == case["out"]


@pytest.mark.parametrize("case", RENDER)
def test_rich_template_formats_like_the_core_sdk(case):
    t = kli.load_rich_prompt_template(_client_for(case["template"]), "t")
    assert isinstance(t, RichPromptTemplate)
    assert t.format(**case["vars"]) == case["out"]


def test_conversions():
    assert kli.to_llamaindex_template("Hi {{ name }}, {x} {{{{y}}") == "Hi {name}, {x} {{y}}"
    assert kli.to_jinja("Hi {{ name }}, {x} {{{{y}}") == "Hi {{ name }}{% raw %}, {x} {{y}}{% endraw %}"
    assert kli.to_jinja("a {% endraw %} {{n}}") == 'a {{ "{" }}% endraw %} {{ n }}'


def test_strict_and_lenient(prompts):
    t = kli.load_prompt_template(prompts, "greeting")
    with pytest.raises(MissingVariableError):
        t.format(name="Ana")
    lenient = kli.load_prompt_template(prompts, "greeting", strict=False)
    assert lenient.format(name="Ana") == "Hello Ana, welcome to {{ company }}."
    with pytest.raises(MissingVariableError):
        kli.load_rich_prompt_template(prompts, "greeting").format(name="Ana")
    assert kli.load_rich_prompt_template(prompts, "greeting", on_missing="empty").format(name="Ana") == (
        "Hello Ana, welcome to ."
    )


def test_prompt_template_features(prompts):
    t = kli.load_prompt_template(prompts, "triage")
    assert t.template == "You are a support agent for {company}. Literal {{braces}} stay."
    assert t.template_vars == ["company"]
    assert t.metadata["kyp.prompt.version"] == 7
    assert t.metadata["kyp.prompt.sha256"].startswith("f31befda")
    partial = t.partial_format(company="Acme")
    assert partial.format() == prompts.render("triage", company="Acme")
    mapped = kli.load_prompt_template(prompts, "triage", template_var_mappings={"org": "company"})
    assert mapped.format(org="Org") == prompts.render("triage", company="Org")
    fn = kli.load_prompt_template(prompts, "triage", function_mappings={"company": lambda **kw: "Fn"})
    assert "for Fn." in fn.format()
    msgs = t.format_messages(company="A")
    assert msgs[0].content == prompts.render("triage", company="A")


def test_chat_templates(prompts):
    t = kli.load_chat_prompt_template(prompts, "triage", messages=[("user", "{query_str}")])
    assert isinstance(t, ChatPromptTemplate)
    msgs = t.format_messages(company="Acme", query_str="hi")
    assert msgs[0].role == MessageRole.SYSTEM
    assert msgs[0].content == "You are a support agent for Acme. Literal {{braces}} stay."
    assert (msgs[1].role, msgs[1].content) == (MessageRole.USER, "hi")
    assert t.template_vars == ["company", "query_str"]
    assert t.metadata["kyp.prompt.name"] == "triage"
    with pytest.raises(MissingVariableError):
        t.format_messages(query_str="hi")
    both = kli.chat_prompt_template(
        prompts,
        [
            kli.KypMessage("system", "triage"),
            kli.KypMessage("user", "greeting"),
            ChatMessage(role="assistant", content="ok"),
        ],
    )
    out = both.partial_format(company="Acme").format_messages(name="Bo")
    assert [m.content for m in out] == [prompts.render("triage", company="Acme"), "Hello Bo, welcome to Acme.", "ok"]
    assert [m["kyp.prompt.name"] for m in both.metadata["kyp.prompts"]] == ["triage", "greeting"]


def test_rich_chat(prompts):
    t = kli.load_rich_prompt_template(prompts, "triage", role="system")
    msgs = t.format_messages(company="Acme")
    assert len(msgs) == 1 and msgs[0].role == MessageRole.SYSTEM
    assert msgs[0].content == prompts.render("triage", company="Acme")


def test_update_prompts_on_a_real_synthesizer(rag):
    synth = get_response_synthesizer(llm=MockLLM(), response_mode="compact")
    synth.update_prompts({"text_qa_template": kli.load_prompt_template(rag.client, "rag/answer", company="Acme")})
    prompt = synth.get_prompts()["text_qa_template"]
    assert prompt.metadata["kyp.prompt.name"] == "rag/answer"
    response = synth.get_response("What is KYP?", ["KYP is prompt delivery."])
    assert "Answer What is KYP? for Acme. Use {json} as is." in str(response)
    assert "KYP is prompt delivery." in str(response)


def test_kyp_update_prompts_checks_variables_and_follows_deploys(rag):
    synth = get_response_synthesizer(llm=MockLLM(), response_mode="compact")
    with pytest.raises(ValueError, match="context_str"):
        kli.kyp_update_prompts(synth, rag.client, {"text_qa_template": "rag/no-context"})

    stop = kli.kyp_update_prompts(
        synth,
        rag.client,
        {"text_qa_template": "rag/answer"},
        keep_updated=True,
        template=lambda c, n: kli.load_prompt_template(c, n, company="Acme"),
    )
    assert "Answer q for Acme" in str(synth.get_response("q", ["ctx"]))
    nxt = dict(RAG)
    nxt["rag/answer"] = ("v2 {{context_str}} / {{query_str}} / {{company}}", 2)
    rag.deploy(nxt)
    assert "v2 ctx / q / Acme" in str(synth.get_response("q", ["ctx"]))
    assert synth.get_prompts()["text_qa_template"].metadata["kyp.prompt.version"] == 2
    stop()
    nxt["rag/answer"] = ("v3 {{context_str}} {{query_str}} {{company}}", 3)
    rag.deploy(nxt)
    assert "v2 ctx" in str(synth.get_response("q", ["ctx"]))


def test_hot_update_via_reload(live):
    vars_ = {"name": "Ana", "company": "Acme"}
    assert kli.load_prompt_template(live.client, "greeting").format(**vars_) == "Hello Ana, welcome to Acme."
    live.deploy("v13")
    assert kli.load_prompt_template(live.client, "greeting").format(**vars_) == "Hi Ana! Acme is glad you are here."
