/**
 * What an action changed, read off its record in the audit trail: each setting that moved, where
 * it sits, and what it was and became — for the trail's detail view (GET /api/audit/:id).
 *
 * Where the two sides come from, best first:
 *  - recorded: the record holds both, the settings as they stood (`before`) and what the save set
 *    (`after`, `patch` or `config`). Settings saves write `before` now (priorOf).
 *  - version: rules, map sets and vote schedules keep every save's before and after in their
 *    version history; the record is matched to its save there by what was saved and when. Read
 *    only by whoever may read that history.
 *  - previous: an auto settings save from before saves wrote `before` is compared with the save
 *    before it on record. When an older template apply, which kept no settings on record, came
 *    between, there is nothing to compare with: the answer says so and lists what the save set.
 *
 * The wording is the panel's own: a profile by its name, a schedule condition as its editor says
 * it, a game setting by the game's label for it, a permission by its name and server.
 */
import { APP_SETTINGS, FEATURE_PRESETS, type AuditRow, type ConfigVersionKind } from "@app/db";
import { canAnywhere, type Grant } from "@app/access";
import { getGame } from "@app/games";
import type { AppContext } from "./context.js";
import { configFieldsFor } from "./routes/kit.js";

/** One setting that moved: where it sits, in words, and how it read before and after. A side that
 *  is null did not exist then: the setting, or what it sits in, was added or removed. */
export interface AuditChange {
  where: string[];
  before: string | null;
  after: string | null;
}

export interface AuditChanges {
  /** recorded / version / previous: see the module comment. set: nothing to compare with, and
   *  `items` are what the action set (each `before` null), `note` says why. */
  basis: "recorded" | "version" | "previous" | "set";
  items: AuditChange[];
  /** previous: the save this one was compared with. */
  since?: { ts: string; actorName: string };
  note?: string;
  /** The record's data fields these were read from — the detail view does not list them again. */
  used: string[];
}

type Plain = Record<string, unknown>;
/** Lists longer than this are compared by what was added and removed. */
const WHOLE_LIST = 6;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** "daysOfWeek" → "Days of week": a key nobody gave words to, readable all the same. */
export function words(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.:-]+/g, " ").trim().toLowerCase();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : key;
}

/** The same value, whatever order its keys were written in. */
function stable(v: unknown): string {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : isPlain(x) ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, norm(x[k])])) : x;
  return JSON.stringify(norm(v)) ?? "";
}

/** How a value reads. Nothing, and an empty list, read as not set (null). */
export function show(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return v === "" ? "(empty)" : v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.length ? v.map((x) => show(x) ?? "—").join(", ") : null;
  if (isPlain(v)) {
    const parts = Object.entries(v).map(([k, x]) => [k, show(x), isPlain(x)] as const).filter(([, x]) => x !== null)
      .map(([k, x, nested]) => `${words(k)}: ${nested ? `(${x})` : x}`);
    return parts.length ? parts.join("; ") : null;
  }
  return String(v);
}

/** How one level of a record reads. */
interface Shape {
  /** The words for a key at this level; null leaves the level out of the path. */
  label?(key: string): string | null;
  /** The shape of what sits under a key. */
  child?(key: string): Shape;
  /** When the value here is a list of records: how its entries are told apart and named. */
  entries?: Entries;
  /** Keys not compared here — an entry's own name, which its path already says. */
  ignore?: readonly string[];
}
interface Entries {
  id(v: Plain, i: number): string;
  name(v: Plain, i: number): string;
  /** How an entry on both sides is compared; without one, an entry is compared whole. */
  shape?: Shape;
  /** One line for an entry added or removed, instead of each of its settings. */
  whole?(v: Plain): string | null;
  /** A list where order counts: the line that says it changed. */
  order?: string;
}

const GENERIC: Shape = {
  label: words,
  child: () => GENERIC,
  entries: {
    id: (v) => (typeof v.name === "string" ? `n:${v.name.toLowerCase()}` : `j:${stable(v)}`),
    name: (v) => (typeof v.name === "string" ? `“${v.name}”` : "Entry"),
    whole: (v) => show(v),
  },
};

function diff(before: unknown, after: unknown, shape: Shape, where: string[], out: AuditChange[]): void {
  const blank = (v: unknown) => v === undefined || v === null;
  if ((isPlain(before) || blank(before)) && (isPlain(after) || blank(after)) && (isPlain(before) || isPlain(after))) {
    const b = isPlain(before) ? before : {}, a = isPlain(after) ? after : {};
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])]) {
      if (shape.ignore?.includes(key)) continue;
      const label = shape.label ? shape.label(key) : words(key);
      diff(b[key], a[key], shape.child ? shape.child(key) : GENERIC, label === null ? where : [...where, label], out);
    }
    return;
  }
  if ((Array.isArray(before) || blank(before)) && (Array.isArray(after) || blank(after))) {
    const b = Array.isArray(before) ? before : [], a = Array.isArray(after) ? after : [];
    if ([...b, ...a].some(isPlain)) return entriesDiff(b, a, shape.entries ?? GENERIC.entries!, where, out);
    // A long list (a chat filter's words) reads as what came and went, not as two lists to compare.
    if (b.length > WHOLE_LIST || a.length > WHOLE_LIST) {
      const counted = (list: unknown[]) => { const m = new Map<string, number>(); for (const x of list) { const k = show(x) ?? ""; m.set(k, (m.get(k) ?? 0) + 1); } return m; };
      const bm = counted(b), am = counted(a);
      const extra = (x: Map<string, number>, y: Map<string, number>) => [...x].flatMap(([k, n]) => Array<string>(Math.max(0, n - (y.get(k) ?? 0))).fill(k));
      const added = extra(am, bm), removed = extra(bm, am);
      if (added.length) out.push({ where, before: null, after: added.join(", ") });
      if (removed.length) out.push({ where, before: removed.join(", "), after: null });
      if (added.length || removed.length) return;
    }
  }
  const was = show(before), now = show(after);
  if (was !== now) out.push({ where, before: was, after: now });
}

function entriesDiff(b: unknown[], a: unknown[], spec: Entries, where: string[], out: AuditChange[]): void {
  const idOf = (v: unknown, i: number) => (isPlain(v) ? spec.id(v, i) : `v:${stable(v)}`);
  const index = (list: unknown[]) => new Map(list.map((v, i) => [idOf(v, i), { v, i }] as const));
  const bm = index(b), am = index(a);
  for (const id of [...new Set([...am.keys(), ...bm.keys()])]) {
    const was = bm.get(id), now = am.get(id);
    const item = (now ?? was)!;
    const name = isPlain(item.v) ? spec.name(item.v, item.i) : show(item.v) ?? "Entry";
    if (was && now && spec.shape) diff(was.v, now.v, spec.shape, [...where, name], out);
    else if (was && now) continue; // compared whole, and the same
    else if (spec.whole || !spec.shape) {
      const line = isPlain(item.v) ? (spec.whole ? spec.whole(item.v) : show(item.v)) : show(item.v);
      out.push({ where: [...where, name], before: was ? line ?? "there" : null, after: now ? line ?? "there" : null });
    } else diff(was?.v, now?.v, spec.shape, [...where, name], out);
  }
  if (spec.order) {
    const common = [...am.keys()].filter((id) => bm.has(id));
    const before = [...bm.keys()].filter((id) => am.has(id));
    if (common.join("\n") !== before.join("\n")) {
      const named = (ids: string[], m: typeof am) => ids.map((id) => { const e = m.get(id)!; return isPlain(e.v) ? spec.name(e.v, e.i) : show(e.v); }).join(", ");
      out.push({ where: [...where, spec.order], before: named(before, bm), after: named(common, am) });
    }
  }
}

/** Every change between two versions of a record, read in `shape`'s words. */
export function changesBetween(before: unknown, after: unknown, shape: Shape = GENERIC): AuditChange[] {
  const out: AuditChange[] = [];
  diff(before, after, shape, [], out);
  return out;
}

/** Auto settings in its editor's words, for the server's game. */
export function autoSettingsShape(game: string | null): Shape {
  const fields = game ? configFieldsFor(game) : new Map<string, { label?: string }>();
  const sides = (game ? getGame(game)?.descriptor.sides : undefined) ?? [];
  const side = (id: string, fallback: string) => sides.find((s) => s.id === id)?.label ?? fallback;
  const SPEC: Record<string, string> = {
    timezone: "Time zone", daysOfWeek: "Days", months: "Months", years: "Years", dates: "Dates", start: "From", end: "Until",
    playersBelow: "Total players are below", playersAbove: "Total players are above",
    alliedBelow: `${side("allies", "Allies")} players are below`, alliedAbove: `${side("allies", "Allies")} players are above`,
    axisBelow: `${side("axis", "Axis")} players are below`, axisAbove: `${side("axis", "Axis")} players are above`,
    teamDiffBelow: "Team-size gap is below", teamDiffAbove: "Team-size gap is above",
    matchMinutesAtLeast: "Match has been running at least (minutes)", matchMinutesBelow: "Match has been running less than (minutes)",
  };
  const settingLabel = (key: string): string => {
    const preset = key.startsWith("preset:") ? FEATURE_PRESETS.find((f) => `preset:${f.feature}` === key) : undefined;
    return fields.get(key)?.label ?? APP_SETTINGS.find((s) => s.key === key)?.label ?? (preset ? `${preset.label} preset` : words(key));
  };
  const PROFILE: Record<string, string | null> = { settings: null, spec: "When", nextMap: "Next map", applyTemplate: "Applies the template" };
  const MESSAGE: Record<string, string> = { minutes: "Minutes after the match starts", message: "Message", minPlayers: "Only with at least this many players on", enabled: "On" };
  const spec: Shape = { label: (k) => SPEC[k] ?? words(k) };
  const settings: Shape = { label: settingLabel };
  const profile: Shape = {
    label: (k) => (k in PROFILE ? PROFILE[k]! : words(k)),
    child: (k) => (k === "spec" ? spec : k === "settings" ? settings : GENERIC),
    // A profile is known by its name: a renamed one reads as one profile gone and another added.
    ignore: ["name"],
  };
  const message: Shape = { label: (k) => MESSAGE[k] ?? words(k) };
  const TOP: Record<string, string | null> = { enabled: "Auto settings", dryRun: "Dry run", timezone: "Time zone", profiles: null, matchMessages: null };
  return {
    label: (k) => (k in TOP ? TOP[k]! : words(k)),
    child: (k) => k === "profiles"
      ? { entries: { id: (v) => `n:${String(v.name ?? "").toLowerCase()}`, name: (v) => `Profile “${String(v.name ?? "")}”`, shape: profile, order: "Profile order (the first that matches wins)" } }
      : k === "matchMessages"
        ? { entries: { id: (_v, i) => `i:${i}`, name: (_v, i) => `Match message ${i + 1}`, shape: message } }
        : GENERIC,
  };
}

/** Permissions — a person's own, or a role's: each by its name and where it holds. */
function permissionsShape(serverName: (id: string) => string): Shape {
  const grant: Shape = { label: (k) => (k === "level" ? "Level" : null), child: () => GENERIC };
  return {
    label: (k) => (k === "grants" ? null : k === "limits" ? "Limits" : words(k)),
    child: (k) => k === "grants"
      ? { entries: {
          id: (g) => `${String(g.capability)}|${String(g.scopeType ?? "global")}|${String(g.scopeId ?? "")}`,
          name: (g) => `${String(g.capability)}${g.scopeType === "server" && g.scopeId ? ` on ${serverName(String(g.scopeId))}` : ""}`,
          shape: grant,
          whole: (g) => show(g.level) ?? "held",
        } }
      : GENERIC,
  };
}

/** The records whose history keeps every save, the save each kind of record answers to, and who may read it. */
const VERSIONED: Record<string, { kind: ConfigVersionKind; change: "edit" | "delete" | "restore"; capability: string }> = {
  "rule.update": { kind: "rule", change: "edit", capability: "admin.moderation" },
  "rule.delete": { kind: "rule", change: "delete", capability: "admin.moderation" },
  "rule.restore": { kind: "rule", change: "restore", capability: "admin.moderation" },
  "mapvote.set.update": { kind: "mapSet", change: "edit", capability: "mapvote.config" },
  "mapvote.set.delete": { kind: "mapSet", change: "delete", capability: "mapvote.config" },
  "mapvote.set.restore": { kind: "mapSet", change: "restore", capability: "mapvote.config" },
  "mapvote.schedule.update": { kind: "voteSchedule", change: "edit", capability: "mapvote.config" },
  "mapvote.schedule.delete": { kind: "voteSchedule", change: "delete", capability: "mapvote.config" },
  "mapvote.schedule.restore": { kind: "voteSchedule", change: "restore", capability: "mapvote.config" },
};
/** A save is kept moments before its record is written; further back than this, it isn't this one's. */
const VERSION_MATCH_MS = 60_000;

/** The record's own shape for its action: auto settings and permissions have words of their own. */
async function shapeFor(ctx: AppContext, row: AuditRow): Promise<Shape> {
  if (row.action.startsWith("autosettings.")) {
    const server = row.serverId ? await ctx.repo.servers.findById(row.serverId) : null;
    return autoSettingsShape(server?.game ?? null);
  }
  if (row.action === "grant.set" || row.action === "role.update") {
    const names = new Map((await ctx.repo.servers.list({ includeRetired: true })).map((s) => [s.id, s.name]));
    return permissionsShape((id) => names.get(id) ?? "a removed server");
  }
  return GENERIC;
}

/** The value a record's data holds for what the action set: `after`, then `patch`, then
 *  `config`, then — for a save that kept its results at the top — the fields `before` names. */
function afterOf(data: Plain, before: Plain): { value: Plain; used: string[] } | null {
  for (const key of ["after", "patch", "config"]) if (isPlain(data[key])) return { value: data[key] as Plain, used: [key] };
  const keys = Object.keys(before).filter((k) => k in data);
  return keys.length ? { value: Object.fromEntries(keys.map((k) => [k, data[k]])), used: keys } : null;
}

/** An auto settings save from before `before` was recorded, against the save before it on record. */
async function previousAutoSettings(ctx: AppContext, row: AuditRow, patch: Plain, shape: Shape): Promise<AuditChanges> {
  const prior = row.targetId
    ? await ctx.repo.audit.list({ targetId: row.targetId, actions: ["autosettings.config", "autosettings.template"], to: row.ts, limit: 100 })
    : [];
  const before: Plain = {};
  const need = new Set(Object.keys(patch));
  let since: AuditChanges["since"];
  const day = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  for (const r of prior) {
    if (r.id === row.id || !need.size) continue;
    const d = isPlain(r.data) ? r.data : {};
    if (r.action === "autosettings.template") {
      // Saving a template from this server changes nothing on it; applying one replaces its profiles.
      if (!/\bapplied\b/i.test(r.summary)) continue;
      const touched = ["timezone", "profiles"].filter((k) => need.has(k));
      if (!touched.length) continue;
      if (!isPlain(d.after)) {
        return {
          basis: "set", items: changesBetween(undefined, patch, shape), used: ["patch"],
          note: `Before this save, the template “${String(d.template ?? "")}” was applied (${day(r.ts)}), and that record does not keep the settings it set — so there is nothing to compare with. This is everything the save set.`,
        };
      }
      for (const k of touched) { before[k] = (d.after as Plain)[k]; need.delete(k); }
      since ??= { ts: r.ts, actorName: r.actorName };
      continue;
    }
    const earlier = isPlain(d.patch) ? d.patch : null;
    if (!earlier) continue;
    since ??= { ts: r.ts, actorName: r.actorName };
    for (const k of [...need]) if (k in earlier) { before[k] = earlier[k]; need.delete(k); }
  }
  if (!since) {
    return { basis: "set", items: changesBetween(undefined, patch, shape), used: ["patch"], note: "No earlier save of these settings is on record, so there is nothing to compare with. This is everything the save set." };
  }
  // Compared on what both saves set: a field no earlier save names has no "before" on record.
  const compared = Object.fromEntries(Object.keys(before).map((k) => [k, patch[k]]));
  return { basis: "previous", since, items: changesBetween(before, compared, shape), used: ["patch"] };
}

/** What the action on this record changed, or null when its record does not say. */
export async function auditChanges(ctx: AppContext, row: AuditRow, grants: Grant[]): Promise<AuditChanges | null> {
  const data = isPlain(row.data) ? row.data : {};
  if (isPlain(data.before)) {
    const after = afterOf(data, data.before);
    if (after) {
      return { basis: "recorded", items: changesBetween(data.before, after.value, await shapeFor(ctx, row)), used: ["before", ...after.used] };
    }
  }
  const versioned = VERSIONED[row.action];
  if (versioned && row.targetId && canAnywhere(grants, versioned.capability, "read")) {
    // A save is kept just before its own record, and after whatever was recorded for the same
    // record before that — so a switch flicked a moment after an edit, which keeps no version of
    // its own, is never handed the edit's.
    const at = Date.parse(row.ts);
    const [previous] = await ctx.repo.audit.list({ targetId: row.targetId, to: row.ts, limit: 1 });
    const after = previous ? Date.parse(previous.ts) : -Infinity;
    const save = (await ctx.repo.configVersions.list(versioned.kind, row.targetId, 50))
      .filter((v) => {
        const t = Date.parse(v.createdAt);
        return v.change === versioned.change && t <= at && t > after && at - t <= VERSION_MATCH_MS;
      })
      .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))[0];
    if (save) return { basis: "version", items: changesBetween(save.before ?? undefined, save.after ?? undefined), used: [] };
  }
  if (row.action === "autosettings.config" && isPlain(data.patch)) {
    return previousAutoSettings(ctx, row, data.patch, await shapeFor(ctx, row));
  }
  return null;
}

/** The record's other details, each in words: what the action stored besides what `changes` read. */
export function auditDetails(row: AuditRow, changes: AuditChanges | null): { label: string; value: string }[] {
  const data = isPlain(row.data) ? row.data : {};
  const skip = new Set(changes?.used ?? []);
  const out: { label: string; value: string }[] = [];
  for (const [key, v] of Object.entries(data)) {
    if (skip.has(key)) continue;
    const value = Array.isArray(v) && v.some(isPlain) ? `${v.length} entr${v.length === 1 ? "y" : "ies"}` : show(v);
    if (value === null) continue;
    out.push({ label: words(key), value: value.length > 600 ? `${value.slice(0, 600)}…` : value });
  }
  return out;
}

/**
 * The settings a save is about to replace, as they stand: `current`'s value (or the default) for
 * each key the save sets — for the record's `before`. Copied, and taken before the write: the
 * in-memory store hands back its live row, which the write changes.
 */
export function priorOf(current: object | null | undefined, patch: object, defaults: object = {}): Record<string, unknown> {
  const base = { ...defaults, ...(current ?? {}) } as Record<string, unknown>;
  return JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(patch).map((k) => [k, base[k] ?? null])))) as Record<string, unknown>;
}
