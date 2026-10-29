# kyp: Keep Your Prompts on the command line

`kyp` snapshots deployed prompts for your builds, prints a rendered prompt, and manages your workspace (search, push
new versions, diff, deploy, roll back, capture) from a terminal or a CI job. It is built on the [Go SDK](../go/README.md).

Version 0.1.0. Licensed under the repository's [LICENSE](../LICENSE).

## Install

```sh
# Go 1.22+
go install github.com/keep-your-prompts/keep-your-prompts-sdk/cli/cmd/kyp@latest

# Homebrew (placeholder: the tap is not published yet)
brew install keep-your-prompts/tap/kyp

# Linux and macOS installer (placeholder URL: https://keepyourprompts.com/install.sh is not live yet)
curl -fsSL https://raw.githubusercontent.com/keep-your-prompts/keep-your-prompts-sdk/main/cli/scripts/install.sh | sh
```

Prebuilt binaries for Linux, macOS and Windows on amd64 and arm64 are attached to each
[`cli-v*` GitHub release](https://github.com/keep-your-prompts/keep-your-prompts-sdk/releases), with `checksums.txt`.

## Two kinds of keys

| Key | Looks like | Used by | Where it comes from |
| --- | --- | --- | --- |
| Delivery key | `kypd_…` | `kyp pull`, `kyp get` (read-only, deployed prompts) | Settings > Delivery keys; `export KYP_DELIVERY_KEY=…` |
| API key | `kyp_live_…` | everything else | Settings > API keys; `kyp login` or `export KYP_API_KEY=…` |

`kyp login` stores the API key in `<config dir>/kyp/config.json` with mode `0600` (`~/.config/kyp` on Linux,
`~/Library/Application Support/kyp` on macOS, `%AppData%\kyp` on Windows; `KYP_CONFIG_DIR` overrides it).
`KYP_API_KEY` wins over the stored key. The API base is `--api-url`, then `KYP_API_URL`, then the URL saved by
`kyp login --api-url`, then `https://api.keepyourprompts.com`.

## Commands

### Prompts in your app (delivery key)

```sh
kyp pull --app support-bot --env prod --out ./prompts                 # protocol layout: commit it or ship it
kyp pull --app support-bot --env prod --out ./prompts --format go     # + embed.go: kyp.WithEmbeddedSnapshot(prompts.Snapshot)
kyp pull --app support-bot --env prod --out ./src/prompts.ts --format ts   # TypeScript EmbeddedSnapshot module
kyp pull --app support-bot --env prod --out - --format json           # {"kyp":1,"files":{...}} to stdout

kyp get triage --var company=Acme --var billing_queue=refunds         # KYP_APP, KYP_DELIVERY_KEY or --snapshot DIR
kyp get triage --snapshot ./prompts --raw                             # the template, unrendered
```

`pull` always reads what is deployed now (CDN, then origin, then `--git-mirror`/`KYP_GIT_MIRROR`), verifies every
blob's SHA-256 and writes files atomically. `get` starts from `--snapshot`/`KYP_SNAPSHOT_DIR` or `KYP_CACHE_DIR` when
present, asks the network once for anything newer (skip with `--offline`), and warns but still answers when the
network is down. Missing variables fail (exit 7) unless you pass `--lenient`.

### Your workspace (API key)

```sh
kyp login                                    # paste the key (or: echo "$KEY" | kyp login)
kyp ls [--kind prompt] [--limit 100]
kyp search refund policy [--scope mine|public|all]
kyp show triage [--version 3]                # body on stdout, details on stderr
kyp push triage.md --name "Support triage" [--slug support/triage] [-m "Shorter"]
kyp diff triage 3 4                          # word diff: red removed, green added
kyp deploy support-bot prod triage=triage@4 reviewer=agents/reviewer -m "Shorter triage"
kyp rollback support-bot prod 41
pbpaste | kyp capture --source ide           # into the Inbox
kyp mcp [--client claude-code|cursor|vscode] [--with-key]
kyp version
```

- `push` creates the prompt when the slug does not exist (slug from `--slug`, else from `--name`), otherwise saves a
  new version with `baseVersion` set to the current version (or `--base N`, the version your edit started from).
  If someone saved in between, the API answers `409 version-conflict` and `kyp` exits 5 with the command to review
  the change. An identical body is reported as unchanged and nothing is written.
- `deploy` resolves each `SLUG` to its asset, deploys `@VERSION` (or the current version) under `NAME`, and prints the
  new revision. A bare `triage` means `triage=triage`.
- `diff` colours output on a terminal (`--color=always|never`, `NO_COLOR` respected); without colour it marks
  `[-removed-]` and `{+added+}`.
- `mcp` prints the snippets for `claude mcp add`, `.cursor/mcp.json` and `.vscode/mcp.json`, with a placeholder key
  unless you pass `--with-key`.

Run `kyp help <command>` for every flag. Flags may come before or after arguments.

### JSON and exit codes

Every command takes `--json`: the result goes to stdout as JSON, and errors go to stderr as
`{"error", "exitCode", "hint", "problem"}` where `problem` is the API's RFC 9457 `application/problem+json` body.

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | other error |
| 2 | usage: bad flags or arguments |
| 3 | auth: no API key, 401, 403 |
| 4 | not found: 404, unknown prompt, slug or version |
| 5 | conflict: 409 (e.g. `version-conflict` on push) |
| 6 | unavailable: network failure, 5xx, no delivery mirror answered |
| 7 | invalid: 400/422 validation errors (each field is listed), missing template variables |
| 8 | quota: 429 rate limit or plan limit (with the upgrade URL) |

## Development

```sh
cd cli
go test -race ./...            # unit + golden tests against an httptest fake API and fake CDN
go test ./... -update          # accept new golden output in internal/app/testdata/golden
scripts/build.sh               # cross-compile linux/darwin/windows × amd64/arm64 into dist/ with checksums
```

`cli/go.work` builds against the SDK in `../go`. `go install …@<version>` ignores it and uses the published SDK
module, so a release tags `go/vX.Y.Z` (SDK), `cli/vX.Y.Z` (this module, for `go install`) and `cli-vX.Y.Z` (which
triggers `.github/workflows/cli.yml` to build and attach the binaries to the GitHub release).
