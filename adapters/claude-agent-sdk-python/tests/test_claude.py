"""Unit tests with a real keepyourprompts client and the real claude_agent_sdk types (AgentDefinition,
ClaudeAgentOptions). tests/test_e2e.py starts a real session."""

from __future__ import annotations

import json

import pytest
from claude_agent_sdk import AgentDefinition, ClaudeAgentOptions
from keepyourprompts import MissingVariableError

import keepyourprompts_claude_agent_sdk as kc

REVIEWER = """---
description: Reviews diffs for security issues
tools: Read, Grep, Glob
model: sonnet
maxTurns: 5
disallowed-tools: [Bash]
---
You review code for {{company}}. Literal {{{{x}} stays."""

PROMPTS = {
    "support-agent": ("You are the support agent for {{company}}.", 3),
    "agents/code-reviewer": (REVIEWER, 2),
    "agents/billing/refunds": ("# Handles refunds\nYou process refunds.", 1),
    "skills/pdf-tools": ("Extract text from PDFs with pdftotext.", 4),
    "skills/release": ("---\nname: release\ndescription: Cut a release\n---\nRun the release checklist.", 1),
    "other": ("not an agent", 1),
}


def test_front_matter():
    p = kc.parse_front_matter("---\na: 1\nb: [x, \"y z\"]\nc:\n  - p\n  - q\nd: 'it''s'\n---\nbody\n")
    assert p == ({"a": "1", "b": ["x", "y z"], "c": ["p", "q"], "d": "it's"}, "body\n", True)
    assert kc.parse_front_matter("plain") == ({}, "plain", False)


def test_system_prompt(snapshot):
    c = snapshot(PROMPTS).client
    assert kc.kyp_system_prompt(c, "support-agent", {"company": "Acme"}) == "You are the support agent for Acme."
    assert kc.kyp_system_prompt(
        c, "support-agent", {"company": "Acme"}, preset="claude_code", exclude_dynamic_sections=True
    ) == {
        "type": "preset",
        "preset": "claude_code",
        "append": "You are the support agent for Acme.",
        "exclude_dynamic_sections": True,
    }
    with pytest.raises(MissingVariableError):
        kc.kyp_system_prompt(c, "support-agent")


def test_agents(snapshot):
    c = snapshot(PROMPTS).client
    agents = kc.kyp_agents(c, variables={"company": "Acme"})
    assert sorted(agents) == ["billing-refunds", "code-reviewer"]
    assert agents["code-reviewer"] == AgentDefinition(
        description="Reviews diffs for security issues",
        prompt="You review code for Acme. Literal {{x}} stays.",
        tools=["Read", "Grep", "Glob"],
        disallowedTools=["Bash"],
        model="sonnet",
        maxTurns=5,
    )
    assert agents["billing-refunds"] == AgentDefinition(
        description="Handles refunds", prompt="# Handles refunds\nYou process refunds."
    )
    with pytest.raises(MissingVariableError):
        kc.kyp_agents(c)
    a = kc.agent_definition(
        c, "agents/billing/refunds", descriptions={"billing-refunds": "Refunds"}, defaults={"model": "inherit"}
    )
    assert (a.description, a.model) == ("Refunds", "inherit")
    per = kc.kyp_agents(c, variables=lambda n: {"company": "Per"} if n == "code-reviewer" else None)
    assert "for Per." in per["code-reviewer"].prompt


def test_materialize_skills(snapshot, tmp_path):
    s = snapshot(PROMPTS)
    d = tmp_path / "plugin"
    r = kc.materialize_skills(s.client, str(d))
    assert r.plugin == {"type": "local", "path": str(d)}
    assert sorted(r.skills) == ["kyp:pdf-tools", "kyp:release"]
    assert r.prompts["kyp:pdf-tools"].version == 4
    assert json.loads((d / ".claude-plugin" / "plugin.json").read_text())["name"] == "kyp"
    assert (d / "skills" / "pdf-tools" / "SKILL.md").read_text() == (
        '---\nname: pdf-tools\ndescription: "Extract text from PDFs with pdftotext."\n---\n\n'
        "Extract text from PDFs with pdftotext."
    )
    assert (d / "skills" / "release" / "SKILL.md").read_text() == PROMPTS["skills/release"][0]
    assert sorted(r.changed) == ["pdf-tools", "release"]
    assert kc.materialize_skills(s.client, str(d)).changed == []

    nxt = {k: v for k, v in PROMPTS.items() if k != "skills/release"}
    nxt["skills/pdf-tools"] = ("Use pdfplumber.", 5)
    s.deploy(nxt)
    r2 = kc.materialize_skills(s.client, str(d))
    assert sorted(r2.changed) == ["pdf-tools", "release"]
    assert not (d / "skills" / "release").exists()
    assert "Use pdfplumber." in (d / "skills" / "pdf-tools" / "SKILL.md").read_text()


def test_refuses_foreign_folder(snapshot, tmp_path):
    c = snapshot(PROMPTS).client
    (tmp_path / "mine.txt").write_text("x")
    with pytest.raises(ValueError, match="not empty"):
        kc.materialize_skills(c, str(tmp_path))


def test_kyp_claude_per_session(snapshot, tmp_path):
    s = snapshot(PROMPTS)
    kyp = kc.KypClaude(
        s.client,
        system_prompt={"name": "support-agent", "variables": {"company": "Acme"}, "preset": "claude_code"},
        agents={"variables": {"company": "Acme"}},
        skills={"dir": str(tmp_path / "plugin")},
    )
    mine = AgentDefinition(description="mine", prompt="p")
    base = ClaudeAgentOptions(allowed_tools=["Read"], agents={"mine": mine}, plugins=[{"type": "local", "path": "/x"}])
    o = kyp.options(base)
    assert isinstance(o, ClaudeAgentOptions)
    assert o.allowed_tools == ["Read"]
    assert o.system_prompt["append"] == "You are the support agent for Acme."
    assert sorted(o.agents) == ["billing-refunds", "code-reviewer", "mine"]
    assert o.plugins == [{"type": "local", "path": "/x"}, {"type": "local", "path": str(tmp_path / "plugin")}]
    assert base.agents == {"mine": mine} and base.system_prompt is None  # base is not modified
    assert kyp.last_prompts().system_prompt.version == 3
    assert kyp.last_prompts().agents["code-reviewer"].version == 2
    assert kyp.last_prompts().skills["kyp:pdf-tools"].version == 4

    nxt = dict(PROMPTS)
    nxt["support-agent"] = ("v4 for {{company}}.", 4)
    s.deploy(nxt)
    o2 = kyp.options(max_turns=3)
    assert o2.system_prompt["append"] == "v4 for Acme."
    assert o2.max_turns == 3
    assert kyp.last_prompts().system_prompt.version == 4


def test_system_prompt_kept_out_of_agents(snapshot):
    c = snapshot(PROMPTS).client
    kyp = kc.KypClaude(c, system_prompt="agents/billing/refunds", agents={"variables": {"company": "A"}})
    assert list(kyp.options().agents) == ["code-reviewer"]
