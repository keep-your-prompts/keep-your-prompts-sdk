'use strict';
const { api, resolveAssetId } = require('../lib/api');
const { renderTemplate, MissingVariablesError } = require('../lib/template');
const { promptSample } = require('../searches/findPrompt');

const KINDS = {
  prompt: 'Prompt',
  system_prompt: 'System prompt',
  skill: 'Skill',
  agent: 'Agent',
  snippet: 'Snippet',
  instruction: 'Instruction',
  mcp_config: 'MCP config',
  test_set: 'Test set',
};

const splitTags = (value) =>
  [].concat(value || []).flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean);

const renderPrompt = {
  key: 'render_prompt',
  noun: 'Prompt',
  display: {
    label: 'Render Prompt',
    description: 'Fills in a prompt’s {{variables}} and returns the finished text (includes are compiled first).',
  },
  operation: {
    inputFields: [
      { key: 'prompt', label: 'Prompt', required: true, helpText: 'The slug or ID of the prompt.' },
      { key: 'version', label: 'Version', type: 'integer', helpText: 'Leave empty for the current version.' },
      { key: 'variables', label: 'Variables', dict: true, helpText: 'Variable name (without braces) and its value.' },
      {
        key: 'on_missing',
        label: 'If a Variable Is Missing',
        choices: { error: 'Stop with an error', keep: 'Keep the {{placeholder}}', empty: 'Leave it empty' },
        default: 'error',
      },
    ],
    perform: async (z, bundle) => {
      const id = await resolveAssetId(z, bundle.inputData.prompt);
      const params = bundle.inputData.version ? { version: bundle.inputData.version } : {};
      const response = await z.request({ url: api(`/v1/assets/${encodeURIComponent(id)}/compiled`), params });
      const compiled = response.data;
      try {
        return {
          promptId: id,
          version: compiled.version,
          rendered: renderTemplate(compiled.body, bundle.inputData.variables || {}, bundle.inputData.on_missing || 'error'),
          variables: compiled.variables || [],
        };
      } catch (e) {
        if (e instanceof MissingVariablesError) throw new z.errors.Error(e.message, 'missing_variable', 400);
        throw e;
      }
    },
    sample: { promptId: promptSample.id, version: 4, rendered: 'You triage support tickets for Acme.', variables: ['company'] },
    outputFields: [{ key: 'rendered', label: 'Rendered Text' }, { key: 'version', label: 'Version', type: 'integer' }],
  },
};

const createPrompt = {
  key: 'create_prompt',
  noun: 'Prompt',
  display: { label: 'Create Prompt', description: 'Creates a prompt (or skill, agent, snippet…) at version 1.' },
  operation: {
    inputFields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'body', label: 'Body', required: true, type: 'text', helpText: 'The prompt text. Write variables as {{name}}.' },
      { key: 'kind', label: 'Kind', choices: KINDS, default: 'prompt' },
      { key: 'slug', label: 'Slug', helpText: 'Handle used by deploys and includes; derived from the name when empty.' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'tags', label: 'Tags', list: true },
      { key: 'message', label: 'Version Message', helpText: 'A note for the version history.' },
    ],
    perform: async (z, bundle) => {
      const d = bundle.inputData;
      const body = { name: d.name, body: d.body, kind: d.kind || 'prompt' };
      for (const k of ['slug', 'description', 'message']) if (d[k]) body[k] = d[k];
      const tags = splitTags(d.tags);
      if (tags.length) body.tags = tags;
      const response = await z.request({ url: api('/v1/assets'), method: 'POST', body });
      return response.data;
    },
    sample: { ...promptSample, currentVersion: 1 },
  },
};

const saveVersion = {
  key: 'save_version',
  noun: 'Version',
  display: { label: 'Save Prompt Version', description: 'Saves a new body as the next version of a prompt.' },
  operation: {
    inputFields: [
      { key: 'prompt', label: 'Prompt', required: true, helpText: 'The slug or ID of the prompt.' },
      { key: 'body', label: 'Body', required: true, type: 'text' },
      { key: 'message', label: 'Version Message' },
      {
        key: 'base_version',
        label: 'Based On Version',
        type: 'integer',
        helpText: 'The version this edit started from. If the prompt has changed since, the step fails instead of overwriting.',
      },
    ],
    perform: async (z, bundle) => {
      const id = await resolveAssetId(z, bundle.inputData.prompt);
      const body = { body: bundle.inputData.body };
      if (bundle.inputData.message) body.message = bundle.inputData.message;
      if (bundle.inputData.base_version) body.baseVersion = Number(bundle.inputData.base_version);
      const response = await z.request({ url: api(`/v1/assets/${encodeURIComponent(id)}`), method: 'PATCH', body });
      return response.data;
    },
    sample: { ...promptSample, currentVersion: 5 },
  },
};

module.exports = { renderPrompt, createPrompt, saveVersion };
