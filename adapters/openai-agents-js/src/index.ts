// Keep Your Prompts for the OpenAI Agents SDK (JavaScript). This code is under the repository's LICENSE.
//
//   import { Agent, run } from '@openai/agents';
//   import { kypInstructions } from '@keepyourprompts/openai-agents';
//
//   const agent = new Agent({ name: 'Triage', instructions: kypInstructions(prompts, 'triage') });
//   await run(agent, 'My invoice is wrong.', { context: { company: 'Acme' } });
//
// `instructions` is a function the SDK calls at the start of every run (and every turn), so each run renders the
// version deployed at that moment: deploys apply without restarting or rebuilding the agent. Rendering reads the
// client's memory only and is the core SDK's (strict: a missing variable throws MissingVariableError).
import type { Prompt, RenderOptions, Vars } from '@keepyourprompts/sdk';
import type { Agent, AgentOutputType, RunContext } from '@openai/agents-core';

/** Anything with `prompt(name)`: a `Client` from `@keepyourprompts/sdk`, or a test double. */
export interface PromptSource {
  prompt(name: string): Prompt;
}

export interface PromptMetadata {
  name: string;
  version: number;
  sha256: string;
}

/** `{ name, version, sha256 }` of a prompt. */
export function promptMetadata(prompt: Pick<Prompt, 'name' | 'version' | 'sha256'>): PromptMetadata {
  return { name: prompt.name, version: prompt.version, sha256: prompt.sha256 };
}

/** Flat span attributes: `kyp.prompt.name`, `kyp.prompt.version`, `kyp.prompt.sha256`. */
export function promptAttributes(prompt: Pick<Prompt, 'name' | 'version' | 'sha256'>): Record<string, string | number> {
  return { 'kyp.prompt.name': prompt.name, 'kyp.prompt.version': prompt.version, 'kyp.prompt.sha256': prompt.sha256 };
}

/** Variables for a run: fixed values, or a function of the run context and the agent. */
export type VarsResolver<TContext> =
  | Vars
  | ((runContext: RunContext<TContext>, agent: Agent<TContext, any>) => Vars | Promise<Vars>);

/** Passed to `onRender` each time instructions are rendered. */
export interface RenderEvent<TContext> extends PromptMetadata {
  agent: string;
  runContext: RunContext<TContext>;
}

export interface InstructionsOptions<TContext> extends RenderOptions {
  /**
   * Where the template's variables come from. Default: the run's `context` when it is a plain object (so
   * `run(agent, input, { context: { company: 'Acme' } })` fills `{{company}}`), otherwise none.
   */
  vars?: VarsResolver<TContext>;
  /** Called after every render with the prompt's name, version and sha256, e.g. to add them to a span or log. */
  onRender?: (event: RenderEvent<TContext>) => void;
}

/** The dynamic-instructions function type of `Agent` in `@openai/agents`. */
export type InstructionsFunction<TContext, TOutput extends AgentOutputType = AgentOutputType> = (
  runContext: RunContext<TContext>,
  agent: Agent<TContext, TOutput>,
) => Promise<string>;

function contextVars(context: unknown): Vars {
  if (context && typeof context === 'object' && !Array.isArray(context)) return context as Vars;
  return {};
}

const META = Symbol.for('keepyourprompts.prompt');

/**
 * Dynamic `instructions` for an `Agent`: renders the deployed prompt `name` on every run. The function carries
 * the prompt name; `lastRendered(fn)` returns the metadata of the version it rendered most recently.
 */
export function kypInstructions<TContext = unknown, TOutput extends AgentOutputType = AgentOutputType>(
  client: PromptSource,
  name: string,
  options: InstructionsOptions<TContext> = {},
): InstructionsFunction<TContext, TOutput> {
  const { vars, onRender, ...render } = options;
  const fn = async (runContext: RunContext<TContext>, agent: Agent<TContext, TOutput>): Promise<string> => {
    const p = client.prompt(name);
    const values =
      vars === undefined ? contextVars(runContext?.context) : typeof vars === 'function' ? await vars(runContext, agent) : vars;
    const text = p.render(values, render);
    const meta = promptMetadata(p);
    (fn as unknown as Record<symbol, PromptMetadata>)[META] = meta;
    onRender?.({ ...meta, agent: agent?.name ?? '', runContext });
    return text;
  };
  Object.defineProperty(fn, 'kypPrompt', { value: name, enumerable: true });
  return fn;
}

/** Metadata of the version an instructions function from `kypInstructions` rendered last, if any. */
export function lastRendered(instructions: unknown): PromptMetadata | undefined {
  if (typeof instructions !== 'function') return undefined;
  return (instructions as unknown as Record<symbol, PromptMetadata | undefined>)[META];
}

/**
 * Static text from a deployed prompt (strict, like `client.render`), e.g. a handoff description:
 * `new Agent({ handoffDescription: kypText(prompts, 'agents/billing/handoff') })`. Read once, at construction.
 */
export function kypText(client: PromptSource, name: string, vars?: Vars, options?: RenderOptions): string {
  return client.prompt(name).render(vars, options);
}
