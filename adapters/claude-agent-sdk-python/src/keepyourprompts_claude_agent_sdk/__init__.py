"""Keep Your Prompts for the Claude Agent SDK (Python). This code is under the repository's LICENSE.

    from claude_agent_sdk import query
    from keepyourprompts import Client
    from keepyourprompts_claude_agent_sdk import KypClaude

    kyp = KypClaude(Client.from_env(), system_prompt="support-agent", skills={"dir": ".kyp/claude-plugin"})
    async for message in query(prompt="...", options=kyp.options(allowed_tools=["Read"])):
        ...

The system prompt, subagent definitions (``agents/...`` prompts) and skills (``skills/...`` prompts) come from
deployed prompts. ``options()`` builds them again for every session from the client's memory, so the next
session uses whatever is deployed by then. Skills are files for the Agent SDK (it has no API to register them),
so they are written to a local plugin folder, rewritten only when a skill's sha256 changes.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Protocol, Sequence, Union

from claude_agent_sdk import AgentDefinition, ClaudeAgentOptions
from keepyourprompts import Prompt, render_template

__version__ = "0.1.0"

__all__ = [
    "KypClaude",
    "Parsed",
    "PromptMetadata",
    "PromptSource",
    "SessionPrompts",
    "SkillsResult",
    "__version__",
    "agent_definition",
    "kyp_agents",
    "kyp_system_prompt",
    "local_name",
    "materialize_skills",
    "parse_front_matter",
    "prompt_attributes",
]


class PromptSource(Protocol):
    """What the adapter needs from a ``Client`` (or ``AsyncClient``) of ``keepyourprompts``."""

    def prompt(self, name: str) -> Prompt: ...

    def names(self) -> List[str]: ...


class PromptMetadata(NamedTuple):
    name: str
    version: int
    sha256: str


def _meta(p: Prompt) -> PromptMetadata:
    return PromptMetadata(p.name, p.version, p.sha256)


def prompt_attributes(p: Union[Prompt, PromptMetadata]) -> Dict[str, Any]:
    """Flat attributes: ``kyp.prompt.name``, ``kyp.prompt.version``, ``kyp.prompt.sha256``."""
    return {"kyp.prompt.name": p.name, "kyp.prompt.version": p.version, "kyp.prompt.sha256": p.sha256}


# ---------------------------------------------------------------------------------------------------------------
# Front matter: the subset of YAML Claude Code agent and skill files use (key: value, inline and block lists).
# ---------------------------------------------------------------------------------------------------------------

FrontMatterValue = Union[str, List[str]]


class Parsed(NamedTuple):
    data: Dict[str, FrontMatterValue]
    body: str
    has_front_matter: bool


_FM = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.S)
_KV = re.compile(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$")
_ITEM = re.compile(r"^\s*-\s+(.*)$")


def _unquote(v: str) -> str:
    t = v.strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'":
        inner = t[1:-1]
        if t[0] == '"':
            return inner.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
        return inner.replace("''", "'")
    return t


def parse_front_matter(text: str) -> Parsed:
    """Split ``---`` front matter from the body. Unknown syntax is kept as strings; no YAML dependency."""
    src = text[1:] if text.startswith("﻿") else text
    m = _FM.match(src)
    if not m:
        return Parsed({}, text, False)
    data: Dict[str, FrontMatterValue] = {}
    list_key = ""
    for raw in m.group(1).splitlines():
        line = re.sub(r"\s+#.*$", "", raw)
        if not line.strip() or line.strip().startswith("#"):
            continue
        item = _ITEM.match(line)
        if item and list_key:
            cur = data.get(list_key)
            data[list_key] = [*(cur if isinstance(cur, list) else []), _unquote(item.group(1))]
            continue
        kv = _KV.match(line)
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2).strip()
        list_key = ""
        if value == "":
            list_key = key
            data[key] = []
        elif value.startswith("[") and value.endswith("]"):
            data[key] = [s for s in (_unquote(x) for x in value[1:-1].split(",")) if s]
        else:
            data[key] = _unquote(value)
    return Parsed(data, src[m.end() :], True)


def _as_list(v: Optional[FrontMatterValue]) -> Optional[List[str]]:
    if v is None:
        return None
    if isinstance(v, list):
        return v
    return [s.strip() for s in v.split(",") if s.strip()]


def _as_str(v: Optional[FrontMatterValue]) -> Optional[str]:
    if v is None:
        return None
    return ", ".join(v) if isinstance(v, list) else v


def _first_line(body: str) -> str:
    for line in body.splitlines():
        t = re.sub(r"^#+\s*", "", line).strip()
        if t:
            return t if len(t) <= 1024 else t[:1021] + "..."
    return ""


def local_name(name: str, prefix: str) -> str:
    """``agents/code-reviewer`` -> ``code-reviewer``; ``agents/billing/refunds`` -> ``billing-refunds``."""
    return name[len(prefix) :].replace("/", "-")


# ---------------------------------------------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------------------------------------------


def kyp_system_prompt(
    client: PromptSource,
    name: str,
    variables: Optional[Mapping[str, Any]] = None,
    *,
    preset: Optional[str] = None,
    exclude_dynamic_sections: Optional[bool] = None,
    strict: bool = True,
    on_missing: Optional[str] = None,
) -> Union[str, Dict[str, Any]]:
    """The ``system_prompt`` option: the rendered text, or ``{"type": "preset", "preset": "claude_code",
    "append": text}`` with ``preset="claude_code"``."""
    text = client.prompt(name).render(dict(variables or {}), strict=strict, on_missing=on_missing)
    if not preset:
        return text
    out: Dict[str, Any] = {"type": "preset", "preset": preset, "append": text}
    if exclude_dynamic_sections is not None:
        out["exclude_dynamic_sections"] = exclude_dynamic_sections
    return out


# ---------------------------------------------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------------------------------------------

VarsOption = Union[None, Mapping[str, Any], Callable[[str], Optional[Mapping[str, Any]]]]

_AGENT_FIELDS = {f for f in getattr(AgentDefinition, "__dataclass_fields__", {})}
_LIST_FIELDS = {"tools", "disallowedTools", "skills"}
_INT_FIELDS = {"maxTurns"}
_BOOL_FIELDS = {"background"}
# Front matter spellings -> AgentDefinition field names (the Python SDK keeps the wire format's camelCase).
_ALIASES = {
    "disallowed-tools": "disallowedTools",
    "disallowed_tools": "disallowedTools",
    "max-turns": "maxTurns",
    "max_turns": "maxTurns",
    "permission-mode": "permissionMode",
    "permission_mode": "permissionMode",
    "initial-prompt": "initialPrompt",
    "initial_prompt": "initialPrompt",
    "mcp-servers": "mcpServers",
}


def _vars_for(option: VarsOption, local: str) -> Dict[str, Any]:
    v = option(local) if callable(option) else option
    return dict(v or {})


def _render_body(p: Prompt, body: str, variables: Mapping[str, Any], strict: bool, on_missing: Optional[str]) -> str:
    if body == p.text:
        return p.render(dict(variables), strict=strict, on_missing=on_missing)
    return render_template(body, variables, strict=strict, on_missing=on_missing)


def agent_definition(
    client: PromptSource,
    name: str,
    *,
    prefix: str = "agents/",
    variables: VarsOption = None,
    descriptions: Optional[Mapping[str, str]] = None,
    defaults: Optional[Mapping[str, Any]] = None,
    strict: bool = True,
    on_missing: Optional[str] = None,
) -> AgentDefinition:
    """One ``AgentDefinition`` from a deployed prompt (see ``kyp_agents``)."""
    local = local_name(name, prefix) if name.startswith(prefix) else name.replace("/", "-")
    p = client.prompt(name)
    parsed = parse_front_matter(p.text)
    prompt = _render_body(p, parsed.body, _vars_for(variables, local), strict, on_missing)
    fields: Dict[str, Any] = dict(defaults or {})
    for k, v in parsed.data.items():
        key = _ALIASES.get(k, k)
        if key in ("name", "description", "prompt") or key not in _AGENT_FIELDS:
            continue
        s = _as_str(v) or ""
        if key in _LIST_FIELDS:
            fields[key] = _as_list(v)
        elif key in _INT_FIELDS and s.isdigit():
            fields[key] = int(s)
        elif key in _BOOL_FIELDS:
            fields[key] = s == "true"
        elif key == "effort" and s.isdigit():
            fields[key] = int(s)
        else:
            fields[key] = s
    description = _as_str(parsed.data.get("description")) or (descriptions or {}).get(local) or _first_line(prompt)
    return AgentDefinition(description=description or local, prompt=prompt, **fields)


def kyp_agents(
    client: PromptSource,
    *,
    prefix: str = "agents/",
    variables: VarsOption = None,
    descriptions: Optional[Mapping[str, str]] = None,
    defaults: Optional[Mapping[str, Any]] = None,
    exclude: Sequence[str] = (),
    strict: bool = True,
    on_missing: Optional[str] = None,
) -> Dict[str, AgentDefinition]:
    """Subagent definitions for ``agents=`` from every deployed prompt under ``prefix``.

    A prompt may start with front matter like a Claude Code agent file (``description``, ``tools``,
    ``disallowedTools``, ``model``, ``skills``, ``maxTurns``, ``effort``, ``permissionMode``, ``memory``,
    ``background``, ``initialPrompt``); the rest is the agent's prompt, rendered by the core SDK. Without a
    ``description`` the first line of the body is used.
    """
    out: Dict[str, AgentDefinition] = {}
    for name in client.names():
        if not name.startswith(prefix) or len(name) == len(prefix) or name in exclude:
            continue
        out[local_name(name, prefix)] = agent_definition(
            client,
            name,
            prefix=prefix,
            variables=variables,
            descriptions=descriptions,
            defaults=defaults,
            strict=strict,
            on_missing=on_missing,
        )
    return out


# ---------------------------------------------------------------------------------------------------------------
# Skills
# ---------------------------------------------------------------------------------------------------------------

_MARKER = ".kyp-managed"


class SkillsResult(NamedTuple):
    plugin: Dict[str, str]
    """For ``plugins=``: ``{"type": "local", "path": dir}``."""
    skills: List[str]
    """Skill names as the session knows them (``kyp:pdf-tools``)."""
    prompts: Dict[str, PromptMetadata]
    changed: List[str]
    """Skill folders written or removed by this call."""


def _write_atomic(path: str, data: str) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(data)
    os.replace(tmp, path)


def _read(path: str) -> Optional[str]:
    try:
        with open(path, encoding="utf-8", newline="") as f:
            return f.read()
    except OSError:
        return None


def materialize_skills(
    client: PromptSource,
    dir: str,
    *,
    prefix: str = "skills/",
    plugin_name: str = "kyp",
    variables: VarsOption = None,
    descriptions: Optional[Mapping[str, str]] = None,
    strict: bool = True,
    on_missing: Optional[str] = None,
) -> SkillsResult:
    """Write every deployed prompt under ``prefix`` as a skill of a local plugin in ``dir``.

    Layout: ``<dir>/.claude-plugin/plugin.json`` and ``<dir>/skills/<skill>/SKILL.md``. A prompt with front matter
    is written as is (body rendered); otherwise ``name`` and ``description`` are added. Only skills whose sha256
    changed are rewritten; skills no longer deployed are removed. The folder belongs to the adapter: a non-empty
    folder it did not create is refused. File I/O happens here, at session set-up, never while rendering.
    """
    root = os.path.abspath(dir)
    os.makedirs(root, exist_ok=True)
    marker = os.path.join(root, _MARKER)
    if not os.path.exists(marker):
        if os.listdir(root):
            raise ValueError(f"{root} is not empty and was not created by Keep Your Prompts; use an empty folder")
        _write_atomic(marker, "This folder is written by keepyourprompts-claude-agent-sdk. Do not edit.\n")
    os.makedirs(os.path.join(root, ".claude-plugin"), exist_ok=True)
    manifest = (
        json.dumps(
            {"name": plugin_name, "version": "0.0.0", "description": "Skills deployed with Keep Your Prompts"}, indent=2
        )
        + "\n"
    )
    manifest_path = os.path.join(root, ".claude-plugin", "plugin.json")
    if _read(manifest_path) != manifest:
        _write_atomic(manifest_path, manifest)

    skills_dir = os.path.join(root, "skills")
    os.makedirs(skills_dir, exist_ok=True)
    prompts: Dict[str, PromptMetadata] = {}
    changed: List[str] = []
    wanted = set()
    for name in client.names():
        if not name.startswith(prefix) or len(name) == len(prefix):
            continue
        local = local_name(name, prefix).lower()
        wanted.add(local)
        p = client.prompt(name)
        meta = _meta(p)
        prompts[f"{plugin_name}:{local}"] = meta
        values = _vars_for(variables, local)
        stamp = json.dumps({**meta._asdict(), "vars": values or None}, sort_keys=True, default=str)
        skill_dir = os.path.join(skills_dir, local)
        stamp_path = os.path.join(skill_dir, ".kyp.json")
        if _read(stamp_path) == stamp:
            continue
        parsed = parse_front_matter(p.text)
        if parsed.has_front_matter:
            head = p.text[: len(p.text) - len(parsed.body)]
            content = head + _render_body(p, parsed.body, values, strict, on_missing)
        else:
            body = p.render(values, strict=strict, on_missing=on_missing)
            description = (descriptions or {}).get(local) or _first_line(body) or local
            content = f"---\nname: {local}\ndescription: {json.dumps(description)}\n---\n\n{body}"
        os.makedirs(skill_dir, exist_ok=True)
        _write_atomic(os.path.join(skill_dir, "SKILL.md"), content)
        _write_atomic(stamp_path, stamp)
        changed.append(local)
    for entry in os.listdir(skills_dir):
        path = os.path.join(skills_dir, entry)
        if entry not in wanted and os.path.isdir(path) and os.path.exists(os.path.join(path, ".kyp.json")):
            shutil.rmtree(path, ignore_errors=True)
            changed.append(entry)
    return SkillsResult({"type": "local", "path": root}, list(prompts), prompts, changed)


# ---------------------------------------------------------------------------------------------------------------
# Per-session options
# ---------------------------------------------------------------------------------------------------------------


@dataclass
class SessionPrompts:
    """The prompts (name, version, sha256) behind one ``options()`` call, for tracing."""

    system_prompt: Optional[PromptMetadata] = None
    agents: Dict[str, PromptMetadata] = field(default_factory=dict)
    skills: Dict[str, PromptMetadata] = field(default_factory=dict)


class KypClaude:
    """Builds ``ClaudeAgentOptions`` from deployed prompts.

    Call ``options()`` for every ``query()`` / ``ClaudeSDKClient`` session: it reads the client's memory (and syncs
    the skills folder when skills changed), so each session starts with the versions deployed at that moment.

    - ``system_prompt``: a prompt name, or a dict ``{"name": ..., "preset": "claude_code", "variables": {...}}``.
    - ``agents``: options for ``kyp_agents`` (``prefix``, ``variables``, ...), or ``False`` to skip. On by default.
    - ``skills``: options for ``materialize_skills`` with at least ``dir``; off by default.
    """

    def __init__(
        self,
        client: PromptSource,
        *,
        system_prompt: Union[str, Mapping[str, Any], None] = None,
        agents: Union[bool, Mapping[str, Any]] = True,
        skills: Union[bool, Mapping[str, Any], None] = None,
    ) -> None:
        self.client = client
        self.system_prompt = system_prompt
        self.agents = agents
        self.skills = skills
        self._last = SessionPrompts()

    def options(self, base: Optional[ClaudeAgentOptions] = None, **overrides: Any) -> ClaudeAgentOptions:
        """``ClaudeAgentOptions`` with ``system_prompt``, ``agents`` and ``plugins`` from deployed prompts, over
        ``base`` and ``overrides`` (your own ``agents`` and ``plugins`` are kept)."""
        opts = replace(base, **overrides) if base is not None else ClaudeAgentOptions(**overrides)
        used = SessionPrompts()
        sp_name: Optional[str] = None
        if self.system_prompt:
            spec: Dict[str, Any] = (
                {"name": self.system_prompt} if isinstance(self.system_prompt, str) else dict(self.system_prompt)
            )
            sp_name = spec.pop("name")
            variables = spec.pop("variables", None)
            opts.system_prompt = kyp_system_prompt(self.client, sp_name, variables, **spec)  # type: ignore[assignment]
            used.system_prompt = _meta(self.client.prompt(sp_name))
        if self.agents is not False:
            cfg = dict(self.agents) if isinstance(self.agents, Mapping) else {}
            prefix = cfg.get("prefix", "agents/")
            exclude = [*cfg.pop("exclude", ()), *([sp_name] if sp_name else [])]
            agents = kyp_agents(self.client, exclude=exclude, **cfg)
            for name in self.client.names():
                if name.startswith(prefix) and name not in exclude and len(name) > len(prefix):
                    used.agents[local_name(name, prefix)] = _meta(self.client.prompt(name))
            if agents or opts.agents:
                opts.agents = {**agents, **(opts.agents or {})}
        if self.skills:
            r = self.sync_skills()
            assert r is not None
            used.skills = r.prompts
            opts.plugins = [*(opts.plugins or []), r.plugin]  # type: ignore[list-item]
        self._last = used
        return opts

    def sync_skills(self) -> Optional[SkillsResult]:
        """Rewrite the skills folder now (then ``await client.reload_skills()``-style APIs pick them up)."""
        if not self.skills:
            return None
        cfg = dict(self.skills) if isinstance(self.skills, Mapping) else {}
        directory = cfg.pop("dir")
        r = materialize_skills(self.client, directory, **cfg)
        self._last.skills = r.prompts
        return r

    def last_prompts(self) -> SessionPrompts:
        """The prompts behind the last ``options()`` call."""
        return self._last
