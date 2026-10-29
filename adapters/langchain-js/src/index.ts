// Keep Your Prompts for LangChain.js. This code is under the repository's LICENSE.
//
//   import { pull, setDefaultClient } from '@keepyourprompts/langchain';
//   setDefaultClient(await Client.fromEnv());
//   const chain = pull('triage').pipe(model);          // ChatPromptTemplate, like hub.pull
//
// Deployed prompts use `{{name}}` variables and `{{{{` for a literal `{{`. LangChain f-strings use `{name}` and
// `{{` / `}}` for literal braces. The conversion below lets the core SDK find the variables (so both agree on
// what is a variable) and escapes every other brace, so a template renders to exactly the text
// `client.render` would produce. Everything reads the client's memory: no network on the hot path.
import { renderTemplate, templateVariables, type Prompt } from '@keepyourprompts/sdk';
import { ChatPromptTemplate, PromptTemplate, type BaseMessagePromptTemplateLike } from '@langchain/core/prompts';
import { RunnableLambda, type RunnableConfig } from '@langchain/core/runnables';
import type { InputValues } from '@langchain/core/utils/types';

/** Anything with `prompt(name)`: a `Client` from `@keepyourprompts/sdk`, or a test double. */
export interface PromptSource {
  prompt(name: string): Prompt;
}

/** A deployed template converted to a LangChain f-string. */
export interface FStringTemplate {
  template: string;
  inputVariables: string[];
}

/** Convert a deployed template (`{{name}}`) to a LangChain f-string (`{name}`), escaping every literal brace. */
export function toFString(text: string): FStringTemplate {
  const inputVariables = templateVariables(text);
  if (!inputVariables.length) return { template: escapeBraces(renderTemplate(text, {})), inputVariables };
  let nonce = '';
  do nonce = Math.random().toString(36).slice(2, 10);
  while (text.includes(nonce));
  const mark = (name: string) => `\u0000${nonce}:${name}\u0000`;
  // Rendered by the core SDK with markers as values: identical parsing, `{{{{` already resolved to `{{`.
  const rendered = renderTemplate(text, Object.fromEntries(inputVariables.map((v) => [v, mark(v)])));
  let template = escapeBraces(rendered);
  for (const v of inputVariables) template = template.split(mark(v)).join(`{${v}}`);
  return { template, inputVariables };
}

function escapeBraces(s: string): string {
  return s.replace(/[{}]/g, (c) => c + c);
}

/** Tracing metadata for a deployed prompt: `kyp.prompt.name`, `kyp.prompt.version`, `kyp.prompt.sha256`. */
export function promptMetadata(prompt: Pick<Prompt, 'name' | 'version' | 'sha256'>): Record<string, string | number> {
  return { 'kyp.prompt.name': prompt.name, 'kyp.prompt.version': prompt.version, 'kyp.prompt.sha256': prompt.sha256 };
}

// Conversion is a pure function of the body, so cache it by sha256 (bounded).
const cache = new Map<string, FStringTemplate>();
function converted(p: Prompt): FStringTemplate {
  let c = cache.get(p.sha256);
  if (!c) {
    c = toFString(p.text);
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(p.sha256, c);
  }
  return c;
}

export interface LoadOptions {
  /** Values bound now (LangChain partial variables). */
  partialVariables?: Record<string, string>;
  /** Extra tracing metadata merged with the prompt's. */
  metadata?: Record<string, unknown>;
  /** Tracing tags. */
  tags?: string[];
}

/** A `PromptTemplate` (f-string) for a deployed prompt, with its name, version and sha256 in `metadata`. */
export function loadPromptTemplate(client: PromptSource, name: string, options: LoadOptions = {}): PromptTemplate {
  const p = client.prompt(name);
  const { template, inputVariables } = converted(p);
  const partial = options.partialVariables ?? {};
  const t = new PromptTemplate({
    template,
    templateFormat: 'f-string',
    inputVariables: inputVariables.filter((v) => !(v in partial)),
    partialVariables: partial,
  });
  return tagged(t, p, options);
}

// BasePromptTemplate.metadata / .tags are merged into the run config on every invoke (tracing).
function tagged<T extends PromptTemplate | ChatPromptTemplate>(t: T, p: Prompt, options: LoadOptions): T {
  t.metadata = { ...options.metadata, ...promptMetadata(p) };
  if (options.tags) t.tags = [...options.tags];
  return t;
}

export type Role = 'system' | 'human' | 'ai' | 'user' | 'assistant' | 'placeholder';

/**
 * A `[role, template]` tuple for `ChatPromptTemplate.fromMessages`, built from a deployed prompt. Use it to
 * compose several deployed prompts with your own messages and placeholders.
 */
export function kypMessage(client: PromptSource, role: Exclude<Role, 'placeholder'>, name: string): [string, string] {
  return [role, converted(client.prompt(name)).template];
}

export interface ChatLoadOptions extends LoadOptions {
  /** Role of the deployed prompt's message. Default `system`. */
  role?: Exclude<Role, 'placeholder'>;
  /** Messages after it, in LangChain's usual forms, e.g. `new MessagesPlaceholder('history')`, `['human', '{input}']`. */
  messages?: BaseMessagePromptTemplateLike[];
}

/** A `ChatPromptTemplate`: the deployed prompt as one message (system by default) followed by `messages`. */
export function loadChatPromptTemplate(client: PromptSource, name: string, options: ChatLoadOptions = {}): ChatPromptTemplate {
  const p = client.prompt(name);
  const t = ChatPromptTemplate.fromMessages([[options.role ?? 'system', converted(p).template], ...(options.messages ?? [])], {
    templateFormat: 'f-string',
  });
  if (options.partialVariables) {
    t.partialVariables = { ...t.partialVariables, ...options.partialVariables };
    t.inputVariables = t.inputVariables.filter((v) => !(v in options.partialVariables!));
  }
  return tagged(t, p, options);
}

let defaultClient: PromptSource | undefined;

/** Set the client `pull` and `livePrompt` use when none is passed. */
export function setDefaultClient(client: PromptSource | undefined): void {
  defaultClient = client;
}

export interface PullOptions extends ChatLoadOptions {
  client?: PromptSource;
  /** `false` returns a `PromptTemplate` instead of a `ChatPromptTemplate`. Default `true`. */
  chat?: boolean;
}

function resolveClient(c?: PromptSource): PromptSource {
  const client = c ?? defaultClient;
  if (!client) throw new Error('no Keep Your Prompts client: pass { client } or call setDefaultClient() first');
  return client;
}

/**
 * Hub-like `pull(name)`: the currently deployed version as a `ChatPromptTemplate` (or a `PromptTemplate` with
 * `{ chat: false }`). Synchronous and memory-only, so call it per request to follow deploys.
 */
export function pull(name: string, options: PullOptions & { chat: false }): PromptTemplate;
export function pull(name: string, options?: PullOptions): ChatPromptTemplate;
export function pull(name: string, options: PullOptions = {}): ChatPromptTemplate | PromptTemplate {
  const client = resolveClient(options.client);
  if (options.chat === false) return loadPromptTemplate(client, name, options);
  return loadChatPromptTemplate(client, name, options);
}

/**
 * A runnable that pulls the deployed prompt on every invocation, so a long-lived chain such as
 * `livePrompt('triage').pipe(model)` follows deploys without being rebuilt.
 */
export function livePrompt(name: string, options: PullOptions = {}) {
  return RunnableLambda.from(async (input: InputValues, config?: RunnableConfig) => {
    const template = options.chat === false ? pull(name, { ...options, chat: false }) : pull(name, options);
    return template.invoke(input, config);
  }).withConfig({ runName: `kyp:${name}` });
}
