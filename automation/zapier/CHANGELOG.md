# Changelog

All notable changes to the Keep Your Prompts Zapier integration are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow semantic versioning (Zapier requires it).

## 0.1.0 - 2026-10-29

First version (preview, not yet pushed to Zapier).

- API key authentication tested with `GET /v1/me`.
- 19 instant REST-hook triggers (New Event plus one per event type) that subscribe with `source: "zapier"`,
  unsubscribe on Zap off, verify Standard Webhooks signatures (rotation-aware, 5-minute tolerance) and sample from
  `GET /v1/webhooks/event-types`.
- Find Prompt search; Render Prompt, Create Prompt, Save Prompt Version, Deploy Prompts, Roll Back Environment and
  Capture Prompt actions.
- Built on `zapier-platform-core` 19.2.1, Node 22.
