/* globals describe, it, expect, beforeEach, afterEach */
'use strict';
const nock = require('nock');
const zapier = require('zapier-platform-core');
const App = require('../index');
const { API, SECRET, hookBundle, events } = require('./helpers');

const appTester = zapier.createAppTester(App);
const auth = { authData: { apiKey: 'kyp_live_test' } };
const example = (type) => events().events.find((e) => e.type === type).example;
const asset = { id: 'ast_7Hq2Lm9Pw4Xr1Tz8Kd3Bn6V', slug: 'support-triage', name: 'Support triage', currentVersion: 4 };

beforeEach(() => nock.disableNetConnect());
afterEach(() => {
  expect(nock.pendingMocks()).toEqual([]);
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('authentication', () => {
  it('tests the key with GET /v1/me as a Bearer token', async () => {
    nock(API, { reqheaders: { authorization: 'Bearer kyp_live_test' } })
      .get('/v1/me')
      .reply(200, { user: { email: 'ava@acme.dev' }, workspace: { name: 'Acme' } });
    const res = await appTester(App.authentication.test, auth);
    expect(res.workspace.name).toBe('Acme');
  });

  it('explains a rejected key', async () => {
    nock(API).get('/v1/me').reply(401, { type: 'unauthorized', title: 'Unauthorized', status: 401, detail: 'Invalid API key.' });
    await expect(appTester(App.authentication.test, auth)).rejects.toThrow(/Invalid API key\. Check the API key/);
  });
});

describe('REST hook triggers', () => {
  const trigger = App.triggers.deploy_completed;

  it('subscribe creates a zapier-sourced endpoint for the event and keeps the secret', async () => {
    nock(API)
      .post('/v1/webhooks', { url: 'https://hooks.zapier.com/hooks/standard/1/abc', events: ['deploy.completed'], description: 'Zapier: Ship alerts', source: 'zapier' })
      .reply(201, { id: 'whk_1', url: 'https://hooks.zapier.com/hooks/standard/1/abc', events: ['deploy.completed'], source: 'zapier', secret: SECRET });
    const res = await appTester(trigger.operation.performSubscribe, {
      ...auth,
      targetUrl: 'https://hooks.zapier.com/hooks/standard/1/abc',
      meta: { zap: { id: 1, name: 'Ship alerts' } },
    });
    expect(res).toMatchObject({ id: 'whk_1', secret: SECRET });
  });

  it('the any-event trigger subscribes to the chosen events', async () => {
    nock(API)
      .post('/v1/webhooks', (b) => JSON.stringify(b.events) === JSON.stringify(['prompt.created', 'capture.created']) && b.source === 'zapier')
      .reply(201, { id: 'whk_2', secret: SECRET });
    await appTester(App.triggers.any_event.operation.performSubscribe, {
      ...auth,
      targetUrl: 'https://hooks.zapier.com/x',
      inputData: { events: ['prompt.created', 'capture.created'] },
    });
  });

  it('unsubscribe deletes the endpoint and tolerates one already gone', async () => {
    nock(API).delete('/v1/webhooks/whk_1').reply(204);
    await expect(appTester(trigger.operation.performUnsubscribe, { ...auth, subscribeData: { id: 'whk_1' } })).resolves.toEqual({ id: 'whk_1', deleted: true });
    nock(API).delete('/v1/webhooks/whk_1').reply(404, { title: 'Not found' });
    await expect(appTester(trigger.operation.performUnsubscribe, { ...auth, subscribeData: { id: 'whk_1' } })).resolves.toEqual({ id: 'whk_1', deleted: true });
  });

  it('perform returns a delivery whose signature verifies', async () => {
    const payload = example('deploy.completed');
    const res = await appTester(trigger.operation.perform, hookBundle(payload));
    expect(res).toEqual([payload]);
  });

  it('perform drops a tampered body, a wrong secret or a stale timestamp', async () => {
    const payload = example('deploy.completed');
    const bundles = [
      hookBundle(payload, { tamper: (c) => c.replace('Ship', 'Skip') }),
      hookBundle(payload, { secret: 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD' }),
      hookBundle(payload, { ts: Math.floor(Date.now() / 1000) - 600 }),
    ];
    for (const bundle of bundles) expect(await appTester(trigger.operation.perform, bundle)).toEqual([]);
  });

  it('perform verifies the re-serialized body when Zapier gives no raw content', async () => {
    const payload = example('deploy.completed');
    const bundle = hookBundle(payload);
    delete bundle.rawRequest.content;
    expect(await appTester(trigger.operation.perform, bundle)).toEqual([payload]);
  });

  it('perform keeps only this trigger’s event type', async () => {
    const res = await appTester(trigger.operation.perform, hookBundle(example('prompt.created')));
    expect(res).toEqual([]);
  });

  it('the any-event trigger passes test events', async () => {
    const payload = { ...example('prompt.created'), type: 'webhook.test', test: true };
    const res = await appTester(App.triggers.any_event.operation.perform, hookBundle(payload, { inputData: { events: ['deploy.completed'] } }));
    expect(res).toEqual([payload]);
  });

  it('performList returns the live example as a sample envelope', async () => {
    nock(API)
      .get('/v1/webhooks/event-types')
      .reply(200, { version: 1, groups: {}, data: [{ type: 'deploy.completed', label: 'Deploy completed', example: example('deploy.completed').data }] });
    const [sample] = await appTester(trigger.operation.performList, auth);
    expect(sample).toMatchObject({ type: 'deploy.completed', version: 1, test: true, data: example('deploy.completed').data });
    expect(sample.id).toMatch(/^msg_sample_/);
  });

  it('every event has its own trigger with a sample that has an id', () => {
    for (const e of events().events) {
      const t = App.triggers[e.type.replace('.', '_')];
      expect(t.operation.type).toBe('hook');
      expect(t.operation.sample.id).toBeTruthy();
      expect(t.display.description).toMatch(/^Triggers when /);
    }
  });
});

describe('find prompt', () => {
  const op = App.searches.find_prompt.operation;

  it('finds by slug, and returns nothing on 404', async () => {
    nock(API).get('/v1/assets/support-triage').reply(200, { ...asset, body: 'Hi' });
    expect(await appTester(op.perform, { ...auth, inputData: { prompt: 'support-triage' } })).toEqual([{ ...asset, body: 'Hi' }]);
    nock(API).get('/v1/assets/nope').reply(404, { title: 'Not found' });
    expect(await appTester(op.perform, { ...auth, inputData: { prompt: 'nope' } })).toEqual([]);
  });

  it('searches by text', async () => {
    nock(API).get('/v1/search').query({ q: 'triage', scope: 'mine', limit: '10' }).reply(200, { data: [{ asset, score: 0.8, snippet: 'Hi' }] });
    expect(await appTester(op.perform, { ...auth, inputData: { query: 'triage' } })).toEqual([{ ...asset, score: 0.8, snippet: 'Hi' }]);
  });
});

describe('creates', () => {
  it('render prompt resolves the slug, compiles and fills variables', async () => {
    nock(API).get('/v1/assets/support-triage').reply(200, asset);
    nock(API).get(`/v1/assets/${asset.id}/compiled`).query({ version: '3' }).reply(200, { version: 3, body: 'Hi {{ company }}, {{{{x}}', variables: ['company'] });
    const res = await appTester(App.creates.render_prompt.operation.perform, {
      ...auth,
      inputData: { prompt: 'support-triage', version: '3', variables: { company: 'Acme' } },
    });
    expect(res).toEqual({ promptId: asset.id, version: 3, rendered: 'Hi Acme, {{x}}', variables: ['company'] });
  });

  it('render prompt reports missing variables', async () => {
    nock(API).get('/v1/assets/ast_1/compiled').reply(200, { version: 1, body: '{{a}}', variables: ['a'] });
    await expect(appTester(App.creates.render_prompt.operation.perform, { ...auth, inputData: { prompt: 'ast_1' } })).rejects.toThrow(/\{\{a\}\}/);
  });

  it('create prompt', async () => {
    nock(API)
      .post('/v1/assets', { name: 'Support triage', body: 'Hi', kind: 'prompt', slug: 'support-triage', tags: ['a', 'b'] })
      .reply(201, { ...asset, currentVersion: 1 });
    const res = await appTester(App.creates.create_prompt.operation.perform, {
      ...auth,
      inputData: { name: 'Support triage', body: 'Hi', slug: 'support-triage', tags: ['a', 'b, '] },
    });
    expect(res.currentVersion).toBe(1);
  });

  it('save version sends the base version, and a conflict is an error', async () => {
    nock(API).patch(`/v1/assets/${asset.id}`, { body: 'New', message: 'm', baseVersion: 4 }).reply(200, { ...asset, currentVersion: 5 });
    const res = await appTester(App.creates.save_version.operation.perform, { ...auth, inputData: { prompt: asset.id, body: 'New', message: 'm', base_version: '4' } });
    expect(res.currentVersion).toBe(5);
    nock(API).patch(`/v1/assets/${asset.id}`).reply(409, { type: 'version-conflict', title: 'Conflict', detail: 'Version 6 is current.', currentVersion: 6 });
    await expect(appTester(App.creates.save_version.operation.perform, { ...auth, inputData: { prompt: asset.id, body: 'x', base_version: '4' } })).rejects.toThrow(/Version 6 is current/);
  });

  it('deploy resolves slugs from line items', async () => {
    nock(API).get('/v1/assets/support-triage').reply(200, asset);
    nock(API)
      .post('/v1/apps/support-bot/deploy', { env: 'prod', prompts: [{ name: 'triage', assetId: asset.id, version: 4 }, { name: 'faq', assetId: 'ast_9' }], message: 'Ship' })
      .reply(201, { status: 'live', revision: 19 });
    const res = await appTester(App.creates.deploy.operation.perform, {
      ...auth,
      inputData: { app: 'support-bot', env: 'prod', message: 'Ship', prompts: [{ name: 'triage', prompt: 'support-triage', version: '4' }, { name: 'faq', prompt: 'ast_9' }] },
    });
    expect(res.revision).toBe(19);
  });

  it('rollback', async () => {
    nock(API).post('/v1/apps/support-bot/rollback', { env: 'prod', toRevision: 17 }).reply(200, { revision: 20, toRevision: 17 });
    const res = await appTester(App.creates.rollback.operation.perform, { ...auth, inputData: { app: 'support-bot', env: 'prod', to_revision: '17' } });
    expect(res.revision).toBe(20);
  });

  it('capture', async () => {
    nock(API).post('/v1/captures', { text: 'Summarize', source: 'api', conversationUrl: 'https://claude.ai/chat/1' }).reply(201, { id: 'cap_1' });
    const res = await appTester(App.creates.create_capture.operation.perform, { ...auth, inputData: { text: 'Summarize', conversation_url: 'https://claude.ai/chat/1' } });
    expect(res.id).toBe('cap_1');
  });

  it('a rate limit becomes a throttled error that honours Retry-After', async () => {
    nock(API).post('/v1/captures').reply(429, { title: 'Too many requests' }, { 'Retry-After': '30' });
    await expect(appTester(App.creates.create_capture.operation.perform, { ...auth, inputData: { text: 'x' } })).rejects.toThrow(/"delay":30/);
  });
});

describe('app definition', () => {
  it('passes the Zapier schema', () => {
    const schema = require('zapier-platform-core/src/tools/schema');
    expect(schema.validateApp(schema.prepareApp(App))).toEqual([]);
  });
});
