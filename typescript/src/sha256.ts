// SHA-256 through Web Crypto (global on Node >= 19, Bun, Deno, Workers, browsers;
// node:crypto's webcrypto on Node 18).

type Subtle = { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer> };
let subtle: Promise<Subtle> | undefined;

function getSubtle(): Promise<Subtle> {
  if (!subtle) {
    const g = (globalThis as { crypto?: { subtle?: Subtle } }).crypto;
    if (g?.subtle) subtle = Promise.resolve(g.subtle);
    else {
      const spec = 'node:crypto';
      subtle = import(/* @vite-ignore */ /* webpackIgnore: true */ spec).then(
        (m: { webcrypto: { subtle: Subtle } }) => m.webcrypto.subtle,
      );
    }
  }
  return subtle;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Lowercase hex SHA-256 of a string (as UTF-8) or of bytes. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await (await getSubtle()).digest('SHA-256', bytes));
  let s = '';
  for (const b of digest) s += HEX[b];
  return s;
}
