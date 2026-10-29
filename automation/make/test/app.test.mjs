import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, APP_DIR } from '../scripts/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const events = readJson(join(repo, 'automation/test-vectors/events.json')).events;
const vectors = readJson(join(repo, 'automation/test-vectors/standard-webhooks.json'));
const conformance = readJson(join(repo, 'conformance/cases.json'));
const manifest = readJson(join(APP_DIR, 'makecomapp.json'));

/** Loads a custom IML function the way Make runs it: a plain script defining `function <name>()`, with Buffer. */
function loadFunction(name) {
	const meta = manifest.components.function[name];
	const context = vm.createContext({ Buffer });
	vm.runInContext(readFileSync(join(APP_DIR, meta.codeFiles.code), 'utf8'), context);
	return { fn: context[name], context, meta };
}

test('the app definition passes every static check', () => {
	assert.deepEqual(validate(APP_DIR, { events }), []);
});

test('the checks catch broken definitions', () => {
	const dir = mkdtempSync(join(tmpdir(), 'kyp-make-'));
	try {
		cpSync(APP_DIR, dir, { recursive: true });
		const edit = (rel, fn) => {
			const p = join(dir, rel);
			writeFileSync(p, JSON.stringify(fn(readJson(p)), null, 4));
		};
		edit('modules/search-prompts/search-prompts.mappable-params.iml.json', (p) => [...p, { name: 'x', type: 'strnig', label: 'X' }]);
		edit('modules/get-prompt/get-prompt.communication.iml.json', (c) => ({ ...c, url: 'https://evil.example.com/{{parameters.nope}}' }));
		edit('modules/render-prompt/render-prompt.communication.iml.json', (c) => [c[0], { ...c[1], response: { output: '{{kypMissing(body)}}' } }]);
		edit('general/base.iml.json', (b) => ({ ...b, log: {} }));
		writeFileSync(join(dir, 'stray.json'), '{');
		const errors = validate(dir, { events: events.slice(1) }).join('\n');
		for (const expected of [
			'unknown type "strnig"',
			'URL must be relative',
			'parameters.nope, which is not declared',
			'unknown IML function kypMissing()',
			'must sanitize request.headers.authorization',
			'stray.json: invalid JSON',
			'events must be',
		]) assert.match(errors, new RegExp(expected.replace(/[().*]/g, '\\$&')), expected);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const name of Object.keys(manifest.components.function)) {
	test(`custom IML function ${name}: its Make test file passes`, () => {
		const { context, meta } = loadFunction(name);
		const results = [];
		context.assert = assert;
		context.it = (title, fn) => {
			fn();
			results.push(title);
		};
		vm.runInContext(readFileSync(join(APP_DIR, meta.codeFiles.test), 'utf8'), context);
		assert.ok(results.length > 0);
	});
}

test('kypVerifyWebhook passes the shared Standard Webhooks vectors', () => {
	const { fn } = loadFunction('kypVerifyWebhook');
	for (const c of vectors.cases) {
		assert.equal(fn(c.secret, c.headers, c.body, c.now), c.valid, c.name);
		// Make hands the webhook a parsed body; Keep Your Prompts signs JSON.stringify output, which re-serializes exactly.
		if (c.reserializable) assert.equal(fn(c.secret, c.headers, JSON.parse(c.body), c.now), c.valid, `${c.name} (parsed body)`);
	}
});

test('kypVerifyWebhook matches node:crypto on random inputs (pure-JS SHA-256 and HMAC)', async () => {
	const { createHmac, randomBytes } = await import('node:crypto');
	const { fn } = loadFunction('kypVerifyWebhook');
	for (let n = 0; n < 200; n++) {
		const key = randomBytes(1 + (n % 90)); // includes keys longer than the 64-byte block
		const secret = `whsec_${key.toString('base64')}`;
		const body = randomBytes(n * 7).toString('base64') + 'é日本';
		const id = `msg_${n}`;
		const ts = 1700000000 + n;
		const sig = `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
		assert.equal(fn(secret, { 'Webhook-Id': id, 'Webhook-Timestamp': String(ts), 'Webhook-Signature': sig }, body, ts), true, `case ${n}`);
	}
});

test('kypRender follows conformance/cases.json', () => {
	const { fn } = loadFunction('kypRender');
	for (const c of conformance.render) {
		if (c.error) assert.throws(() => fn(c.template, c.vars), new RegExp(`\\{\\{${c.variable}\\}\\}`));
		else assert.equal(fn(c.template, c.vars, c.lenient ? 'keep' : 'error'), c.out, JSON.stringify(c.template));
	}
});
