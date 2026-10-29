'use strict';
// The webhook event catalogue (payload version 1): a copy of automation/test-vectors/events.json, checked by the
// tests. The live catalogue is GET /v1/webhooks/event-types.
const { events } = require('./events.json');

const byType = Object.fromEntries(events.map((e) => [e.type, e]));

module.exports = { events, byType, TEST_EVENT: 'webhook.test' };
