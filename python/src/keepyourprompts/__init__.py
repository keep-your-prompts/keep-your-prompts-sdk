"""Keep Your Prompts Python SDK. This code is under the repository's LICENSE.

    from keepyourprompts import Client

    prompts = Client.from_env()                 # KYP_DELIVERY_KEY, KYP_APP, KYP_ENV
    system = prompts.render("triage", company="Acme")

Implements the prompt delivery protocol v1: interchangeable mirrors with one layout,
a manifest plus content-addressed blobs verified with SHA-256, ETag revalidation, a
background refresher and an atomic in-memory swap. Reads never do I/O.
"""

from ._async import AsyncClient
from ._client import Client
from ._engine import Mirror, MirrorStatus, Options, Prompt, Status, Update
from ._errors import KypError, MissingVariableError, NotFoundError, ProtocolError, UnavailableError
from ._manifest import Manifest, ManifestPrompt, is_slug, parse_manifest
from ._outcomes import OUTCOME_KINDS
from ._snapshot import SnapshotInfo, pull_snapshot, write_snapshot
from ._template import render_template, template_variables
from ._version import __version__


def sha256_hex(data: "str | bytes") -> str:
    """Lowercase hex SHA-256 of ``data`` (``str`` is encoded as UTF-8)."""
    import hashlib

    return hashlib.sha256(data.encode("utf-8") if isinstance(data, str) else data).hexdigest()


__all__ = [
    "AsyncClient",
    "Client",
    "KypError",
    "Manifest",
    "ManifestPrompt",
    "Mirror",
    "MirrorStatus",
    "MissingVariableError",
    "NotFoundError",
    "OUTCOME_KINDS",
    "Options",
    "Prompt",
    "ProtocolError",
    "SnapshotInfo",
    "Status",
    "UnavailableError",
    "Update",
    "__version__",
    "is_slug",
    "parse_manifest",
    "pull_snapshot",
    "render_template",
    "sha256_hex",
    "template_variables",
    "write_snapshot",
]
