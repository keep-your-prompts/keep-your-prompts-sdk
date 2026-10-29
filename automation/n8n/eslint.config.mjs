import { config } from '@n8n/node-cli/eslint';

export default [
	...config,
	{
		// The package ships under the repository's licence (LICENSE, LicenseRef-Republic-Lex-Aequa-1.0), not MIT.
		// n8n's verified-node programme requires MIT: see automation/README.md before submitting for verification.
		files: ['package.json'],
		rules: { 'n8n-nodes-base/community-package-json-license-not-default': 'off' },
	},
];
