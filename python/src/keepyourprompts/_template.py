"""``{{name}}`` rendering. No logic, loops or escaping: prompts are plain text."""

from __future__ import annotations

from typing import Any, List, Mapping, Optional, Tuple, Union

from ._errors import MissingVariableError

_Piece = Union[str, Tuple[str, str]]  # literal text, or (name, raw)


def _is_start(c: str) -> bool:
    return ("a" <= c <= "z") or ("A" <= c <= "Z") or c == "_"


def _is_ident(c: str) -> bool:
    return _is_start(c) or ("0" <= c <= "9")


def _scan(t: str) -> List[_Piece]:
    out: List[_Piece] = []
    i = run = 0
    n = len(t)
    while True:
        op = t.find("{{", i)
        if op < 0:
            break
        if t.startswith("{{{{", op):
            out.append(t[run:op])
            out.append("{{")
            i = run = op + 4
            continue
        j = op + 2
        while j < n and t[j] in " \t":
            j += 1
        if j < n and _is_start(t[j]):
            start = j
            while j < n and _is_ident(t[j]):
                j += 1
            name = t[start:j]
            while j < n and t[j] in " \t":
                j += 1
            if t.startswith("}}", j):
                out.append(t[run:op])
                out.append((name, t[op : j + 2]))
                i = run = j + 2
                continue
        i = op + 2  # not a variable: keep the braces as text
    out.append(t[run:])
    return out


def render_template(
    template: str,
    variables: Optional[Mapping[str, Any]] = None,
    *,
    strict: bool = True,
    on_missing: Optional[str] = None,
) -> str:
    """Render a template.

    ``{{name}}`` (spaces inside the braces allowed) is replaced by ``str(variables[name])``;
    ``{{{{`` renders a literal ``{{``. Values are inserted as-is and never rendered again.
    A missing variable raises :class:`MissingVariableError` listing every missing name,
    unless ``strict=False`` (leave ``{{name}}`` in place) or ``on_missing="empty"``.
    ``on_missing`` is one of ``"error"``, ``"keep"``, ``"empty"`` and overrides ``strict``.
    """
    mode = on_missing or ("error" if strict else "keep")
    if mode not in ("error", "keep", "empty"):
        raise ValueError('on_missing must be "error", "keep" or "empty"')
    vars_ = variables or {}
    parts: List[str] = []
    missing: List[str] = []
    for p in _scan(template):
        if isinstance(p, str):
            parts.append(p)
            continue
        name, raw = p
        v = vars_.get(name)
        if v is not None:
            parts.append(v if isinstance(v, str) else str(v))
        elif mode == "keep":
            parts.append(raw)
        elif mode == "error" and name not in missing:
            missing.append(name)
    if missing:
        raise MissingVariableError(missing)
    return "".join(parts)


def template_variables(template: str) -> List[str]:
    """Distinct variable names in order of first appearance."""
    names: List[str] = []
    for p in _scan(template):
        if not isinstance(p, str) and p[0] not in names:
            names.append(p[0])
    return names
