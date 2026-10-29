import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class KeepYourPromptsApi implements ICredentialType {
	name = 'keepYourPromptsApi';

	displayName = 'Keep Your Prompts API';

	icon: Icon = {
		light: 'file:../icons/keepyourprompts.svg',
		dark: 'file:../icons/keepyourprompts.dark.svg',
	};

	documentationUrl = 'https://keepyourprompts.com/docs/api';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'kyp_live_...',
			description:
				'A workspace API key from Settings › API keys. Use an editor key created by an owner or admin to save versions, deploy and register webhooks; a viewer key can only read.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.keepyourprompts.com',
			description: 'Leave as is unless Keep Your Prompts support gave you another API address',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/v1/me',
			method: 'GET',
		},
	};
}
