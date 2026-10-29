'use strict';
const authentication = require('./authentication');
const { addApiKey, handleErrors } = require('./lib/api');
const { triggers } = require('./triggers/hooks');
const findPrompt = require('./searches/findPrompt');
const { renderPrompt, createPrompt, saveVersion } = require('./creates/prompts');
const { deploy, rollback, createCapture } = require('./creates/deploys');

const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));
const { promptSample, ...findPromptSearch } = findPrompt; // eslint-disable-line no-unused-vars

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,

  // Values arrive exactly as entered (D028); each action converts what it needs.
  flags: { cleanInputData: false },

  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [handleErrors],

  triggers: byKey(triggers),
  searches: byKey([findPromptSearch]),
  creates: byKey([renderPrompt, createPrompt, saveVersion, deploy, rollback, createCapture]),
};
