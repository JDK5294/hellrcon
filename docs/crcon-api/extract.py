"""Enumerate CRCON's whole HTTP API by parsing the source with ast — no imports, no deps.

Every endpoint is `POST/GET /api/<name>`. The catalogue comes from three places:
  * rconweb/api/views.py ENDPOINT_PERMISSIONS  — the auto-registered ones (name -> permission)
  * rconweb/api/views.py ENDPOINT_HTTP_METHODS — which verbs each takes
  * rconweb/api/urls.py  `endpoints`           — hand-written ones (auth, scoreboards, ...)
Signatures/return types come from the RconAPI and Rcon classes; response shapes from rcon/types.py.
"""
import ast, json, sys, re
from pathlib import Path

ROOT = Path(sys.argv[1])


def un(node):
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:
        return "?"


def public_methods(path, classname):
    tree = ast.parse(path.read_text())
    out = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == classname:
            for fn in node.body:
                if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) or fn.name.startswith("_"):
                    continue
                args, pos = [], fn.args.args[1:]
                defaults = [None] * (len(pos) - len(fn.args.defaults)) + list(fn.args.defaults)
                for a, d in zip(pos, defaults):
                    args.append({"name": a.arg, "type": un(a.annotation), "default": un(d)})
                for a, d in zip(fn.args.kwonlyargs, fn.args.kw_defaults):
                    args.append({"name": a.arg, "type": un(a.annotation), "default": un(d)})
                doc = ast.get_docstring(fn)
                out[fn.name] = {
                    "args": args,
                    "returns": un(fn.returns),
                    "doc": (doc or "").strip().split("\n\n")[0].replace("\n", " ").strip() or None,
                }
    return out


def dict_literal(path, varname):
    """Pull `NAME: ann = { key: value, ... }` out of a module as {keystr: valuestr}."""
    tree = ast.parse(path.read_text())
    for node in tree.body:
        target = None
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target, value = node.target.id, node.value
        elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            target, value = node.targets[0].id, node.value
        if target != varname or not isinstance(value, ast.Dict):
            continue
        out = {}
        for k, v in zip(value.keys, value.values):
            key = un(k)
            key = key.split(".")[-1]  # rcon_api.kick -> kick
            out[key] = un(v)
        return out
    return {}


def typed_dicts(path):
    """Every TypedDict / Enum in rcon/types.py — the response shapes."""
    tree = ast.parse(path.read_text())
    out = {}
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        bases = [un(b) for b in node.bases]
        kind = ("TypedDict" if any("TypedDict" in (b or "") for b in bases)
                else "Enum" if any("Enum" in (b or "") for b in bases)
                else "class")
        fields = {}
        for st in node.body:
            if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                fields[st.target.id] = un(st.annotation)
            elif kind == "Enum" and isinstance(st, ast.Assign) and isinstance(st.targets[0], ast.Name):
                fields[st.targets[0].id] = un(st.value)
        if fields:
            out[node.name] = {"kind": kind, "bases": bases, "fields": fields}
    return out


def manual_endpoints(path):
    src = path.read_text()
    body = src.split("endpoints: list[tuple[str, Callable]] = [", 1)[1].split("] + [", 1)[0]
    return sorted(set(re.findall(r'"([a-z0-9_]+)"', body)))


views = ROOT / "rconweb" / "api" / "views.py"
perms = dict_literal(views, "ENDPOINT_PERMISSIONS")
verbs = dict_literal(views, "RCON_ENDPOINT_HTTP_METHODS")
sigs = {**public_methods(ROOT / "rcon" / "commands.py", "ServerCtl"),
        **public_methods(ROOT / "rcon" / "rcon.py", "Rcon"),
        **public_methods(ROOT / "rcon" / "api_commands.py", "RconAPI")}
manual = manual_endpoints(ROOT / "rconweb" / "api" / "urls.py")

# The hand-written endpoints are plain Django views living in rconweb/api/*.py. They take
# `request`, so there is no typed signature to read — but the module and docstring still say what
# each one is, and that is what makes the catalogue usable without the source.
views_dir = ROOT / "rconweb" / "api"
django_views = {}
for f in sorted(views_dir.glob("*.py")):
    tree = ast.parse(f.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            doc = ast.get_docstring(node)
            django_views.setdefault(node.name, {
                "module": f"rconweb/api/{f.name}",
                "doc": (doc or "").strip().split("\n\n")[0].replace("\n", " ").strip() or None,
            })

endpoints = {}
for name in sorted(set(perms) | set(manual)):
    s = sigs.get(name, {})
    dv = django_views.get(name, {})
    endpoints[name] = {
        "permission": perms.get(name),
        "http": verbs.get(name),
        "args": s.get("args", []),
        "returns": s.get("returns"),
        "doc": s.get("doc") or dv.get("doc"),
        "module": dv.get("module") if name not in sigs else None,
        "source": "auto" if name in perms else "manual",
    }

print(json.dumps({
    "endpoints": endpoints,
    "types": typed_dicts(ROOT / "rcon" / "types.py"),
}, indent=2))
