// Unit tests against a real @keepyourprompts/sdk client; the option objects are type-checked against the
// real @anthropic-ai/claude-agent-sdk types (`npm run typecheck`). test/e2e.test.ts starts a real session.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition, Options } from '@anthropic-ai/claude-agent-sdk';
import { MissingVariableError } from '@keepyourprompts/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { KypClaude, agentDefinition, kypAgents, kypSystemPrompt, materializeSkills, parseFrontMatter } from '../src/index.js';
import { snapshotClient, tempDir } from './helpers.js';

const REVIEWER = `---
description: Reviews diffs for security issues
tools: Read, Grep, Glob
model: sonnet
maxTurns: 5
disallowed-tools: [Bash]
---
You review code for {{company}}. Literal {{{{x}} stays.`;

const PROMPTS = {
  'support-agent': { text: 'You are the support agent for {{company}}.', version: 3 },
  'agents/code-reviewer': { text: REVIEWER, version: 2 },
  'agents/billing/refunds': { text: '# Handles refunds\nYou process refunds.', version: 1 },
  'skills/pdf-tools': { text: 'Extract text from PDFs with pdftotext.', version: 4 },
  'skills/release': { text: '---\nname: release\ndescription: Cut a release\n---\nRun the release checklist.', version: 1 },
  other: { text: 'not an agent', version: 1 },
};

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function setup(prompts = PROMPTS) {
  const s = await snapshotClient(prompts);
  cleanups.push(s.cleanup);
  return s;
}

describe('front matter', () => {
  it('reads the subset agent and skill files use', () => {
    const p = parseFrontMatter('---\na: 1\nb: [x, "y z"]\nc:\n  - p\n  - q\nd: \'it\'\'s\'\n---\nbody\n');
    expect(p).toEqual({ data: { a: '1', b: ['x', 'y z'], c: ['p', 'q'], d: "it's" }, body: 'body\n', hasFrontMatter: true });
    expect(parseFrontMatter('no front matter')).toEqual({ data: {}, body: 'no front matter', hasFrontMatter: false });
  });
});

describe('kypSystemPrompt', () => {
  it('renders a string or the claude_code preset', async () => {
    const { client } = await setup();
    const s: Options['systemPrompt'] = kypSystemPrompt(client, 'support-agent', { vars: { company: 'Acme' } });
    expect(s).toBe('You are the support agent for Acme.');
    expect(kypSystemPrompt(client, 'support-agent', { vars: { company: 'Acme' }, preset: 'claude_code', excludeDynamicSections: true })).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'You are the support agent for Acme.',
      excludeDynamicSections: true,
    });
    expect(() => kypSystemPrompt(client, 'support-agent')).toThrow(MissingVariableError);
  });
});

describe('kypAgents', () => {
  it('builds AgentDefinitions from agents/ prompts', async () => {
    const { client } = await setup();
    const agents: Record<string, AgentDefinition> = kypAgents(client, { vars: { company: 'Acme' } });
    expect(Object.keys(agents).sort()).toEqual(['billing-refunds', 'code-reviewer']);
    expect(agents['code-reviewer']).toEqual({
      description: 'Reviews diffs for security issues',
      tools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Bash'],
      model: 'sonnet',
      maxTurns: 5,
      prompt: 'You review code for Acme. Literal {{x}} stays.',
    });
    expect(agents['billing-refunds']).toEqual({ description: 'Handles refunds', prompt: '# Handles refunds\nYou process refunds.' });
  });

  it('is strict about variables, with defaults, descriptions and per-agent vars', async () => {
    const { client } = await setup();
    expect(() => kypAgents(client)).toThrow(MissingVariableError);
    const a = agentDefinition(client, 'agents/billing/refunds', { descriptions: { 'billing-refunds': 'Refunds' }, defaults: { model: 'inherit' } });
    expect(a).toEqual({ model: 'inherit', description: 'Refunds', prompt: '# Handles refunds\nYou process refunds.' });
    const agents = kypAgents(client, { vars: (n) => (n === 'code-reviewer' ? { company: 'Per' } : undefined) });
    expect(agents['code-reviewer']!.prompt).toContain('for Per.');
  });
});

describe('materializeSkills', () => {
  it('writes a plugin with one SKILL.md per skills/ prompt and rewrites only changes', async () => {
    const s = await setup();
    const dir = join(tempDir(), 'plugin');
    cleanups.push(() => rmSync(join(dir, '..'), { recursive: true, force: true }));
    const r = materializeSkills(s.client, { dir });
    expect(r.plugin).toEqual({ type: 'local', path: dir });
    expect(r.skills.sort()).toEqual(['kyp:pdf-tools', 'kyp:release']);
    expect(r.prompts['kyp:pdf-tools']).toMatchObject({ name: 'skills/pdf-tools', version: 4 });
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('kyp');
    expect(readFileSync(join(dir, 'skills', 'pdf-tools', 'SKILL.md'), 'utf8')).toBe(
      '---\nname: pdf-tools\ndescription: "Extract text from PDFs with pdftotext."\n---\n\nExtract text from PDFs with pdftotext.',
    );
    expect(readFileSync(join(dir, 'skills', 'release', 'SKILL.md'), 'utf8')).toBe(PROMPTS['skills/release'].text);
    expect(r.changed.sort()).toEqual(['pdf-tools', 'release']);

    expect(materializeSkills(s.client, { dir }).changed).toEqual([]);

    const { 'skills/release': _gone, ...rest } = PROMPTS;
    await s.deploy({ ...rest, 'skills/pdf-tools': { text: 'Use pdfplumber.', version: 5 } });
    const r2 = materializeSkills(s.client, { dir });
    expect(r2.changed.sort()).toEqual(['pdf-tools', 'release']);
    expect(existsSync(join(dir, 'skills', 'release'))).toBe(false);
    expect(readFileSync(join(dir, 'skills', 'pdf-tools', 'SKILL.md'), 'utf8')).toContain('Use pdfplumber.');
  });

  it('refuses a non-empty folder it did not create', async () => {
    const { client } = await setup();
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'mine.txt'), 'x');
    expect(() => materializeSkills(client, { dir })).toThrow(/not empty/);
    expect(readdirSync(dir)).toEqual(['mine.txt']);
  });
});

describe('KypClaude', () => {
  it('builds options per session and follows deploys between sessions', async () => {
    const s = await setup();
    const dir = join(tempDir(), 'plugin');
    cleanups.push(() => rmSync(join(dir, '..'), { recursive: true, force: true }));
    const kyp = new KypClaude(s.client, {
      systemPrompt: { name: 'support-agent', vars: { company: 'Acme' }, preset: 'claude_code' },
      agents: { vars: { company: 'Acme' } },
      skills: { dir },
    });
    const mine: AgentDefinition = { description: 'mine', prompt: 'p' };
    const o: Options = kyp.options({ allowedTools: ['Read'], agents: { mine }, plugins: [{ type: 'local', path: '/x' }] });
    expect(o.allowedTools).toEqual(['Read']);
    expect(o.systemPrompt).toMatchObject({ preset: 'claude_code', append: 'You are the support agent for Acme.' });
    expect(Object.keys(o.agents!).sort()).toEqual(['billing-refunds', 'code-reviewer', 'mine']);
    expect(o.plugins).toEqual([{ type: 'local', path: '/x' }, { type: 'local', path: dir }]);
    expect(kyp.lastPrompts().systemPrompt).toMatchObject({ name: 'support-agent', version: 3 });
    expect(kyp.lastPrompts().agents['code-reviewer']).toMatchObject({ version: 2 });

    await s.deploy({ ...PROMPTS, 'support-agent': { text: 'v4 for {{company}}.', version: 4 } });
    const o2 = kyp.options();
    expect(o2.systemPrompt).toMatchObject({ append: 'v4 for Acme.' });
    expect(kyp.lastPrompts().systemPrompt?.version).toBe(4);
  });

  it('keeps the system prompt out of the agents when it lives under agents/', async () => {
    const { client } = await setup();
    const kyp = new KypClaude(client, { systemPrompt: { name: 'agents/billing/refunds' }, agents: { vars: { company: 'A' } } });
    expect(Object.keys(kyp.options().agents!)).toEqual(['code-reviewer']);
  });
});
