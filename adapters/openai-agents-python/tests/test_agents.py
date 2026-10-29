"""Runs against the real openai-agents package: Agent, Runner and RunContextWrapper, with a recording Model in place
of the OpenAI API."""

from __future__ import annotations

import dataclasses

import pytest
from agents import Agent, ModelResponse, RunConfig, RunContextWrapper, Runner, Usage, set_tracing_disabled
from agents.models.interface import Model
from keepyourprompts import MissingVariableError
from openai.types.responses import ResponseOutputMessage, ResponseOutputText

import keepyourprompts_openai_agents as ka

set_tracing_disabled(True)


class RecordingModel(Model):
    def __init__(self) -> None:
        self.system: list = []

    async def get_response(
        self, system_instructions, input, model_settings, tools, output_schema, handoffs, tracing, **kw
    ):
        self.system.append(system_instructions)
        msg = ResponseOutputMessage(
            id="m1",
            type="message",
            role="assistant",
            status="completed",
            content=[ResponseOutputText(type="output_text", text="ok", annotations=[])],
        )
        return ModelResponse(output=[msg], usage=Usage(), response_id="r1")

    def stream_response(self, *args, **kwargs):
        raise NotImplementedError


@dataclasses.dataclass
class Ctx:
    company: str


async def test_context_mapping_dataclass_and_pydantic(prompts):
    agent = Agent(name="Triage", instructions=ka.kyp_instructions(prompts, "triage"))
    expected = prompts.render("triage", company="Acme")
    assert await agent.get_system_prompt(RunContextWrapper({"company": "Acme"})) == expected
    assert await agent.get_system_prompt(RunContextWrapper(Ctx("Acme"))) == expected
    pydantic = pytest.importorskip("pydantic")

    class P(pydantic.BaseModel):
        company: str

    assert await agent.get_system_prompt(RunContextWrapper(P(company="Acme"))) == expected


async def test_fixed_and_resolved_vars(prompts):
    fixed = Agent(name="F", instructions=ka.kyp_instructions(prompts, "triage", vars={"company": "Fixed"}))
    assert "Fixed" in await fixed.get_system_prompt(RunContextWrapper(None))

    async def resolve(ctx, agent):
        return {"company": f"{ctx.context.company}/{agent.name}"}

    resolved = Agent(name="R", instructions=ka.kyp_instructions(prompts, "triage", vars=resolve))
    assert "Acme/R" in await resolved.get_system_prompt(RunContextWrapper(Ctx("Acme")))
    sync = Agent(name="S", instructions=ka.kyp_instructions(prompts, "triage", vars=lambda c, a: {"company": "Sync"}))
    assert "Sync" in await sync.get_system_prompt(RunContextWrapper(None))


async def test_strict_by_default(prompts):
    strict = Agent(name="S", instructions=ka.kyp_instructions(prompts, "greeting"))
    with pytest.raises(MissingVariableError):
        await strict.get_system_prompt(RunContextWrapper({"name": "Ana"}))
    lenient = Agent(name="L", instructions=ka.kyp_instructions(prompts, "greeting", strict=False))
    assert await lenient.get_system_prompt(RunContextWrapper({"name": "Ana"})) == "Hello Ana, welcome to {{ company }}."


async def test_metadata(prompts):
    events = []
    instructions = ka.kyp_instructions(prompts, "triage", on_render=events.append)
    assert ka.last_rendered(instructions) is None
    await Agent(name="Triage", instructions=instructions).get_system_prompt(RunContextWrapper({"company": "A"}))
    assert events[0].name == "triage" and events[0].version == 7 and events[0].agent == "Triage"
    meta = ka.last_rendered(instructions)
    assert meta == ("triage", 7, "f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf")
    assert ka.prompt_attributes(meta)["kyp.prompt.version"] == 7
    assert instructions.kyp_prompt == "triage"
    assert ka.kyp_text(prompts, "agents/reviewer") == "Review the diff."


async def test_runner_follows_deploys(live):
    model = RecordingModel()
    agent = Agent(name="Greeter", model=model, instructions=ka.kyp_instructions(live.client, "greeting"))
    ctx = {"name": "Ana", "company": "Acme"}
    cfg = RunConfig(tracing_disabled=True)
    result = await Runner.run(agent, "hi", context=ctx, run_config=cfg)
    assert result.final_output == "ok"
    assert model.system[0] == "Hello Ana, welcome to Acme."
    live.deploy("v13")
    await Runner.run(agent, "hi again", context=ctx, run_config=cfg)
    assert model.system[1] == "Hi Ana! Acme is glad you are here."
    assert ka.last_rendered(agent.instructions).version == 5


def test_run_sync(prompts):
    model = RecordingModel()
    agent = Agent(name="T", model=model, instructions=ka.kyp_instructions(prompts, "triage"))
    Runner.run_sync(agent, "hi", context={"company": "Acme"}, run_config=RunConfig(tracing_disabled=True))
    assert model.system == [prompts.render("triage", company="Acme")]
