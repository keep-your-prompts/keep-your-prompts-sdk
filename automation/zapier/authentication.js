'use strict';
const { api } = require('./lib/api');

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      helpText:
        'A workspace API key (`kyp_live_…`) from [Settings › API keys](https://app.keepyourprompts.com/settings/api-keys). ' +
        'Use an **editor** key created by an owner or admin: instant triggers register webhooks and actions save and deploy prompts. A viewer key can only find and render prompts.',
    },
  ],
  test: { url: api('/v1/me') },
  connectionLabel: '{{workspace.name}}',
};
