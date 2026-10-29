// Vectors from automation/test-vectors/standard-webhooks.json (the first is the Standard Webhooks reference vector).
const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const headers = {
	'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
	'webhook-timestamp': '1614265330',
	'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const body = '{"test": 2432232314}';

it('accepts the specification vector', () => {
	assert.strictEqual(kypVerifyWebhook(secret, headers, body, 1614265330), true);
});

it('accepts any v1 signature during a secret rotation', () => {
	const rotated = Object.assign({}, headers, { 'webhook-signature': 'v1,78nXHjpFP0tVJQW5D0SBwmVyyW87BV/rL6MgfM/Bw44= ' + headers['webhook-signature'] });
	assert.strictEqual(kypVerifyWebhook(secret, rotated, body, 1614265330), true);
});

it('rejects a tampered body, a wrong secret and a stale timestamp', () => {
	assert.strictEqual(kypVerifyWebhook(secret, headers, '{"test": 2432232315}', 1614265330), false);
	assert.strictEqual(kypVerifyWebhook('whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD', headers, body, 1614265330), false);
	assert.strictEqual(kypVerifyWebhook(secret, headers, body, 1614265330 + 301), false);
});

it('rejects missing headers', () => {
	assert.strictEqual(kypVerifyWebhook(secret, { 'webhook-id': headers['webhook-id'] }, body, 1614265330), false);
});
