// Keep Your Prompts for the Claude Agent SDK (TypeScript). This code is under the repository's LICENSE.
//
//   import { query } from '@anthropic-ai/claude-agent-sdk';
//   import { KypClaude } from '@keepyourprompts/claude-agent-sdk';
//
//   const kyp = new KypClaude(prompts, { systemPrompt: 'support-agent', skills: { dir: '.kyp/plugin' } });
//   for await (const m of query({ prompt, options: kyp.options({ allowedTools: ['Read'] }) })) { ... }
//
// The system prompt, subagent definitions (`agents/...` prompts) and skills (`skills/...` prompts) come from
// deployed prompts. `options()` builds them again for every session from the client's memory, so the next
// session uses whatever is deployed by then. Skills are files for the Agent SDK (it has no API to register them),
// so they are written to a local plugin folder, rewritten only when a skill's sha256 changes.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderTemplate, type Prompt, type RenderOptions, type Vars } from '@keepyourprompts/sdk';
import type { AgentDefinition, Options, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { asList, asString, parseFrontMatter } from './frontmatter.js';

export { parseFrontMatter, type FrontMatterValue, type Parsed } from './frontmatter.js';

/** What the adapter needs from a `Client` of `@keepyourprompts/sdk`. */
export interface PromptSource {
  prompt(name: string): Prompt;
  names(): string[];
}

export interface PromptMetadata {
  name: string;
  version: number;
  sha256: string;
}

export function promptMetadata(p: Pick<Prompt, 'name' | 'version' | 'sha256'>): PromptMetadata {
  return { name: p.name, version: p.version, sha256: p.sha256 };
}

/** Flat attributes: `kyp.prompt.name`, `kyp.prompt.version`, `kyp.prompt.sha256`. */
export function promptAttributes(p: Pick<Prompt, 'name' | 'version' | 'sha256'>): Record<string, string | number> {
  return { 'kyp.prompt.name': p.name, 'kyp.prompt.version': p.version, 'kyp.prompt.sha256': p.sha256 };
}

// ---------------------------------------------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------------------------------------------

export type SystemPrompt = NonNullable<Options['systemPrompt']>;

export interface SystemPromptOptions extends RenderOptions {
  vars?: Vars;
  /** `'claude_code'`: keep Claude Code's prompt and append the deployed one. Default: the deployed prompt alone. */
  preset?: 'claude_code';
  /** With the preset: move per-user sections out of the system prompt so it caches across machines. */
  excludeDynamicSections?: boolean;
}

/** The `systemPrompt` option from a deployed prompt: a string, or the `claude_code` preset with `append`. */
export function kypSystemPrompt(client: PromptSource, name: string, options: SystemPromptOptions = {}): SystemPrompt {
  const { vars, preset, excludeDynamicSections, ...render } = options;
  const text = client.prompt(name).render(vars, render);
  if (!preset) return text;
  return {
    type: 'preset',
    preset,
    append: text,
    ...(excludeDynamicSections !== undefined ? { excludeDynamicSections } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Agents and skills
// ---------------------------------------------------------------------------------------------------------------

/** `agents/code-reviewer` -> `code-reviewer`, `agents/billing/refunds` -> `billing-refunds`. */
export function localName(name: string, prefix: string): string {
  return name.slice(prefix.length).replace(/\//g, '-');
}

function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t) return t.length > 1024 ? `${t.slice(0, 1021)}...` : t;
  }
  return '';
}

export interface AgentsOptions extends RenderOptions {
  /** Prompts whose names start with this become agents. Default `agents/`. */
  prefix?: string;
  /** Variables for every agent body, or per agent (by local name). */
  vars?: Vars | ((localName: string) => Vars | undefined);
  /** Descriptions for agents whose prompt has no `description` front matter (by local name). */
  descriptions?: Record<string, string>;
  /** Fields merged into every definition (front matter wins), e.g. `{ model: 'inherit' }`. */
  defaults?: Partial<AgentDefinition>;
  /** Prompt names to leave out (e.g. the one used as the system prompt). */
  exclude?: string[];
}

const NUMBER_FIELDS = new Set(['maxTurns', 'autoCompactWindow']);

/**
 * Subagent definitions for the `agents` option from every deployed prompt under `prefix`. A prompt may start
 * with front matter like a Claude Code agent file (`description`, `tools`, `disallowedTools`, `model`, `skills`,
 * `maxTurns`, `effort`, `permissionMode`, `memory`, `background`, `initialPrompt`); the rest is the agent's
 * prompt, rendered with the core SDK. Without a `description`, the first line of the body is used.
 */
export function kypAgents(client: PromptSource, options: AgentsOptions = {}): Record<string, AgentDefinition> {
  const prefix = options.prefix ?? 'agents/';
  const out: Record<string, AgentDefinition> = {};
  for (const name of client.names()) {
    if (!name.startsWith(prefix) || name.length === prefix.length || options.exclude?.includes(name)) continue;
    out[localName(name, prefix)] = agentDefinition(client, name, { ...options, prefix });
  }
  return out;
}

/** One agent definition from a deployed prompt (see `kypAgents`). */
export function agentDefinition(client: PromptSource, name: string, options: AgentsOptions = {}): AgentDefinition {
  const prefix = options.prefix ?? 'agents/';
  const local = name.startsWith(prefix) ? localName(name, prefix) : name.replace(/\//g, '-');
  const p = client.prompt(name);
  const { data, body } = parseFrontMatter(p.text);
  const vars = typeof options.vars === 'function' ? options.vars(local) : options.vars;
  const render: RenderOptions = {};
  if (options.strict !== undefined) render.strict = options.strict;
  if (options.onMissing !== undefined) render.onMissing = options.onMissing;
  const prompt = renderBody(p, body, vars, render);
  const def: Record<string, unknown> = { ...options.defaults };
  for (const [k, v] of Object.entries(data)) {
    const key = k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()); // disallowed-tools -> disallowedTools
    if (key === 'name' || key === 'description' || key === 'prompt') continue;
    if (key === 'tools' || key === 'disallowedTools' || key === 'skills') def[key] = asList(v);
    else if (NUMBER_FIELDS.has(key) && /^\d+$/.test(asString(v) ?? '')) def[key] = Number(asString(v));
    else if (key === 'background' || key === 'omitClaudeMd') def[key] = asString(v) === 'true';
    else if (key === 'effort' && /^\d+$/.test(asString(v) ?? '')) def[key] = Number(asString(v));
    else def[key] = asString(v);
  }
  def.description = asString(data.description) ?? options.descriptions?.[local] ?? firstLine(prompt) ?? local;
  if (!def.description) def.description = local;
  def.prompt = prompt;
  return def as AgentDefinition;
}

// Renders the body (after the front matter) with the core SDK's renderer: same template rules, same errors.
function renderBody(p: Prompt, body: string, vars: Vars | undefined, render: RenderOptions): string {
  return body === p.text ? p.render(vars, render) : renderTemplate(body, vars ?? {}, render);
}

export interface SkillsOptions extends RenderOptions {
  /** Folder the plugin is written to (created if needed; this adapter owns it). */
  dir: string;
  /** Prompts whose names start with this become skills. Default `skills/`. */
  prefix?: string;
  /** Plugin name; skills are invoked as `<plugin>:<skill>`. Default `kyp`. */
  pluginName?: string;
  /** Variables for every skill body, or per skill. */
  vars?: Vars | ((localName: string) => Vars | undefined);
  /** Descriptions for skills whose prompt has no front matter (by local name). Default: the first line. */
  descriptions?: Record<string, string>;
}

export interface SkillsResult {
  /** For the `plugins` option. */
  plugin: SdkPluginConfig;
  /** Skill names as the session knows them (`kyp:pdf-tools`), for the `skills` option or `AgentDefinition.skills`. */
  skills: string[];
  /** Deployed prompt behind each skill. */
  prompts: Record<string, PromptMetadata>;
  /** Skill folders written or removed by this call (empty when nothing changed). */
  changed: string[];
}

const MARKER = '.kyp-managed';

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function yamlString(s: string): string {
  return JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar
}

/**
 * Write every deployed prompt under `prefix` as a skill of a local plugin in `dir`
 * (`<dir>/.claude-plugin/plugin.json`, `<dir>/skills/<skill>/SKILL.md`) and return the `plugins` entry.
 * A prompt that starts with front matter is written as is; otherwise `name` and `description` are added.
 * Only skills whose sha256 changed are rewritten, and skills no longer deployed are removed. File I/O happens
 * here, at session set-up, never while rendering.
 */
export function materializeSkills(client: PromptSource, options: SkillsOptions): SkillsResult {
  const prefix = options.prefix ?? 'skills/';
  const plugin = options.pluginName ?? 'kyp';
  const dir = resolve(options.dir);
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, MARKER);
  if (!existsSync(marker)) {
    if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty and was not created by Keep Your Prompts; use an empty folder`);
    writeFileSync(marker, 'This folder is written by @keepyourprompts/claude-agent-sdk. Do not edit.\n');
  }
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  const manifest = JSON.stringify({ name: plugin, version: '0.0.0', description: 'Skills deployed with Keep Your Prompts' }, null, 2) + '\n';
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifest) writeAtomic(manifestPath, manifest);

  const skillsDir = join(dir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  const prompts: Record<string, PromptMetadata> = {};
  const changed: string[] = [];
  const wanted = new Set<string>();
  for (const name of client.names()) {
    if (!name.startsWith(prefix) || name.length === prefix.length) continue;
    const local = localName(name, prefix).toLowerCase();
    wanted.add(local);
    const p = client.prompt(name);
    const meta = promptMetadata(p);
    prompts[`${plugin}:${local}`] = meta;
    const vars = typeof options.vars === 'function' ? options.vars(local) : options.vars;
    const render: RenderOptions = {};
    if (options.strict !== undefined) render.strict = options.strict;
    if (options.onMissing !== undefined) render.onMissing = options.onMissing;
    const stamp = JSON.stringify({ ...meta, vars: vars ?? null });
    const skillDir = join(skillsDir, local);
    const stampPath = join(skillDir, '.kyp.json');
    if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp) continue;
    const parsed = parseFrontMatter(p.text);
    let content: string;
    if (parsed.hasFrontMatter) {
      const fm = p.text.slice(0, p.text.length - parsed.body.length);
      content = fm + renderBody(p, parsed.body, vars, render);
    } else {
      const body = p.render(vars, render);
      const description = options.descriptions?.[local] ?? (firstLine(body) || local);
      content = `---\nname: ${local}\ndescription: ${yamlString(description)}\n---\n\n${body}`;
    }
    mkdirSync(skillDir, { recursive: true });
    writeAtomic(join(skillDir, 'SKILL.md'), content);
    writeAtomic(stampPath, stamp);
    changed.push(local);
  }
  for (const entry of readdirSync(skillsDir)) {
    const path = join(skillsDir, entry);
    if (!wanted.has(entry) && statSync(path).isDirectory() && existsSync(join(path, '.kyp.json'))) {
      rmSync(path, { recursive: true, force: true });
      changed.push(entry);
    }
  }
  return { plugin: { type: 'local', path: dir }, skills: Object.keys(prompts), prompts, changed };
}

// ---------------------------------------------------------------------------------------------------------------
// Per-session options
// ---------------------------------------------------------------------------------------------------------------

export interface KypClaudeConfig {
  /** Deployed prompt used as the system prompt, or `{ name, preset, vars, ... }`. */
  systemPrompt?: string | ({ name: string } & SystemPromptOptions);
  /** Subagents from `agents/...` prompts. `false` to skip. Default: on, with the default prefix. */
  agents?: AgentsOptions | false;
  /** Skills from `skills/...` prompts, written to a local plugin. Off unless a `dir` is given. */
  skills?: SkillsOptions | false;
}

/** What one `options()` call used: the prompt behind each part of the session, for tracing. */
export interface SessionPrompts {
  systemPrompt?: PromptMetadata;
  agents: Record<string, PromptMetadata>;
  skills: Record<string, PromptMetadata>;
}

/**
 * Builds Agent SDK options from deployed prompts. Call `options()` for every `query()`: it reads the client's
 * memory (and syncs the skills folder when skills changed), so each session starts with the versions deployed
 * at that moment. Inside a long session, `await q.reloadSkills()` after `syncSkills()` picks up new skills.
 */
export class KypClaude {
  private last: SessionPrompts = { agents: {}, skills: {} };

  constructor(
    readonly client: PromptSource,
    readonly config: KypClaudeConfig = {},
  ) {}

  /** `{ systemPrompt, agents, plugins }` merged over `overrides` (your `agents` and `plugins` are kept). */
  options<T extends Partial<Options>>(overrides?: T): T & Pick<Options, 'systemPrompt' | 'agents' | 'plugins'> {
    const used: SessionPrompts = { agents: {}, skills: {} };
    const out: Record<string, unknown> = { ...overrides };
    const sp = this.config.systemPrompt;
    const spName = typeof sp === 'string' ? sp : sp?.name;
    if (sp) {
      const { name, ...opts } = typeof sp === 'string' ? { name: sp } : sp;
      out.systemPrompt = kypSystemPrompt(this.client, name, opts);
      used.systemPrompt = promptMetadata(this.client.prompt(name));
    }
    if (this.config.agents !== false) {
      const opts = this.config.agents ?? {};
      const prefix = opts.prefix ?? 'agents/';
      const exclude = [...(opts.exclude ?? []), ...(spName ? [spName] : [])];
      const agents = kypAgents(this.client, { ...opts, exclude });
      for (const name of this.client.names()) {
        if (name.startsWith(prefix) && !exclude.includes(name) && name.length > prefix.length) {
          used.agents[localName(name, prefix)] = promptMetadata(this.client.prompt(name));
        }
      }
      if (Object.keys(agents).length || overrides?.agents) out.agents = { ...agents, ...overrides?.agents };
    }
    if (this.config.skills) {
      const r = materializeSkills(this.client, this.config.skills);
      used.skills = r.prompts;
      out.plugins = [...(overrides?.plugins ?? []), r.plugin];
    }
    this.last = used;
    return out as T & Pick<Options, 'systemPrompt' | 'agents' | 'plugins'>;
  }

  /** Rewrite the skills folder now (for `q.reloadSkills()` inside a running session). */
  syncSkills(): SkillsResult | undefined {
    if (!this.config.skills) return undefined;
    const r = materializeSkills(this.client, this.config.skills);
    this.last = { ...this.last, skills: r.prompts };
    return r;
  }

  /** The prompts (name, version, sha256) behind the last `options()` call. */
  lastPrompts(): SessionPrompts {
    return this.last;
  }
}
