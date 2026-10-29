"""Keep Your Prompts for LlamaIndex. This code is under the repository's LICENSE.

    from keepyourprompts import Client
    from keepyourprompts_llamaindex import kyp_update_prompts, load_prompt_template

    prompts = Client.from_env()
    qa = load_prompt_template(prompts, "rag/answer")              # a PromptTemplate
    kyp_update_prompts(query_engine, prompts, {"response_synthesizer:text_qa_template": "rag/answer"},
                       keep_updated=True)                        # re-applied on every deploy

LlamaIndex's own ``PromptTemplate`` leaves a missing ``{variable}`` in place and has no way to escape a literal
brace. The templates here are LlamaIndex classes (``PromptTemplate``, ``ChatPromptTemplate``,
``RichPromptTemplate``) whose formatting is done by the core SDK, so they render exactly like
``client.render``: strict about missing variables by default, and literal braces stay literal. Everything reads
the client's memory: no network on the hot path.
"""

from __future__ import annotations

import secrets
from collections.abc import Mapping
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Protocol, Sequence, Tuple, Union

from keepyourprompts import MissingVariableError, Prompt, render_template, template_variables
from llama_index.core.base.llms.types import ChatMessage, MessageRole
from llama_index.core.llms import LLM
from llama_index.core.prompts import ChatPromptTemplate, PromptTemplate, PromptType, RichPromptTemplate
from llama_index.core.prompts.base import BasePromptTemplate
from pydantic import PrivateAttr

__version__ = "0.1.0"

__all__ = [
    "KypChatPromptTemplate",
    "KypMessage",
    "KypPromptTemplate",
    "KypRichPromptTemplate",
    "PromptSource",
    "__version__",
    "chat_prompt_template",
    "kyp_update_prompts",
    "load_chat_prompt_template",
    "load_prompt_template",
    "load_rich_prompt_template",
    "prompt_metadata",
    "to_jinja",
    "to_llamaindex_template",
]


class PromptSource(Protocol):
    """Anything with ``prompt(name)``: a ``Client`` or ``AsyncClient`` of ``keepyourprompts``."""

    def prompt(self, name: str) -> Prompt: ...


def prompt_metadata(prompt: Prompt) -> Dict[str, Any]:
    """``kyp.prompt.name``, ``kyp.prompt.version`` and ``kyp.prompt.sha256``, as stored in each template's
    ``metadata``."""
    return {"kyp.prompt.name": prompt.name, "kyp.prompt.version": prompt.version, "kyp.prompt.sha256": prompt.sha256}


# ---------------------------------------------------------------------------------------------------------------
# Conversions (for display and for LlamaIndex code that reads the template string)
# ---------------------------------------------------------------------------------------------------------------


def _split(text: str) -> Tuple[List[Union[str, Tuple[str]]], List[str]]:
    """Literal text and variables, using the core SDK to decide what is a variable (``{{{{`` already resolved)."""
    names = template_variables(text)
    nonce = secrets.token_hex(6)
    while nonce in text:
        nonce = secrets.token_hex(6)
    rendered = render_template(text, {n: f"\x00{nonce}:{n}\x00" for n in names})
    pieces: List[Union[str, Tuple[str]]] = []
    for i, part in enumerate(rendered.split("\x00")):
        if i % 2 == 1 and part.startswith(nonce + ":"):
            pieces.append((part[len(nonce) + 1 :],))
        elif part:
            pieces.append(part)
    return pieces, names


def to_llamaindex_template(text: str) -> str:
    """``{{name}}`` -> ``{name}``. Literal braces are kept as is (LlamaIndex templates cannot escape them, which is
    why ``KypPromptTemplate`` formats with the core SDK instead of this string)."""
    pieces, _ = _split(text)
    return "".join("{" + p[0] + "}" if isinstance(p, tuple) else p for p in pieces)


def _jinja_literal(s: str) -> str:
    if "{" not in s:
        return s
    if "endraw" not in s:
        return "{% raw %}" + s + "{% endraw %}"
    return s.replace("{", '{{ "{" }}')


def to_jinja(text: str) -> str:
    """A Jinja template (``RichPromptTemplate``) with the same output: variables become ``{{ name }}`` and every
    literal brace is protected from Jinja."""
    pieces, _ = _split(text)
    return "".join("{{ " + p[0] + " }}" if isinstance(p, tuple) else _jinja_literal(p) for p in pieces)


# ---------------------------------------------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------------------------------------------


class KypPromptTemplate(PromptTemplate):
    """A ``PromptTemplate`` for a deployed prompt, formatted by the core SDK.

    ``template`` holds the ``{name}`` form for display and for code that reads it; ``format`` renders the deployed
    text with partial variables, ``template_var_mappings`` and ``function_mappings`` applied as usual.
    """

    _kyp_text: str = PrivateAttr(default="")
    _kyp_strict: bool = PrivateAttr(default=True)
    _kyp_on_missing: Optional[str] = PrivateAttr(default=None)

    def format(
        self,
        llm: Optional[LLM] = None,
        completion_to_prompt: Optional[Callable[[str], str]] = None,
        **kwargs: Any,
    ) -> str:
        del llm
        mapped = self._map_all_vars({**self.kwargs, **kwargs})
        prompt = render_template(self._kyp_text, mapped, strict=self._kyp_strict, on_missing=self._kyp_on_missing)
        if self.output_parser is not None:
            prompt = self.output_parser.format(prompt)
        if completion_to_prompt is not None:
            prompt = completion_to_prompt(prompt)
        return prompt


def _finish(t: Any, p: Prompt, text: str, strict: bool, on_missing: Optional[str]) -> None:
    t._kyp_text = text
    t._kyp_strict = strict
    t._kyp_on_missing = on_missing
    t.metadata.update(prompt_metadata(p))


def load_prompt_template(
    client: PromptSource,
    name: str,
    *,
    prompt_type: PromptType = PromptType.CUSTOM,
    strict: bool = True,
    on_missing: Optional[str] = None,
    template_var_mappings: Optional[Dict[str, Any]] = None,
    function_mappings: Optional[Dict[str, Callable]] = None,
    **partial_kwargs: Any,
) -> KypPromptTemplate:
    """A ``PromptTemplate`` for the deployed prompt ``name`` (keyword arguments are partial variables)."""
    p = client.prompt(name)
    _, names = _split(p.text)
    t = KypPromptTemplate(
        to_llamaindex_template(p.text),
        prompt_type=prompt_type,
        template_var_mappings=template_var_mappings,
        function_mappings=function_mappings,
        **partial_kwargs,
    )
    t.template_vars = names
    _finish(t, p, p.text, strict, on_missing)
    return t


class KypMessage(NamedTuple):
    """A chat message rendered from a deployed prompt, for ``chat_prompt_template``."""

    role: str
    prompt: str


class KypChatPromptTemplate(ChatPromptTemplate):
    """A ``ChatPromptTemplate`` whose deployed messages are formatted by the core SDK; other messages are
    formatted the usual LlamaIndex way."""

    _kyp_texts: List[Optional[str]] = PrivateAttr(default_factory=list)
    _kyp_strict: bool = PrivateAttr(default=True)
    _kyp_on_missing: Optional[str] = PrivateAttr(default=None)

    def format_messages(self, llm: Optional[LLM] = None, **kwargs: Any) -> List[ChatMessage]:
        del llm
        mapped = self._map_all_vars({**self.kwargs, **kwargs})
        out: List[ChatMessage] = []
        missing: List[str] = []
        for tmpl, text in zip(self.message_templates, self._kyp_texts, strict=True):
            if text is None:
                out.append(tmpl.format_vars(**mapped))
                continue
            try:
                content = render_template(text, mapped, strict=self._kyp_strict, on_missing=self._kyp_on_missing)
            except MissingVariableError as e:
                missing.extend(n for n in e.names if n not in missing)
                continue
            out.append(ChatMessage(role=tmpl.role, content=content, additional_kwargs=dict(tmpl.additional_kwargs)))
        if missing:
            raise MissingVariableError(missing)
        if self.output_parser is not None:
            out = self.output_parser.format_messages(out)
        return out


MessageSpec = Union[KypMessage, ChatMessage, Tuple[str, str]]


def chat_prompt_template(
    client: PromptSource,
    messages: Sequence[MessageSpec],
    *,
    prompt_type: PromptType = PromptType.CUSTOM,
    strict: bool = True,
    on_missing: Optional[str] = None,
    **partial_kwargs: Any,
) -> KypChatPromptTemplate:
    """A ``ChatPromptTemplate`` from ``KypMessage(role, prompt_name)`` entries mixed with ordinary LlamaIndex
    messages (``ChatMessage`` or ``(role, "{template}")``). ``metadata`` lists the deployed prompts used."""
    templates: List[ChatMessage] = []
    texts: List[Optional[str]] = []
    used: List[Prompt] = []
    for m in messages:
        if isinstance(m, KypMessage):
            p = client.prompt(m.prompt)
            used.append(p)
            templates.append(ChatMessage(role=MessageRole(m.role), content=to_llamaindex_template(p.text)))
            texts.append(p.text)
        elif isinstance(m, ChatMessage):
            templates.append(m)
            texts.append(None)
        else:
            templates.append(ChatMessage(role=MessageRole(m[0]), content=m[1]))
            texts.append(None)
    t = KypChatPromptTemplate(message_templates=templates, prompt_type=prompt_type, **partial_kwargs)
    names: List[str] = []
    for tmpl, text in zip(templates, texts, strict=True):
        for n in template_variables(text) if text is not None else tmpl.get_template_vars():
            if n not in names:
                names.append(n)
    t.template_vars = names
    t._kyp_texts = texts
    t._kyp_strict = strict
    t._kyp_on_missing = on_missing
    if used:
        t.metadata.update(prompt_metadata(used[0]))
        t.metadata["kyp.prompts"] = [prompt_metadata(p) for p in used]
    return t


def load_chat_prompt_template(
    client: PromptSource,
    name: str,
    *,
    role: str = "system",
    messages: Sequence[Union[ChatMessage, Tuple[str, str]]] = (),
    **options: Any,
) -> KypChatPromptTemplate:
    """The deployed prompt as one message (``system`` by default), followed by ``messages``."""
    return chat_prompt_template(client, [KypMessage(role, name), *messages], **options)


class KypRichPromptTemplate(RichPromptTemplate):
    """A ``RichPromptTemplate`` (Jinja, via banks) converted from a deployed prompt, strict about missing
    variables like the core SDK."""

    _kyp_vars: List[str] = PrivateAttr(default_factory=list)
    _kyp_strict: bool = PrivateAttr(default=True)
    _kyp_on_missing: Optional[str] = PrivateAttr(default=None)

    def _checked(self, kwargs: Dict[str, Any]) -> Dict[str, Any]:
        mapped = self._map_all_vars({**self.kwargs, **kwargs})
        absent = [n for n in self._kyp_vars if mapped.get(n) is None]
        mode = self._kyp_on_missing or ("error" if self._kyp_strict else "keep")
        if absent and mode == "error":
            raise MissingVariableError(absent)
        for n in absent:
            mapped[n] = "{{" + n + "}}" if mode == "keep" else ""
        return mapped

    def format(self, llm: Optional[LLM] = None, messages_to_prompt: Any = None, **kwargs: Any) -> str:
        return super().format(llm, messages_to_prompt, **self._checked(kwargs))

    def format_messages(self, llm: Optional[LLM] = None, **kwargs: Any) -> List[ChatMessage]:
        return super().format_messages(llm, **self._checked(kwargs))


def load_rich_prompt_template(
    client: PromptSource,
    name: str,
    *,
    role: Optional[str] = None,
    strict: bool = True,
    on_missing: Optional[str] = None,
    **partial_kwargs: Any,
) -> KypRichPromptTemplate:
    """A ``RichPromptTemplate`` for the deployed prompt. With ``role`` the body is one chat message
    (``{% chat role="system" %}...{% endchat %}``)."""
    p = client.prompt(name)
    _, names = _split(p.text)
    body = to_jinja(p.text)
    if role:
        body = '{% chat role="' + role + '" %}' + body + "{% endchat %}"
    t = KypRichPromptTemplate(body, template_vars=names or None, **partial_kwargs)
    t.template_vars = names
    t._kyp_vars = names
    t._kyp_strict = strict
    t._kyp_on_missing = on_missing
    t.metadata.update(prompt_metadata(p))
    return t


# ---------------------------------------------------------------------------------------------------------------
# update_prompts
# ---------------------------------------------------------------------------------------------------------------


def kyp_update_prompts(
    module: Any,
    client: PromptSource,
    mapping: Mapping[str, str],
    *,
    check_variables: bool = True,
    keep_updated: bool = False,
    template: Callable[[PromptSource, str], BasePromptTemplate] = load_prompt_template,
) -> Optional[Callable[[], None]]:
    """Put deployed prompts into a LlamaIndex module (query engine, response synthesizer, agent...) with
    ``module.update_prompts``. ``mapping`` maps the module's prompt keys (see ``module.get_prompts()``, e.g.
    ``"response_synthesizer:text_qa_template"``) to deployed prompt names.

    ``check_variables`` refuses a deployed prompt that lacks a variable the replaced prompt had (``context_str``,
    ``query_str``...), since LlamaIndex would silently drop that input. ``keep_updated`` re-applies the mapping
    whenever a deploy changes one of the prompts (from the client's refresher thread) and returns a function that
    stops it.
    """

    def apply() -> None:
        current = module.get_prompts() if check_variables else {}
        new: Dict[str, BasePromptTemplate] = {}
        for key, name in mapping.items():
            t = template(client, name)
            old = current.get(key)
            if old is not None:
                lacking = [v for v in old.template_vars if v not in t.template_vars and v not in old.kwargs]
                if lacking:
                    raise ValueError(f"deployed prompt {name!r} for {key!r} lacks variables {lacking}")
            new[key] = t
        module.update_prompts(new)

    apply()
    if not keep_updated:
        return None
    if not hasattr(client, "on_update"):
        raise TypeError("keep_updated=True needs a client with on_update() (keepyourprompts.Client)")
    names = set(mapping.values())

    def listener(update: Any) -> None:
        if names.intersection(getattr(update, "changed", names)):
            apply()

    client.on_update(listener)  # type: ignore[attr-defined]
    return lambda: client.remove_update_listener(listener)  # type: ignore[attr-defined]
