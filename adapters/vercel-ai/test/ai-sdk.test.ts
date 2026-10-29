// Runs against the real `ai` package (generateText, streamText, wrapLanguageModel) with its own
// MockLanguageModelV4 from `ai/test` standing in for a provider.
import { generateText, streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { MissingVariableError } from '@keepyourprompts/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@keepyourprompts/sdk';
import {
  kypInstructions,
  kypMessages,
  kypMiddleware,
  kypSystem,
  promptAttributes,
  type KypCall,
} from '../src/index.js';
import { fixtureClient, liveClient } from './helpers.js';

const GREETING = { name: 'greeting', version: 4, sha256: '5d3d1a279222fe6f5711f3ce5ac7a3fd351c9a843d3c1aa4b107a365909dfc0d' };
const TRIAGE = { name: 'triage', version: 7, sha256: 'f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf' };

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

function mockModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      providerMetadata: { mock: { id: 'm1' } },
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: 't' });
          c.enqueue({ type: 'text-delta', id: 't', delta: 'ok' });
          c.enqueue({ type: 'text-end', id: 't' });
          c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
          c.close();
        },
      }),
    }),
  });
}

let prompts: Client;
beforeAll(async () => {
  prompts = await fixtureClient();
});
afterAll(async () => {
  await prompts.close();
});

describe('helpers', () => {
  it('render with the core SDK and tag the message', () => {
    const m = kypInstructions(prompts, 'triage', { company: 'Acme' });
    expect(m).toEqual({
      role: 'system',
      content: 'You are a support agent for Acme. Literal {{braces}} stay.',
      providerOptions: { kyp: TRIAGE },
    });
    expect(m.content).toBe(prompts.render('triage', { company: 'Acme' }));
    expect(kypSystem(prompts, 'greeting', { name: 'Ana', company: 'Acme' })).toBe('Hello Ana, welcome to Acme.');
  });

  it('are strict about missing variables by default, like the core SDK', () => {
    expect(() => kypInstructions(prompts, 'greeting', { name: 'Ana' })).toThrow(MissingVariableError);
    expect(kypInstructions(prompts, 'greeting', { name: 'Ana' }, { strict: false }).content).toBe(
      'Hello Ana, welcome to {{ company }}.',
    );
  });

  it('keep other provider options next to the tag', () => {
    const m = kypInstructions(prompts, 'triage', { company: 'A' }, { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } });
    expect(m.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } }, kyp: TRIAGE });
  });

  it('kypMessages renders several prompts', () => {
    const msgs = kypMessages(prompts, [
      { role: 'system', prompt: 'triage', vars: { company: 'Acme' } },
      { role: 'user', prompt: 'greeting', vars: { name: 'Bo', company: 'Acme' } },
    ]);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['system', 'You are a support agent for Acme. Literal {{braces}} stay.'],
      ['user', 'Hello Bo, welcome to Acme.'],
    ]);
    expect(msgs[1]!.providerOptions.kyp).toEqual(GREETING);
  });

  it('promptAttributes gives flat span attributes', () => {
    expect(promptAttributes(prompts.prompt('greeting'))).toEqual({
      'kyp.prompt.name': 'greeting',
      'kyp.prompt.version': 4,
      'kyp.prompt.sha256': GREETING.sha256,
    });
  });
});

describe('kypMiddleware with generateText / streamText', () => {
  it('tags generateText results and strips the tag before the provider', async () => {
    const inner = mockModel();
    const calls: KypCall[] = [];
    const { text, providerMetadata } = await generateText({
      model: wrapLanguageModel({ model: inner, middleware: kypMiddleware({ onCall: (c) => calls.push(c) }) }),
      instructions: kypInstructions(prompts, 'triage', { company: 'Acme' }),
      prompt: 'My invoice is wrong.',
    });
    expect(text).toBe('ok');
    expect(providerMetadata?.mock).toEqual({ id: 'm1' });
    expect(providerMetadata?.kyp).toMatchObject({ ...TRIAGE, prompts: [TRIAGE] });
    expect(calls).toEqual([{ type: 'generate', prompts: [TRIAGE] }]);

    const sent = inner.doGenerateCalls[0]!.prompt;
    expect(sent[0]).toEqual({ role: 'system', content: 'You are a support agent for Acme. Literal {{braces}} stay.' });
    expect(JSON.stringify(sent)).not.toContain('"kyp"');
  });

  it('can leave the tag in place', async () => {
    const inner = mockModel();
    await generateText({
      model: wrapLanguageModel({ model: inner, middleware: kypMiddleware({ strip: false }) }),
      instructions: kypInstructions(prompts, 'triage', { company: 'Acme' }),
      prompt: 'x',
    });
    expect(inner.doGenerateCalls[0]!.prompt[0]!.providerOptions).toEqual({ kyp: TRIAGE });
  });

  it('system messages inside messages need allowSystemInMessages (AI SDK 7 default)', async () => {
    const inner = mockModel();
    await generateText({
      model: wrapLanguageModel({ model: inner, middleware: kypMiddleware() }),
      allowSystemInMessages: true,
      messages: [
        ...kypMessages(prompts, [{ role: 'system', prompt: 'triage', vars: { company: 'Acme' } }]),
        { role: 'user', content: 'hi' },
      ],
    });
    expect(inner.doGenerateCalls[0]!.prompt[0]!.role).toBe('system');
  });

  it('tags streamText finish metadata', async () => {
    const calls: KypCall[] = [];
    const result = streamText({
      model: wrapLanguageModel({ model: mockModel(), middleware: kypMiddleware({ onCall: (c) => calls.push(c) }) }),
      instructions: kypInstructions(prompts, 'triage', { company: 'Acme' }),
      messages: kypMessages(prompts, [{ role: 'user', prompt: 'greeting', vars: { name: 'Bo', company: 'Acme' } }]),
    });
    expect(await result.text).toBe('ok');
    expect((await result.providerMetadata)?.kyp).toMatchObject({ ...TRIAGE, prompts: [TRIAGE, GREETING] });
    expect(calls).toEqual([{ type: 'stream', prompts: [TRIAGE, GREETING] }]);
  });

  it('leaves untagged calls alone', async () => {
    const calls: KypCall[] = [];
    const { providerMetadata } = await generateText({
      model: wrapLanguageModel({ model: mockModel(), middleware: kypMiddleware({ onCall: (c) => calls.push(c) }) }),
      instructions: 'plain',
      prompt: 'x',
    });
    expect(providerMetadata?.kyp).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('hot updates', () => {
  it('the next call renders the newly deployed version, without a restart', async () => {
    const live = await liveClient();
    try {
      const vars = { name: 'Ana', company: 'Acme' };
      expect(kypInstructions(live.client, 'greeting', vars).content).toBe('Hello Ana, welcome to Acme.');
      live.deploy('v13');
      expect(await live.client.refresh()).toBe(true);
      const m = kypInstructions(live.client, 'greeting', vars);
      expect(m.content).toBe('Hi Ana! Acme is glad you are here.');
      expect((m.providerOptions.kyp as { version: number }).version).toBe(5);
    } finally {
      await live.cleanup();
    }
  });
});
