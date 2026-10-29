"""Manifest parsing: ``envs/<app>/<env>.json``."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Dict, Mapping, Optional, Tuple, Union

from ._errors import ProtocolError

_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
_WORKSPACE = re.compile(r"[A-Za-z0-9._-]{1,128}")
_SHA = re.compile(r"[0-9a-f]{64}")


def is_slug(s: str) -> bool:
    """``[a-z0-9][a-z0-9-]{0,62}``, the shape of app and env names."""
    return isinstance(s, str) and _SLUG.fullmatch(s) is not None


@dataclass(frozen=True)
class ManifestPrompt:
    sha256: str
    version: int
    variables: Tuple[str, ...]


@dataclass(frozen=True)
class Manifest:
    workspace: str
    app: str
    env: str
    revision: int
    deployed_at: str
    prompts: Mapping[str, ManifestPrompt]
    schema: int = 1


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def parse_manifest(
    data: Union[str, bytes, Mapping[str, Any]],
    app: Optional[str] = None,
    env: Optional[str] = None,
) -> Manifest:
    """Parse and validate a manifest (JSON text or an already-parsed dict).

    Unknown fields are ignored and ``variables`` defaults to ``()``. With ``app``/``env``,
    a manifest for another app env is rejected. Raises :class:`ProtocolError`.
    """
    j: Any = data
    if isinstance(data, (str, bytes)):
        try:
            j = json.loads(data)
        except ValueError:
            raise ProtocolError("manifest is not valid JSON") from None
    if not isinstance(j, Mapping):
        raise ProtocolError("manifest is not a JSON object")
    if "schema" in j and not (_is_int(j["schema"]) and j["schema"] == 1):
        raise ProtocolError("unsupported manifest schema (this SDK reads schema 1)")

    def string(k: str, required: bool) -> str:
        v = j.get(k)
        if v is None:
            if required:
                raise ProtocolError('manifest is missing "%s"' % k)
            return ""
        if not isinstance(v, str):
            raise ProtocolError('manifest "%s" must be a string' % k)
        return v

    workspace = string("workspace", True)
    m_app = string("app", True)
    m_env = string("env", True)
    deployed_at = string("deployed_at", False)
    if not _WORKSPACE.fullmatch(workspace) or workspace in (".", ".."):
        raise ProtocolError("manifest workspace is not a valid slug")
    if (app is not None and m_app != app) or (env is not None and m_env != env):
        raise ProtocolError("manifest is for %s/%s, expected %s/%s" % (m_app, m_env, app or m_app, env or m_env))
    revision = j.get("revision")
    if not _is_int(revision) or revision < 0:
        raise ProtocolError('manifest "revision" must be a non-negative integer')
    raw_prompts = j.get("prompts")
    if not isinstance(raw_prompts, Mapping):
        raise ProtocolError('manifest "prompts" must be an object')

    prompts: Dict[str, ManifestPrompt] = {}
    for name, p in raw_prompts.items():
        if not name or name.startswith("/") or name.endswith("/") or "//" in name:
            raise ProtocolError('invalid prompt name "%s"' % name)
        if not isinstance(p, Mapping):
            raise ProtocolError('prompt "%s" must be an object' % name)
        sha = p.get("sha256")
        if not isinstance(sha, str):
            raise ProtocolError('prompt "%s" has no sha256' % name)
        sha = sha.lower()
        if not _SHA.fullmatch(sha):
            raise ProtocolError('prompt "%s" has an invalid sha256' % name)
        version = p.get("version")
        variables = p.get("variables")
        prompts[name] = ManifestPrompt(
            sha256=sha,
            version=version if _is_int(version) else 0,
            variables=tuple(v for v in variables if isinstance(v, str)) if isinstance(variables, list) else (),
        )
    return Manifest(
        workspace=workspace,
        app=m_app,
        env=m_env,
        revision=revision,
        deployed_at=deployed_at,
        prompts=MappingProxyType(prompts),
    )
