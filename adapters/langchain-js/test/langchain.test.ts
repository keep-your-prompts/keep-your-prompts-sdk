// Runs against the real @langchain/core (PromptTemplate, ChatPromptTemplate, RunnableLambda) and a real
// @keepyourprompts/sdk client over the conformance fixtures.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MissingVariableError, type Client } from '@keepyourprompts/sdk';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatPromptTemplate, MessagesPlaceholder, PromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda } from '@langchain/core/runnables';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  kypMessage,
  livePrompt,
  loadChatPromptTemplate,
  loadPromptTemplate,
  pull,
  setDefaultClient,
  toFString,
} from '../src/index.js';
import { FIXTURES, fixtureClient, liveClient } from './helpers.js';

interface RenderCase {
  template: string;
  vars: Record<string, string>;
  out?: string;
  error?: string;
  variable?: string;
  lenient?: boolean;
}
const cases = (JSON.parse(readFileSync(join(FIXTURES, '..', 'cases.json'), 'utf8')) as { render: RenderCase[] }).render;

let prompts: Client;
beforeAll(async () => {
  prompts = await fixtureClient();
});
afterAll(async () => {
  setDefaultClient(undefined);
  await prompts.close();
});

describe('toFString', () => {
  it('escapes literal braces and converts variables', () => {
    expect(toFString('Hi {{ name }}, {x} {{{{y}} }}')).toEqual({ template: 'Hi {name}, {{x}} {{{{y}}}} }}}}', inputVariables: ['name'] });
    expect(toFString('no vars {}')).toEqual({ template: 'no vars {{}}', inputVariables: [] });
  });

  for (const c of cases.filter((c) => !c.error && !c.lenient)) {
    it(`renders like the core SDK: ${JSON.stringify(c.template)}`, async () => {
      const { template, inputVariables } = toFString(c.template);
      const t = new PromptTemplate({ template, inputVariables, templateFormat: 'f-string' });
      const vars = Object.fromEntries(inputVariables.map((v) => [v, c.vars[v]!]));
      expect(await t.format(vars)).toBe(c.out);
    });
  }

  it('rejects a missing variable (strict, like the core SDK)', async () => {
    const t = loadPromptTemplate(prompts, 'greeting');
    await expect(t.format({ name: 'Ana' } as never)).rejects.toThrow(/company/);
    expect(() => prompts.render('greeting', { name: 'Ana' })).toThrow(MissingVariableError);
  });
});

describe('loaders', () => {
  it('loadPromptTemplate matches client.render and carries metadata', async () => {
    const t = loadPromptTemplate(prompts, 'triage');
    expect(t.inputVariables).toEqual(['company']);
    expect(await t.format({ company: 'Acme' })).toBe(prompts.render('triage', { company: 'Acme' }));
    expect(t.metadata).toEqual({
      'kyp.prompt.name': 'triage',
      'kyp.prompt.version': 7,
      'kyp.prompt.sha256': 'f31befda9f5a0fed97bb07f8164baf8673f4342fcca9ad37d59dafaacefc53bf',
    });
  });

  it('supports partial variables', async () => {
    const t = loadPromptTemplate(prompts, 'greeting', { partialVariables: { company: 'Acme' } });
    expect(t.inputVariables).toEqual(['name']);
    expect(await t.format({ name: 'Ana' })).toBe('Hello Ana, welcome to Acme.');
  });

  it('loadChatPromptTemplate builds system + extra messages', async () => {
    const t = loadChatPromptTemplate(prompts, 'triage', {
      messages: [new MessagesPlaceholder('history'), ['human', '{input}']],
    });
    const msgs = await t.formatMessages({ company: 'Acme', history: [new AIMessage('earlier')], input: 'hi' });
    expect(msgs[0]).toBeInstanceOf(SystemMessage);
    expect(msgs[0]!.content).toBe('You are a support agent for Acme. Literal {{braces}} stay.');
    expect(msgs[1]).toBeInstanceOf(AIMessage);
    expect(msgs[2]).toBeInstanceOf(HumanMessage);
    expect(t.metadata?.['kyp.prompt.version']).toBe(7);
  });

  it('chat templates take partial variables', async () => {
    const t = loadChatPromptTemplate(prompts, 'greeting', { role: 'human', partialVariables: { company: 'Acme' } });
    expect(t.inputVariables).toEqual(['name']);
    const msgs = await t.formatMessages({ name: 'Bo' });
    expect(msgs[0]).toBeInstanceOf(HumanMessage);
    expect(msgs[0]!.content).toBe('Hello Bo, welcome to Acme.');
  });

  it('kypMessage composes several deployed prompts', async () => {
    const t = ChatPromptTemplate.fromMessages([kypMessage(prompts, 'system', 'triage'), kypMessage(prompts, 'human', 'greeting')]);
    const msgs = await t.formatMessages({ company: 'Acme', name: 'Bo' });
    expect(msgs.map((m) => m.content)).toEqual([
      'You are a support agent for Acme. Literal {{braces}} stay.',
      'Hello Bo, welcome to Acme.',
    ]);
  });

  it('prompt metadata reaches the run tree (tracing)', async () => {
    const t = loadPromptTemplate(prompts, 'triage');
    const seen: Record<string, unknown>[] = [];
    await t.invoke(
      { company: 'A' },
      {
        callbacks: [
          {
            handleChainStart(_chain: unknown, _inputs: unknown, _runId: string, _parent?: string, _tags?: string[], metadata?: Record<string, unknown>) {
              seen.push(metadata ?? {});
            },
          },
        ],
      },
    );
    expect(seen[0]).toMatchObject({ 'kyp.prompt.name': 'triage', 'kyp.prompt.version': 7 });
  });
});

describe('pull and livePrompt', () => {
  it('pull uses the default client', async () => {
    expect(() => pull('triage')).toThrow(/setDefaultClient/);
    setDefaultClient(prompts);
    const chat = pull('triage');
    expect(chat).toBeInstanceOf(ChatPromptTemplate);
    const text = pull('triage', { chat: false });
    expect(text).toBeInstanceOf(PromptTemplate);
    expect(await text.format({ company: 'X' })).toBe(prompts.render('triage', { company: 'X' }));
    expect(() => pull('nope')).toThrow(/not found/);
  });

  it('livePrompt follows a deploy without rebuilding the chain', async () => {
    const live = await liveClient();
    try {
      const chain = livePrompt('greeting', { client: live.client, chat: false }).pipe(
        RunnableLambda.from((v: { toString(): string }) => v.toString()),
      );
      const vars = { name: 'Ana', company: 'Acme' };
      expect(await chain.invoke(vars)).toBe('Hello Ana, welcome to Acme.');
      live.deploy('v13');
      await live.client.refresh();
      expect(await chain.invoke(vars)).toBe('Hi Ana! Acme is glad you are here.');
    } finally {
      await live.cleanup();
    }
  });
});
