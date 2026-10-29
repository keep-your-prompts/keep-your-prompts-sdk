'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KeepYourPrompts } = require('../dist/nodes/KeepYourPrompts/KeepYourPrompts.node.js');
const { KeepYourPromptsApi } = require('../dist/credentials/KeepYourPromptsApi.credentials.js');
const { fakeContext, httpError } = require('./helpers');

const node = new KeepYourPrompts();
const run = (ctx) => node.execute.call(ctx);
const asset = { id: 'ast_7Hq2Lm9Pw4Xr1Tz8Kd3Bn6V', slug: 'support-triage', name: 'Support triage', currentVersion: 4, body: 'Hi {{company}}' };

test('credential sends the key as a Bearer token and tests GET /v1/me', () => {
	const cred = new KeepYourPromptsApi();
	assert.equal(cred.name, 'keepYourPromptsApi');
	assert.equal(cred.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
	assert.equal(cred.test.request.url, '/v1/me');
	assert.equal(cred.properties.find((p) => p.name === 'baseUrl').default, 'https://api.keepyourprompts.com');
});

test('prompt search returns one item per result', async () => {
	const ctx = fakeContext({
		params: { resource: 'prompt', operation: 'search', query: 'triage', scope: 'mine', limit: 5 },
		routes: { 'GET /v1/search': { data: [{ asset, score: 0.9, snippet: 'Hi' }, { asset: { id: 'ast_2' }, score: 0.5 }] } },
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 2);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
	assert.equal(ctx.calls[0].baseURL, 'https://api.example.test');
	assert.deepEqual(ctx.calls[0].qs, { q: 'triage', scope: 'mine', limit: 5 });
	assert.equal(ctx.calls[0].credentialType, 'keepYourPromptsApi');
});

test('prompt get by slug, and at a given version', async () => {
	const routes = {
		'GET /v1/assets/support-triage': asset,
		'GET /v1/assets/ast_7Hq2Lm9Pw4Xr1Tz8Kd3Bn6V/versions/2': { version: 2, body: 'old', sha256: 'abc' },
	};
	let [out] = await run(fakeContext({ params: { resource: 'prompt', operation: 'get', promptId: 'support-triage', version: 0 }, routes }));
	assert.equal(out[0].json.body, 'Hi {{company}}');
	[out] = await run(fakeContext({ params: { resource: 'prompt', operation: 'get', promptId: 'support-triage', version: 2 }, routes }));
	assert.equal(out[0].json.body, 'old');
	assert.equal(out[0].json.version, 2);
	assert.equal(out[0].json.currentVersion, 4);
});

test('prompt render resolves the slug, compiles includes and fills variables', async () => {
	const ctx = fakeContext({
		params: {
			resource: 'prompt', operation: 'render', promptId: 'support-triage', version: 3, onMissing: 'error',
			variables: { variable: [{ name: 'company', value: 'Acme' }, { name: 'queue', value: 'refunds' }] },
		},
		routes: {
			'GET /v1/assets/support-triage': asset,
			'GET /v1/assets/ast_7Hq2Lm9Pw4Xr1Tz8Kd3Bn6V/compiled': (o) => {
				assert.deepEqual(o.qs, { version: 3 });
				return { version: 3, body: 'You work for {{ company }}; send refunds to {{queue}}. {{{{literal}}', variables: ['company', 'queue'] };
			},
		},
	});
	const [out] = await run(ctx);
	assert.equal(out[0].json.rendered, 'You work for Acme; send refunds to refunds. {{literal}}');
	assert.equal(out[0].json.version, 3);
	assert.deepEqual(out[0].json.variables, ['company', 'queue']);
});

test('prompt render fails with the missing variable names, or keeps them when asked', async () => {
	const routes = { 'GET /v1/assets/ast_1/compiled': { version: 1, body: '{{a}} {{b}}', variables: ['a', 'b'] } };
	const params = { resource: 'prompt', operation: 'render', promptId: 'ast_1', version: 0, variables: { variable: [{ name: 'a', value: '1' }] } };
	await assert.rejects(run(fakeContext({ params: { ...params, onMissing: 'error' }, routes })), (e) => e.constructor.name === 'NodeOperationError' && /\{\{b\}\}/.test(e.message));
	const [out] = await run(fakeContext({ params: { ...params, onMissing: 'keep' }, routes }));
	assert.equal(out[0].json.rendered, '1 {{b}}');
});

test('prompt create sends kind, slug and split tags', async () => {
	const ctx = fakeContext({
		params: { resource: 'prompt', operation: 'create', name: 'Support triage', body: 'Hi', createFields: { kind: 'system_prompt', slug: 'support-triage', tags: 'support, triage,', message: 'first' } },
		routes: { 'POST /v1/assets': (o) => ({ id: 'ast_new', ...o.body, currentVersion: 1 }) },
	});
	const [out] = await run(ctx);
	assert.deepEqual(ctx.calls[0].body, { name: 'Support triage', body: 'Hi', kind: 'system_prompt', slug: 'support-triage', message: 'first', tags: ['support', 'triage'] });
	assert.equal(out[0].json.id, 'ast_new');
});

test('save version patches the asset with the base version', async () => {
	const ctx = fakeContext({
		params: { resource: 'prompt', operation: 'saveVersion', promptId: 'support-triage', body: 'New body', versionFields: { message: 'tighter', baseVersion: 4 } },
		routes: { 'GET /v1/assets/support-triage': asset, 'PATCH /v1/assets/ast_7Hq2Lm9Pw4Xr1Tz8Kd3Bn6V': (o) => ({ ...asset, currentVersion: 5, sent: o.body }) },
	});
	const [out] = await run(ctx);
	assert.deepEqual(ctx.calls[1].body, { body: 'New body', message: 'tighter', baseVersion: 4 });
	assert.equal(out[0].json.currentVersion, 5);
});

test('a version conflict surfaces as an API error', async () => {
	const ctx = fakeContext({
		params: { resource: 'prompt', operation: 'saveVersion', promptId: 'ast_1', body: 'x', versionFields: { baseVersion: 1 } },
		routes: { 'PATCH /v1/assets/ast_1': httpError(409, 'version-conflict') },
	});
	await assert.rejects(run(ctx), (e) => e.constructor.name === 'NodeApiError');
});

test('deploy resolves prompt slugs and omits version 0', async () => {
	const ctx = fakeContext({
		params: {
			resource: 'deployment', operation: 'deploy', app: 'support-bot', env: 'prod', message: 'Ship v4',
			prompts: { prompt: [{ name: 'triage', promptId: 'support-triage', version: 4 }, { name: 'escalation', promptId: 'ast_9', version: 0 }] },
		},
		routes: { 'GET /v1/assets/support-triage': asset, 'POST /v1/apps/support-bot/deploy': { status: 'live', revision: 19 } },
	});
	const [out] = await run(ctx);
	assert.deepEqual(ctx.calls.at(-1).body, {
		env: 'prod',
		prompts: [{ name: 'triage', assetId: asset.id, version: 4 }, { name: 'escalation', assetId: 'ast_9' }],
		message: 'Ship v4',
	});
	assert.equal(out[0].json.revision, 19);
});

test('rollback posts the target revision', async () => {
	const ctx = fakeContext({
		params: { resource: 'deployment', operation: 'rollback', app: 'support-bot', env: 'prod', toRevision: 17 },
		routes: { 'POST /v1/apps/support-bot/rollback': { revision: 20, toRevision: 17 } },
	});
	const [out] = await run(ctx);
	assert.deepEqual(ctx.calls[0].body, { env: 'prod', toRevision: 17 });
	assert.equal(out[0].json.revision, 20);
});

test('capture create sends source api', async () => {
	const ctx = fakeContext({
		params: { resource: 'capture', operation: 'create', text: 'Summarize this', captureFields: { conversationUrl: 'https://claude.ai/chat/1' } },
		routes: { 'POST /v1/captures': { id: 'cap_1' } },
	});
	const [out] = await run(ctx);
	assert.deepEqual(ctx.calls[0].body, { text: 'Summarize this', source: 'api', conversationUrl: 'https://claude.ai/chat/1' });
	assert.equal(out[0].json.id, 'cap_1');
});

test('continue on fail returns the error per item', async () => {
	const ctx = fakeContext({
		continueOnFail: true,
		items: [{ json: {} }, { json: {} }],
		params: { resource: 'capture', operation: 'create', text: 'x', captureFields: {} },
		routes: { 'POST /v1/captures': httpError(429, 'quota-exceeded') },
	});
	const [out] = await run(ctx);
	assert.equal(out.length, 2);
	assert.equal(out[1].json.error, 'quota-exceeded');
	assert.deepEqual(out[1].pairedItem, { item: 1 });
});
