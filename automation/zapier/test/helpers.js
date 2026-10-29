'use strict';
const fs = require('fs');
const path = require('path');
const { createHmac } = require('crypto');

const root = path.join(__dirname, '..', '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

const API = 'https://api.keepyourprompts.com';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const sign = (secret, id, ts, body) =>
  'v1,' + createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');

/** A REST-hook bundle as Zapier builds it: headers renamed `Http-Webhook-Id` etc., raw body in rawRequest.content. */
function hookBundle(payload, { secret = SECRET, ts = Math.floor(Date.now() / 1000), inputData = {}, tamper } = {}) {
  const content = JSON.stringify(payload);
  const signature = sign(secret, payload.id, ts, content);
  return {
    authData: { apiKey: 'kyp_live_test' },
    inputData,
    subscribeData: { id: 'whk_1', secret: SECRET },
    rawRequest: {
      method: 'POST',
      querystring: '',
      headers: {
        'Content-Type': 'application/json',
        'Http-Webhook-Id': payload.id,
        'Http-Webhook-Timestamp': String(ts),
        'Http-Webhook-Signature': signature,
      },
      content: tamper ? tamper(content) : content,
    },
    cleanedRequest: { ...payload, querystring: {} },
  };
}

module.exports = {
  API,
  SECRET,
  sign,
  hookBundle,
  vectors: () => readJson('automation/test-vectors/standard-webhooks.json'),
  events: () => readJson('automation/test-vectors/events.json'),
  conformance: () => readJson('conformance/cases.json'),
};
