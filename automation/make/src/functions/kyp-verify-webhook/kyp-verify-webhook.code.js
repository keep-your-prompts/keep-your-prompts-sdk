// Verifies a Standard Webhooks signature (https://www.standardwebhooks.com) without the crypto module, which custom
// IML functions cannot use: v1,base64(HMAC-SHA256(base64-decoded secret, id.timestamp.body)). Accepts any v1
// signature (two during a secret rotation) and timestamps within 300 s of `nowSeconds`. A parsed `body` is
// re-serialized with JSON.stringify, which gives back the bytes Keep Your Prompts signed.
function kypVerifyWebhook(secret, headers, body, nowSeconds) {
	const h = {};
	for (const k of Object.keys(headers || {})) h[k.toLowerCase()] = headers[k];
	const id = h['webhook-id'];
	const ts = String(h['webhook-timestamp'] || '');
	const sigs = String(h['webhook-signature'] || '');
	const now = nowSeconds == null ? Math.floor(Date.now() / 1000) : Number(nowSeconds);
	if (!secret || !id || !/^\d+$/.test(ts) || !sigs || Math.abs(now - Number(ts)) > 300) return false;
	const raw = typeof body === 'string' ? body : JSON.stringify(body);
	const K = [];
	for (let i = 0, p = 2; i < 64; p++) {
		let prime = true;
		for (let d = 2; d * d <= p; d++) if (p % d === 0) prime = false;
		if (prime) K[i++] = (Math.pow(p, 1 / 3) % 1) * 4294967296 | 0;
	}
	const sha256 = (bytes) => {
		const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
		const len = bytes.length;
		const total = Math.ceil((len + 9) / 64) * 64;
		const m = Buffer.alloc(total);
		bytes.copy(m);
		m[len] = 0x80;
		m.writeUInt32BE(Math.floor((len * 8) / 4294967296), total - 8);
		m.writeUInt32BE((len * 8) >>> 0, total - 4);
		const W = new Array(64);
		const r = (x, n) => (x >>> n) | (x << (32 - n));
		for (let o = 0; o < total; o += 64) {
			for (let t = 0; t < 64; t++) {
				if (t < 16) W[t] = m.readUInt32BE(o + t * 4);
				else {
					const a = W[t - 15], b = W[t - 2];
					W[t] = (W[t - 16] + (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) + W[t - 7] + (r(b, 17) ^ r(b, 19) ^ (b >>> 10))) | 0;
				}
			}
			let [a, b, c, d, e, f, g, k] = H;
			for (let t = 0; t < 64; t++) {
				const t1 = (k + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
				const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
				k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
			}
			[a, b, c, d, e, f, g, k].forEach((v, n) => (H[n] = (H[n] + v) | 0));
		}
		const out = Buffer.alloc(32);
		H.forEach((v, n) => out.writeUInt32BE(v >>> 0, n * 4));
		return out;
	};
	let key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
	if (key.length > 64) key = sha256(key);
	const pad = (x) => Buffer.from(Array.from({ length: 64 }, (_, n) => (key[n] || 0) ^ x));
	const msg = Buffer.from(id + '.' + ts + '.' + raw, 'utf8');
	const expected = sha256(Buffer.concat([pad(0x5c), sha256(Buffer.concat([pad(0x36), msg]))])).toString('base64');
	return sigs.split(' ').some((s) => {
		const c = s.indexOf(',');
		if (c < 0 || s.slice(0, c) !== 'v1') return false;
		const got = s.slice(c + 1);
		let diff = got.length ^ expected.length;
		for (let n = 0; n < expected.length; n++) diff |= expected.charCodeAt(n) ^ got.charCodeAt(n);
		return diff === 0;
	});
}
