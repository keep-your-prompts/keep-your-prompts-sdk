'use strict';
const { createHmac, timingSafeEqual } = require('crypto');

const TOLERANCE_SECONDS = 300;

/** Case-insensitive header lookup that also accepts Zapier's `Http-Webhook-Id` naming. */
function header(headers, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    const k = key.toLowerCase();
    if (k === wanted || k === `http-${wanted}`) {
      const v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function sign(secret, id, timestamp, body) {
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/**
 * Standard Webhooks verification (https://www.standardwebhooks.com): any `v1` signature in `webhook-signature`
 * (space-separated, two during a secret rotation) must match and `webhook-timestamp` must be within 5 minutes.
 */
function verify(secret, headers, rawBody, nowSeconds = Math.floor(Date.now() / 1000), tolerance = TOLERANCE_SECONDS) {
  const id = header(headers, 'webhook-id');
  const ts = header(headers, 'webhook-timestamp');
  const sigs = header(headers, 'webhook-signature');
  if (!secret || !id || !ts || !sigs || typeof rawBody !== 'string') return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > tolerance) return false;
  const expected = Buffer.from(sign(secret, id, ts, rawBody).slice(3));
  return sigs.split(' ').some((candidate) => {
    const comma = candidate.indexOf(',');
    if (comma < 0 || candidate.slice(0, comma) !== 'v1') return false;
    const got = Buffer.from(candidate.slice(comma + 1));
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

module.exports = { verify, sign, header, TOLERANCE_SECONDS };
