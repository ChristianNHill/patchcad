#!/usr/bin/env python3
"""Structural checks on the kernel's own source, no service and no build needed.

    uv run python check_module.py

Exists because index-based source edits deleted and duplicated code three times
in one afternoon, and every time the suites stayed green. A duplicate `def` is
silent, because Python takes the last one, so a fix can live in a shadowed copy
and never run. A deleted constant is silent until the one gate that reads it is
exercised. Both are one AST walk away from being impossible to miss.
"""
from __future__ import annotations

import ast
import builtins
import collections
import pathlib
import sys

SRC = pathlib.Path(__file__).parent / "src" / "patchcad_kernel"

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f' — {detail}' if detail else ''}")
    if not ok:
        failures.append(name)


for path in sorted(SRC.glob("*.py")):
    tree = ast.parse(path.read_text(), filename=str(path))

    # A second definition silently wins. That is how a fix ended up in a copy
    # nothing called, while the check covering it passed either way.
    defs = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    dupe_defs = sorted(k for k, v in collections.Counter(defs).items() if v > 1)
    check(f"{path.name}: no duplicate top-level definitions", not dupe_defs, ", ".join(dupe_defs))

    consts = [t.id for n in tree.body if isinstance(n, ast.Assign)
              for t in n.targets if isinstance(t, ast.Name) and t.id.isupper()]
    dupe_consts = sorted(k for k, v in collections.Counter(consts).items() if v > 1)
    check(f"{path.name}: no duplicate module constants", not dupe_consts, ", ".join(dupe_consts))

    # A name used but never bound anywhere in the module: the signature of a
    # deletion that took a neighbour with it.
    bound = set(dir(builtins)) | {"__file__", "__name__", "__doc__"}
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(n.name)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
            bound.add(n.id)
        elif isinstance(n, ast.arg):
            bound.add(n.arg)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                bound.add((a.asname or a.name).split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bound.add(n.name)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            bound.update(n.names)
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    missing = sorted(u for u in used - bound if not u.startswith("__"))
    check(f"{path.name}: every name used is bound", not missing, ", ".join(missing))

print()
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
print("module structure clean")
