// Manifest parsing: envs/<app>/<env>.json
import { ProtocolError } from './errors.js';

export interface ManifestPrompt {
  readonly sha256: string;
  readonly version: number;
  /** Declared variables; `[]` when the manifest does not list them. */
  readonly variables: readonly string[];
}

export interface Manifest {
  readonly schema: 1;
  readonly workspace: string;
  readonly app: string;
  readonly env: string;
  readonly revision: number;
  readonly deployedAt: string;
  /** Prompt name to entry. Names may contain `/` (e.g. `agents/reviewer`). */
  readonly prompts: Readonly<Record<string, ManifestPrompt>>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WORKSPACE = /^[A-Za-z0-9._-]{1,128}$/;
const SHA = /^[0-9a-f]{64}$/;

/** `[a-z0-9][a-z0-9-]{0,62}`, the shape of app and env names. */
export const isSlug = (s: string): boolean => SLUG.test(s);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse and validate a manifest (a JSON string or an already-parsed object). Unknown fields are
 * ignored. With `expect`, a manifest for another app/env is rejected. Throws `ProtocolError`.
 */
export function parseManifest(input: string | unknown, expect?: { app?: string; env?: string }): Manifest {
  let j: unknown = input;
  if (typeof input === 'string') {
    try {
      j = JSON.parse(input);
    } catch {
      throw new ProtocolError('manifest is not valid JSON');
    }
  }
  if (!isObj(j)) throw new ProtocolError('manifest is not a JSON object');
  if ('schema' in j && j.schema !== 1) throw new ProtocolError('unsupported manifest schema (this SDK reads schema 1)');
  const str = (k: string, required: boolean): string => {
    const v = j[k];
    if (v === undefined || v === null) {
      if (required) throw new ProtocolError(`manifest is missing "${k}"`);
      return '';
    }
    if (typeof v !== 'string') throw new ProtocolError(`manifest "${k}" must be a string`);
    return v;
  };
  const workspace = str('workspace', true);
  const app = str('app', true);
  const env = str('env', true);
  const deployedAt = str('deployed_at', false);
  if (!WORKSPACE.test(workspace) || workspace === '.' || workspace === '..')
    throw new ProtocolError('manifest workspace is not a valid slug');
  if ((expect?.app !== undefined && app !== expect.app) || (expect?.env !== undefined && env !== expect.env))
    throw new ProtocolError(`manifest is for ${app}/${env}, expected ${expect?.app ?? app}/${expect?.env ?? env}`);
  const revision = j.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)
    throw new ProtocolError('manifest "revision" must be a non-negative integer');
  if (!isObj(j.prompts)) throw new ProtocolError('manifest "prompts" must be an object');

  const prompts: Record<string, ManifestPrompt> = Object.create(null);
  for (const [name, p] of Object.entries(j.prompts)) {
    if (!name || name.startsWith('/') || name.endsWith('/') || name.includes('//'))
      throw new ProtocolError(`invalid prompt name "${name}"`);
    if (!isObj(p)) throw new ProtocolError(`prompt "${name}" must be an object`);
    if (typeof p.sha256 !== 'string') throw new ProtocolError(`prompt "${name}" has no sha256`);
    const sha256 = p.sha256.toLowerCase();
    if (!SHA.test(sha256)) throw new ProtocolError(`prompt "${name}" has an invalid sha256`);
    const version = typeof p.version === 'number' && Number.isSafeInteger(p.version) ? p.version : 0;
    const variables = Array.isArray(p.variables) ? p.variables.filter((v): v is string => typeof v === 'string') : [];
    prompts[name] = Object.freeze({ sha256, version, variables: Object.freeze(variables) });
  }
  return Object.freeze({ schema: 1, workspace, app, env, revision, deployedAt, prompts: Object.freeze(prompts) });
}
