#!/bin/sh
# Keep Your Prompts: headersHelper for the plugin's MCP server.
# Prints the headers Claude Code adds to every MCP request, as one JSON object.
#  - KYP_API_KEY set (kyp_live_… / kyp_test_…): sends it as a bearer token.
#  - KYP_API_KEY unset: prints {} so Claude Code falls back to OAuth (run /mcp and sign in in the browser).
#  - KYP_WORKSPACE set: selects that workspace for OAuth sign-ins (API keys are already bound to one workspace).
# Only characters that are safe inside JSON strings are accepted; anything else is ignored.
key=${KYP_API_KEY:-}
ws=${KYP_WORKSPACE:-}
out=""
case "$key" in
  kyp_live_*|kyp_test_*)
    case "$key" in
      *[!A-Za-z0-9_-]*) ;;
      *) out="\"Authorization\":\"Bearer $key\"" ;;
    esac ;;
esac
if [ -n "$ws" ]; then
  case "$ws" in
    *[!A-Za-z0-9_-]*) ;;
    *) out="${out:+$out,}\"X-KYP-Workspace\":\"$ws\"" ;;
  esac
fi
printf '{%s}\n' "$out"
