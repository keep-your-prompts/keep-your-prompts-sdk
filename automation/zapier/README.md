# Keep Your Prompts for Zapier

A [Zapier Platform CLI](https://docs.zapier.com/platform/build-cli/overview) integration for
[Keep Your Prompts](https://keepyourprompts.com): start Zaps when something happens in your workspace, and find,
render, create, version and deploy prompts from any Zap.

> **Preview.** Version 0.1.0 is not on Zapier yet: it has to be pushed and go through Zapier's integration review
> (see [`../README.md`](../README.md#owner-checklist)).

## Connect

Authentication is an API key (custom auth). Paste a workspace API key (`kyp_live_…`) from **Settings › API keys**;
Zapier tests it with `GET /v1/me` and labels the connection with the workspace name. Use an **editor** key created by
an owner or admin for triggers (they register webhooks) and for the actions that change your workspace.

## Triggers (instant, REST hooks)

| Trigger | Event |
| --- | --- |
| New Event | Any of the events you pick |
| Prompt Created, Version Saved, Prompt Deleted | `prompt.created`, `prompt.version_saved`, `prompt.deleted` |
| Deploy Completed, Rolled Back, Deploy Requested, Deploy Approved | `deploy.*` |
| Review Requested, Review Merged, Review Closed | `review.*` |
| Capture Created | `capture.created` |
| Eval Run Finished, Eval Gate Failed | `eval.run_completed`, `eval.gate_failed` |
| Sync Conflict, Sync Failing | `sync.conflict`, `sync.failed` |
| Quota Warning, Member Joined, Member Removed | `quota.warning`, `member.joined`, `member.removed` |

- **Subscribe** (Zap turned on): `POST /v1/webhooks { url: <Zapier target URL>, events, description, source: "zapier" }`.
  Zapier keeps the response, including the signing secret, as `bundle.subscribeData`.
- **Unsubscribe** (Zap turned off): `DELETE /v1/webhooks/:id` (an endpoint already gone is fine).
- **Perform** (each delivery): verifies the [Standard Webhooks](https://www.standardwebhooks.com) signature over the
  raw body (`bundle.rawRequest.content`, headers `Http-Webhook-Id`, `Http-Webhook-Timestamp`,
  `Http-Webhook-Signature`) with the subscription's secret, accepts either signature during a secret rotation, and
  rejects timestamps more than 5 minutes off. Deliveries that fail are dropped (logged), never passed to the Zap.
  The output is the event envelope `{ id, type, timestamp, version, workspace, data }`; Zapier deduplicates on `id`,
  which is the same on every retry.
- **Perform list** (sample in the Zap editor): the live example from `GET /v1/webhooks/event-types`.

## Search

| Search | API |
| --- | --- |
| Find Prompt | By slug or ID: `GET /v1/assets/:slugOrId` (404 → not found); by text: `GET /v1/search` |

## Actions

| Action | API |
| --- | --- |
| Render Prompt | `GET /v1/assets/:id/compiled?version=` then fills `{{variables}}` from the Variables dictionary |
| Create Prompt | `POST /v1/assets` |
| Save Prompt Version | `PATCH /v1/assets/:id` (Based On Version guards against overwriting a newer version) |
| Deploy Prompts | `POST /v1/apps/:app/deploy` with line items (name in the app, prompt, version) |
| Roll Back Environment | `POST /v1/apps/:app/rollback` |
| Capture Prompt | `POST /v1/captures` (`source: "api"`) |

Errors from the API (RFC 9457 problem details) are shown with their `detail`; `429` becomes a throttled error that
Zapier retries after `Retry-After`.

## Develop and test

Node 22 (Zapier's runtime). No credentials or network needed: tests use `zapier-platform-core`'s `appTester` with
[nock](https://github.com/nock/nock), the shared webhook vectors in `../test-vectors/` and `conformance/cases.json`.

```sh
npm install
npm test                                              # jest
npx -p zapier-platform-cli zapier-platform validate   # schema and Zapier's integration checks
```

## Deploy

```sh
npm install -g zapier-platform-cli
zapier-platform login
zapier-platform register "Keep Your Prompts"   # once; writes .zapierapprc (not committed)
zapier-platform push                           # uploads this version (private)
zapier-platform promote 0.1.0                  # when it is ready for users
```

CI pushes on a `zapier-v*` tag when the repository has the `ZAPIER_DEPLOY_KEY` secret and the `ZAPIER_APP_ID`
variable (see `.github/workflows/automation-zapier.yml`). `zapier-platform env:set 0.1.0 KYP_API_BASE_URL=…` points a
test version at another API.

## Licence

[The Republic Lex Aequa License 1.0](LICENSE) (SPDX `LicenseRef-Republic-Lex-Aequa-1.0`).
