# Changelog

All notable changes to `n8n-nodes-keepyourprompts` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses semantic versioning.

## 0.1.0 - 2026-10-29

First release (preview).

- **Keep Your Prompts API** credential: workspace API key as a Bearer token, tested with `GET /v1/me`.
- **Keep Your Prompts** node: Prompt › Search, Get, Render (key/value variables, includes compiled), Create,
  Save Version; Deployment › Deploy, Roll Back; Capture › Create. Usable as an AI agent tool.
- **Keep Your Prompts Trigger**: registers a webhook endpoint (`source: "n8n"`) for the chosen events on
  activation, deletes it on deactivation, verifies Standard Webhooks signatures (rotation-aware) and timestamps.
