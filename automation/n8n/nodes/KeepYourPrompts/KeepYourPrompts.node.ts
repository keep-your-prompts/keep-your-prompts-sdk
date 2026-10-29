import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INode,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

import { MissingVariablesError, renderTemplate, type OnMissing } from '../shared/template';
import { apiRequest, resolveAssetId } from '../shared/transport';

const ASSET_KINDS = [
	{ name: 'Agent', value: 'agent' },
	{ name: 'Instruction', value: 'instruction' },
	{ name: 'MCP Config', value: 'mcp_config' },
	{ name: 'Prompt', value: 'prompt' },
	{ name: 'Skill', value: 'skill' },
	{ name: 'Snippet', value: 'snippet' },
	{ name: 'System Prompt', value: 'system_prompt' },
	{ name: 'Test Set', value: 'test_set' },
];

const promptIdField = (operations: string[]) => ({
	displayName: 'Prompt',
	name: 'promptId',
	type: 'string' as const,
	required: true,
	default: '',
	placeholder: 'support-triage or ast_7Hq2Lm9Pw4Xr1Tz8Kd3Bn6V',
	description: 'The slug or ID of the prompt',
	displayOptions: { show: { resource: ['prompt'], operation: operations } },
});

export class KeepYourPrompts implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Keep Your Prompts',
		name: 'keepYourPrompts',
		icon: {
			light: 'file:../../icons/keepyourprompts.svg',
			dark: 'file:../../icons/keepyourprompts.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Search, render, version and deploy prompts in Keep Your Prompts',
		defaults: { name: 'Keep Your Prompts' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'keepYourPromptsApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Capture', value: 'capture' },
					{ name: 'Deployment', value: 'deployment' },
					{ name: 'Prompt', value: 'prompt' },
				],
				default: 'prompt',
			},

			// ───────────── Prompt ─────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['prompt'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create a prompt',
						description: 'Create a prompt at version 1',
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a prompt',
						description: 'Get a prompt with its current (or a given) version body',
					},
					{
						name: 'Render',
						value: 'render',
						action: 'Render a prompt',
						description: 'Fill in a prompt’s {{variables}} (includes are compiled first)',
					},
					{
						name: 'Save Version',
						value: 'saveVersion',
						action: 'Save a new prompt version',
						description: 'Save a new body as the next version of a prompt',
					},
					{
						name: 'Search',
						value: 'search',
						action: 'Search prompts',
						description: 'Find prompts by meaning and keywords',
					},
				],
				default: 'search',
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'support triage',
				description: 'What to look for',
				displayOptions: { show: { resource: ['prompt'], operation: ['search'] } },
			},
			{
				displayName: 'Scope',
				name: 'scope',
				type: 'options',
				options: [
					{ name: 'All (Workspace and Public Library)', value: 'all' },
					{ name: 'My Workspace', value: 'mine' },
					{ name: 'Public Library', value: 'public' },
				],
				default: 'mine',
				displayOptions: { show: { resource: ['prompt'], operation: ['search'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 50 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['prompt'], operation: ['search'] } },
			},
			promptIdField(['get', 'render', 'saveVersion']),
			{
				displayName: 'Version',
				name: 'version',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 0,
				description: 'Version number to read; 0 means the current version',
				displayOptions: { show: { resource: ['prompt'], operation: ['get', 'render'] } },
			},
			{
				displayName: 'Variables',
				name: 'variables',
				placeholder: 'Add Variable',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				displayOptions: { show: { resource: ['prompt'], operation: ['render'] } },
				options: [
					{
						name: 'variable',
						displayName: 'Variable',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'company',
								description: 'Variable name as written in the prompt, without braces',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'If a Variable Is Missing',
				name: 'onMissing',
				type: 'options',
				options: [
					{
						name: 'Fail',
						value: 'error',
						description: 'Stop with an error that lists the missing names',
					},
					{
						name: 'Keep the Placeholder',
						value: 'keep',
						description: 'Leave {{name}} in the text',
					},
					{ name: 'Leave Empty', value: 'empty', description: 'Replace it with nothing' },
				],
				default: 'error',
				displayOptions: { show: { resource: ['prompt'], operation: ['render'] } },
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'Support triage',
				displayOptions: { show: { resource: ['prompt'], operation: ['create'] } },
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'string',
				typeOptions: { rows: 8 },
				required: true,
				default: '',
				description: 'The prompt text. Write variables as {{name}}.',
				displayOptions: { show: { resource: ['prompt'], operation: ['create', 'saveVersion'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'createFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['prompt'], operation: ['create'] } },
				options: [
					{
						displayName: 'Description',
						name: 'description',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Kind',
						name: 'kind',
						type: 'options',
						options: ASSET_KINDS,
						default: 'prompt',
					},
					{
						displayName: 'Message',
						name: 'message',
						type: 'string',
						default: '',
						description: 'A note for the version history',
					},
					{
						displayName: 'Slug',
						name: 'slug',
						type: 'string',
						default: '',
						placeholder: 'support-triage',
						description: 'Handle used by deploys and includes; derived from the name when empty',
					},
					{
						displayName: 'Tags',
						name: 'tags',
						type: 'string',
						default: '',
						description: 'Comma-separated tags',
					},
				],
			},
			{
				displayName: 'Additional Fields',
				name: 'versionFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['prompt'], operation: ['saveVersion'] } },
				options: [
					{
						displayName: 'Base Version',
						name: 'baseVersion',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 1,
						description:
							'The version this edit started from. If the prompt has moved on since, the save fails instead of overwriting.',
					},
					{
						displayName: 'Message',
						name: 'message',
						type: 'string',
						default: '',
						description: 'A note for the version history',
					},
				],
			},

			// ───────────── Deployment ─────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['deployment'] } },
				options: [
					{
						name: 'Deploy',
						value: 'deploy',
						action: 'Deploy prompts to an app environment',
						description: 'Point an app environment at prompt versions',
					},
					{
						name: 'Roll Back',
						value: 'rollback',
						action: 'Roll back an app environment',
						description: 'Bring an app environment back to an earlier revision',
					},
				],
				default: 'deploy',
			},
			{
				displayName: 'App',
				name: 'app',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'support-bot',
				description: 'The app’s slug',
				displayOptions: { show: { resource: ['deployment'] } },
			},
			{
				displayName: 'Environment',
				name: 'env',
				type: 'string',
				required: true,
				default: 'prod',
				placeholder: 'prod',
				displayOptions: { show: { resource: ['deployment'] } },
			},
			{
				displayName: 'Prompts',
				name: 'prompts',
				placeholder: 'Add Prompt',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				required: true,
				default: {},
				displayOptions: { show: { resource: ['deployment'], operation: ['deploy'] } },
				options: [
					{
						name: 'prompt',
						displayName: 'Prompt',
						values: [
							{
								displayName: 'Name in the App',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'triage',
								description: 'The name your code reads the prompt by',
							},
							{
								displayName: 'Prompt',
								name: 'promptId',
								type: 'string',
								default: '',
								placeholder: 'support-triage',
								description: 'The slug or ID of the prompt',
							},
							{
								displayName: 'Version',
								name: 'version',
								type: 'number',
								typeOptions: { minValue: 0 },
								default: 0,
								description: 'Version to deploy; 0 deploys the current version',
							},
						],
					},
				],
			},
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				default: '',
				description: 'A note for the deploy history',
				displayOptions: { show: { resource: ['deployment'], operation: ['deploy'] } },
			},
			{
				displayName: 'To Revision',
				name: 'toRevision',
				type: 'number',
				typeOptions: { minValue: 1 },
				required: true,
				default: 1,
				description: 'The earlier revision of the environment to bring back',
				displayOptions: { show: { resource: ['deployment'], operation: ['rollback'] } },
			},

			// ───────────── Capture ─────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['capture'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Capture a prompt into the inbox',
						description: 'Save text to the inbox to review and promote later',
					},
				],
				default: 'create',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 6 },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['capture'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'captureFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['capture'], operation: ['create'] } },
				options: [
					{
						displayName: 'Conversation URL',
						name: 'conversationUrl',
						type: 'string',
						default: '',
						placeholder: 'https://claude.ai/chat/...',
						description: 'Where the prompt came from',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const results = await runOperation.call(this, resource, operation, i);
				for (const json of results) out.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw toNodeError(this.getNode(), error, i);
			}
		}
		return [out];
	}
}

/** Wraps an error for the n8n UI: API errors keep their HTTP details, others become operation errors. */
function toNodeError(
	node: INode,
	error: unknown,
	itemIndex: number,
): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	if (error instanceof MissingVariablesError) {
		return new NodeOperationError(node, error.message, {
			itemIndex,
			description: 'Add a value for each variable, or change “If a Variable Is Missing”.',
		});
	}
	const e = error as { httpCode?: string; response?: unknown };
	if (e.httpCode || e.response) return new NodeApiError(node, error as JsonObject, { itemIndex });
	return new NodeOperationError(node, error as Error, { itemIndex });
}

async function runOperation(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	i: number,
): Promise<IDataObject[]> {
	if (resource === 'prompt') {
		if (operation === 'search') {
			const res = (await apiRequest.call(this, 'GET', '/v1/search', undefined, {
				q: this.getNodeParameter('query', i) as string,
				scope: this.getNodeParameter('scope', i) as string,
				limit: this.getNodeParameter('limit', i) as number,
			})) as { data?: IDataObject[] };
			return res.data ?? [];
		}
		if (operation === 'get') {
			const idOrSlug = (this.getNodeParameter('promptId', i) as string).trim();
			const version = this.getNodeParameter('version', i) as number;
			const asset = (await apiRequest.call(
				this,
				'GET',
				`/v1/assets/${encodeURIComponent(idOrSlug)}`,
			)) as IDataObject;
			if (!version) return [asset];
			const v = (await apiRequest.call(
				this,
				'GET',
				`/v1/assets/${encodeURIComponent(String(asset.id))}/versions/${version}`,
			)) as IDataObject;
			return [{ ...asset, ...v, currentVersion: asset.currentVersion }];
		}
		if (operation === 'render') {
			const id = await resolveAssetId.call(this, this.getNodeParameter('promptId', i) as string);
			const version = this.getNodeParameter('version', i) as number;
			const compiled = (await apiRequest.call(
				this,
				'GET',
				`/v1/assets/${encodeURIComponent(id)}/compiled`,
				undefined,
				version ? { version } : undefined,
			)) as { version: number; body: string; variables?: string[] };
			const pairs =
				(
					this.getNodeParameter('variables', i, {}) as {
						variable?: Array<{ name: string; value: string }>;
					}
				).variable ?? [];
			const vars: Record<string, string> = {};
			for (const p of pairs) if (p.name) vars[p.name.trim()] = p.value;
			const onMissing = this.getNodeParameter('onMissing', i) as OnMissing;
			return [
				{
					promptId: id,
					version: compiled.version,
					rendered: renderTemplate(compiled.body, vars, onMissing),
					variables: compiled.variables ?? [],
				},
			];
		}
		if (operation === 'create') {
			const fields = this.getNodeParameter('createFields', i, {}) as IDataObject;
			const body: IDataObject = {
				name: this.getNodeParameter('name', i) as string,
				body: this.getNodeParameter('body', i) as string,
				kind: (fields.kind as string) || 'prompt',
			};
			for (const key of ['slug', 'description', 'message'] as const)
				if (fields[key]) body[key] = fields[key];
			if (fields.tags) {
				body.tags = String(fields.tags)
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean);
			}
			return [(await apiRequest.call(this, 'POST', '/v1/assets', body)) as IDataObject];
		}
		if (operation === 'saveVersion') {
			const id = await resolveAssetId.call(this, this.getNodeParameter('promptId', i) as string);
			const fields = this.getNodeParameter('versionFields', i, {}) as IDataObject;
			const body: IDataObject = { body: this.getNodeParameter('body', i) as string };
			if (fields.message) body.message = fields.message;
			if (fields.baseVersion) body.baseVersion = fields.baseVersion;
			return [
				(await apiRequest.call(
					this,
					'PATCH',
					`/v1/assets/${encodeURIComponent(id)}`,
					body,
				)) as IDataObject,
			];
		}
	}

	if (resource === 'deployment') {
		const app = encodeURIComponent((this.getNodeParameter('app', i) as string).trim());
		const env = (this.getNodeParameter('env', i) as string).trim();
		if (operation === 'deploy') {
			const rows =
				(
					this.getNodeParameter('prompts', i, {}) as {
						prompt?: Array<{ name: string; promptId: string; version: number }>;
					}
				).prompt ?? [];
			if (!rows.length) {
				throw new NodeOperationError(this.getNode(), 'Add at least one prompt to deploy', {
					itemIndex: i,
				});
			}
			const prompts: IDataObject[] = [];
			for (const row of rows) {
				const entry: IDataObject = {
					name: row.name.trim(),
					assetId: await resolveAssetId.call(this, row.promptId),
				};
				if (row.version) entry.version = row.version;
				prompts.push(entry);
			}
			const body: IDataObject = { env, prompts };
			const message = this.getNodeParameter('message', i, '') as string;
			if (message) body.message = message;
			return [(await apiRequest.call(this, 'POST', `/v1/apps/${app}/deploy`, body)) as IDataObject];
		}
		if (operation === 'rollback') {
			const toRevision = this.getNodeParameter('toRevision', i) as number;
			const res = (await apiRequest.call(this, 'POST', `/v1/apps/${app}/rollback`, {
				env,
				toRevision,
			})) as IDataObject | undefined;
			return [res ?? { app: decodeURIComponent(app), env, toRevision }];
		}
	}

	if (resource === 'capture' && operation === 'create') {
		const fields = this.getNodeParameter('captureFields', i, {}) as IDataObject;
		const body: IDataObject = { text: this.getNodeParameter('text', i) as string, source: 'api' };
		if (fields.conversationUrl) body.conversationUrl = fields.conversationUrl;
		return [(await apiRequest.call(this, 'POST', '/v1/captures', body)) as IDataObject];
	}

	throw new NodeOperationError(this.getNode(), `Unsupported operation ${resource}.${operation}`, {
		itemIndex: i,
	});
}
