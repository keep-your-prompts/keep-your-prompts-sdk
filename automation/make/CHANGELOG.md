# Changelog

All notable changes to the Keep Your Prompts Make app are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - 2026-10-29

First version (preview, not yet deployed to Make).

- Base (Bearer API key, error handling, log sanitization) and API key connection verified with `GET /v1/me`.
- Dedicated webhook `kypEvents` with attach (`POST /v1/webhooks`, `source: "make"`, chosen events) and detach.
- Modules: Watch Events (instant), Search Prompts, Get a Prompt, Render a Prompt, Create a Prompt, Save a Prompt
  Version, Deploy Prompts, Roll Back an Environment, Capture a Prompt, Make an API Call.
- Custom IML functions `kypRender` and `kypVerifyWebhook` with Make IML tests.
- `scripts/validate.mjs` static checks and `node --test` suite.
