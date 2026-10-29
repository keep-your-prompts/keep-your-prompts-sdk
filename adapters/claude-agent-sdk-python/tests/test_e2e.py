"""Starts a real Claude Agent SDK session (the Claude Code CLI bundled with claude-agent-sdk) with options from
KypClaude and checks the session's init message lists the deployed subagents and skills. The session is stopped
right after init. Opt-in: KYP_CLAUDE_E2E=1."""

from __future__ import annotations

import os

import pytest
from claude_agent_sdk import ClaudeSDKClient, SystemMessage

import keepyourprompts_claude_agent_sdk as kc

pytestmark = pytest.mark.skipif(os.environ.get("KYP_CLAUDE_E2E") != "1", reason="set KYP_CLAUDE_E2E=1")


async def test_real_session_registers_agents_and_skills(snapshot, tmp_path):
    s = snapshot(
        {
            "support-agent": ("You are a support agent.", 1),
            "agents/code-reviewer": ("---\ndescription: Reviews diffs\ntools: Read\n---\nReview the diff.", 1),
            "skills/pdf-tools": ("Extract text from PDFs with pdftotext.", 1),
        }
    )
    kyp = kc.KypClaude(s.client, system_prompt="support-agent", skills={"dir": str(tmp_path / "plugin")})
    work = tmp_path / "work"
    work.mkdir()
    options = kyp.options(cwd=str(work), setting_sources=[], max_turns=1)
    init = None
    async with ClaudeSDKClient(options=options) as client:
        await client.query("hello")
        async for m in client.receive_messages():
            if isinstance(m, SystemMessage) and m.subtype == "init":
                init = m.data
                await client.interrupt()
                break
    assert init is not None
    assert "code-reviewer" in init["agents"]
    assert "kyp:pdf-tools" in init["skills"]
    assert "kyp" in [p["name"] for p in init["plugins"]]
