'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyWebhook, signPayload } = require('../dist/nodes/shared/signature.js');
const { vectors } = require('./helpers');

const v = vectors();

for (const c of v.cases) {
	test(`shared vector: ${c.name}`, () => {
		const result = verifyWebhook(c.secret, c.headers, c.body, c.now, v.toleranceSeconds);
		assert.equal(result.valid, c.valid, JSON.stringify(result));
		// The raw body may also arrive as a Buffer (n8n's req.rawBody).
		assert.equal(verifyWebhook(c.secret, c.headers, Buffer.from(c.body, 'utf8'), c.now).valid, c.valid);
	});
}

test('signPayload reproduces the specification signature', () => {
	const c = v.cases[0];
	assert.equal(signPayload(c.secret, c.headers['webhook-id'], c.headers['webhook-timestamp'], c.body), c.expectedSignature);
});

test('header names are case-insensitive', () => {
	const c = v.cases[0];
	const upper = Object.fromEntries(Object.entries(c.headers).map(([k, val]) => [k.toUpperCase(), val]));
	assert.equal(verifyWebhook(c.secret, upper, c.body, c.now).valid, true);
});
