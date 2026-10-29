import { createHmac, timingSafeEqual } from 'crypto';

/** Seconds a delivery's `webhook-timestamp` may differ from this clock (Standard Webhooks default). */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

export type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === wanted) {
			const value = headers[key];
			return Array.isArray(value) ? value[0] : value;
		}
	}
	return undefined;
}

/** `v1,` + base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)); the key is the base64 part after `whsec_`. */
export function signPayload(
	secret: string,
	id: string,
	timestamp: string,
	body: string | Buffer,
): string {
	const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
	const hmac = createHmac('sha256', key);
	hmac.update(`${id}.${timestamp}.`);
	hmac.update(body);
	return `v1,${hmac.digest('base64')}`;
}

export type VerifyResult = { valid: true } | { valid: false; reason: string };

/**
 * Verifies a Standard Webhooks delivery (https://www.standardwebhooks.com): any `v1` signature in the
 * space-separated `webhook-signature` header must match (two are sent during a secret rotation), and
 * `webhook-timestamp` must be within `toleranceSeconds` of `nowSeconds`. Pass the raw body, never re-encoded JSON.
 */
export function verifyWebhook(
	secret: string,
	headers: HeaderBag,
	rawBody: string | Buffer,
	nowSeconds: number = Math.floor(Date.now() / 1000),
	toleranceSeconds: number = TIMESTAMP_TOLERANCE_SECONDS,
): VerifyResult {
	const id = header(headers, 'webhook-id');
	const timestamp = header(headers, 'webhook-timestamp');
	const signatures = header(headers, 'webhook-signature');
	if (!id || !timestamp || !signatures)
		return { valid: false, reason: 'missing Standard Webhooks headers' };
	if (!/^\d+$/.test(timestamp)) return { valid: false, reason: 'invalid webhook-timestamp' };
	if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) {
		return { valid: false, reason: 'webhook-timestamp outside the tolerance' };
	}
	const expected = Buffer.from(signPayload(secret, id, timestamp, rawBody).slice(3));
	for (const candidate of signatures.split(' ')) {
		const comma = candidate.indexOf(',');
		if (comma < 0 || candidate.slice(0, comma) !== 'v1') continue;
		const got = Buffer.from(candidate.slice(comma + 1));
		if (got.length === expected.length && timingSafeEqual(got, expected)) return { valid: true };
	}
	return { valid: false, reason: 'no matching v1 signature' };
}
