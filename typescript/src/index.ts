// Keep Your Prompts TypeScript SDK. This code is under the repository's LICENSE.
//
//   import { Client } from '@keepyourprompts/sdk';
//   const prompts = await Client.fromEnv();            // KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
//   const system = prompts.render('triage', { company: 'Acme' });
//
// Implements the prompt delivery protocol v1: interchangeable mirrors with one layout,
// a manifest plus content-addressed blobs verified with SHA-256, ETag revalidation,
// a background refresher and an atomic in-memory swap. Reads never do I/O.
export {
  Client,
  type ClientOptions,
  type EmbeddedSnapshot,
  type LogLevel,
  type Logger,
  type MirrorConfig,
  type MirrorStatus,
  type Prompt,
  type Status,
  type Update,
} from './client.js';
export { KypError, MissingVariableError, NotFoundError, ProtocolError, UnavailableError } from './errors.js';
export { isSlug, parseManifest, type Manifest, type ManifestPrompt } from './manifest.js';
export type { OutcomeKind, OutcomeReport } from './outcomes.js';
export { sha256Hex } from './sha256.js';
export { pullSnapshot, snapshotModuleSource, writeSnapshotFolder, type PullOptions } from './snapshot.js';
export {
  renderTemplate,
  templateVariables,
  type OnMissing,
  type RenderOptions,
  type TemplateValue,
  type Vars,
} from './template.js';
export { VERSION } from './version.js';
