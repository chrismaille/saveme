#!/usr/bin/env python3
"""Summarize GJS lcov coverage, optionally enforcing thresholds.

Usage:
  coverage.py COVERAGE.lcov [COVERAGE2.lcov ...] [options]

GJS produces lcov with --coverage-prefix=file:///path/to/repo
--coverage-output=DIR. This script maps the generated paths back to the
repository, merges multiple runs and prints line/branch/function coverage.
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path


class FileCoverage:
    def __init__(self, path: str):
        self.path = path
        self.lines: dict[int, int] = {}
        self.branches: dict[tuple[int, int, int], int] = {}
        self.functions: dict[str, int] = {}


def parse_lcov(path: Path, root: Path) -> dict[str, FileCoverage]:
    files: dict[str, FileCoverage] = {}
    current: FileCoverage | None = None
    root_marker = str(root).lstrip("/") + "/"
    for raw in path.read_text(errors="replace").splitlines():
        if raw.startswith("SF:"):
            sf = raw[3:]
            if root_marker in sf:
                rel = sf.split(root_marker, 1)[1]
            else:
                rel = sf
            current = files.setdefault(rel, FileCoverage(rel))
        elif current is None:
            continue
        elif raw.startswith("DA:"):
            line, count = raw[3:].split(",", 1)
            current.lines[int(line)] = current.lines.get(int(line), 0) + int(float(count))
        elif raw.startswith("BRDA:"):
            line, block, branch, taken = raw[5:].split(",", 3)
            key = (int(line), int(block), int(branch))
            value = 0 if taken == "-" else int(float(taken))
            current.branches[key] = current.branches.get(key, 0) + value
        elif raw.startswith("FNDA:"):
            count, name = raw[5:].split(",", 1)
            current.functions[name] = current.functions.get(name, 0) + int(float(count))
    return files


def merge(target: dict[str, FileCoverage], source: dict[str, FileCoverage]) -> None:
    for rel, incoming in source.items():
        current = target.setdefault(rel, FileCoverage(rel))
        for line, count in incoming.lines.items():
            current.lines[line] = current.lines.get(line, 0) + count
        for key, count in incoming.branches.items():
            current.branches[key] = current.branches.get(key, 0) + count
        for name, count in incoming.functions.items():
            current.functions[name] = current.functions.get(name, 0) + count


def pct(hit: int, found: int) -> float:
    return 100.0 * hit / found if found else 100.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("lcov", nargs="+", help="lcov file(s)")
    parser.add_argument("--root", default=".", help="repository root")
    parser.add_argument("--include", action="append", default=[],
                        help="include path prefix (repeatable)")
    parser.add_argument("--exclude", action="append", default=[],
                        help="exclude path prefix (repeatable)")
    parser.add_argument("--strip-prefix", action="append", default=[],
                        help="strip a generated output prefix (repeatable)")
    parser.add_argument("--min-lines", type=float, default=None)
    parser.add_argument("--min-branches", type=float, default=None)
    parser.add_argument("--min-functions", type=float, default=None)
    parser.add_argument("--all-files", action="store_true",
                        help="include unexecuted .js files under --include prefixes")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    includes = [item.strip("/") + "/" for item in args.include]
    excludes = [item.strip("/") + "/" for item in args.exclude]
    strip_prefixes = [item.strip("/") + "/" for item in args.strip_prefix]

    merged: dict[str, FileCoverage] = {}
    for name in args.lcov:
        parsed = parse_lcov(Path(name), root)
        for rel, cov in parsed.items():
            for prefix in strip_prefixes:
                if rel.startswith(prefix):
                    rel = rel[len(prefix):]
                    break
            merge(merged, {rel: cov})

    if args.all_files:
        for prefix in includes:
            for file in sorted((root / prefix).rglob("*.js")):
                rel = str(file.relative_to(root))
                merged.setdefault(rel, FileCoverage(rel))

    rows = []
    for rel, cov in sorted(merged.items()):
        if includes and not any(rel.startswith(prefix) for prefix in includes):
            continue
        if any(rel.startswith(prefix) for prefix in excludes):
            continue
        line_found = len(cov.lines)
        line_hit = sum(1 for count in cov.lines.values() if count > 0)
        branch_found = len(cov.branches)
        branch_hit = sum(1 for count in cov.branches.values() if count > 0)
        fn_found = len(cov.functions)
        fn_hit = sum(1 for count in cov.functions.values() if count > 0)
        rows.append((rel, line_hit, line_found, branch_hit, branch_found, fn_hit, fn_found))

    if not rows:
        print("No coverage records matched.", file=sys.stderr)
        return 1

    print(f"{'file':60} {'lines':>14} {'branches':>14} {'functions':>14}")
    print("-" * 106)
    total = [0, 0, 0, 0, 0, 0]
    for rel, lh, lf, bh, bf, fh, ff in rows:
        print(f"{rel:60} {lh:6}/{lf:<7} {bh:6}/{bf:<7} {fh:6}/{ff:<7}")
        total[0] += lh
        total[1] += lf
        total[2] += bh
        total[3] += bf
        total[4] += fh
        total[5] += ff

    lh, lf, bh, bf, fh, ff = total
    print("-" * 106)
    print(f"{'TOTAL':60} {lh:6}/{lf:<7} {bh:6}/{bf:<7} {fh:6}/{ff:<7}")
    print(f"{'coverage':60} "
          f"{pct(lh, lf):6.1f}%       {pct(bh, bf):6.1f}%       {pct(fh, ff):6.1f}%")

    failed = False
    if args.min_lines is not None and pct(lh, lf) < args.min_lines:
        print(f"FAIL: line coverage {pct(lh, lf):.1f}% < {args.min_lines}%", file=sys.stderr)
        failed = True
    if args.min_branches is not None and pct(bh, bf) < args.min_branches:
        print(f"FAIL: branch coverage {pct(bh, bf):.1f}% < {args.min_branches}%", file=sys.stderr)
        failed = True
    if args.min_functions is not None and pct(fh, ff) < args.min_functions:
        print(f"FAIL: function coverage {pct(fh, ff):.1f}% < {args.min_functions}%", file=sys.stderr)
        failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
