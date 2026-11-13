"""Command-line interface for the SaveMe Omega lint rules."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .rules import (
    RULE_DESCRIPTIONS,
    baseline_counts,
    load_baseline,
    scan,
    split_baseline,
)


def _write_baseline(path: Path, counts: dict[str, int]) -> None:
    path.write_text(json.dumps(counts, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="omega-lint",
        description=(
            "Check SaveMe's custom architecture rules. The linter scans every "
            "project file, staged or not."
        ),
    )
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--baseline",
        default=".omega-lint-baseline.json",
        help="baseline file relative to --root",
    )
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="record current violations as the accepted baseline",
    )
    parser.add_argument(
        "--list-rules",
        action="store_true",
        help="print the custom rule names and exit",
    )
    args = parser.parse_args(argv)

    if args.list_rules:
        for name, description in sorted(RULE_DESCRIPTIONS.items()):
            print(f"{name}: {description}")
        return 0

    root = args.root.resolve()
    baseline_path = root / args.baseline
    try:
        violations = scan(root)
        if args.update_baseline:
            counts = baseline_counts(violations)
            _write_baseline(baseline_path, counts)
            print(f"omega-lint: wrote {sum(counts.values())} baseline violation(s)")
            return 0
        baseline = load_baseline(baseline_path)
        new, baselined, stale = split_baseline(violations, baseline)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"omega-lint: {exc}", file=sys.stderr)
        return 2

    for violation in new:
        print(
            f"{violation.path}:{violation.line}: {violation.rule}: "
            f"{violation.message} [{violation.symbol}]"
        )

    if new:
        print(
            f"omega-lint: {len(new)} new violation(s), {baselined} baselined",
            file=sys.stderr,
        )
        return 1

    suffix = f", {stale} stale" if stale else ""
    print(f"omega-lint: OK ({baselined} baselined{suffix})")
    return 0
