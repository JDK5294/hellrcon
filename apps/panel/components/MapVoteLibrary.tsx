"use client";
/**
 * The shared library: map sets (WHAT) and schedules (WHEN), each a named record any server can use.
 *
 * Two things drove this. Sets used to live inside one server's config, so the same curated pool had
 * to be rebuilt on every server and kept in step by hand; and the only starting points were five
 * presets frozen in the source, which you could copy but never fix or remove. Now there is one
 * library, everything in it is editable and deletable, and the starter rows are just rows.
 *
 * A schedule is its OWN record rather than a field of a set, because a timing is reusable in its own
 * right — "Friday teatime" is a fact about the community's week, not about one pool of maps.
 *
 * Editing here is deliberately explicit. The vote setup around it has one Save for the server's own
 * settings; a library record is shared, so it has its own Save, its own "used by" line, and a delete
 * the API refuses while a server still points at it. Two save buttons on one page is a cost, but the
 * alternative — one Save that quietly rewrites records other servers depend on — is worse.
 *
 * Both halves are collapsed by default: on a phone, the list of every set the community owns is not
 * what you came to this page for.
 */
import { useState } from "react";
import { api } from "../lib/api";
import { useToast, useConfirm } from "../lib/feedback";
import { localWindowHint, overnightSpillHint } from "../lib/time";
import { MapSetEditor, type Pool } from "./MapSetEditor";
import { ActionResult, Callout } from "./ui";
import type { GridMap } from "./MapGrid";
import { RecentlyDeleted, VersionHistory } from "./VersionHistory";
import type { DiffOptions } from "../lib/versionDiff";

/** The editor's words for a map set's and a schedule's settings, for their version history. */
const LIBRARY_LABELS: Record<string, string> = {
  name: "Name", game: "Game", pool: "Maps", spec: "When",
  dayCount: "Day maps", nightCount: "Night maps", wildcardCount: "Wildcard maps", duplicateMaps: "Allow the same map twice",
  battleModes: "Modes", wildcardModes: "Wildcard modes", allowedMaps: "Allowed maps", blacklistMaps: "Never offered",
  excludePlayedMaps: "Skip maps played in the last", excludePlayedFamilies: "Skip map families played in the last",
  enforceCount: "Guaranteed picks", enforcedMaps: "Guaranteed maps", alwaysOffer: "Always offer", variety: "Variety", variantPreference: "Variant preference",
  dayModes: "Day modes", nightModes: "Night modes", dayMaps: "Day maps", nightMaps: "Night maps", wildcardMaps: "Wildcard maps",
  modeBuckets: "Mode", mode: "Mode", count: "How many", limits: "Most per time of day", maps: "Maps",
  timezone: "Time zone", daysOfWeek: "Days", dates: "Dates", months: "Months", years: "Years", start: "From", end: "Until",
  playersBelow: "Fewer players than", playersAbove: "More players than",
};
const deepCopy = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? {})) as T;

/** Where a schedule applies. Mirrors ScheduleSpec, minus the fields this editor does not offer. */
export interface Spec {
  timezone?: string; daysOfWeek?: string[]; dates?: string[]; months?: number[]; years?: number[];
  start?: string; end?: string; playersBelow?: number; playersAbove?: number;
}
export interface MapSet { id: string; name: string; game: string; pool: Pool; usedBy?: string[] }
export interface VoteSchedule { id: string; name: string; spec: Spec; usedBy?: string[] }

const WD = [
  { id: "mon", label: "Mon" }, { id: "tue", label: "Tue" }, { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" }, { id: "fri", label: "Fri" }, { id: "sat", label: "Sat" }, { id: "sun", label: "Sun" },
] as const;

/** Plain-language description of when a schedule applies — the spec read back as a sentence. */
export function describeWhen(spec: Spec | undefined): string {
  if (!spec) return "Applies all the time.";
  const bits: string[] = [];
  if (spec.daysOfWeek?.length) bits.push(spec.daysOfWeek.map((d) => d[0]!.toUpperCase() + d.slice(1)).join(", "));
  if (spec.start || spec.end) bits.push(`${spec.start || "00:00"}–${spec.end || "24:00"}`);
  if (spec.dates?.length) bits.push(`on ${spec.dates.join(", ")}`);
  if (spec.playersBelow !== undefined) bits.push(`under ${spec.playersBelow} players`);
  if (spec.playersAbove !== undefined) bits.push(`over ${spec.playersAbove} players`);
  return bits.length ? `Applies ${bits.join(" · ")}.` : "Applies all the time — use this as your catch-all.";
}

/** "used by A, B" — the thing to know before editing something shared. */
function UsedBy({ usedBy }: { usedBy: string[] | undefined }) {
  if (!usedBy?.length) return <p className="hint mt-0">Not used by any server yet — safe to change or delete.</p>;
  return (
    <p className="hint mt-0">
      Shared: editing this changes the vote on <strong>{usedBy.join(", ")}</strong>.
    </p>
  );
}

/**
 * One disclosure containing a picker and the editor for whatever it points at. Both halves of the
 * library have the same shape, so they share one shell — the difference is only what `children`
 * draws for the selected record.
 */
function LibrarySection({
  title, blurb, open, onToggle, items, selectedId, onSelect, onAdd, addLabel, canManage, busy, children,
}: {
  title: string; blurb: string; open: boolean; onToggle: () => void;
  items: { id: string; name: string }[]; selectedId: string | null; onSelect: (id: string) => void;
  onAdd: () => void; addLabel: string; canManage: boolean; busy: boolean; children: React.ReactNode;
}) {
  return (
    <>
      <div className="control-row" style={{ marginTop: 10 }}>
        <button className="ghost mini" onClick={onToggle} aria-expanded={open}>
          {title} ({items.length}) {open ? "▴" : "▾"}
        </button>
      </div>
      {open && (
        <div className="setting-card" style={{ marginTop: 8 }}>
          <p className="hint mt-0">{blurb}</p>
          <div className="control-row">
            <label style={{ margin: 0, flex: "1 1 220px" }}>
              <select aria-label={title} value={selectedId ?? ""} onChange={(e) => onSelect(e.target.value)}>
                <option value="">Pick one to edit…</option>
                {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </label>
            {canManage && <button className="ghost" onClick={onAdd} disabled={busy}>{addLabel}</button>}
          </div>
          {children}
        </div>
      )}
    </>
  );
}

export default function MapVoteLibrary({
  sets, schedules, catalogue, defaultPool, game, timezone, showLocal, canManage, onChanged,
}: {
  sets: MapSet[]; schedules: VoteSchedule[]; catalogue: GridMap[]; defaultPool: Pool;
  /** The pinned server's game. A set is a list of that game's map ids, so a new one is stamped with
   *  it and the list above only ever shows sets this server could actually use. */
  game: string;
  timezone: string; showLocal: boolean; canManage: boolean;
  /** Reload the page's config + library. Called after every write, because a rename here moves
   *  every pairing that used the old name and the rows above must not keep showing it. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [setsOpen, setSetsOpen] = useState(false);
  const [schedOpen, setSchedOpen] = useState(false);
  const [setId, setSetId] = useState<string | null>(null);
  const [schedId, setSchedId] = useState<string | null>(null);
  // The record being edited, held locally so typing doesn't write to the server on every keystroke.
  const [draftSet, setDraftSet] = useState<{ name: string; pool: Pool } | null>(null);
  const [draftSched, setDraftSched] = useState<{ name: string; spec: Spec } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const chosenSet = sets.find((s) => s.id === setId) ?? null;
  const chosenSched = schedules.find((s) => s.id === schedId) ?? null;
  // Map ids read by their names in a set's history ("Foy", not "foy_warfare").
  const libraryDiff: DiffOptions = {
    labels: LIBRARY_LABELS,
    format: (path, v) => (typeof v === "string" && /maps$/i.test(path.split(".").pop() ?? "") ? catalogue.find((m) => m.id === v)?.prettyName ?? v : undefined),
  };

  const pickSet = (id: string) => {
    setSetId(id || null); setErr("");
    const s = sets.find((x) => x.id === id);
    setDraftSet(s ? { name: s.name, pool: JSON.parse(JSON.stringify(s.pool ?? {})) } : null);
  };
  const pickSched = (id: string) => {
    setSchedId(id || null); setErr("");
    const s = schedules.find((x) => x.id === id);
    setDraftSched(s ? { name: s.name, spec: JSON.parse(JSON.stringify(s.spec ?? {})) } : null);
  };

  /** Every write goes through here so one place owns the busy flag, the error and the reload. */
  async function run(what: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setErr("");
    try {
      await fn();
      toast.success(what);
      onChanged();
      return true;
    } catch (e) {
      setErr((e as Error).message); toast.error((e as Error).message);
      return false;
    } finally { setBusy(false); }
  }

  /**
   * The creates (New and Duplicate, for sets and schedules alike) share the same busy flag as the
   * writes in `run`. Each used to post on its own, so a second press while the first was on its way
   * made a second record, under the same name: the name is picked from the list as it stood before
   * either one landed.
   */
  async function create<T>(name: string, post: () => Promise<T>, open: (row: T) => void): Promise<void> {
    setBusy(true); setErr("");
    try {
      const r = await post();
      toast.success(`Created "${name}"`);
      open(r);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }
  const openSet = (r: { set: MapSet }) => { setSetId(r.set.id); setDraftSet({ name: r.set.name, pool: r.set.pool ?? {} }); };
  const openSched = (r: { schedule: VoteSchedule }) => { setSchedId(r.schedule.id); setDraftSched({ name: r.schedule.name, spec: r.schedule.spec ?? {} }); };

  function addSet() {
    const name = uniqueName("New map set", sets.map((s) => s.name));
    // Born in the mode-based shape, not the legacy day/night one. `{}` has no modeBuckets, which is
    // how a LEGACY set is spelled — so a brand-new set used to open on "this set still uses the older
    // buckets, convert it", asking staff to migrate something that had never held anything.
    void create(name, () => api<{ set: MapSet }>("/mapvote/sets", { method: "POST", body: { name, game, pool: { modeBuckets: [] } } }), openSet);
  }

  function addSchedule() {
    const name = uniqueName("New schedule", schedules.map((s) => s.name));
    void create(name, () => api<{ schedule: VoteSchedule }>("/mapvote/schedules", { method: "POST", body: { name, spec: {} } }), openSched);
  }

  const setSpec = (patch: Partial<Spec>) => setDraftSched((d) => (d ? { ...d, spec: { ...d.spec, ...patch } } : d));

  return (
    <>
      <ActionResult error={err} />

      <LibrarySection
        title="Manage map sets" open={setsOpen} onToggle={() => setSetsOpen((o) => !o)}
        blurb="Map sets belong to the whole community, not to one server — build one here and every server can use it."
        items={sets} selectedId={setId} onSelect={pickSet}
        onAdd={addSet} addLabel="New map set" canManage={canManage} busy={busy}
      >
        {chosenSet && draftSet && (
          <>
            <UsedBy usedBy={chosenSet.usedBy} />
            <label>Name
              <input value={draftSet.name} disabled={!canManage}
                onChange={(e) => setDraftSet({ ...draftSet, name: e.target.value })} />
            </label>
            <MapSetEditor
              pool={draftSet.pool}
              set={(patch) => setDraftSet({ ...draftSet, pool: { ...draftSet.pool, ...patch } })}
              catalogue={catalogue} defaultPool={defaultPool} disabled={!canManage}
            />
            {canManage && (
              <div className="actions">
                <button className="primary" disabled={busy}
                  onClick={() => run(`Saved "${draftSet.name}"`, () =>
                    api(`/mapvote/sets/${chosenSet.id}`, { method: "PUT", body: draftSet }))}>
                  {busy ? "Saving…" : "Save map set"}
                </button>
                <button className="ghost" disabled={busy}
                  onClick={() => {
                    const name = uniqueName(`${draftSet.name} copy`, sets.map((s) => s.name));
                    // The copy is the same game as its source — the create route refuses a set
                    // that does not say, and this button forgot to when sets learned games.
                    void create(name, () => api<{ set: MapSet }>("/mapvote/sets", { method: "POST", body: { name, game: chosenSet.game, pool: draftSet.pool } }), openSet);
                  }}>Duplicate</button>
                <button className="danger" disabled={busy}
                  onClick={async () => {
                    if (!(await confirm({
                      title: `Delete the map set "${chosenSet.name}"?`,
                      body: "It goes for every server. Any server still using it has to drop it first. It can be brought back from Recently deleted.",
                      confirmLabel: "Delete", danger: true,
                    }))) return;
                    if (await run(`Deleted "${chosenSet.name}"`, () => api(`/mapvote/sets/${chosenSet.id}`, { method: "DELETE" }))) {
                      setSetId(null); setDraftSet(null);
                    }
                  }}>Delete</button>
              </div>
            )}
            <details className="library-history" style={{ marginTop: 8 }}>
              <summary className="muted fs-sm">History — every saved change to this set, and a way back</summary>
              <VersionHistory listUrl={`/mapvote/sets/${chosenSet.id}/versions`} restoreUrl={(id) => `/mapvote/versions/${id}/restore`}
                canRestore={canManage} diff={libraryDiff} noun="map set"
                onRestored={(r) => { const s = (r as { set?: MapSet }).set; if (s) setDraftSet({ name: s.name, pool: deepCopy(s.pool) }); onChanged(); }} />
            </details>
          </>
        )}
        {sets.length === 0 && <p className="nothing">No map sets yet.</p>}
        <details className="library-deleted" style={{ marginTop: 8 }}>
          <summary className="muted fs-sm">Recently deleted map sets</summary>
          <RecentlyDeleted listUrl="/mapvote/sets/deleted" restoreUrl={(id) => `/mapvote/versions/${id}/restore`} canRestore={canManage} noun="map set" onRestored={() => onChanged()} />
        </details>
      </LibrarySection>

      <LibrarySection
        title="Manage schedules" open={schedOpen} onToggle={() => setSchedOpen((o) => !o)}
        blurb="A schedule is just a WHEN — days, a time window, a player range. It is not tied to any one map set, so the same timing can drive several."
        items={schedules} selectedId={schedId} onSelect={pickSched}
        onAdd={addSchedule} addLabel="New schedule" canManage={canManage} busy={busy}
      >
        {chosenSched && draftSched && (
          <>
            <UsedBy usedBy={chosenSched.usedBy} />
            <label>Name
              <input value={draftSched.name} disabled={!canManage}
                onChange={(e) => setDraftSched({ ...draftSched, name: e.target.value })} />
            </label>
            <p className="hint">{describeWhen(draftSched.spec)} Leave everything blank and it applies all the time; fill anything in and it only applies then.</p>
            <div className="daypick" style={{ marginBottom: 8 }}>
              {WD.map((d) => {
                const on = draftSched.spec.daysOfWeek?.includes(d.id) ?? false;
                return <button key={d.id} type="button" className="daypick-btn" aria-pressed={on} disabled={!canManage}
                  onClick={() => setSpec({ daysOfWeek: on ? (draftSched.spec.daysOfWeek ?? []).filter((x) => x !== d.id) : [...(draftSched.spec.daysOfWeek ?? []), d.id] })}>{d.label}</button>;
              })}
            </div>
            <p className="hint mt-0">{(draftSched.spec.daysOfWeek?.length ?? 0) === 0 ? "No days picked — this applies every day." : `Only on the ${draftSched.spec.daysOfWeek!.length} highlighted day(s).`}</p>
            <div className="grid">
              <label>From (time of day)<input value={draftSched.spec.start ?? ""} disabled={!canManage}
                onChange={(e) => setSpec({ start: e.target.value || undefined })} placeholder="20:00" /></label>
              <label>Until<input value={draftSched.spec.end ?? ""} disabled={!canManage}
                onChange={(e) => setSpec({ end: e.target.value || undefined })} placeholder="23:00" /></label>
              {showLocal && (draftSched.spec.start || draftSched.spec.end) && localWindowHint(timezone, draftSched.spec.start, draftSched.spec.end) && (
                <p className="hint" style={{ gridColumn: "1 / -1", margin: 0 }}>
                  That window is <strong>{localWindowHint(timezone, draftSched.spec.start, draftSched.spec.end)}</strong> — times are read in each server&rsquo;s own zone ({timezone} here).
                </p>
              )}
              {overnightSpillHint(draftSched.spec.daysOfWeek, draftSched.spec.start, draftSched.spec.end) && (
                <p className="hint" style={{ gridColumn: "1 / -1", margin: 0 }}>⚠ {overnightSpillHint(draftSched.spec.daysOfWeek, draftSched.spec.start, draftSched.spec.end)}</p>
              )}
              <label>Only when fewer players than<input type="number" min={0} disabled={!canManage}
                value={draftSched.spec.playersBelow ?? ""}
                onChange={(e) => setSpec({ playersBelow: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="e.g. 50 for seeding" /></label>
              <label>Only when more players than<input type="number" min={0} disabled={!canManage}
                value={draftSched.spec.playersAbove ?? ""}
                onChange={(e) => setSpec({ playersAbove: e.target.value === "" ? undefined : Number(e.target.value) })} placeholder="" /></label>
              <label>Specific dates<input value={(draftSched.spec.dates ?? []).join(", ")} disabled={!canManage}
                onChange={(e) => setSpec({ dates: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="06-06" />
                <span className="hint">Month-day, for one-off events like D-Day.</span></label>
            </div>
            {canManage && (
              <div className="actions">
                <button className="primary" disabled={busy}
                  onClick={() => run(`Saved "${draftSched.name}"`, () =>
                    api(`/mapvote/schedules/${chosenSched.id}`, { method: "PUT", body: draftSched }))}>
                  {busy ? "Saving…" : "Save schedule"}
                </button>
                <button className="ghost" disabled={busy}
                  onClick={() => {
                    const name = uniqueName(`${draftSched.name} copy`, schedules.map((s) => s.name));
                    void create(name, () => api<{ schedule: VoteSchedule }>("/mapvote/schedules", { method: "POST", body: { name, spec: draftSched.spec } }), openSched);
                  }}>Duplicate</button>
                <button className="danger" disabled={busy}
                  onClick={async () => {
                    if (!(await confirm({
                      title: `Delete the schedule "${chosenSched.name}"?`,
                      body: "It goes for every server. Any server still using it has to drop it first. It can be brought back from Recently deleted.",
                      confirmLabel: "Delete", danger: true,
                    }))) return;
                    if (await run(`Deleted "${chosenSched.name}"`, () => api(`/mapvote/schedules/${chosenSched.id}`, { method: "DELETE" }))) {
                      setSchedId(null); setDraftSched(null);
                    }
                  }}>Delete</button>
              </div>
            )}
            <details className="library-history" style={{ marginTop: 8 }}>
              <summary className="muted fs-sm">History — every saved change to this schedule, and a way back</summary>
              <VersionHistory listUrl={`/mapvote/schedules/${chosenSched.id}/versions`} restoreUrl={(id) => `/mapvote/versions/${id}/restore`}
                canRestore={canManage} diff={libraryDiff} noun="schedule"
                onRestored={(r) => { const s = (r as { schedule?: VoteSchedule }).schedule; if (s) setDraftSched({ name: s.name, spec: deepCopy(s.spec) }); onChanged(); }} />
            </details>
          </>
        )}
        {schedules.length === 0 && <p className="nothing">No schedules yet — sets with no schedule apply all the time.</p>}
        <details className="library-deleted" style={{ marginTop: 8 }}>
          <summary className="muted fs-sm">Recently deleted schedules</summary>
          <RecentlyDeleted listUrl="/mapvote/schedules/deleted" restoreUrl={(id) => `/mapvote/versions/${id}/restore`} canRestore={canManage} noun="schedule" onRestored={() => onChanged()} />
        </details>
      </LibrarySection>

      {(setsOpen || schedOpen) && (
        <Callout variant="info">
          These are saved on their own, right away — they are shared, so they do not wait for the
          <strong> Save</strong> at the top of this page.
        </Callout>
      )}
    </>
  );
}

/** " copy", " copy 2", … — the API rejects a duplicate name, so pick a free one before asking. */
function uniqueName(base: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}
