"""Errors. Everything the SDK raises derives from :class:`KypError`."""

from __future__ import annotations

from typing import Iterable, Optional, Tuple


class KypError(Exception):
    """Base class of every error the SDK raises."""


class NotFoundError(KypError, KeyError):
    """``get`` / ``prompt`` / ``render`` for a name that is not in the deployed manifest.

    Also a :class:`KeyError`, so ``except KeyError`` works."""

    def __init__(self, name: str, detail: Optional[str] = None) -> None:
        self.message = 'prompt not found: "%s"%s' % (name, " (%s)" % detail if detail else "")
        super().__init__(self.message)
        self.name = name

    def __str__(self) -> str:
        return self.message


class MissingVariableError(KypError, ValueError):
    """``render`` was called without a value for one or more ``{{variables}}``."""

    def __init__(self, names: Iterable[str]) -> None:
        self.names: Tuple[str, ...] = tuple(names)
        plural = "" if len(self.names) == 1 else "s"
        super().__init__("missing template variable%s: %s" % (plural, ", ".join(self.names)))


class UnavailableError(KypError):
    """No mirror could deliver a manifest during start-up (see ``startup_timeout``)."""


class ProtocolError(KypError, ValueError):
    """A mirror returned something that does not follow the delivery protocol."""
