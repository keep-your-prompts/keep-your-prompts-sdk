"""Keep Your Prompts for the OpenAI Agents SDK (Python). This code is under the repository's LICENSE.

    from agents import Agent, Runner
    from keepyourprompts import Client
    from keepyourprompts_openai_agents import kyp_instructions

    prompts = Client.from_env()
    agent = Agent(name="Triage", instructions=kyp_instructions(prompts, "triage"))
    await Runner.run(agent, "My invoice is wrong.", context={"company": "Acme"})

``instructions`` is a function the SDK calls for every run (and every turn), so each run renders the version
deployed at that moment: deploys apply without restarting the process or rebuilding the agent. Rendering reads
the client's memory only and is the core SDK's (strict: a missing variable raises ``MissingVariableError``).
"""

from __future__ import annotations

import dataclasses
import inspect
from collections.abc import Mapping
from typing import Any, Awaitable, Callable, Dict, NamedTuple, Optional, Protocol, Union

from keepyourprompts import Prompt

__version__ = "0.1.0"

__all__ = [
    "PromptMetadata",
    "PromptSource",
    "RenderEvent",
    "__version__",
    "kyp_instructions",
    "kyp_text",
    "last_rendered",
    "prompt_attributes",
]


class PromptSource(Protocol):
    """Anything with ``prompt(name)``: a ``Client`` or ``AsyncClient`` of ``keepyourprompts``."""

    def prompt(self, name: str) -> Prompt: ...


class PromptMetadata(NamedTuple):
    name: str
    version: int
    sha256: str


@dataclasses.dataclass(frozen=True)
class RenderEvent:
    """Passed to ``on_render`` after every render."""

    name: str
    version: int
    sha256: str
    agent: str
    context: Any


def prompt_attributes(prompt: Union[Prompt, PromptMetadata]) -> Dict[str, Any]:
    """Flat span attributes: ``kyp.prompt.name``, ``kyp.prompt.version``, ``kyp.prompt.sha256``."""
    return {"kyp.prompt.name": prompt.name, "kyp.prompt.version": prompt.version, "kyp.prompt.sha256": prompt.sha256}


VarsResolver = Union[
    Mapping[str, Any],
    Callable[[Any, Any], Union[Mapping[str, Any], Awaitable[Mapping[str, Any]]]],
]


def _context_vars(context: Any) -> Mapping[str, Any]:
    """The run context as variables: a mapping, a dataclass or a pydantic model; anything else gives none."""
    if context is None:
        return {}
    if isinstance(context, Mapping):
        return context
    if dataclasses.is_dataclass(context) and not isinstance(context, type):
        return {f.name: getattr(context, f.name) for f in dataclasses.fields(context)}
    dump = getattr(context, "model_dump", None)
    if callable(dump):
        return dump()
    return {}


_LAST = "__kyp_last_rendered__"


def kyp_instructions(
    client: PromptSource,
    name: str,
    *,
    vars: Optional[VarsResolver] = None,
    strict: bool = True,
    on_missing: Optional[str] = None,
    on_render: Optional[Callable[[RenderEvent], Any]] = None,
) -> Callable[[Any, Any], Awaitable[str]]:
    """Dynamic ``instructions`` for an ``Agent``: renders the deployed prompt ``name`` on every run.

    ``vars`` is a mapping, or a function ``(run_context_wrapper, agent) -> mapping`` (sync or async). By default the
    run's ``context`` is used when it is a mapping, a dataclass or a pydantic model.
    """

    async def instructions(ctx: Any, agent: Any) -> str:
        p = client.prompt(name)
        if vars is None:
            values: Mapping[str, Any] = _context_vars(getattr(ctx, "context", None))
        elif callable(vars):
            got = vars(ctx, agent)
            values = await got if inspect.isawaitable(got) else got  # type: ignore[assignment]
        else:
            values = vars
        text = p.render(dict(values), strict=strict, on_missing=on_missing)
        meta = PromptMetadata(p.name, p.version, p.sha256)
        setattr(instructions, _LAST, meta)
        if on_render is not None:
            on_render(
                RenderEvent(p.name, p.version, p.sha256, getattr(agent, "name", ""), getattr(ctx, "context", None))
            )
        return text

    instructions.kyp_prompt = name  # type: ignore[attr-defined]
    instructions.__name__ = f"kyp_instructions[{name}]"
    return instructions


def last_rendered(instructions: Any) -> Optional[PromptMetadata]:
    """``PromptMetadata`` of the version a ``kyp_instructions`` function rendered last, or ``None``."""
    return getattr(instructions, _LAST, None)


def kyp_text(client: PromptSource, name: str, variables: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> str:
    """Rendered text read once (strict, like ``client.render``), e.g. for ``handoff_description``."""
    return client.prompt(name).render(dict(variables or {}), **kwargs)
