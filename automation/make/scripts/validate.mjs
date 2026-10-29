#!/usr/bin/env node
// Static checks for the Make custom app in ../src (the local-development layout of Make's VS Code extension,
// "Make Apps Editor"). No dependencies: run `node scripts/validate.mjs` (exit code 1 on errors).
//
// What it checks: every file is valid JSON (or JS for custom IML functions), makecomapp.json has the shape of the
// extension's makecomapp.schema.json and points at existing files (and every file is referenced), parameters and
// interfaces use valid Make types, communication objects use known directives, IML `{{…}}` expressions are balanced
// and only reference parameters the component declares, custom IML functions exist, modules are grouped, samples
// match interfaces, the base sanitizes the API key, the universal module uses a relative URL, and the webhook offers
// exactly the documented event types.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// From the extension's syntaxes/imljson/schemas/parameters.json (`type` enum).
export const PARAMETER_TYPES = new Set([
	'any', 'array', 'boolean', 'buffer', 'cert', 'collection', 'color', 'date', 'email', 'filename', 'folder', 'file',
	'filter', 'hidden', 'json', 'integer', 'uinteger', 'number', 'password', 'path', 'pkey', 'port', 'select', 'text',
	'time', 'timestamp', 'timezone', 'url', 'uuid', 'banner', 'udt', 'section',
]);
// From syntaxes/imljson/schemas/api.json (request and response properties).
const REQUEST_KEYS = new Set([
	'url', 'endpoint', 'input', 'encodeUrl', 'method', 'headers', 'qs', 'ca', 'body', 'type', 'temp', 'condition', 'gzip',
	'aws', 'followRedirects', 'followAllRedirects', 'log', 'oauth', 'pagination', 'output', 'iterate', 'respond',
	'verification', 'repeat', 'response',
]);
const RESPONSE_KEYS = new Set([
	'type', 'valid', 'limit', 'error', 'iterate', 'temp', 'output', 'trigger', 'data', 'metadata', 'uid', 'oauth',
	'wrapper', 'expires',
]);
const BASE_KEYS = new Set([
	'url', 'baseUrl', 'encodeUrl', 'method', 'headers', 'qs', 'ca', 'body', 'timeout', 'type', 'temp', 'condition', 'aws',
	'followRedirects', 'followAllRedirects', 'log', 'oauth', 'pagination', 'response',
]);
const MODULE_TYPES = new Set(['action', 'instant_trigger', 'responder', 'search', 'trigger', 'universal']);
const COMPONENT_TYPES = ['connection', 'endpoint', 'function', 'module', 'rpc', 'webhook'];
const PARAM_CODES = new Set(['params', 'staticParams', 'mappableParams', 'interface']);
const COMMUNICATION_CODES = new Set(['communication', 'attach', 'detach', 'update']);
// Built-in IML functions used by this app (https://developers.make.com/custom-apps-documentation/block-elements/iml).
const BUILTIN_IML = new Set(['if', 'ifempty', 'length', 'encodeURL', 'toCollection', 'map', 'get', 'merge', 'omit', 'formatDate', 'parseNumber']);

const here = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = join(here, '..', 'src');

function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

/** Every `{{ … }}` expression in a JSON value (strings and object keys), with balance errors. */
function imlExpressions(value, where, errors, out = []) {
	const visit = (s) => {
		let depth = 0;
		let start = -1;
		for (let i = 0; i < s.length; i++) {
			if (s.startsWith('{{', i)) {
				if (depth === 0) start = i + 2;
				depth++;
				i++;
			} else if (s.startsWith('}}', i) && depth > 0) {
				depth--;
				if (depth === 0) out.push(s.slice(start, i));
				i++;
			}
		}
		if (depth !== 0) errors.push(`${where}: unbalanced {{ }} in ${JSON.stringify(s)}`);
	};
	if (typeof value === 'string') visit(value);
	else if (Array.isArray(value)) value.forEach((v) => imlExpressions(v, where, errors, out));
	else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) {
			visit(k);
			imlExpressions(v, where, errors, out);
		}
	}
	return out;
}

function checkParameters(list, where, errors, { needLabel = true, needName = true } = {}) {
	if (!Array.isArray(list)) {
		errors.push(`${where}: must be an array`);
		return;
	}
	for (const p of list) {
		if (typeof p === 'string') continue; // reference to an RPC or a shared definition
		if (!p || typeof p !== 'object') {
			errors.push(`${where}: parameter must be an object`);
			continue;
		}
		if (needName && !p.name) errors.push(`${where}: parameter without a name`);
		if (!PARAMETER_TYPES.has(p.type)) errors.push(`${where}: ${p.name}: unknown type ${JSON.stringify(p.type)}`);
		if (needLabel && !p.label) errors.push(`${where}: ${p.name}: missing label`);
		if (p.type === 'select' && !(Array.isArray(p.options) && p.options.every((o) => o && 'value' in o)) && typeof p.options !== 'string') {
			errors.push(`${where}: ${p.name}: select needs options with values`);
		}
		// `spec` is a list of fields (collection, or array of collections) or one unnamed item type (array of values).
		if (Array.isArray(p.spec)) checkParameters(p.spec, `${where} › ${p.name}`, errors, { needLabel: false });
		else if (p.spec !== undefined) checkParameters([p.spec], `${where} › ${p.name}`, errors, { needLabel: false, needName: false });
	}
}

function checkCommunication(value, where, errors, { relativeUrls = true } = {}) {
	const requests = Array.isArray(value) ? value : [value];
	for (const r of requests) {
		if (!r || typeof r !== 'object') {
			errors.push(`${where}: request must be an object`);
			continue;
		}
		for (const k of Object.keys(r)) if (!REQUEST_KEYS.has(k)) errors.push(`${where}: unknown directive "${k}"`);
		if (r.response) for (const k of Object.keys(r.response)) if (!RESPONSE_KEYS.has(k)) errors.push(`${where}: unknown response directive "${k}"`);
		if (typeof r.url === 'string') {
			if (relativeUrls && !r.url.startsWith('/')) errors.push(`${where}: URL must be relative to the base: ${r.url}`);
			if (!relativeUrls && !r.url.startsWith('https://')) errors.push(`${where}: URL must be https: ${r.url}`);
		}
	}
}

/** Top-level parameter names a component declares. */
const declared = (lists) => new Set(lists.flat().filter((p) => p && typeof p === 'object').map((p) => p.name));

export function validate(appDir = APP_DIR, { events } = {}) {
	const errors = [];
	const files = walk(appDir).map((p) => relative(appDir, p).split('\\').join('/'));
	const json = {};
	for (const f of files) {
		if (!f.endsWith('.json')) continue;
		try {
			json[f] = JSON.parse(readFileSync(join(appDir, f), 'utf8'));
		} catch (e) {
			errors.push(`${f}: invalid JSON (${e.message})`);
		}
	}
	const manifest = json['makecomapp.json'];
	if (!manifest) return [...errors, 'makecomapp.json is missing'];

	for (const k of ['fileVersion', 'generalCodeFiles', 'components', 'origins']) if (!(k in manifest)) errors.push(`makecomapp.json: missing "${k}"`);
	if (typeof manifest.fileVersion !== 'number') errors.push('makecomapp.json: fileVersion must be a number');
	if (!Array.isArray(manifest.origins)) errors.push('makecomapp.json: origins must be an array');
	for (const o of manifest.origins || []) {
		for (const k of ['apikeyFile', 'appId', 'appVersion', 'baseUrl']) if (!(k in o)) errors.push(`makecomapp.json: origin missing "${k}"`);
		if (o.appId && /FILL/.test(o.appId)) errors.push('makecomapp.json: origin has a -FILL-ME- placeholder');
	}
	for (const k of ['base', 'common', 'groups', 'readme']) if (!(k in (manifest.generalCodeFiles || {}))) errors.push(`makecomapp.json: generalCodeFiles missing "${k}"`);
	for (const t of COMPONENT_TYPES) if (!manifest.components || !(t in manifest.components)) errors.push(`makecomapp.json: components missing "${t}"`);

	const referenced = new Set(['makecomapp.json']);
	const ref = (path, where) => {
		if (path === null) return;
		if (typeof path !== 'string') return errors.push(`${where}: path must be a string or null`);
		referenced.add(path);
		if (!existsSync(join(appDir, path))) errors.push(`${where}: ${path} does not exist`);
	};
	for (const [k, p] of Object.entries(manifest.generalCodeFiles || {})) ref(p, `generalCodeFiles.${k}`);

	const comps = manifest.components || {};
	const functionNames = new Set(Object.keys(comps.function || {}));
	for (const t of COMPONENT_TYPES) {
		for (const [name, meta] of Object.entries(comps[t] || {})) {
			const where = `${t} ${name}`;
			if (!meta || !meta.codeFiles) {
				errors.push(`${where}: missing codeFiles`);
				continue;
			}
			for (const [code, p] of Object.entries(meta.codeFiles)) ref(p, `${where}.${code}`);
			if (t === 'module') {
				if (!MODULE_TYPES.has(meta.moduleType)) errors.push(`${where}: invalid moduleType ${meta.moduleType}`);
				if (!meta.label || !meta.description) errors.push(`${where}: needs a label and a description`);
				if (meta.moduleType === 'instant_trigger' && !(comps.webhook || {})[meta.webhook]) errors.push(`${where}: instant trigger must reference a webhook`);
			}
			if (t === 'webhook' && !['web', 'web-shared'].includes(meta.webhookType)) errors.push(`${where}: invalid webhookType`);
			if (t === 'connection' && !['basic', 'oauth'].includes(meta.connectionType)) errors.push(`${where}: invalid connectionType`);
			for (const k of ['connection', 'altConnection']) {
				if (meta[k] && !(comps.connection || {})[meta[k]]) errors.push(`${where}: ${k} ${meta[k]} does not exist`);
			}
			if (t === 'function') {
				const code = meta.codeFiles.code && existsSync(join(appDir, meta.codeFiles.code)) ? readFileSync(join(appDir, meta.codeFiles.code), 'utf8') : '';
				if (!new RegExp(`^function ${name}\\(`, 'm').test(code)) errors.push(`${where}: code must define function ${name}()`);
				if (code.length > 5000) errors.push(`${where}: code is ${code.length} characters (Make allows 5000)`);
			}

			// Per-code checks.
			const get = (code) => (meta.codeFiles[code] ? json[meta.codeFiles[code]] : undefined);
			for (const code of Object.keys(meta.codeFiles)) {
				const value = get(code);
				if (value === undefined) continue;
				const w = `${where}.${code}`;
				if (PARAM_CODES.has(code)) checkParameters(value, w, errors);
				if (COMMUNICATION_CODES.has(code)) {
					const isWebhookPayload = t === 'webhook' && code === 'communication';
					if (!isWebhookPayload) checkCommunication(value, w, errors, { relativeUrls: t !== 'connection' });
					else for (const k of Object.keys(value)) if (!['verification', 'respond', 'iterate', 'output', 'condition', 'uid'].includes(k)) errors.push(`${w}: unknown webhook directive "${k}"`);
				}
				// IML: balanced, custom functions exist, parameters.X declared.
				const exprs = imlExpressions(value, w, errors);
				const params = declared([get('params') || [], get('staticParams') || [], get('mappableParams') || []].map((x) => (Array.isArray(x) ? x : [])));
				for (const e of exprs) {
					for (const m of e.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
						if (!BUILTIN_IML.has(m[1]) && !functionNames.has(m[1])) errors.push(`${w}: unknown IML function ${m[1]}() in {{${e}}}`);
					}
					if (code !== 'samples') {
						for (const m of e.matchAll(/\bparameters\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
							if (!params.has(m[1])) errors.push(`${w}: {{${e}}} uses parameters.${m[1]}, which is not declared`);
						}
					}
				}
			}
			if (t === 'module') {
				const iface = get('interface');
				const samples = get('samples');
				if (Array.isArray(iface) && samples && typeof samples === 'object') {
					const names = new Set(iface.map((p) => p.name));
					for (const k of Object.keys(samples)) if (!names.has(k)) errors.push(`${where}: sample key "${k}" is not in the interface`);
				}
				if (meta.moduleType === 'search' && !declared([get('mappableParams') || []]).has('limit')) errors.push(`${where}: search modules need a limit parameter`);
				if (meta.moduleType === 'universal') {
					const c = get('communication');
					if (!c || typeof c.url !== 'string' || !c.url.startsWith('/')) errors.push(`${where}: universal module must use a relative URL`);
				}
			}
		}
	}

	// Base: https, API key sanitized, known keys.
	const base = json[manifest.generalCodeFiles && manifest.generalCodeFiles.base];
	if (base) {
		for (const k of Object.keys(base)) if (!BASE_KEYS.has(k)) errors.push(`base: unknown directive "${k}"`);
		if (!/^https:\/\//.test(base.baseUrl || '')) errors.push('base: baseUrl must be https');
		if (!(base.log && (base.log.sanitize || []).includes('request.headers.authorization'))) errors.push('base: must sanitize request.headers.authorization');
		if (!(base.response && base.response.error)) errors.push('base: needs error handling');
		imlExpressions(base, 'base', errors);
	}
	for (const [name, meta] of Object.entries(comps.connection || {})) {
		const c = json[meta.codeFiles.communication];
		if (c && !(c.log && (c.log.sanitize || []).includes('request.headers.authorization'))) errors.push(`connection ${name}: must sanitize request.headers.authorization`);
		if (c && !(c.response && c.response.error)) errors.push(`connection ${name}: needs error handling`);
	}

	// Groups: every visible module once, only existing modules.
	const groups = json[manifest.generalCodeFiles && manifest.generalCodeFiles.groups];
	if (groups) {
		const grouped = groups.flatMap((g) => g.modules || []);
		for (const m of grouped) if (!(comps.module || {})[m]) errors.push(`groups: unknown module ${m}`);
		for (const m of Object.keys(comps.module || {})) if (!grouped.includes(m)) errors.push(`groups: module ${m} is in no group`);
	}

	// Webhook events: exactly the documented catalogue (plus "*").
	if (events) {
		for (const [name, meta] of Object.entries(comps.webhook || {})) {
			const params = json[meta.codeFiles.params] || [];
			const ev = params.find((p) => p.name === 'events');
			const values = ev ? ev.options.map((o) => o.value) : [];
			const expected = ['*', ...events.map((e) => e.type)];
			if (JSON.stringify(values) !== JSON.stringify(expected)) errors.push(`webhook ${name}: events must be ${expected.join(', ')}`);
		}
	}

	for (const f of files) if (!referenced.has(f)) errors.push(`${f}: not referenced from makecomapp.json`);
	return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const eventsPath = join(here, '..', '..', 'test-vectors', 'events.json');
	const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')).events : undefined;
	const errors = validate(APP_DIR, { events });
	for (const e of errors) console.error(`error: ${e}`);
	console.log(errors.length ? `${errors.length} problem(s)` : 'Make app definition: OK');
	process.exit(errors.length ? 1 : 0);
}
