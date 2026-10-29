import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
} from 'n8n-workflow';

export const CREDENTIAL_NAME = 'keepYourPromptsApi';
export const DEFAULT_BASE_URL = 'https://api.keepyourprompts.com';

type Context = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions | IWebhookFunctions;

/** Calls the Keep Your Prompts REST API (`/v1/...`) with the workspace API key. */
export async function apiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<unknown> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	const baseURL = String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
	const options: IHttpRequestOptions = {
		method,
		baseURL,
		url: path,
		json: true,
		headers: { Accept: 'application/json' },
	};
	if (body !== undefined) options.body = body;
	if (qs !== undefined) {
		const query: IDataObject = {};
		for (const [k, v] of Object.entries(qs)) if (v !== undefined && v !== '') query[k] = v;
		options.qs = query;
	}
	return await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_NAME, options);
}

/** Asset ids start with `ast_`; anything else is treated as a slug and resolved with `GET /v1/assets/:slug`. */
export async function resolveAssetId(this: IExecuteFunctions, idOrSlug: string): Promise<string> {
	const trimmed = idOrSlug.trim();
	if (trimmed.startsWith('ast_')) return trimmed;
	const asset = (await apiRequest.call(
		this,
		'GET',
		`/v1/assets/${encodeURIComponent(trimmed)}`,
	)) as IDataObject;
	return String(asset.id);
}
