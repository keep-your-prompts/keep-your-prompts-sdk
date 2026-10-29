// A small reader for the YAML front matter Claude Code uses in agent and skill files:
//
//   ---
//   description: Reviews diffs
//   tools: Read, Grep          (or [Read, Grep], or a "- Read" block list)
//   model: sonnet
//   ---
//   body
//
// Only `key: value` pairs, inline or block lists and quoted strings: enough for agent and skill
// definitions, without a YAML dependency. Anything it does not understand is kept as a string.

export type FrontMatterValue = string | string[];

export interface Parsed {
  /** Keys in the order they appear; empty when the text has no front matter. */
  data: Record<string, FrontMatterValue>;
  /** The text after the front matter (all of it when there is none). */
  body: string;
  /** Whether the text started with a front matter block. */
  hasFrontMatter: boolean;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return t;
}

export function parseFrontMatter(text: string): Parsed {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: text, hasFrontMatter: false };
  const data: Record<string, FrontMatterValue> = {};
  let listKey = '';
  for (const raw of m[1]!.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s*(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const cur = data[listKey];
      data[listKey] = [...(Array.isArray(cur) ? cur : []), unquote(item[1]!)];
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    listKey = '';
    if (value === '') {
      listKey = key;
      data[key] = [];
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map(unquote)
        .filter((s) => s.length > 0);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, body: src.slice(m[0].length), hasFrontMatter: true };
}

/** A string list from `[a, b]`, a block list, or a comma-separated string (`tools: Read, Grep`). */
export function asList(v: FrontMatterValue | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function asString(v: FrontMatterValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}
