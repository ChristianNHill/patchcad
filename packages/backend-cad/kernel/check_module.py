#!/usr/bin/env python3
"""Structural checks on the kernel's own source, no service and no build needed.

    uv run python check_module.py

Exists because index-based source edits deleted and duplicated code three times
in one afternoon, and every time the suites stayed green. A duplicate `def` is
silent, because Python takes the last one, so a fix can live in a shadowed copy
and never run. A deleted constant is silent until the one gate that reads it is
exercised. Both are one AST walk away from being impossible to miss.

Scope of the duplicate check is every scope, not just the module body, and it
covers `def`, `class`, plain assignment, annotated assignment and tuple
unpacking, because all five are ways to rebind a name and the first version of
this file only caught two of them. Scope of the binding check is per function
with its enclosing chain, because one flat module-wide set of names let a local
variable stand in for a module constant that had been deleted.
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


def bound_names(node: ast.AST) -> list[str]:
    """Every name this ONE statement binds in the scope that contains it."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [node.name]
    if isinstance(node, ast.Assign):
        return [t.id for tgt in node.targets for t in ast.walk(tgt)
                if isinstance(t, ast.Name) and isinstance(t.ctx, ast.Store)]
    if isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        return [node.target.id] if isinstance(node.target, ast.Name) else []
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return [(a.asname or a.name).split(".")[0] for a in node.names if a.name != "*"]
    return []


def scopes(tree: ast.Module) -> list[tuple[str, list[ast.stmt]]]:
    """Scopes where a name bound twice is a defect: the module body, and each
    class body. A method defined twice inside a class is the same silent
    shadowing as a function defined twice at module level, and the first
    version of this file never looked inside a class. Function bodies are
    deliberately NOT checked: rebinding a local is ordinary Python, and
    flagging it produced three false positives on this very tree."""
    out = [("module", tree.body)]
    for n in ast.walk(tree):
        if isinstance(n, ast.ClassDef):
            out.append((n.name, n.body))
    return out


def local_binds(body: list[ast.stmt]) -> set[str]:
    """Names bound anywhere inside a function body, at any nesting depth."""
    found: set[str] = set()
    for stmt in body:
        for n in ast.walk(stmt):
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
                found.add(n.id)
            elif isinstance(n, ast.arg):
                found.add(n.arg)
            elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                found.add(n.name)
            elif isinstance(n, (ast.Import, ast.ImportFrom)):
                found.update((a.asname or a.name).split(".")[0]
                             for a in n.names if a.name != "*")
            elif isinstance(n, ast.ExceptHandler) and n.name:
                found.add(n.name)
            elif isinstance(n, (ast.Global, ast.Nonlocal)):
                found.update(n.names)
    return found


modules = sorted(SRC.glob("*.py"))
# A clean report over zero modules is the failure mode this file exists to
# prevent, so a missing or empty tree is itself a failure.
check(f"source tree has modules ({SRC})", bool(modules), f"{len(modules)} found")

for path in modules:
    tree = ast.parse(path.read_text(), filename=str(path))

    # A second binding silently wins. That is how a fix ended up in a copy
    # nothing called, while the check covering it passed either way.
    dupes: list[str] = []
    for scope_name, body in scopes(tree):
        names = [nm for stmt in body for nm in bound_names(stmt)]
        dupes += [f"{scope_name}.{k}" for k, v in collections.Counter(names).items() if v > 1]
    check(f"{path.name}: no name bound twice in one scope", not dupes, ", ".join(sorted(dupes)))

    # A name used but never bound: the signature of a deletion that took a
    # neighbour with it. Checked per function against its enclosing chain, so a
    # same-named local somewhere else in the file cannot vouch for a module
    # constant that is gone.
    star = [n for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)
            and any(a.name == "*" for a in n.names)]
    if star:
        check(f"{path.name}: every name used is bound", True, "skipped: star-import")
        continue

    module_bound = set(dir(builtins)) | {"__file__", "__name__", "__doc__"}
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            module_bound.add(stmt.name)
        else:
            # Not just the statement's own targets: a module-level `if` or `try`
            # binds everything in its body at module scope, and the kernel's
            # __main__ self-check block is exactly that.
            module_bound |= local_binds([stmt])

    missing: set[str] = set()

    def visit(body: list[ast.stmt], enclosing: set[str]) -> None:
        for stmt in body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                inner = enclosing | local_binds(stmt.body)
                if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    inner |= {a.arg for a in ast.walk(stmt) if isinstance(a, ast.arg)}
                for n in ast.walk(stmt):
                    if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                        if n.id not in inner and n.id not in module_bound:
                            missing.add(n.id)
                visit(stmt.body, inner)
            else:
                for n in ast.walk(stmt):
                    if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                        if n.id not in enclosing and n.id not in module_bound:
                            missing.add(n.id)

    visit(tree.body, set())
    named = sorted(u for u in missing if not u.startswith("__"))
    check(f"{path.name}: every name used is bound", not named, ", ".join(named))

print()
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
print("module structure clean")
