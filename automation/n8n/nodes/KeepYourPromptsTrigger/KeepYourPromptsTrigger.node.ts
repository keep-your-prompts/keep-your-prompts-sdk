import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IHookFunctions,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
	type JsonObject,
} from 'n8n-workflow';

import { EVENT_TYPES } from '../shared/events';
import { verifyWebhook } from '../shared/signature';
import { apiRequest } from '../shared/transport';

const TEST_EVENT = 'webhook.test';

interface EndpointState extends IDataObject {
	webhookId?: string;
	webhookSecret?: string;
	webhookUrl?: string;
}

function statusOf(error: unknown): number | undefined {
	const e = error as { httpCode?: string; response?: { status?: number }; statusCode?: number };
	const code = Number(e.httpCode ?? e.response?.status ?? e.statusCode);
	return Number.isFinite(code) ? code : undefined;
}

function selectedEvents(this: IHookFunctions | IWebhookFunctions): string[] {
	const events = this.getNodeParameter('events', []) as string[];
	return events.length === 0 || events.includes('*') ? ['*'] : events;
}

export class KeepYourPromptsTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Keep Your Prompts Trigger',
		name: 'keepYourPromptsTrigger',
		icon: {
			light: 'file:../../icons/keepyourprompts.svg',
			dark: 'file:../../icons/keepyourprompts.dark.svg',
		},
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when something happens in a Keep Your Prompts workspace',
		defaults: { name: 'Keep Your Prompts Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'keepYourPromptsApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Activating the workflow registers a webhook endpoint in your workspace (Settings › Webhooks, source “n8n”) and deactivating it removes the endpoint. It needs an editor API key created by an owner or admin.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: [
					{
						name: 'All Events',
						value: '*',
						description: 'Every event, including ones added later',
					},
					...EVENT_TYPES,
				],
				default: ['prompt.version_saved'],
				description: 'The events that start the workflow',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Ignore Test Events',
						name: 'ignoreTestEvents',
						type: 'boolean',
						default: false,
						description:
							'Whether to drop the events sent by “Send test event” in Settings › Webhooks (they carry "test": true)',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as EndpointState;
				const url = this.getNodeWebhookUrl('default') as string;
				if (state.webhookId) {
					let endpoint: IDataObject | undefined;
					try {
						endpoint = (await apiRequest.call(
							this,
							'GET',
							`/v1/webhooks/${encodeURIComponent(state.webhookId)}`,
						)) as IDataObject;
					} catch (error) {
						if (statusOf(error) !== 404)
							throw new NodeApiError(this.getNode(), error as JsonObject);
						this.logger.debug(`Keep Your Prompts webhook ${state.webhookId} no longer exists`);
					}
					if (endpoint && endpoint.url === url && state.webhookSecret) return true;
					if (endpoint) await deleteEndpoint.call(this, state.webhookId);
					delete state.webhookId;
					delete state.webhookSecret;
					delete state.webhookUrl;
					return false;
				}
				// No stored endpoint: remove any endpoint left for this URL (its secret is lost), then create a new one.
				const list = (await apiRequest.call(this, 'GET', '/v1/webhooks')) as {
					data?: IDataObject[];
				};
				for (const endpoint of list.data ?? []) {
					if (endpoint.url === url) await deleteEndpoint.call(this, String(endpoint.id));
				}
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as EndpointState;
				const url = this.getNodeWebhookUrl('default') as string;
				const workflow = this.getWorkflow();
				const created = (await apiRequest.call(this, 'POST', '/v1/webhooks', {
					url,
					events: selectedEvents.call(this),
					description: `n8n: ${workflow.name ?? workflow.id ?? 'workflow'}`.slice(0, 200),
					source: 'n8n',
				})) as IDataObject;
				if (!created.id || typeof created.secret !== 'string') {
					throw new NodeOperationError(
						this.getNode(),
						'Keep Your Prompts did not return the webhook id and signing secret',
					);
				}
				state.webhookId = String(created.id);
				state.webhookSecret = created.secret;
				state.webhookUrl = url;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const state = this.getWorkflowStaticData('node') as EndpointState;
				if (state.webhookId) await deleteEndpoint.call(this, state.webhookId);
				delete state.webhookId;
				delete state.webhookSecret;
				delete state.webhookUrl;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		const state = this.getWorkflowStaticData('node') as EndpointState;

		if (!req.rawBody && typeof req.readRawBody === 'function') await req.readRawBody();
		const raw: Buffer | undefined = req.rawBody;
		if (!state.webhookSecret || !raw) {
			res.status(401).json({ error: 'webhook is not registered' });
			return { noWebhookResponse: true };
		}
		const check = verifyWebhook(state.webhookSecret, this.getHeaderData(), raw);
		if (!check.valid) {
			res.status(401).json({ error: `invalid signature: ${check.reason}` });
			return { noWebhookResponse: true };
		}

		let payload: IDataObject;
		try {
			payload = JSON.parse(raw.toString('utf8')) as IDataObject;
		} catch (error) {
			this.logger.warn(`Keep Your Prompts webhook body is not JSON: ${(error as Error).message}`);
			res.status(400).json({ error: 'body is not JSON' });
			return { noWebhookResponse: true };
		}

		const type = String(payload.type ?? '');
		const options = this.getNodeParameter('options', {}) as { ignoreTestEvents?: boolean };
		const isTest = payload.test === true || type === TEST_EVENT;
		const events = selectedEvents.call(this);
		const wanted = isTest
			? !options.ignoreTestEvents
			: events.includes('*') || events.includes(type);
		if (!wanted) return { webhookResponse: { received: true, ignored: type } };

		return { workflowData: [this.helpers.returnJsonArray(payload)] };
	}
}

async function deleteEndpoint(this: IHookFunctions, id: string): Promise<void> {
	try {
		await apiRequest.call(this, 'DELETE', `/v1/webhooks/${encodeURIComponent(id)}`);
	} catch (error) {
		if (statusOf(error) !== 404) throw new NodeApiError(this.getNode(), error as JsonObject);
		this.logger.debug(`Keep Your Prompts webhook ${id} was already deleted`);
	}
}
