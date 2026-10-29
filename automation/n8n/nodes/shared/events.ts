// The webhook event catalogue (GET /v1/webhooks/event-types, payload version 1). test/events.test.js keeps it
// in step with automation/test-vectors/events.json.

export const EVENT_TYPES: Array<{ value: string; name: string; description: string }> = [
	{
		value: 'prompt.created',
		name: 'Prompt Created',
		description: 'A prompt (or skill, agent, snippet…) was created, at version 1',
	},
	{
		value: 'prompt.version_saved',
		name: 'Version Saved',
		description:
			'A new current version was saved: an edit, a restore, a merged review or an import from a sync target',
	},
	{
		value: 'prompt.deleted',
		name: 'Prompt Deleted',
		description: 'A prompt was deleted (in the app, through the API or by a sync target)',
	},
	{
		value: 'deploy.completed',
		name: 'Deploy Completed',
		description:
			'An app environment points at new prompt versions (directly, or when a gated deploy was approved)',
	},
	{
		value: 'deploy.rolled_back',
		name: 'Rolled Back',
		description: 'An app environment went back to an earlier revision',
	},
	{
		value: 'deploy.requested',
		name: 'Deploy Requested',
		description: 'A deploy to an environment with an approval rule waits for approvers',
	},
	{
		value: 'deploy.approved',
		name: 'Deploy Approved',
		description: 'The last needed approval was given; the deploy is live',
	},
	{
		value: 'review.requested',
		name: 'Review Requested',
		description: 'Someone proposed a change and asked for a review',
	},
	{
		value: 'review.merged',
		name: 'Review Merged',
		description: 'An approved review was merged: its proposal is the current version',
	},
	{
		value: 'review.closed',
		name: 'Review Closed',
		description: 'A review was closed without merging',
	},
	{
		value: 'capture.created',
		name: 'Capture Created',
		description: 'A prompt was captured into the inbox (browser extension or API)',
	},
	{
		value: 'eval.run_completed',
		name: 'Eval Run Finished',
		description: 'An evaluation run finished (done or failed)',
	},
	{
		value: 'eval.gate_failed',
		name: 'Eval Gate Failed',
		description: 'A deploy was refused because a prompt is below the environment’s eval gate',
	},
	{
		value: 'sync.conflict',
		name: 'Sync Conflict',
		description: 'A prompt changed here and in a sync target; someone must choose',
	},
	{
		value: 'sync.failed',
		name: 'Sync Failing',
		description: 'A sync target started failing after working, or needs reconnecting',
	},
	{
		value: 'quota.warning',
		name: 'Quota Warning',
		description: 'The workspace used 80% (or all) of a monthly or daily allowance',
	},
	{ value: 'member.joined', name: 'Member Joined', description: 'Someone joined the workspace' },
	{
		value: 'member.removed',
		name: 'Member Removed',
		description: 'Someone was removed from, or left, the workspace',
	},
];
