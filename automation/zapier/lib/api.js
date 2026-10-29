'use strict';

/** The public REST API. Set KYP_API_BASE_URL with `zapier-platform env:set` to point a test version elsewhere. */
const baseUrl = () => (process.env.KYP_API_BASE_URL || 'https://api.keepyourprompts.com').replace(/\/+$/, '');

const api = (path) => `${baseUrl()}${path}`;

/** Asset ids start with `ast_`; anything else is a slug, resolved with GET /v1/assets/:slug. */
async function resolveAssetId(z, idOrSlug) {
  const value = String(idOrSlug || '').trim();
  if (!value) throw new z.errors.Error('Enter the slug or ID of a prompt.', 'invalid_input', 400);
  if (value.startsWith('ast_')) return value;
  const response = await z.request({ url: api(`/v1/assets/${encodeURIComponent(value)}`) });
  return response.data.id;
}

/** Adds the API key to every request. */
function addApiKey(request, z, bundle) {
  if (bundle.authData && bundle.authData.apiKey) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`;
  }
  request.headers = { Accept: 'application/json', ...request.headers };
  return request;
}

/** Turns RFC 9457 problem responses into readable Zapier errors (429 is already a ThrottledError in core). */
function handleErrors(response, z) {
  if (response.status < 400 || response.skipThrowForStatus) return response;
  let problem = {};
  try {
    problem = typeof response.data === 'object' && response.data ? response.data : JSON.parse(response.content || '{}');
  } catch (e) {
    problem = {};
  }
  const message = problem.detail || problem.title || `Keep Your Prompts answered HTTP ${response.status}`;
  if (response.status === 401) {
    throw new z.errors.Error(`${message} Check the API key in the connection.`, 'AuthenticationError', 401);
  }
  throw new z.errors.Error(message, problem.type || `http_${response.status}`, response.status);
}

module.exports = { api, baseUrl, resolveAssetId, addApiKey, handleErrors };
