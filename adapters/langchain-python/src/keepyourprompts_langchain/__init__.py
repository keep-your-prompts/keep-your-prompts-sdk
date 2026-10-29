"""Keep Your Prompts for LangChain (Python). This code is under the repository's LICENSE.

    from keepyourprompts import Client
    from keepyourprompts_langchain import pull, set_default_client

    set_default_client(Client.from_env())
    chain = pull("triage") | model            # a ChatPromptTemplate, like hub.pull

Deployed prompts use ``{{name}}`` variables and ``{{{{`` for a literal ``{{``. LangChain f-strings use
``{name}`` and ``{{`` / ``}}`` for literal braces. The conversion lets the core SDK find the variables (so both
agree on what is a variable) and escapes every other brace, so a template formats to exactly the text
``client.render`` returns. Everything reads the client's memory: no network on the hot path.
"""

from __future__ import annotations

import secrets
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Mapping, NamedTuple, Optional, Protocol, Sequence, Tuple, Union

from keepyourprompts import Prompt, render_template, template_variables
from langchain_core.prompts import ChatPromptTemplate, PromptTemplate
from langchain_core.runnables import RunnableConfig, RunnableLambda

__version__ = "0.1.0"

__all__ = [
    "FStringTemplate",
    "PromptSource",
    "__version__",
    "kyp_message",
    "live_prompt",
    "load_chat_prompt_template",
    "load_prompt_template",
    "prompt_metadata",
    "pull",
    "set_default_client",
    "to_fstring",
]


class PromptSource(Protocol):
    """Anything with ``prompt(name)``: a ``Client`` or ``AsyncClient`` of ``keepyourprompts``."""

    def prompt(self, name: str) -> Prompt: ...


class FStringTemplate(NamedTuple):
    template: str
    input_variables: List[str]


def _escape(s: str) -> str:
    return s.replace("{", "{{").replace("}", "}}")


def to_fstring(text: str) -> FStringTemplate:
    """Convert a deployed template (``{{name}}``) to a LangChain f-string (``{name}``), escaping literal braces."""
    names = template_variables(text)
    if not names:
        return FStringTemplate(_escape(render_template(text, {})), [])
    nonce = secrets.token_hex(6)
    while nonce in text:
        nonce = secrets.token_hex(6)

    def mark(n: str) -> str:
        return f"\x00{nonce}:{n}\x00"

    # Rendered by the core SDK with markers as values: identical parsing, "{{{{" already resolved to "{{".
    out = _escape(render_template(text, {n: mark(n) for n in names}))
    for n in names:
        out = out.replace(mark(n), "{" + n + "}")
    return FStringTemplate(out, names)


def prompt_metadata(prompt: Prompt) -> Dict[str, Any]:
    """Tracing metadata: ``kyp.prompt.name``, ``kyp.prompt.version``, ``kyp.prompt.sha256``."""
    return {"kyp.prompt.name": prompt.name, "kyp.prompt.version": prompt.version, "kyp.prompt.sha256": prompt.sha256}


# The conversion is a pure function of the body: cache it by sha256 (bounded, thread-safe).
_cache: OrderedDict[str, FStringTemplate] = OrderedDict()
_cache_lock = threading.Lock()


def _converted(p: Prompt) -> FStringTemplate:
    with _cache_lock:
        hit = _cache.get(p.sha256)
        if hit is not None:
            _cache.move_to_end(p.sha256)
            return hit
    conv = to_fstring(p.text)
    with _cache_lock:
        _cache[p.sha256] = conv
        while len(_cache) > 256:
            _cache.popitem(last=False)
    return conv


def _metadata(p: Prompt, extra: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    return {**(extra or {}), **prompt_metadata(p)}


def load_prompt_template(
    client: PromptSource,
    name: str,
    *,
    partial_variables: Optional[Mapping[str, Any]] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    tags: Optional[Sequence[str]] = None,
) -> PromptTemplate:
    """A ``PromptTemplate`` (f-string) for a deployed prompt, with its name, version and sha256 in ``metadata``."""
    p = client.prompt(name)
    conv = _converted(p)
    partial = dict(partial_variables or {})
    return PromptTemplate(
        template=conv.template,
        input_variables=[v for v in conv.input_variables if v not in partial],
        partial_variables=partial,
        template_format="f-string",
        metadata=_metadata(p, metadata),
        tags=list(tags) if tags else None,
    )


def kyp_message(client: PromptSource, role: str, name: str) -> Tuple[str, str]:
    """A ``(role, template)`` tuple for ``ChatPromptTemplate.from_messages``, from a deployed prompt."""
    return (role, _converted(client.prompt(name)).template)


MessageLike = Any


def load_chat_prompt_template(
    client: PromptSource,
    name: str,
    *,
    role: str = "system",
    messages: Optional[Sequence[MessageLike]] = None,
    partial_variables: Optional[Mapping[str, Any]] = None,
    metadata: Optional[Mapping[str, Any]] = None,
    tags: Optional[Sequence[str]] = None,
) -> ChatPromptTemplate:
    """A ``ChatPromptTemplate``: the deployed prompt as one message (``system`` by default), then ``messages``."""
    p = client.prompt(name)
    t = ChatPromptTemplate.from_messages(
        [(role, _converted(p).template), *(messages or [])], template_format="f-string"
    )
    t.metadata = _metadata(p, metadata)
    if tags:
        t.tags = list(tags)
    if partial_variables:
        t = t.partial(**partial_variables)
    return t


_default_client: Optional[PromptSource] = None


def set_default_client(client: Optional[PromptSource]) -> None:
    """Set the client ``pull`` and ``live_prompt`` use when none is passed."""
    global _default_client
    _default_client = client


def _client(client: Optional[PromptSource]) -> PromptSource:
    c = client if client is not None else _default_client
    if c is None:
        raise RuntimeError("no Keep Your Prompts client: pass client= or call set_default_client() first")
    return c


def pull(
    name: str,
    *,
    client: Optional[PromptSource] = None,
    chat: bool = True,
    **options: Any,
) -> Union[ChatPromptTemplate, PromptTemplate]:
    """Hub-like ``pull(name)``: the deployed version as a ``ChatPromptTemplate`` (or ``PromptTemplate`` with
    ``chat=False``). Memory-only, so call it per request to follow deploys. ``options`` go to the loader."""
    c = _client(client)
    if chat:
        return load_chat_prompt_template(c, name, **options)
    return load_prompt_template(c, name, **options)


def live_prompt(
    name: str, *, client: Optional[PromptSource] = None, chat: bool = True, **options: Any
) -> RunnableLambda:
    """A runnable that pulls the deployed prompt on every invocation, so ``live_prompt("triage") | model`` follows
    deploys without rebuilding the chain."""

    def _invoke(inputs: Dict[str, Any], config: RunnableConfig) -> Any:
        return pull(name, client=client, chat=chat, **options).invoke(inputs, config)

    async def _ainvoke(inputs: Dict[str, Any], config: RunnableConfig) -> Any:
        return await pull(name, client=client, chat=chat, **options).ainvoke(inputs, config)

    return RunnableLambda(_invoke, afunc=_ainvoke, name=f"kyp:{name}")
