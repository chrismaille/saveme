"""Project-specific lint rules for SaveMe.

The public entry point is ``scripts/omega_lint.py``.  Rules are intentionally
small and deterministic so they can run in pre-commit and in unit tests.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "0.1.0"
