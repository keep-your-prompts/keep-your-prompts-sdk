'use strict';
// {{name}} rendering with the same rules as the Keep Your Prompts SDKs (protocol/README.md, "Templates"):
// `{{name}}` with optional spaces inside the braces, `{{{{` is a literal `{{`, no logic or escaping.

const isStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
const isIdent = (c) => isStart(c) || (c >= 48 && c <= 57);
const isSpace = (c) => c === 32 || c === 9;

function scan(t) {
  const out = [];
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
    i = open + 2;
  }
  out.push(t.slice(run));
  return out;
}

class MissingVariablesError extends Error {
  constructor(missing) {
    super(`Missing value for ${missing.map((m) => `{{${m}}}`).join(', ')}`);
    this.name = 'MissingVariablesError';
    this.missing = missing;
  }
}

/** onMissing: 'error' (default), 'keep' (leave {{name}}) or 'empty'. */
function renderTemplate(template, vars = {}, onMissing = 'error') {
  let out = '';
  const missing = [];
  for (const p of scan(template)) {
    if (typeof p === 'string') {
      out += p;
      continue;
    }
    const v = Object.prototype.hasOwnProperty.call(vars, p.name) ? vars[p.name] : undefined;
    if (v !== undefined && v !== null) out += String(v);
    else if (onMissing === 'keep') out += p.raw;
    else if (onMissing === 'error' && !missing.includes(p.name)) missing.push(p.name);
  }
  if (missing.length) throw new MissingVariablesError(missing);
  return out;
}

function templateVariables(template) {
  const names = [];
  for (const p of scan(template)) if (typeof p !== 'string' && !names.includes(p.name)) names.push(p.name);
  return names;
}

module.exports = { renderTemplate, templateVariables, MissingVariablesError };
