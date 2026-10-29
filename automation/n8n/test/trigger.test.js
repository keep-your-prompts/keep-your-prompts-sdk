'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KeepYourPromptsTrigger } = require('../dist/nodes/KeepYourPromptsTrigger/KeepYourPromptsTrigger.node.js');
const { fakeContext, fakeResponse, httpError, sign, events } = require('./helpers');

const trigger = new KeepYourPromptsTrigger();
const hooks = trigger.webhookMethods.default;
const URL = 'https://n8n.example.com/webhook/abc/webhook';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

test('create registers an n8n-sourced endpoint for the chosen events and keeps the secret', async () => {
	const ctx = fakeContext({
		params: { events: ['prompt.version_saved', 'deploy.completed'] },
		routes: { 'POST /v1/webhooks': (o) => ({ id: 'whk_1', url: o.body.url, events: o.body.events, secret: SECRET }) },
	});
	assert.equal(await hooks.create.call(ctx), true);
	assert.deepEqual(ctx.calls[0].body, { url: URL, events: ['prompt.version_saved', 'deploy.completed'], description: 'n8n: Sync prompts', source: 'n8n' });
	assert.deepEqual(ctx.staticData, { webhookId: 'whk_1', webhookSecret: SECRET, webhookUrl: URL });
});

test('"All events" subscribes with *', async () => {
	const ctx = fakeContext({ params: { events: ['*', 'prompt.created'] }, routes: { 'POST /v1/webhooks': { id: 'whk_2', secret: SECRET } } });
	await hooks.create.call(ctx);
	assert.deepEqual(ctx.calls[0].body.events, ['*']);
});

test('checkExists keeps a live endpoint and forgets a deleted one', async () => {
	let ctx = fakeContext({ staticData: { webhookId: 'whk_1', webhookSecret: SECRET }, routes: { 'GET /v1/webhooks/whk_1': { id: 'whk_1', url: URL } } });
	assert.equal(await hooks.checkExists.call(ctx), true);
	ctx = fakeContext({ staticData: { webhookId: 'whk_1', webhookSecret: SECRET }, routes: { 'GET /v1/webhooks/whk_1': httpError(404) } });
	assert.equal(await hooks.checkExists.call(ctx), false);
	assert.deepEqual(ctx.staticData, {});
});

test('checkExists removes endpoints left for this URL whose secret is unknown', async () => {
	const ctx = fakeContext({
		routes: {
			'GET /v1/webhooks': { data: [{ id: 'whk_old', url: URL }, { id: 'whk_other', url: 'https://elsewhere.example.com' }] },
			'DELETE /v1/webhooks/whk_old': {},
		},
	});
	assert.equal(await hooks.checkExists.call(ctx), false);
	assert.deepEqual(ctx.calls.map((c) => `${c.method} ${c.url}`), ['GET /v1/webhooks', 'DELETE /v1/webhooks/whk_old']);
});

test('delete removes the endpoint (a 404 is fine) and clears the state', async () => {
	let ctx = fakeContext({ staticData: { webhookId: 'whk_1', webhookSecret: SECRET, webhookUrl: URL }, routes: { 'DELETE /v1/webhooks/whk_1': {} } });
	assert.equal(await hooks.delete.call(ctx), true);
	assert.deepEqual(ctx.staticData, {});
	ctx = fakeContext({ staticData: { webhookId: 'whk_1' }, routes: { 'DELETE /v1/webhooks/whk_1': httpError(404) } });
	assert.equal(await hooks.delete.call(ctx), true);
	ctx = fakeContext({ staticData: { webhookId: 'whk_1' }, routes: { 'DELETE /v1/webhooks/whk_1': httpError(500) } });
	await assert.rejects(hooks.delete.call(ctx));
});

function delivery(type, { secret = SECRET, ts = Math.floor(Date.now() / 1000), test: isTest } = {}) {
	const example = events().events.find((e) => e.type === type)?.example ?? { id: 'msg_test', type, timestamp: new Date().toISOString(), version: 1, workspace: { id: 'org_1' }, data: {} };
	const payload = isTest ? { ...example, type, test: true } : example;
	const raw = JSON.stringify(payload);
	const headers = { 'webhook-id': payload.id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(secret, payload.id, ts, raw), 'content-type': 'application/json' };
	return { payload, request: { rawBody: Buffer.from(raw), headers, body: payload } };
}

const hookContext = (request, params = { events: ['deploy.completed'], options: {} }) => {
	const response = fakeResponse();
	const ctx = fakeContext({ params, request, response, staticData: { webhookId: 'whk_1', webhookSecret: SECRET } });
	return { ctx, response };
};

test('a signed delivery for a chosen event starts the workflow with the envelope', async () => {
	const { payload, request } = delivery('deploy.completed');
	const { ctx } = hookContext(request);
	const out = await trigger.webhook.call(ctx);
	assert.deepEqual(out.workflowData[0][0].json, payload);
});

test('a bad signature, a wrong secret or a stale timestamp answers 401', async () => {
	for (const req of [
		(() => { const d = delivery('deploy.completed'); d.request.rawBody = Buffer.from(d.request.rawBody.toString().replace('Ship', 'Skip')); return d.request; })(),
		delivery('deploy.completed', { secret: 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD' }).request,
		delivery('deploy.completed', { ts: Math.floor(Date.now() / 1000) - 600 }).request,
	]) {
		const { ctx, response } = hookContext(req);
		const out = await trigger.webhook.call(ctx);
		assert.deepEqual(out, { noWebhookResponse: true });
		assert.equal(response.statusCode, 401);
	}
});

test('events not chosen are acknowledged but ignored', async () => {
	const { request } = delivery('prompt.created');
	const { ctx } = hookContext(request);
	const out = await trigger.webhook.call(ctx);
	assert.equal(out.workflowData, undefined);
	assert.deepEqual(out.webhookResponse, { received: true, ignored: 'prompt.created' });
});

test('test events pass unless ignored', async () => {
	const { request } = delivery('webhook.test', { test: true });
	let { ctx } = hookContext(request);
	assert.ok((await trigger.webhook.call(ctx)).workflowData);
	({ ctx } = hookContext(request, { events: ['deploy.completed'], options: { ignoreTestEvents: true } }));
	assert.equal((await trigger.webhook.call(ctx)).workflowData, undefined);
});

test('the raw body is read when n8n has not buffered it yet', async () => {
	const { request } = delivery('deploy.completed');
	const raw = request.rawBody;
	delete request.rawBody;
	request.readRawBody = async () => { request.rawBody = raw; };
	const { ctx } = hookContext(request);
	assert.ok((await trigger.webhook.call(ctx)).workflowData);
});
