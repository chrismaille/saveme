from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from omega_lint_lib.cli import main  # noqa: E402
from omega_lint_lib.rules import (  # noqa: E402
    baseline_counts,
    check_extension_metadata,
    load_baseline,
    parse_js_imports,
    resolve_import,
    scan,
    split_baseline,
)


class OmegaLintRulesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write(self, relative: str, content: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def rules(self):
        return [item.rule for item in scan(self.root)]

    def test_parses_static_dynamic_and_require_imports(self) -> None:
        imports = parse_js_imports(
            "\n".join(
                [
                    "import Gio from 'gi://Gio';",
                    "import {",
                    "  thing,",
                    "} from './thing.js';",
                    "const lazy = import('./lazy.js');",
                    "const old = require('legacy');",
                    "// import ignored from './ignored.js';",
                    "/* import alsoIgnored from './ignored.js'; */",
                ]
            )
        )
        self.assertEqual(
            imports,
            [
                (1, "gi://Gio"),
                (2, "./thing.js"),
                (5, "./lazy.js"),
                (6, "legacy"),
            ],
        )

    def test_resolves_relative_and_project_imports(self) -> None:
        self.assertEqual(
            resolve_import("app/window.js", "../src/daemon.js"),
            "src/daemon.js",
        )
        self.assertEqual(
            resolve_import("src/application/job-service.js", "../ports/clock.js"),
            "src/ports/clock.js",
        )
        self.assertEqual(resolve_import("app/window.js", "src/jobs.js"), "src/jobs.js")
        self.assertIsNone(resolve_import("app/window.js", "gi://Gio"))

    def test_pure_layers_cannot_import_gi_or_adapters(self) -> None:
        self.write(
            "src/application/service.js",
            "import Gio from 'gi://Gio';\n"
            "import {Engine} from '../adapters/rclone/engine.js';\n",
        )
        self.assertEqual(
            self.rules(),
            ["domain-no-gi-import", "domain-no-adapter-import"],
        )

    def test_extension_cannot_import_runtime(self) -> None:
        self.write("extension/extension.js", "import {daemon} from '../src/daemon.js';\n")
        self.assertEqual(self.rules(), ["extension-no-src-import"])

    def test_app_cannot_import_daemon_internals(self) -> None:
        self.write("app/window.js", "import {Runner} from '../src/runner.js';\n")
        self.assertEqual(self.rules(), ["app-no-runtime-import"])

    def test_app_cannot_import_extension(self) -> None:
        self.write(
            "app/window.js",
            "import {statusLabel} from '../extension/presentation.js';\n",
        )
        self.assertEqual(self.rules(), ["app-no-extension-import"])

    def test_production_cannot_import_tests(self) -> None:
        self.write("src/helper.js", "import {x} from '../tests/helpers.js';\n")
        self.assertEqual(self.rules(), ["tests-not-imported"])

    def test_subprocess_and_dbus_ownership(self) -> None:
        self.write(
            "src/adapters/rclone/engine.js",
            "const child = Gio.Subprocess.new(['rclone'], 0);\n"
            "const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);\n",
        )
        self.write("src/runner.js", "const child = Gio.Subprocess.new(['rclone'], 0);\n")
        self.write("src/daemon.js", "const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);\n")
        self.assertEqual(
            self.rules(),
            ["dbus-ownership", "subprocess-ownership"],
        )

    def test_focused_tests_are_rejected(self) -> None:
        self.write("tests/unit/example.test.js", "test.only('focused', () => {});\n")
        self.assertEqual(self.rules(), ["focused-tests"])

    def test_extension_metadata(self) -> None:
        self.write(
            "extension/metadata.json",
            json.dumps(
                {
                    "uuid": "saveme@chrismaille.github.io",
                    "name": "SaveMe",
                    "description": "test",
                    "shell-version": ["50"],
                    "url": "https://example.invalid",
                }
            ),
        )
        self.assertEqual(check_extension_metadata(self.root), [])

        self.write(
            "extension/metadata.json",
            json.dumps(
                {
                    "uuid": "wrong@example.invalid",
                    "name": "SaveMe",
                    "shell-version": [],
                    "url": "http://example.invalid",
                }
            ),
        )
        self.assertEqual(
            [item.rule for item in check_extension_metadata(self.root)],
            ["extension-metadata"] * 4,
        )

    def test_baseline_counts_allow_existing_but_not_new_occurrences(self) -> None:
        self.write("src/runner.js", "const a = Gio.Subprocess.new(['a'], 0);\n")
        violations = scan(self.root)
        self.assertEqual(len(violations), 1)

        new, baselined, stale = split_baseline(violations, baseline_counts(violations))
        self.assertEqual((len(new), baselined, stale), (0, 1, 0))

        self.write(
            "src/runner.js",
            "const a = Gio.Subprocess.new(['a'], 0);\n"
            "const b = Gio.Subprocess.new(['b'], 0);\n",
        )
        violations = scan(self.root)
        new, baselined, _ = split_baseline(violations, baseline_counts(violations[:1]))
        self.assertEqual((len(new), baselined), (1, 1))

    def test_cli_updates_and_reads_baseline(self) -> None:
        self.write("src/runner.js", "const a = Gio.Subprocess.new(['a'], 0);\n")
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(main(["--root", str(self.root), "--update-baseline"]), 0)
        baseline = json.loads((self.root / ".omega-lint-baseline.json").read_text())
        self.assertEqual(sum(baseline.values()), 1)

        with redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(main(["--root", str(self.root)]), 0)

        self.write(
            "src/runner.js",
            "const a = Gio.Subprocess.new(['a'], 0);\n"
            "const b = Gio.Subprocess.new(['b'], 0);\n",
        )
        with redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(main(["--root", str(self.root)]), 1)
        self.assertIn("1 new violation", stderr.getvalue())

    def test_load_baseline_rejects_invalid_values(self) -> None:
        self.write(".omega-lint-baseline.json", '{"rule:file:key": -1}')
        with self.assertRaises(ValueError):
            load_baseline(self.root / ".omega-lint-baseline.json")


if __name__ == "__main__":
    unittest.main()
