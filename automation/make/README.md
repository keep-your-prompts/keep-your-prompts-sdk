# Keep Your Prompts for Make

A [Make](https://www.make.com) custom app for [Keep Your Prompts](https://keepyourprompts.com), kept as source in the
local-development layout of Make's VS Code extension
([Make Apps Editor](https://marketplace.visualstudio.com/items?itemName=Integromat.apps-sdk)). Make has no package
registry: you deploy these files into an app you create in Make.

> **Preview.** Version 0.1.0 has not been deployed to Make yet, and it has only been validated statically (see
> [What is tested](#what-is-tested)).

## Contents

```
src/
  makecomapp.json                       components and their files (origins are added when you deploy)
  README.md                             the app's description in Make
  general/base.iml.json                 base URL, Bearer auth, error handling, log sanitization
  connections/kyp-api-key/              API key connection, verified with GET /v1/me
  webhooks/kyp-events/                  dedicated webhook: attach (POST /v1/webhooks, source "make") / detach (DELETE)
  modules/watch-events/                 Watch Events (instant trigger)
  modules/search-prompts/               Search Prompts (search, limit 1–50)
  modules/get-prompt/                   Get a Prompt
  modules/render-prompt/                Render a Prompt (compiled body + {{variables}}, uses kypRender)
  modules/create-prompt/                Create a Prompt
  modules/save-version/                 Save a Prompt Version
  modules/deploy/                       Deploy Prompts
  modules/rollback/                     Roll Back an Environment
  modules/create-capture/               Capture a Prompt
  modules/make-api-call/                Make an API Call (universal, relative URLs only)
  modules/groups.json                   module groups
  functions/kyp-render/                 custom IML function kypRender (+ Make IML test)
  functions/kyp-verify-webhook/         custom IML function kypVerifyWebhook (+ Make IML test)
assets/icon-512.png                     app icon (512×512 PNG)
scripts/validate.mjs                    static checks (no dependencies)
test/app.test.mjs                       node --test: checks, IML function tests, shared vectors
```

## Import into Make

1. In Make, create an API token with the `sdk-apps` scopes (**Profile › API access**), and create an empty custom app
   (**Custom apps › Create a new app**: name `keep-your-prompts`, label *Keep Your Prompts*, theme `#3D6BFF`). Upload
   `assets/icon-512.png` as its icon.
2. Install the **Make Apps Editor** extension in VS Code and add your Make zone as an environment
   (`>Make Apps: Add SDK Environment`, for example `eu1.make.com/api`, with the token).
3. Open this repository in VS Code, right-click `automation/make/src/makecomapp.json` and choose **Deploy to Make**.
   Pick **Deploy into another app**, replace the `-FILL-ME-` values of the new origin (`appId` of the app from step 1,
   `baseUrl` of your zone, `apikeyFile` pointing at a file outside the repository such as `../../../.secrets/apikey`),
   save, and deploy again. Choose **Deploy as new remote component (and Apply for all unmapped)**.
   Commit `makecomapp.json` afterwards only if you want the origin (it has no secret) in the repository.
4. Custom IML functions are not enabled for new apps by default: ask Make support (helpdesk ticket) to enable them
   for the app, then deploy `functions/` (Render a Prompt needs `kypRender`).
5. Test in a scenario: create a connection with an editor API key, add **Watch Events**, create its webhook (this
   registers an endpoint in Keep Your Prompts › Settings › Webhooks with source *make*), and use **Send test event**
   there.

`common` data is not used (no client secrets), so it is `null` in `makecomapp.json`.

## Webhook signatures

Keep Your Prompts signs every delivery with [Standard Webhooks](https://www.standardwebhooks.com). The attach call
saves the endpoint id and its signing secret (`response.data`: `id`, `secret`), and `kypVerifyWebhook(secret, headers,
body, nowSeconds)` verifies a delivery (both signatures during a rotation, 5-minute timestamp tolerance). Make gives
webhook code the parsed `body`, not the raw bytes; the function re-serializes it with `JSON.stringify`, which gives
back exactly what Keep Your Prompts signed (it signs `JSON.stringify` output).

**The webhook does not call it yet.** Make's documentation lists `headers`, `body`, `query` and `parameters` for
webhook communication but no variable for data saved by attach (`webhook.*` is documented for detach and RPCs only).
The webhook's `condition` therefore only accepts version-1 envelopes that carry the Standard Webhooks headers, and the
unguessable dedicated URL is what keeps strangers out. Once Make confirms how webhook code reads attach data (for
example `{{webhook.secret}}`), change the condition in `webhooks/kyp-events/kyp-events.communication.iml.json` to:

```json
"condition": "{{kypVerifyWebhook(webhook.secret, headers, body, formatDate(now, 'X'))}}"
```

and check in Make DevTool that a test event passes and a forged one (edit a byte with curl) is dropped.

## What is tested

`npm test` (or `node --test test/`) and `node scripts/validate.mjs`, with no Make account:

- every file parses; `makecomapp.json` follows the extension's `makecomapp.schema.json` shape and references exactly
  the files present; module types, connection and webhook references, groups, samples against interfaces;
- parameter and interface types against the extension's `parameters.json` enum; communication directives against
  its `api.json`; balanced `{{ }}`; only declared `parameters.*` and known IML functions; relative URLs in modules
  and the universal module; base and connection sanitize the `authorization` header and handle errors;
- the webhook offers exactly the 18 documented event types;
- both custom IML functions run their Make IML tests (`it`/`assert`) in a sandbox with only `Buffer`, under Make's
  5,000-character limit; `kypVerifyWebhook` (pure-JS SHA-256/HMAC) passes the shared Standard Webhooks vectors and
  matches `node:crypto` on 200 random inputs; `kypRender` passes `conformance/cases.json`.

Not tested here: anything that needs Make itself (deployment, the scenario builder, real webhook attach/detach and
deliveries, IML evaluation of the communication files).

## Licence

[The Republic Lex Aequa License 1.0](LICENSE) (SPDX `LicenseRef-Republic-Lex-Aequa-1.0`).
