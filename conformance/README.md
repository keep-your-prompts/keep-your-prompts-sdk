# Conformance suite

Every SDK in this repository runs these checks, so a prompt behaves identically in Python, TypeScript, Go, Java,
C#, Rust, Swift, PHP and Ruby. The C++ SDK is the reference implementation and covers the same behaviours with its
own fixtures in `cpp/tests/`; moving it onto this suite is planned. The protocol itself is in [`../protocol/README.md`](../protocol/README.md).

## Data

- `cases.json`: table-driven cases for template rendering (`render`), variable extraction (`variables`), manifest
  validation (`manifest`) and SHA-256 (`sha256`). Load the file from your language's tests and run every case.
- `fixtures/<name>/`: complete mirrors in the protocol layout (`envs/demo/prod.json`, `blobs/<sha256>`), app `demo`,
  env `prod`, workspace `acme`:

  | Fixture | Revision | What it tests |
  | --- | --- | --- |
  | `v12` | 12 | a normal mirror: prompts `greeting` (2 variables), `triage` (literal `{{{{`), `agents/reviewer` (nested name), `empty` (empty body) |
  | `v13` | 13 | a newer deploy: `greeting` changed to version 5 |
  | `v11-stale` | 11 | an older mirror: clients holding 12 must ignore it |
  | `tampered-v14` | 14 | the `greeting` blob does not match its hash: clients must refuse this manifest (or fetch the blob from another mirror) |

- `fake_cdn.py`: an HTTP mirror server for tests (Python 3 standard library only). Serves fixture folders under URL
  prefixes with the protocol's `Cache-Control`, strong `ETag` and `304`, records `Authorization` headers, and can
  take a route down (`/__down/<route>`, `/__up/<route>`) or report counters (`/__stats`). Run
  `python3 fake_cdn.py --route cdn:/v1/d/kypd_test:fixtures/v12 --route origin:/v1/delivery/kypd_test:fixtures/v12`;
  it prints `PORT <n>`.

## Required behaviour (each SDK has a test for every line)

1. **Render**: every `cases.json` `render` case, including the missing-variable error (strict by default) and lenient mode.
2. **Variables**: `cases.json` `variables`.
3. **Manifest**: valid and invalid cases; unknown fields ignored; `variables` defaults to `[]`.
4. **Hash check**: a blob whose SHA-256 differs from its name is rejected (`tampered-v14`).
5. **Start from local**: with a snapshot folder (`v12`) and no network, the client starts at once and serves `greeting` v4.
6. **Mirror order and fallback**: CDN first, origin second, git third. With the CDN route down, the origin serves; with both down, the git mirror (with `Authorization: Bearer <token>`) serves.
7. **Revalidation**: the second poll sends `If-None-Match` and a `304` changes nothing.
8. **Hot update**: switching the mirror from `v12` to `v13` makes `greeting` return v5 after one refresh, without restarting, and the update callback fires once.
9. **Stale mirror**: a mirror serving `v11-stale` never replaces revision 12.
10. **Failures never evict**: with every mirror down, `get` keeps returning the last good prompt; `status` reports the error and how stale the state is.
11. **Disk cache**: after a successful fetch, a new client with only the cache directory (no network) starts from it.
12. **Read path**: `get` performs no I/O and is safe from many threads (or tasks) at once.

## Also worth testing (recommended, not required)

These follow from the [protocol clarifications](../protocol/README.md#clarifications); they are not part of the
12 required behaviours above.

- **Bytes as stored**: a blob whose body ends with a newline, or starts with a UTF-8 BOM, verifies against the
  hash of its exact bytes and is returned unchanged (the `empty` prompt in `v12` covers the empty body).
- **Missing `schema`**: a manifest without `schema` is accepted as schema 1 (`cases.json` already rejects `schema: 2`).
- **`404` counts as a failure**: a mirror answering `404` or `410` for the manifest is skipped for that round, enters
  backoff, and does not evict the state held.
- **Derived variables**: when a prompt's `variables` is empty, the variables reported for it match `cases.json`
  `variables` extraction of its body.
