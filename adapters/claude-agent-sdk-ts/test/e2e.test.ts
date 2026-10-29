// Starts a real Claude Agent SDK session (the Claude Code binary bundled with @anthropic-ai/claude-agent-sdk)
// with options from KypClaude and checks the session's init message: the deployed subagents and skills are
// registered. The session is aborted right after init, before any model request. Opt-in: KYP_CLAUDE_E2E=1.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { KypClaude } from '../src/index.js';
import { snapshotClient, tempDir } from './helpers.js';

describe.skipIf(process.env.KYP_CLAUDE_E2E !== '1')('real Agent SDK session', () => {
  it('registers deployed agents and skills', async () => {
    const s = await snapshotClient({
      'support-agent': { text: 'You are a support agent.', version: 1 },
      'agents/code-reviewer': { text: '---\ndescription: Reviews diffs\ntools: Read\n---\nReview the diff.', version: 1 },
      'skills/pdf-tools': { text: 'Extract text from PDFs with pdftotext.', version: 1 },
    });
    const root = tempDir();
    try {
      const kyp = new KypClaude(s.client, { systemPrompt: 'support-agent', skills: { dir: join(root, 'plugin') } });
      const abortController = new AbortController();
      const options = kyp.options({
        cwd: root,
        settingSources: [],
        maxTurns: 1,
        abortController,
        ...(process.env.CLAUDE_CODE_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH } : {}),
      });
      let init: Extract<SDKMessage, { type: 'system'; subtype: 'init' }> | undefined;
      try {
        for await (const m of query({ prompt: 'hello', options })) {
          if (m.type === 'system' && m.subtype === 'init') {
            init = m;
            abortController.abort();
            break;
          }
        }
      } catch (e) {
        if (!init) throw e;
      }
      expect(init).toBeDefined();
      expect(init!.agents).toContain('code-reviewer');
      expect(init!.skills).toContain('kyp:pdf-tools');
      expect(init!.plugins.map((p) => p.name)).toContain('kyp');
    } finally {
      rmSync(root, { recursive: true, force: true });
      await s.cleanup();
    }
  }, 60_000);
});
