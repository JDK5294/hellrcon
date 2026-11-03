import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLayout, WidgetRegistry, ADMIN_WIDGETS, type WidgetDef } from "../src/index.ts";

const defs: WidgetDef[] = [
  { id: "a", title: "A", surface: "admin", defaultOrder: 10, defaultVisible: true, required: true },
  { id: "b", title: "B", surface: "admin", defaultOrder: 20, defaultVisible: true },
  { id: "c", title: "C", surface: "admin", defaultOrder: 30, defaultVisible: false },
];

test("resolveLayout: no saved config uses defaults, sorted by order", () => {
  const r = resolveLayout(defs, null);
  assert.deepEqual(r.map((w) => w.id), ["a", "b", "c"]);
  assert.equal(r.find((w) => w.id === "c")?.visible, false); // default hidden
});

test("resolveLayout: saved overrides reorder and toggle visibility", () => {
  const r = resolveLayout(defs, { items: [
    { widgetId: "b", visible: true, order: 5 }, // move B first
    { widgetId: "c", visible: true, order: 25 }, // reveal C
  ]});
  assert.deepEqual(r.map((w) => w.id), ["b", "a", "c"]);
  assert.equal(r.find((w) => w.id === "c")?.visible, true);
});

test("resolveLayout: required widgets can never be hidden", () => {
  const r = resolveLayout(defs, { items: [{ widgetId: "a", visible: false, order: 10 }] });
  assert.equal(r.find((w) => w.id === "a")?.visible, true); // forced visible
});

test("resolveLayout: new registered widgets appear even if not in saved config", () => {
  const r = resolveLayout(defs, { items: [{ widgetId: "a", visible: true, order: 10 }] });
  assert.ok(r.some((w) => w.id === "b")); // b was registered but absent from saved → still present
});

test("resolveLayout: stale saved entries (unknown widget) are dropped", () => {
  const r = resolveLayout(defs, { items: [{ widgetId: "ghost", visible: true, order: 1 }] });
  assert.ok(!r.some((w) => w.id === "ghost"));
  assert.equal(r.length, defs.length);
});

test("resolveLayout carries a plugin widget's view and pluginId through", () => {
  const withView = [
    ...defs,
    {
      id: "kf",
      title: "Kill Feed",
      surface: "admin" as const,
      defaultOrder: 5,
      defaultVisible: true,
      pluginId: "killfeed",
      view: { blocks: [{ type: "feed" as const, kinds: ["evt.kill"] }] },
    },
  ];
  const r = resolveLayout(withView, null);
  const kf = r.find((w) => w.id === "kf");
  assert.ok(kf);
  assert.equal(kf!.pluginId, "killfeed");
  assert.equal(kf!.view?.blocks[0]?.type, "feed");
});

test("registry lists by surface; ADMIN_WIDGETS all target admin", () => {
  const reg = new WidgetRegistry();
  ADMIN_WIDGETS.forEach((w) => reg.register(w));
  reg.register({ id: "x", title: "X", surface: "community", defaultOrder: 1, defaultVisible: true });
  assert.equal(reg.list("admin").length, ADMIN_WIDGETS.length);
  assert.equal(reg.list("community").length, 1);
});

test("register refuses to overwrite an existing id, and says so", () => {
  const reg = new WidgetRegistry();
  const first: WidgetDef = { id: "players", title: "Players", surface: "admin", defaultOrder: 20, defaultVisible: true };
  assert.equal(reg.register(first), true);
  // Silently accepting this used to remove the real Players entry from the nav.
  assert.equal(reg.register({ id: "players", title: "Impostor", surface: "admin", defaultOrder: 1, defaultVisible: true }), false);
  assert.equal(reg.list("admin")[0]?.title, "Players", "the original registration survives");
  assert.equal(reg.has("players"), true);
});

test("upsert overwrites where that is the intent", () => {
  const reg = new WidgetRegistry();
  reg.register({ id: "x", title: "One", surface: "admin", defaultOrder: 1, defaultVisible: true });
  reg.upsert({ id: "x", title: "Two", surface: "admin", defaultOrder: 1, defaultVisible: true });
  assert.equal(reg.list("admin")[0]?.title, "Two");
});

test("first-party widget ids are unique across surfaces (the registry is one flat map)", async () => {
  const { DASHBOARD_WIDGETS } = await import("../src/index.ts");
  const ids = [...ADMIN_WIDGETS, ...DASHBOARD_WIDGETS].map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, "two first-party widgets share an id, so one is unreachable");
});

test("resolveLayout: a saved size overrides the default, which falls back to 2x1", () => {
  const sized: WidgetDef[] = [
    { id: "s1", title: "S1", surface: "dashboard", defaultOrder: 1, defaultVisible: true, defaultSize: { w: 4, h: 2 } },
    { id: "s2", title: "S2", surface: "dashboard", defaultOrder: 2, defaultVisible: true },
  ];
  const r = resolveLayout(sized, { items: [{ widgetId: "s1", visible: true, order: 1, size: { w: 1, h: 3 } }] });
  assert.deepEqual(r.find((w) => w.id === "s1")?.size, { w: 1, h: 3 }, "saved size wins");
  assert.deepEqual(r.find((w) => w.id === "s2")?.size, { w: 2, h: 1 }, "no default size → 2x1");
});

/**
 * The panel hand-copies this module's widget vocabulary, and nothing checked that it still matches.
 *
 * `apps/panel` has no workspace dependency on `@app/widgets` (it is a static export that ships
 * without the monorepo), so `LayoutEditor.tsx` re-declares the block union and the value formats by
 * hand. Two separate unions means TypeScript is happy on both sides while they disagree — and the
 * disagreement only shows up in a browser, as a dashboard tile reading "Unsupported block" for a
 * widget the API served perfectly well. That exact drift has already happened once.
 *
 * A string comparison, deliberately: the point is to fail the build the moment a block type is
 * added on one side only, not to type-check the shapes.
 */
import { readFileSync } from "node:fs";

const CANON = new URL("../src/index.ts", import.meta.url);
const MIRROR = new URL("../../../apps/panel/components/LayoutEditor.tsx", import.meta.url);
const RENDERER = new URL("../../../apps/panel/components/WidgetRenderer.tsx", import.meta.url);

/** Every `type: "x"` naming a block variant, from either side's union. */
function blockTypes(url: URL): string[] {
  const src = readFileSync(url, "utf8");
  return [...new Set([...src.matchAll(/\btype:\s*"([a-z]+)"/g)].map((m) => m[1]!))].sort();
}

test("the panel's copy of the widget block types matches this one", () => {
  assert.deepEqual(blockTypes(MIRROR), blockTypes(CANON),
    "LayoutEditor.tsx has drifted from @app/widgets — a block on only one side renders as 'Unsupported block'");
});

test("the renderer actually handles every block type the model can express", () => {
  // The mirror agreeing is not enough: a type can exist in both unions and still have no branch in
  // the renderer, which is the same blank tile by a different route.
  const renderer = readFileSync(RENDERER, "utf8");
  const unhandled = blockTypes(CANON).filter((t) => !renderer.includes(`"${t}"`));
  assert.deepEqual(unhandled, [], "WidgetRenderer has no branch for these block types: " + unhandled.join(", "));
});

test("the panel's copy of the value formats matches this one", () => {
  const formats = (url: URL, re: RegExp) => {
    const m = re.exec(readFileSync(url, "utf8"));
    assert.ok(m, `could not find the ValueFormat union in ${url.pathname} — if it moved, update this test`);
    return [...new Set([...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!))].sort();
  };
  const canon = formats(CANON, /export type ValueFormat =([\s\S]*?);/);
  const mirror = formats(MIRROR, /export type ValueFormat =([^;]*);/);
  assert.deepEqual(mirror, canon, "LayoutEditor.tsx's ValueFormat has drifted from @app/widgets");
});
