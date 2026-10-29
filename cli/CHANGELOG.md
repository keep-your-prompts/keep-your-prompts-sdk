# Changelog: kyp CLI

All notable changes to the `kyp` command-line tool. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the tool uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-29

### Added

- `kyp pull --app --env --out [--format folder|go|ts|json]`: snapshot the deployed prompts with a delivery key.
- `kyp get NAME [--var k=v]...`: print a rendered prompt from a snapshot folder, the disk cache or the mirrors.
- `kyp login` / `kyp logout`: store the API key in the OS config folder with mode 0600.
- `kyp search`, `kyp ls`, `kyp show [--version N]`.
- `kyp push FILE --name N [--slug S] [-m MSG]`: create a prompt or save a new version (sends `baseVersion`).
- `kyp diff SLUG A B`: coloured word diff.
- `kyp deploy APP ENV NAME=SLUG[@VERSION]...`, `kyp rollback APP ENV REV`.
- `kyp capture`: stdin to the Inbox.
- `kyp mcp`: MCP config for Claude Code, Cursor and VS Code.
- `kyp version`.
- `--json` on every command, documented exit codes, hints from `application/problem+json` errors.
- Release builds for linux, darwin and windows on amd64 and arm64 (`scripts/build.sh`).
