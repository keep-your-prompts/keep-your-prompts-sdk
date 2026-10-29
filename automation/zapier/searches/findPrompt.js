'use strict';
const { api } = require('../lib/api');

const promptSample = {
  id: 'ast_7Hq2Lm9Pw4Xr1Tz8Kd3Bn6V',
  kind: 'prompt',
  name: 'Support triage',
  slug: 'support-triage',
  description: 'Routes support tickets',
  tags: ['support'],
  currentVersion: 4,
  body: 'You triage support tickets for {{company}}.',
  variables: ['company'],
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
};

module.exports = {
  key: 'find_prompt',
  noun: 'Prompt',
  display: {
    label: 'Find Prompt',
    description: 'Finds a prompt by its slug or ID, or by searching your library.',
  },
  operation: {
    inputFields: [
      {
        key: 'prompt',
        label: 'Slug or ID',
        helpText: 'The exact slug (`support-triage`) or ID (`ast_…`). Leave empty to search by text instead.',
      },
      { key: 'query', label: 'Search Text', helpText: 'Words or meaning to look for (used when Slug or ID is empty).' },
      {
        key: 'scope',
        label: 'Search In',
        choices: { mine: 'My workspace', all: 'Workspace and public library', public: 'Public library' },
        default: 'mine',
      },
    ],
    perform: async (z, bundle) => {
      const { prompt, query, scope } = bundle.inputData;
      if (prompt) {
        const response = await z.request({
          url: api(`/v1/assets/${encodeURIComponent(String(prompt).trim())}`),
          skipThrowForStatus: true,
        });
        if (response.status === 404) return [];
        response.throwForStatus();
        return [response.data];
      }
      if (!query) throw new z.errors.Error('Enter a slug, an ID or some search text.', 'invalid_input', 400);
      const response = await z.request({ url: api('/v1/search'), params: { q: query, scope: scope || 'mine', limit: 10 } });
      return ((response.data && response.data.data) || []).map((r) => ({
        ...r.asset,
        score: r.score,
        snippet: r.snippet,
      }));
    },
    sample: promptSample,
    outputFields: [
      { key: 'id', label: 'ID' },
      { key: 'slug', label: 'Slug' },
      { key: 'name', label: 'Name' },
      { key: 'kind', label: 'Kind' },
      { key: 'currentVersion', label: 'Current Version', type: 'integer' },
      { key: 'body', label: 'Body (current version)' },
    ],
  },
  promptSample,
};
