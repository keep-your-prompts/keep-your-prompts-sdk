"""``python -m keepyourprompts snapshot --app support-bot --env prod --out ./prompts``"""

from __future__ import annotations

import argparse
import os
import sys
from typing import List, Optional

from ._engine import Mirror
from ._errors import KypError
from ._snapshot import pull_snapshot
from ._version import __version__


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m keepyourprompts",
        description="Keep Your Prompts command line.",
    )
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="command")
    sp = sub.add_parser(
        "snapshot",
        help="pull a snapshot folder for an app env",
        description=(
            "Pull the deployed prompts of an app env, verify every body with SHA-256 and write them "
            "as a folder in the delivery protocol layout. Ship it with your app (KYP_SNAPSHOT_DIR) "
            "so it starts with zero network."
        ),
    )
    sp.add_argument("--app", required=True)
    sp.add_argument("--env", default="prod")
    sp.add_argument("--out", required=True, help="output folder")
    sp.add_argument(
        "--key", default=os.environ.get("KYP_DELIVERY_KEY", ""), help="delivery key (default: $KYP_DELIVERY_KEY)"
    )
    sp.add_argument("--cdn", default=os.environ.get("KYP_CDN_URL") or None, help="CDN base URL")
    sp.add_argument("--origin", default=os.environ.get("KYP_ORIGIN_URL") or None, help="origin base URL")
    sp.add_argument(
        "--git", default=None, help="git mirror base, e.g. https://raw.githubusercontent.com/acme/prompts/main/.kyp"
    )
    sp.add_argument("--git-token", default=os.environ.get("KYP_GIT_TOKEN", ""), help="token for a private git mirror")
    sp.add_argument(
        "--mirror", action="append", default=[], help="use only these mirrors (repeatable; https:// or a folder)"
    )
    sp.add_argument("--timeout", type=float, default=10.0, help="give up after this many seconds (default 10)")
    sp.add_argument("-q", "--quiet", action="store_true", help="print nothing on success")
    args = ap.parse_args(argv)
    if args.command != "snapshot":
        ap.print_help(sys.stderr)
        return 2
    if args.timeout <= 0:
        ap.error("--timeout must be positive")

    opts = dict(
        app=args.app,
        env=args.env,
        delivery_key=args.key,
        git_mirror=args.git,
        git_token=args.git_token,
        startup_timeout=args.timeout,
        request_timeout=min(5.0, args.timeout),
    )
    if args.cdn:
        opts["cdn_url"] = args.cdn
    if args.origin:
        opts["origin_url"] = args.origin
    if args.mirror:
        opts["mirrors"] = [Mirror("mirror%d" % (i + 1), url) for i, url in enumerate(args.mirror)]
    try:
        info = pull_snapshot(args.out, **opts)
    except KypError as e:
        print("keepyourprompts: %s" % e, file=sys.stderr)
        return 1
    if not args.quiet:
        print(
            "%s/%s revision %d (%d prompts, workspace %s) from %s -> %s (%d files written)"
            % (
                args.app,
                args.env,
                info.revision,
                info.prompt_count,
                info.workspace,
                info.source,
                args.out,
                info.files_written,
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
