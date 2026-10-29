'use strict';
// Shared fixtures for the tests. They run against the compiled `dist/` (run `npm run build` first).
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');

const root = path.join(__dirname, '..', '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

exports.vectors = () => readJson('automation/test-vectors/standard-webhooks.json');
exports.events = () => readJson('automation/test-vectors/events.json');
exports.conformance = () => readJson('conformance/cases.json');

exports.sign = (secret, id, ts, body) =>
	'v1,' +
	createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
		.update(`${id}.${ts}.${body}`)
		.digest('base64');

/**
 * A fake n8n context: `params` are the node parameters, `routes` answer API calls by "METHOD /path"
 * (a function receives the request options). Every request is recorded in `calls`.
 */
exports.fakeContext = ({ params = {}, items = [{ json: {} }], routes = {}, continueOnFail = false, staticData = {}, webhookUrl = 'https://n8n.example.com/webhook/abc/webhook', request, response } = {}) => {
	const calls = [];
	const logs = [];
	const ctx = {
		calls,
		logs,
		staticData,
		getInputData: () => items,
		getNodeParameter: (name, _i, fallback) => {
			// Hook and webhook functions call getNodeParameter(name, fallback).
			if (typeof _i !== 'number' && fallback === undefined) fallback = _i;
			return name in params ? params[name] : fallback;
		},
		getNode: () => ({ name: 'Keep Your Prompts', type: 'n8n-nodes-keepyourprompts.keepYourPrompts', typeVersion: 1, parameters: {} }),
		getCredentials: async () => ({ apiKey: 'kyp_live_test', baseUrl: 'https://api.example.test/' }),
		continueOnFail: () => continueOnFail,
		getWorkflowStaticData: () => staticData,
		getNodeWebhookUrl: () => webhookUrl,
		getWorkflow: () => ({ id: 'wf1', name: 'Sync prompts', active: true }),
		getRequestObject: () => request,
		getResponseObject: () => response,
		getHeaderData: () => (request ? request.headers : {}),
		logger: { debug: (m) => logs.push(m), warn: (m) => logs.push(m), info: (m) => logs.push(m), error: (m) => logs.push(m) },
		helpers: {
			returnJsonArray: (data) => (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
			httpRequestWithAuthentication: async function (credentialType, options) {
				calls.push({ credentialType, ...options });
				const key = `${options.method} ${options.url}`;
				const route = routes[key];
				if (route === undefined) throw Object.assign(new Error(`no route for ${key}`), { httpCode: '404' });
				if (typeof route === 'function') return route(options);
				if (route instanceof Error) throw route;
				return JSON.parse(JSON.stringify(route));
			},
		},
	};
	return ctx;
};

exports.httpError = (status, message = 'error') =>
	Object.assign(new Error(message), { httpCode: String(status), response: { status } });

/** A minimal Express-like response that records status and JSON. */
exports.fakeResponse = () => {
	const res = { statusCode: 200, body: undefined };
	res.status = (code) => {
		res.statusCode = code;
		return res;
	};
	res.json = (body) => {
		res.body = body;
		return res;
	};
	res.send = res.json;
	return res;
};
