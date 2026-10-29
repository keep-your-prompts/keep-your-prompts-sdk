// Keep Your Prompts for the Vercel AI SDK. This code is under the repository's LICENSE.
//
//   import { generateText, wrapLanguageModel } from 'ai';
//   import { kypInstructions, kypMiddleware } from '@keepyourprompts/ai-sdk';
//
//   const { text } = await generateText({
//     model: wrapLanguageModel({ model, middleware: kypMiddleware() }),
//     instructions: kypInstructions(prompts, 'triage', { company: 'Acme' }),
//     prompt: 'My invoice is wrong.',
//   });
//
// Every helper reads the client's memory only (no I/O) and renders with the core SDK, so a
// missing variable throws MissingVariableError exactly like `client.render`.
import type { Prompt, RenderOptions, Vars } from '@keepyourprompts/sdk';
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
} from '@ai-sdk/provider';

/** Anything with `prompt(name)`: a `Client` from `@keepyourprompts/sdk`, or a test double. */
export interface PromptSource {
  prompt(name: string): Prompt;
}

/** Which deployed prompt produced a message. */
export interface PromptMetadata {
  name: string;
  version: number;
  sha256: string;
}

/** The key used in `providerOptions` (on messages) and `providerMetadata` (on results). */
export const PROVIDER_KEY = 'kyp';

/** Metadata of a prompt, for your own spans or logs. */
export function promptMetadata(prompt: Prompt): PromptMetadata {
  return { name: prompt.name, version: prompt.version, sha256: prompt.sha256 };
}

/** The same metadata as flat attributes (`kyp.prompt.name`, `kyp.prompt.version`, `kyp.prompt.sha256`). */
export function promptAttributes(prompt: Prompt | PromptMetadata): Record<string, string | number> {
  return { 'kyp.prompt.name': prompt.name, 'kyp.prompt.version': prompt.version, 'kyp.prompt.sha256': prompt.sha256 };
}

type ProviderOptions = SharedV4ProviderOptions;

/** A system message as the AI SDK accepts it in `instructions`, `system` or `messages`. */
export interface KypSystemMessage {
  role: 'system';
  content: string;
  providerOptions: ProviderOptions;
}

/** A user or assistant message rendered from a deployed prompt. */
export interface KypTextMessage {
  role: 'user' | 'assistant';
  content: string;
  providerOptions: ProviderOptions;
}

function tag(prompt: Prompt, extra?: ProviderOptions): ProviderOptions {
  return { ...extra, [PROVIDER_KEY]: { ...promptMetadata(prompt) } };
}

/**
 * Render a deployed prompt as a system message for `instructions` (or `system`) of `generateText`,
 * `streamText`, `generateObject` or a `ToolLoopAgent`. The message carries the prompt's name, version
 * and sha256 in `providerOptions.kyp`, which `kypMiddleware()` reads (and strips) to tag the call.
 */
export function kypInstructions(
  client: PromptSource,
  name: string,
  vars?: Vars,
  options?: RenderOptions & { providerOptions?: ProviderOptions },
): KypSystemMessage {
  const p = client.prompt(name);
  return { role: 'system', content: p.render(vars, options), providerOptions: tag(p, options?.providerOptions) };
}

/** The rendered text only, for places that take a plain string. Not tagged. */
export function kypSystem(client: PromptSource, name: string, vars?: Vars, options?: RenderOptions): string {
  return client.prompt(name).render(vars, options);
}

/**
 * One entry of `kypMessages`: a deployed prompt rendered as a message with this role. AI SDK 7 rejects
 * system messages inside `messages` unless `allowSystemInMessages: true`; put the system prompt in
 * `instructions` (`kypInstructions`) instead.
 */
export interface MessageSpec {
  role: 'system' | 'user' | 'assistant';
  prompt: string;
  vars?: Vars;
  /** Render options for this message; defaults to strict. */
  options?: RenderOptions;
}

/**
 * Render several deployed prompts as `messages` (for example a user template and a few-shot assistant
 * turn). Each message is tagged like `kypInstructions`.
 */
export function kypMessages(client: PromptSource, specs: readonly MessageSpec[]): Array<KypSystemMessage | KypTextMessage> {
  return specs.map((s) => {
    const p = client.prompt(s.prompt);
    return { role: s.role, content: p.render(s.vars, s.options), providerOptions: tag(p) } as KypSystemMessage | KypTextMessage;
  });
}

/** What `kypMiddleware` reports for each model call. */
export interface KypCall {
  type: 'generate' | 'stream';
  /** Deployed prompts found in the call's messages, in message order. */
  prompts: PromptMetadata[];
}

export interface KypMiddlewareOptions {
  /** Called once per model call that used at least one deployed prompt (before the provider is called). */
  onCall?: (call: KypCall) => void;
  /**
   * Remove `providerOptions.kyp` from messages before the provider sees them. Default `true`; providers
   * ignore unknown keys, but there is no reason to send them.
   */
  strip?: boolean;
}

function isMetadata(v: unknown): v is PromptMetadata {
  const m = v as PromptMetadata | undefined;
  return !!m && typeof m.name === 'string' && typeof m.version === 'number' && typeof m.sha256 === 'string';
}

function extract(params: LanguageModelV4CallOptions, strip: boolean): { params: LanguageModelV4CallOptions; prompts: PromptMetadata[] } {
  const prompts: PromptMetadata[] = [];
  let changed = false;
  const prompt = params.prompt.map((msg) => {
    const opts = msg.providerOptions as ProviderOptions | undefined;
    const meta = opts?.[PROVIDER_KEY];
    if (!opts || !isMetadata(meta)) return msg;
    prompts.push({ name: meta.name, version: meta.version, sha256: meta.sha256 });
    if (!strip) return msg;
    changed = true;
    const { [PROVIDER_KEY]: _drop, ...rest } = opts;
    const copy = { ...msg } as typeof msg;
    if (Object.keys(rest).length) copy.providerOptions = rest as typeof msg.providerOptions;
    else delete copy.providerOptions;
    return copy;
  });
  return { params: changed ? { ...params, prompt } : params, prompts };
}

function withKyp(meta: SharedV4ProviderMetadata | undefined, prompts: PromptMetadata[]): SharedV4ProviderMetadata {
  return {
    ...meta,
    [PROVIDER_KEY]: {
      prompts: prompts.map((p) => ({ ...p })),
      // The first deployed prompt (usually the system prompt), flat, for dashboards that cannot read arrays.
      name: prompts[0]!.name,
      version: prompts[0]!.version,
      sha256: prompts[0]!.sha256,
    },
  } as SharedV4ProviderMetadata;
}

/**
 * Language model middleware that finds messages rendered by `kypInstructions` / `kypMessages`, strips
 * the tag from what the provider receives, and adds `providerMetadata.kyp` (`{ name, version, sha256,
 * prompts[] }`) to the result: `result.providerMetadata.kyp` for `generateText`, the `finish` part for
 * `streamText`. The AI SDK's OpenTelemetry integration records provider metadata on its spans when created with
 * `providerMetadata: true`. Use with `wrapLanguageModel({ model, middleware: kypMiddleware() })`.
 */
export function kypMiddleware(options: KypMiddlewareOptions = {}): LanguageModelV4Middleware {
  const strip = options.strip !== false;
  const found = new WeakMap<LanguageModelV4CallOptions, PromptMetadata[]>();
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params, type }) => {
      const { params: out, prompts } = extract(params, strip);
      if (prompts.length) {
        found.set(out, prompts);
        options.onCall?.({ type, prompts });
      }
      return out;
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      const prompts = found.get(params);
      if (!prompts) return result;
      return { ...result, providerMetadata: withKyp(result.providerMetadata, prompts) };
    },
    wrapStream: async ({ doStream, params }) => {
      const result = await doStream();
      const prompts = found.get(params);
      if (!prompts) return result;
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === 'finish') controller.enqueue({ ...part, providerMetadata: withKyp(part.providerMetadata, prompts) });
            else controller.enqueue(part);
          },
        }),
      );
      return { ...result, stream };
    },
  };
}
