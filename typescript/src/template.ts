// {{name}} rendering. No logic, loops or escaping: prompts are plain text.
import { MissingVariableError } from './errors.js';

/** Values accepted by `render`. Numbers and booleans are converted with `String()`. */
export type TemplateValue = string | number | boolean | bigint;
export type Vars = Readonly<Record<string, TemplateValue | null | undefined>>;

/** What to do with a `{{variable}}` that has no value. */
export type OnMissing = 'error' | 'keep' | 'empty';

export interface RenderOptions {
  /** `true` (default): a missing variable throws `MissingVariableError`. `false`: it is left as `{{name}}`. */
  strict?: boolean;
  /** Finer control than `strict`: `error`, `keep` (leave `{{name}}`) or `empty` (replace with ""). */
  onMissing?: OnMissing;
}

const isStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
const isIdent = (c: number) => isStart(c) || (c >= 48 && c <= 57);
const isSpace = (c: number) => c === 32 || c === 9;

type Piece = string | { name: string; raw: string };

// Splits a template into literal text and variables. "{{{{" is a literal "{{";
// anything that is not a well-formed {{ name }} stays as text.
function scan(t: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  let run = 0;
  for (;;) {
    const open = t.indexOf('{{', i);
    if (open < 0) break;
    if (t.startsWith('{{{{', open)) {
      out.push(t.slice(run, open), '{{');
      i = run = open + 4;
      continue;
    }
    let j = open + 2;
    while (j < t.length && isSpace(t.charCodeAt(j))) j++;
    if (j < t.length && isStart(t.charCodeAt(j))) {
      const start = j;
      while (j < t.length && isIdent(t.charCodeAt(j))) j++;
      const name = t.slice(start, j);
      while (j < t.length && isSpace(t.charCodeAt(j))) j++;
      if (t.startsWith('}}', j)) {
        out.push(t.slice(run, open), { name, raw: t.slice(open, j + 2) });
        i = run = j + 2;
        continue;
      }
    }
    i = open + 2; // not a variable: keep the braces as text
  }
  out.push(t.slice(run));
  return out;
}

function resolveMode(opts?: RenderOptions | boolean): OnMissing {
  if (typeof opts === 'boolean') return opts ? 'error' : 'keep';
  if (opts?.onMissing) return opts.onMissing;
  return opts?.strict === false ? 'keep' : 'error';
}

/**
 * Render a template: `{{name}}` (spaces inside the braces allowed) is replaced by `vars[name]`,
 * `{{{{` renders a literal `{{`. Values are inserted as-is and never rendered again.
 * A missing variable throws `MissingVariableError` (listing every missing name) unless
 * `{ strict: false }` (keep it) or `{ onMissing: 'empty' }`.
 */
export function renderTemplate(template: string, vars: Vars = {}, options?: RenderOptions | boolean): string {
  const mode = resolveMode(options);
  let out = '';
  const missing: string[] = [];
  for (const p of scan(template)) {
    if (typeof p === 'string') {
      out += p;
      continue;
    }
    const v = Object.prototype.hasOwnProperty.call(vars, p.name) ? vars[p.name] : undefined;
    if (v !== undefined && v !== null) out += String(v);
    else if (mode === 'keep') out += p.raw;
    else if (mode === 'error' && !missing.includes(p.name)) missing.push(p.name);
  }
  if (missing.length) throw new MissingVariableError(missing);
  return out;
}

/** Distinct variable names in order of first appearance. */
export function templateVariables(template: string): string[] {
  const names: string[] = [];
  for (const p of scan(template)) if (typeof p !== 'string' && !names.includes(p.name)) names.push(p.name);
  return names;
}
