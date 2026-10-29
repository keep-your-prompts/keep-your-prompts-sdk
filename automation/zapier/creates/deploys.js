'use strict';
const { api, resolveAssetId } = require('../lib/api');

const deploy = {
  key: 'deploy',
  noun: 'Deploy',
  display: {
    label: 'Deploy Prompts',
    description: 'Points an app environment at prompt versions (environments with approvals wait for approvers).',
  },
  operation: {
    inputFields: [
      { key: 'app', label: 'App', required: true, helpText: 'The app’s slug, for example `support-bot`.' },
      { key: 'env', label: 'Environment', required: true, default: 'prod' },
      {
        key: 'prompts',
        label: 'Prompts',
        required: true,
        children: [
          { key: 'name', label: 'Name in the App', required: true, helpText: 'The name your code reads the prompt by.' },
          { key: 'prompt', label: 'Prompt', required: true, helpText: 'The slug or ID of the prompt.' },
          { key: 'version', label: 'Version', type: 'integer', helpText: 'Leave empty for the current version.' },
        ],
      },
      { key: 'message', label: 'Message', helpText: 'A note for the deploy history.' },
    ],
    perform: async (z, bundle) => {
      const rows = [].concat(bundle.inputData.prompts || []).filter((r) => r && r.name && r.prompt);
      if (!rows.length) throw new z.errors.Error('Add at least one prompt to deploy.', 'invalid_input', 400);
      const prompts = [];
      for (const row of rows) {
        const entry = { name: String(row.name).trim(), assetId: await resolveAssetId(z, row.prompt) };
        if (row.version) entry.version = Number(row.version);
        prompts.push(entry);
      }
      const body = { env: bundle.inputData.env, prompts };
      if (bundle.inputData.message) body.message = bundle.inputData.message;
      const response = await z.request({
        url: api(`/v1/apps/${encodeURIComponent(bundle.inputData.app)}/deploy`),
        method: 'POST',
        body,
      });
      return response.data;
    },
    sample: { status: 'live', revision: 18, publishedAt: '2026-10-29T10:00:00.000Z' },
  },
};

const rollback = {
  key: 'rollback',
  noun: 'Rollback',
  display: { label: 'Roll Back Environment', description: 'Brings an app environment back to an earlier revision.' },
  operation: {
    inputFields: [
      { key: 'app', label: 'App', required: true },
      { key: 'env', label: 'Environment', required: true, default: 'prod' },
      { key: 'to_revision', label: 'To Revision', required: true, type: 'integer' },
    ],
    perform: async (z, bundle) => {
      const toRevision = Number(bundle.inputData.to_revision);
      const response = await z.request({
        url: api(`/v1/apps/${encodeURIComponent(bundle.inputData.app)}/rollback`),
        method: 'POST',
        body: { env: bundle.inputData.env, toRevision },
      });
      return response.data && typeof response.data === 'object'
        ? response.data
        : { app: bundle.inputData.app, env: bundle.inputData.env, toRevision };
    },
    sample: { revision: 19, toRevision: 17 },
  },
};

const createCapture = {
  key: 'create_capture',
  noun: 'Capture',
  display: { label: 'Capture Prompt', description: 'Saves text to your inbox, to review and promote to a prompt later.' },
  operation: {
    inputFields: [
      { key: 'text', label: 'Text', required: true, type: 'text' },
      { key: 'conversation_url', label: 'Conversation URL', helpText: 'Where the prompt came from (optional).' },
    ],
    perform: async (z, bundle) => {
      const body = { text: bundle.inputData.text, source: 'api' };
      if (bundle.inputData.conversation_url) body.conversationUrl = bundle.inputData.conversation_url;
      const response = await z.request({ url: api('/v1/captures'), method: 'POST', body });
      return response.data;
    },
    sample: { id: 'cap_1Rk7Hb3Nd5CTz9Wm2Lq8Px4' },
  },
};

module.exports = { deploy, rollback, createCapture };
