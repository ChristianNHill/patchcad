#!/usr/bin/env python3
"""Structural checks on the kernel's own source, no service and no build needed.

    uv run python check_module.py

Exists because index-based source edits deleted and duplicated code three times
in one afternoon, and every time the suites stayed green. A duplicate `def` is
silent, because Python takes the last one, so a fix can live in a shadowed copy
and never run. A deleted constant is silent until the one gate that reads it is
exercised. Both are one AST walk away from being impossible to miss.

Scope of the duplicate check is the module body and each class body, covering
`def`, `class`, plain assignment, annotated assignment and tuple unpacking,
because all five are ways to rebind a name and the first version of this file
only caught two of them. Scope of the binding check is per function with its
enclosing chain, because one flat module-wide set of names let a local variable
stand in for a module constant that had been deleted.

Known blind spots, so the claim stays bounded, and each is checked rather than
assumed. A `def` DUPLICATED where one copy sits inside a module-level `if` or
`try` is missed, because those bodies are deliberately not treated as module
bindings: that is what keeps a legitimate `try: import ujson as json / except:
import json` from failing, so it is a trade rather than an oversight. Such a
def's BODY is load-checked, which it was not until the check learned to recurse
into non-def statements. Rebinding a local inside a function is not flagged at
all, since it is ordinary Python. A comprehension variable leaks into its
enclosing function scope, which is a miss and not noise. A walrus DOES count as
a binding, because its target is an ordinary Name store.
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
    """Names bound in THIS scope, not in scopes nested inside it.

    Walking into a nested def was the same defect this file exists to catch,
    one scope down: a name bound only inside an inner function vouched for the
    outer one, so `return HELPER` after an inner `HELPER = 1` read as bound.
    A nested def contributes its own name here and nothing from its body."""
    found: set[str] = set()

    def take(node: ast.AST, top: bool) -> None:
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            found.add(node.id)
        elif isinstance(node, ast.arg) and top:
            found.add(node.arg)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            found.update((a.asname or a.name).split(".")[0]
                         for a in node.names if a.name != "*")
        elif isinstance(node, ast.ExceptHandler) and node.name:
            found.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            found.update(node.names)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                found.add(child.name)  # the name binds here; the body does not
                continue
            take(child, top)

    for stmt in body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            found.add(stmt.name)
        else:
            take(stmt, True)
    return found


def nested_defs(node: ast.AST) -> list[ast.stmt]:
    """Definitions inside a non-def statement (a module-level `if`, a `try`),
    without descending into a definition's own body: that body is visited when
    the definition itself is handled."""
    out: list[ast.stmt] = []

    def rec(n: ast.AST) -> None:
        for child in ast.iter_child_nodes(n):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                out.append(child)
                continue
            rec(child)

    rec(node)
    return out


def loads_here(node: ast.AST) -> set[str]:
    """Names LOADED in this scope only, stopping at nested function and class
    bodies. Walking the whole subtree checked a method's `self` against its
    class's scope, which reported `self` unbound in every method."""
    out: set[str] = set()

    def rec(n: ast.AST) -> None:
        for child in ast.iter_child_nodes(n):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue  # its own scope, visited separately
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load):
                out.add(child.id)
            rec(child)

    rec(node)
    return out


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

    def sig_loads(fn: ast.AST) -> set[str]:
        """Names a definition evaluates in the scope AROUND it: decorators,
        default arguments, annotations, return annotation, base classes. These
        run when the enclosing body runs, not when the function is called, so a
        method default may read a class attribute even though the method body
        cannot."""
        parts: list[ast.AST] = list(getattr(fn, "decorator_list", []))
        if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            a = fn.args
            parts += [d for d in a.defaults + a.kw_defaults if d is not None]
            parts += [x.annotation for x in a.args + a.posonlyargs + a.kwonlyargs
                      if x.annotation is not None]
            parts += [x.annotation for x in (a.vararg, a.kwarg)
                      if x is not None and x.annotation is not None]
            if fn.returns is not None:
                parts.append(fn.returns)
        elif isinstance(fn, ast.ClassDef):
            parts += list(fn.bases) + [k.value for k in fn.keywords]
        out: set[str] = set()
        for part in parts:
            if isinstance(part, ast.Name) and isinstance(part.ctx, ast.Load):
                out.add(part.id)
            out |= loads_here(part)
        return out

    def visit(body: list[ast.stmt], for_stmts: set[str], for_defs: set[str]) -> None:
        """A class body needs two different scopes, which is why these are two
        arguments. Statements in the body see the class's own names, so a
        class-level comprehension or an attribute derived from a sibling
        resolves. Its methods do NOT: `TOL = 0.25` beside `def run` does not
        make a bare `TOL` inside run resolve. One shared set got the method
        right and reported a class-level comprehension unbound."""

        def handle_def(stmt: ast.stmt) -> None:
            own = local_binds(stmt.body)
            inner = for_defs | own
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                a = stmt.args
                inner |= {x.arg for x in a.args + a.posonlyargs + a.kwonlyargs}
                inner |= {x.arg for x in (a.vararg, a.kwarg) if x}
            # The signature evaluates OUT here, so it sees for_stmts.
            for nm in sig_loads(stmt):
                if nm not in for_stmts and nm not in module_bound:
                    missing.add(nm)
            body: set[str] = set()
            for sub in stmt.body:
                # A nested definition is handled on its own; folding its loads
                # in here checked a method's `self` against its class's scope.
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    continue
                body |= loads_here(sub)
            for nm in body:
                if nm not in inner and nm not in module_bound:
                    missing.add(nm)
            if isinstance(stmt, ast.ClassDef):
                visit(stmt.body, for_defs | own, for_defs)
            else:
                visit(stmt.body, inner, inner)

        for stmt in body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                handle_def(stmt)
            else:
                for nm in loads_here(stmt):
                    if nm not in for_stmts and nm not in module_bound:
                        missing.add(nm)
                # A def inside a module-level `if` or `try` was never load-checked
                # at all: this branch did not recurse, and loads_here skips defs
                # by design. gates.py defines expect and pose inside its
                # __main__ block, so those bodies were outside the check.
                for nested in nested_defs(stmt):
                    handle_def(nested)

    visit(tree.body, set(), set())
    named = sorted(u for u in missing if not u.startswith("__"))
    check(f"{path.name}: every name used is bound", not named, ", ".join(named))

print()
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
print("module structure clean")
