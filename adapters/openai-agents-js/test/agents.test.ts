// Runs against the real @openai/agents-core: Agent, Runner and RunContext, with a recording Model in place of
// the OpenAI API.
import { Agent, Runner, RunContext, Usage, setTracingDisabled, type Model, type ModelRequest, type ModelResponse } from '@openai/agents-core';
import { MissingVariableError, type Client } from '@keepyourprompts/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kypInstructions, kypText, lastRendered, promptAttributes, type RenderEvent } from '../src/index.js';
import { fixtureClient, liveClient } from './helpers.js';

setTracingDisabled(true);

class RecordingModel implements Model {
  requests: ModelRequest[] = [];
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      usage: new Usage(),
      output: [
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
      ],
      responseId: 'r1',
    } as ModelResponse;
  }
  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error('not used');
  }
}

let prompts: Client;
beforeAll(async () => {
  prompts = await fixtureClient();
});
afterAll(async () => {
  await prompts.close();
});

describe('kypInstructions', () => {
  it('fills variables from the run context by default', async () => {
    const agent = new Agent({ name: 'Triage', instructions: kypInstructions(prompts, 'triage') });
    expect(await agent.getSystemPrompt(new RunContext({ company: 'Acme' }))).toBe(prompts.render('triage', { company: 'Acme' }));
  });

  it('takes fixed vars or a resolver', async () => {
    const fixed = new Agent({ name: 'A', instructions: kypInstructions(prompts, 'triage', { vars: { company: 'Fixed' } }) });
    expect(await fixed.getSystemPrompt(new RunContext({}))).toContain('Fixed');
    const resolved = new Agent<{ org: { name: string } }>({
      name: 'B',
      instructions: kypInstructions(prompts, 'triage', { vars: async (ctx, agent) => ({ company: `${ctx.context.org.name}/${agent.name}` }) }),
    });
    expect(await resolved.getSystemPrompt(new RunContext({ org: { name: 'Acme' } }))).toContain('Acme/B');
  });

  it('is strict by default and lenient on request', async () => {
    const strict = new Agent({ name: 'S', instructions: kypInstructions(prompts, 'greeting') });
    await expect(strict.getSystemPrompt(new RunContext({ name: 'Ana' }))).rejects.toBeInstanceOf(MissingVariableError);
    const lenient = new Agent({ name: 'L', instructions: kypInstructions(prompts, 'greeting', { strict: false }) });
    expect(await lenient.getSystemPrompt(new RunContext({ name: 'Ana' }))).toBe('Hello Ana, welcome to {{ company }}.');
  });

  it('reports the rendered version (onRender, lastRendered)', async () => {
    const events: RenderEvent<unknown>[] = [];
    const instructions = kypInstructions(prompts, 'triage', { onRender: (e) => events.push(e) });
    expect(lastRendered(instructions)).toBeUndefined();
    const agent = new Agent({ name: 'Triage', instructions });
    await agent.getSystemPrompt(new RunContext({ company: 'A' }));
    expect(events[0]).toMatchObject({ name: 'triage', version: 7, agent: 'Triage' });
    expect(lastRendered(instructions)).toEqual({ name: 'triage', version: 7, sha256: 'f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf' });
    expect(promptAttributes(prompts.prompt('triage'))['kyp.prompt.version']).toBe(7);
    expect((instructions as unknown as { kypPrompt: string }).kypPrompt).toBe('triage');
  });

  it('kypText renders static text', () => {
    expect(kypText(prompts, 'agents/reviewer')).toBe('Review the diff.');
  });
});

describe('with Runner.run', () => {
  it('sends the deployed prompt and picks up a deploy on the next run, without rebuilding the agent', async () => {
    const live = await liveClient();
    try {
      const model = new RecordingModel();
      const agent = new Agent({ name: 'Greeter', model, instructions: kypInstructions(live.client, 'greeting') });
      const runner = new Runner({ tracingDisabled: true });
      const context = { name: 'Ana', company: 'Acme' };

      const first = await runner.run(agent, 'hi', { context });
      expect(first.finalOutput).toBe('ok');
      expect(model.requests[0]!.systemInstructions).toBe('Hello Ana, welcome to Acme.');

      live.deploy('v13');
      await live.client.refresh();
      await runner.run(agent, 'hi again', { context });
      expect(model.requests[1]!.systemInstructions).toBe('Hi Ana! Acme is glad you are here.');
      expect(lastRendered(agent.instructions)?.version).toBe(5);
    } finally {
      await live.cleanup();
    }
  });
});
