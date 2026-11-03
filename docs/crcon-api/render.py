"""Render catalogue.json into the two committed markdown tables.

The catalogue is machine-readable and the markdown is what people actually read, so both are
committed — but only the extractor was, which meant the tables could only be refreshed by hand and
in practice went stale. Now the whole chain is one command:

    python3 extract.py <path-to-hll_rcon_tool> > catalogue.json && python3 render.py

Deliberately dependency-free and deterministic: same catalogue in, byte-identical markdown out, so
a re-run against an unchanged release produces an empty diff and a real diff is all signal.
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
CAT = json.loads((HERE / "catalogue.json").read_text())


def cell(text):
    """A table cell: pipes escaped, newlines flattened — a doc line must not break the row."""
    return str(text).replace("|", r"\|").replace("\n", " ").strip()


def verbs(raw):
    """`http` is a stringified Python list ("['POST']") as the extractor found it in the source."""
    if not raw:
        return ""
    return ", ".join(v.strip(" '\"") for v in raw.strip("[]").split(",") if v.strip())


def signature(ep):
    """(args) → `returns`, or an em dash for the hand-written views that take a raw request.

    Keyed on `module` rather than on `source`: the manual endpoints the extractor traced back to a
    Django view have no signature to show and give their module in the notes instead, but the few
    it could not place (login, logout, reconnect_gameserver) still render their empty arg list.
    """
    if ep["module"]:
        return "—"
    parts = []
    for a in ep["args"]:
        s = a["name"]
        if a["type"]:
            s += f": {a['type']}"
        if a["default"]:
            s += f" = {a['default']}"
        parts.append(s)
    sig = f"({', '.join(parts)})"
    # No `returns` means the method carries no return annotation, which is not the same as
    # returning None — so the arrow is omitted rather than asserting a type the source never gave.
    return f"{sig} → `{ep['returns']}`" if ep["returns"] else sig


def endpoints_md():
    eps = CAT["endpoints"]
    rows = []
    for name in sorted(eps):
        ep = eps[name]
        perm = (ep["permission"] or "").strip("'\"")
        # A hand-written view gives its module even when it also has a docstring — that is the only
        # pointer to where the thing actually lives, so it is appended rather than replaced.
        note = " ".join(filter(None, [
            ep["doc"].split("\n")[0] if ep["doc"] else "",
            f"({ep['module']})" if ep["module"] else "",
        ]))
        rows.append(
            f"| `{name}` | {cell(verbs(ep['http']))} | `{cell(perm)}` | "
            f"{cell(signature(ep))} | {cell(note)} |"
        )
    return f"""# CRCON endpoints (generated)

{CREDIT}
Every one is `/api/<name>`. {len(eps)} endpoints, extracted from the CRCON source
with `ast` — see `docs/crcon-api.md` for the envelope, auth and how to read this table.

`auto` endpoints are registered from `ENDPOINT_PERMISSIONS` in `rconweb/api/views.py` and
wrap a method on `ServerCtl`/`Rcon`/`RconAPI`, so they have a real typed signature.
`manual` ones are Django views listed in `rconweb/api/urls.py`; they take the raw request,
so the module is given instead of a signature.

| Endpoint | Verbs | Permission | Signature → returns | Notes |
|---|---|---|---|---|
""" + "\n".join(rows) + "\n"


# Every generated page is CRCON's API read out of CRCON's own source, so each carries its credit.
CREDIT = """> Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool —
> Copyright (c) 2020 Julien Marechal. MIT License; full text in `third_party/crcon/LICENSE`.
"""


def type_block(name, t):
    """One type: a heading that names what it extends, then its fields or its values."""
    base = [b for b in t["bases"] if b not in ("TypedDict", "enum.Enum", "str")]
    head = f"### `{name}`" + (f" — extends `{base[0]}`" if base else "")
    if t["kind"] == "Enum":
        head = f"### `{name}`" + (" — extends `str`" if "str" in t["bases"] else "")
        cols = "| Name | Value |"
    else:
        cols = "| Field | Type |"
    lines = [head, "", cols, "|---|---|"]
    lines += [f"| `{f}` | `{cell(v)}` |" for f, v in t["fields"].items()]
    return "\n".join(lines)


def types_md():
    types = CAT["types"]
    # Three groups, because they answer different questions: what comes back, what the string
    # fields can hold, and the handful that extend another shape rather than standing alone.
    plain = {k: v for k, v in types.items() if v["kind"] == "TypedDict"}
    enums = {k: v for k, v in types.items() if v["kind"] == "Enum"}
    other = {k: v for k, v in types.items() if v["kind"] not in ("TypedDict", "Enum")}
    out = [f"""# CRCON response shapes (generated)

{CREDIT}
The {len(types)} types named in the endpoint table's `returns` column, from
`rcon/types.py`. TypedDicts are the JSON objects that come back inside the response
envelope's `result`; the enums are the string values those fields take.

## Response objects
"""]
    for group, heading in ((plain, None), (enums, "## Enums"), (other, "## Other")):
        if heading:
            out.append(f"\n{heading}\n")
        for name in sorted(group):
            out.append(type_block(name, group[name]))
            out.append("")
    return "\n".join(out).rstrip() + "\n"


(HERE / "endpoints.md").write_text(endpoints_md())
(HERE / "response-types.md").write_text(types_md())
print(f"wrote endpoints.md ({len(CAT['endpoints'])} endpoints) and response-types.md ({len(CAT['types'])} types)")
