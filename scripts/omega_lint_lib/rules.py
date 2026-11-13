"""Deterministic, project-specific lint rules for SaveMe.

The rules are intentionally based on path boundaries, not on a full JavaScript
parser.  They run on every project file (not only staged files), so new files
are covered automatically.
"""

from __future__ import annotations

import json
import posixpath
import re
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

EXCLUDED_DIRS = {
    ".git",
    ".idea",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "tools",
}
JS_SUFFIXES = {".js", ".mjs", ".cjs"}

PURE_PREFIXES = ("src/domain/", "src/application/", "src/ports/")
ADAPTER_PREFIXES = ("src/adapters/", "src/composition/")
EXTENSION_PREFIX = "extension/"
APP_PREFIX = "app/"
TESTS_PREFIX = "tests/"

FORBIDDEN_APP_IMPORTS = {
    "src/auth.js",
    "src/config.js",
    "src/daemon.js",
    "src/rclone.js",
    "src/runner.js",
    "src/state.js",
    "src/supervisor.js",
}

STATIC_IMPORT_RE = re.compile(
    r"(?ms)^[ \t]*(?:import|export)\s+(?:[^;]*?\bfrom\s+)?['\"]([^'\"]+)['\"]"
)
DYNAMIC_IMPORT_RE = re.compile(r"\bimport\s*\(\s*['\"]([^'\"]+)['\"]")
REQUIRE_RE = re.compile(r"\brequire\s*\(\s*['\"]([^'\"]+)['\"]")
FOCUSED_TEST_RE = re.compile(r"\b(?:describe|it|suite|test)\.only\s*\(")


@dataclass(frozen=True)
class Violation:
    rule: str
    path: str
    line: int
    message: str
    symbol: str = ""

    @property
    def key(self) -> str:
        return f"{self.rule}:{self.path}:{self.symbol or '-'}"


@dataclass(frozen=True)
class SymbolRule:
    name: str
    pattern: re.Pattern[str]
    message: str
    applies_to: tuple[str, ...] = ()
    allowed_prefixes: tuple[str, ...] = ()


SYMBOL_RULES = (
    SymbolRule(
        name="subprocess-ownership",
        pattern=re.compile(r"\bGio\.Subprocess\b"),
        message=(
            "Gio.Subprocess must be behind a port/adapter "
            "(TransferEngine, SystemLauncher, or AuthProcess)."
        ),
        allowed_prefixes=("src/adapters/", "src/composition/", "app/gateway/",
                          "extension/system-launcher.js", "bin/", "tests/"),
    ),
    SymbolRule(
        name="dbus-ownership",
        pattern=re.compile(r"\bGio\.bus_get_sync\b"),
        message=(
            "D-Bus connections belong in src/adapters/dbus, app/gateway, "
            "or extension/daemon-client.js."
        ),
        allowed_prefixes=(
            "src/adapters/",
            "app/daemon-client.js",
            "app/gateway/",
            "extension/daemon-client.js",
            "bin/",
            "tests/",
        ),
    ),
    SymbolRule(
        name="domain-no-gio",
        pattern=re.compile(r"\bGio\."),
        message="Domain/application/ports code must not use Gio.",
        applies_to=PURE_PREFIXES,
    ),
    SymbolRule(
        name="domain-no-glib",
        pattern=re.compile(r"\bGLib\."),
        message="Domain/application/ports code must not use GLib.",
        applies_to=PURE_PREFIXES,
    ),
)

RULE_DESCRIPTIONS = {
    "domain-no-gi-import": "domain/application/ports cannot import gi:// modules",
    "domain-no-adapter-import": "domain/application cannot import adapters or composition",
    "extension-no-src-import": "the GNOME extension must talk to the daemon over D-Bus",
    "app-no-runtime-import": "the GTK app must use its daemon gateway, not daemon internals",
    "app-no-extension-import": "the GTK app must be independent from the extension",
    "tests-not-imported": "production code cannot import test modules",
    "extension-metadata": "extension/metadata.json has the required GNOME Shell fields",
    "focused-tests": "test files must not contain focused (.only) tests",
    "subprocess-ownership": "Gio.Subprocess is only allowed behind adapters/composition",
    "dbus-ownership": "Gio.bus_get_sync is only allowed in D-Bus boundaries",
    "domain-no-gio": "domain/application/ports cannot use Gio",
    "domain-no-glib": "domain/application/ports cannot use GLib",
}


def iter_js_files(root: Path) -> Iterator[tuple[str, Path]]:
    """Yield repository-relative JS paths, excluding generated directories."""
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in JS_SUFFIXES:
            continue
        relative = path.relative_to(root)
        if any(part in EXCLUDED_DIRS for part in relative.parts):
            continue
        yield relative.as_posix(), path


def strip_js_comments(text: str) -> str:
    """Blank JS comments while preserving newlines and string contents."""
    result: list[str] = []
    index = 0
    length = len(text)
    state = "code"
    while index < length:
        char = text[index]
        next_char = text[index + 1] if index + 1 < length else ""

        if state == "code":
            if char == "/" and next_char == "/":
                state = "line-comment"
                result.extend((" ", " "))
                index += 2
                continue
            if char == "/" and next_char == "*":
                state = "block-comment"
                result.extend((" ", " "))
                index += 2
                continue
            if char == "'":
                state = "single-quote"
            elif char == '"':
                state = "double-quote"
            elif char == "`":
                state = "template"
            result.append(char)
            index += 1
            continue

        if state == "line-comment":
            if char == "\n":
                state = "code"
                result.append(char)
            else:
                result.append(" ")
            index += 1
            continue

        if state == "block-comment":
            if char == "*" and next_char == "/":
                state = "code"
                result.extend((" ", " "))
                index += 2
                continue
            result.append("\n" if char == "\n" else " ")
            index += 1
            continue

        result.append(char)
        if char == "\\" and index + 1 < length:
            result.append(text[index + 1])
            index += 2
            continue
        if (
            (state == "single-quote" and char == "'")
            or (state == "double-quote" and char == '"')
            or (state == "template" and char == "`")
        ):
            state = "code"
        index += 1
    return "".join(result)


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def parse_js_imports(text: str) -> list[tuple[int, str]]:
    """Return ``(line, specifier)`` for static, dynamic and require imports."""
    stripped = strip_js_comments(text)
    found: dict[tuple[int, str], None] = {}
    for pattern in (STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE):
        for match in pattern.finditer(stripped):
            found[(_line_number(stripped, match.start()), match.group(1))] = None
    return sorted(found)


def resolve_import(relative_path: str, specifier: str) -> str | None:
    """Resolve a project-relative import, or return None for external modules."""
    if specifier.startswith("."):
        resolved = posixpath.normpath(
            posixpath.join(posixpath.dirname(relative_path), specifier)
        )
        return resolved
    if specifier.startswith("/"):
        return posixpath.normpath(specifier.lstrip("/"))
    if specifier.startswith(("app/", "extension/", "scripts/", "src/", "tests/")):
        return posixpath.normpath(specifier)
    return None


def check_import_rules(relative_path: str, text: str) -> list[Violation]:
    violations: list[Violation] = []
    for line, specifier in parse_js_imports(text):
        resolved = resolve_import(relative_path, specifier)

        if relative_path.startswith(PURE_PREFIXES):
            if specifier.startswith("gi://"):
                violations.append(
                    Violation(
                        "domain-no-gi-import",
                        relative_path,
                        line,
                        f"{specifier} is a GI import; this layer must be pure.",
                        specifier,
                    )
                )
            if resolved and resolved.startswith(ADAPTER_PREFIXES):
                violations.append(
                    Violation(
                        "domain-no-adapter-import",
                        relative_path,
                        line,
                        f"this layer must not import {resolved}.",
                        resolved,
                    )
                )

        if relative_path.startswith(EXTENSION_PREFIX) and resolved and resolved.startswith(
            ("src/", "app/")
        ):
            violations.append(
                Violation(
                    "extension-no-src-import",
                    relative_path,
                    line,
                    f"the extension must use D-Bus, not import {resolved}.",
                    resolved,
                )
            )

        if relative_path.startswith(APP_PREFIX) and resolved and resolved.startswith(
            EXTENSION_PREFIX
        ):
            violations.append(
                Violation(
                    "app-no-extension-import",
                    relative_path,
                    line,
                    f"the app must be independent from the extension, not import {resolved}.",
                    resolved,
                )
            )

        if relative_path.startswith(APP_PREFIX) and resolved in FORBIDDEN_APP_IMPORTS:
            violations.append(
                Violation(
                    "app-no-runtime-import",
                    relative_path,
                    line,
                    f"the app must use its gateway, not import {resolved}.",
                    resolved,
                )
            )

        if not relative_path.startswith(TESTS_PREFIX) and resolved and resolved.startswith(
            TESTS_PREFIX
        ):
            violations.append(
                Violation(
                    "tests-not-imported",
                    relative_path,
                    line,
                    f"production code must not import {resolved}.",
                    resolved,
                )
            )
    return violations


def check_symbol_rules(relative_path: str, text: str) -> list[Violation]:
    violations: list[Violation] = []
    for rule in SYMBOL_RULES:
        if rule.applies_to and not relative_path.startswith(rule.applies_to):
            continue
        if rule.allowed_prefixes and relative_path.startswith(rule.allowed_prefixes):
            continue
        for match in rule.pattern.finditer(text):
            violations.append(
                Violation(
                    rule.name,
                    relative_path,
                    _line_number(text, match.start()),
                    rule.message,
                    match.group(0),
                )
            )
    return violations


def check_focused_tests(relative_path: str, text: str) -> list[Violation]:
    if not relative_path.startswith(TESTS_PREFIX):
        return []
    return [
        Violation(
            "focused-tests",
            relative_path,
            _line_number(text, match.start()),
            "remove .only so the full test suite runs.",
            ".only",
        )
        for match in FOCUSED_TEST_RE.finditer(strip_js_comments(text))
    ]


def _metadata_key_line(text: str, key: str) -> int:
    match = re.search(rf'"{re.escape(key)}"\s*:', text)
    return _line_number(text, match.start()) if match else 1


def check_extension_metadata(root: Path) -> list[Violation]:
    path = root / "extension" / "metadata.json"
    if not path.exists():
        return []
    relative = "extension/metadata.json"
    text = path.read_text(encoding="utf-8", errors="replace")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return [
            Violation(
                "extension-metadata",
                relative,
                exc.lineno,
                f"invalid JSON: {exc.msg}.",
                "json",
            )
        ]

    violations: list[Violation] = []
    if not isinstance(data, dict):
        return [
            Violation(
                "extension-metadata",
                relative,
                1,
                "metadata.json must contain a JSON object.",
                "json",
            )
        ]

    for key in ("uuid", "name", "description", "shell-version", "url"):
        if not data.get(key):
            violations.append(
                Violation(
                    "extension-metadata",
                    relative,
                    _metadata_key_line(text, key),
                    f"missing required field {key!r}.",
                    key,
                )
            )

    uuid = data.get("uuid")
    if isinstance(uuid, str) and not uuid.endswith("@chrismaille.github.io"):
        violations.append(
            Violation(
                "extension-metadata",
                relative,
                _metadata_key_line(text, "uuid"),
                "uuid must use the chrismaille.github.io namespace.",
                "uuid",
            )
        )

    shell_versions = data.get("shell-version")
    if isinstance(shell_versions, list) and not all(
        isinstance(item, str) and item for item in shell_versions
    ):
        violations.append(
            Violation(
                "extension-metadata",
                relative,
                _metadata_key_line(text, "shell-version"),
                "shell-version must be a non-empty list of strings.",
                "shell-version",
            )
        )

    url = data.get("url")
    if isinstance(url, str) and not url.startswith("https://"):
        violations.append(
            Violation(
                "extension-metadata",
                relative,
                _metadata_key_line(text, "url"),
                "url must use https.",
                "url",
            )
        )
    return violations


def scan(root: Path) -> list[Violation]:
    """Run every rule against every project file under *root*."""
    violations: list[Violation] = []
    for relative_path, path in iter_js_files(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        violations.extend(check_import_rules(relative_path, text))
        violations.extend(check_symbol_rules(relative_path, text))
        violations.extend(check_focused_tests(relative_path, text))
    violations.extend(check_extension_metadata(root))
    violations.sort(key=lambda item: (item.path, item.line, item.rule, item.symbol))
    return violations


def load_baseline(path: Path) -> dict[str, int]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("baseline must be a JSON object")
    baseline: dict[str, int] = {}
    for key, count in data.items():
        if not isinstance(key, str) or not isinstance(count, int) or count < 0:
            raise ValueError("baseline values must be non-negative integers")
        baseline[key] = count
    return baseline


def split_baseline(
    violations: Iterable[Violation], baseline: dict[str, int]
) -> tuple[list[Violation], int, int]:
    """Return ``(new_violations, baselined_count, stale_count)``."""
    seen: Counter[str] = Counter()
    new: list[Violation] = []
    for violation in violations:
        key = violation.key
        if seen[key] < baseline.get(key, 0):
            seen[key] += 1
            continue
        new.append(violation)
    baselined = sum(min(seen[key], baseline.get(key, 0)) for key in seen)
    stale = sum(max(0, count - seen.get(key, 0)) for key, count in baseline.items())
    return new, baselined, stale


def baseline_counts(violations: Iterable[Violation]) -> dict[str, int]:
    return dict(sorted(Counter(item.key for item in violations).items()))
