"use client";
/**
 * The zone-set library, under Auto settings — named sector paints, per game, one paint per map.
 * A set is authored here once and enforced by any number of "player outside the allowed area"
 * rules (the Rules tab), the same author-once/use-anywhere shape as the map-set library. The
 * painter is the seeding-areas picker's: the tactical map under the game's own 10×10 grid,
 * brushed per side. Drawing is moderation.zones; the rules permission reads the sets, since its
 * zone rules pick one.
 *
 * The seeding areas' own painter and the other position-driven seeding rules (GroundRules) sit on
 * this page too, under the rules permission, for those who can also read the seeding config: the
 * two painters looked like one feature split across two screens, so the owner merged them here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useServers } from "../lib/servers";
import { sideNameIn, useGameDescriptor } from "../lib/game";
import { liveMapUrl } from "../lib/gameAssets";
import { seriesVar } from "./viz";
import { ActionResult, AskNotice, Callout, EmptyState, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { GroundRules } from "./GroundRules";

const GRID_LETTERS = "ABCDEFGHIJ";
const GRID_CELLS: string[] = [];
for (let row = 1; row <= 10; row++) for (const col of GRID_LETTERS) GRID_CELLS.push(`${col}${row}`);

type ZoneSide = "allies" | "axis" | "shared";
type ZoneLists = { allies: string[]; axis: string[]; shared: string[] };
const EMPTY_ZONE: ZoneLists = { allies: [], axis: [], shared: [] };

interface ZoneSet {
  id: string;
  name: string;
  game: string;
  zones: Record<string, ZoneLists>;
  usedBy: string[];
  updatedAt: string;
}
interface ZonesResp { sets: ZoneSet[]; maps: { key: string; label: string }[] }

export default function MapZones({ canManage = false, showGround = false }: {
  canManage?: boolean;
  /** the ground rules — this page's permission plus seeding read (each server is judged again inside). */
  showGround?: boolean;
}) {
  const { server } = useServers();
  // The ground rules follow the server this hub is editing ("Editing <server>"), like the
  // Seeding tab beside them, rather than carrying a second picker of their own.
  const groundServers = useMemo(() => (server ? [{ id: server.id, name: server.name, game: server.game ?? "hll", engagementMode: server.engagementMode }] : []), [server]);
  const [game, setGame] = useState<string>((server as { game?: string } | undefined)?.game ?? "hll");
  // The sides are painted in the words of the game the sets are for (US/NVA on Vietnam).
  const sides = useGameDescriptor(game);
  const [resp, setResp] = useState<ZonesResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selId, setSelId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // The selected set's WORKING paint — edited locally, saved as a whole (the API validates and
  // drops empty maps, so "clear this map" is just saving it empty).
  const [zones, setZones] = useState<Record<string, ZoneLists>>({});
  const [dirty, setDirty] = useState(false);
  const [zoneMap, setZoneMap] = useState("");
  const [brush, setBrush] = useState<ZoneSide>("allies");

  const load = useCallback(async (g: string) => {
    setErr(null);
    try {
      setResp(await api<ZonesResp>(`/zones?game=${encodeURIComponent(g)}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => { void load(game); }, [game, load]);

  const sets = useMemo(() => resp?.sets ?? [], [resp]);
  const maps = useMemo(() => resp?.maps ?? [], [resp]);
  const sel = sets.find((s) => s.id === selId) ?? null;

  // Selecting a set copies its paint into the working state; switching game clears the selection
  // (the sets listed are the new game's).
  useEffect(() => { setSelId(null); setZones({}); setDirty(false); }, [game]);
  useEffect(() => {
    if (!sel) return;
    setZones(structuredClone(sel.zones ?? {}));
    setDirty(false);
    setZoneMap((m) => (maps.some((x) => x.key === m) ? m : maps[0]?.key ?? ""));
    // The paint is copied once per SELECTION — refetches must not clobber unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  const zone = zones[zoneMap] ?? EMPTY_ZONE;
  const toggleCell = (cell: string) => {
    if (!canManage) return;
    setZones((prev) => {
      const cur = prev[zoneMap] ?? EMPTY_ZONE;
      const next: ZoneLists = { allies: [...cur.allies], axis: [...cur.axis], shared: [...cur.shared] };
      const holder = (["allies", "axis", "shared"] as const).find((s) => next[s].includes(cell)) ?? null;
      for (const s of ["allies", "axis", "shared"] as const) next[s] = next[s].filter((c) => c !== cell);
      // Same feel as the seeding painter: painting an empty cell paints the brush; re-painting a
      // cell of the brush's own colour erases it; another colour's cell is claimed by the brush.
      if (holder !== brush) next[brush].push(cell);
      return { ...prev, [zoneMap]: next };
    });
    setDirty(true);
  };
  const clearMap = () => {
    if (!canManage) return;
    setZones((prev) => ({ ...prev, [zoneMap]: { allies: [], axis: [], shared: [] } }));
    setDirty(true);
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null); setNote(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const create = () => act(async () => {
    const r = await api<{ set: ZoneSet }>("/zones", { method: "POST", body: { name: newName.trim(), game } });
    setNewName("");
    await load(game);
    setSelId(r.set.id);
    setNote(`created "${r.set.name}" — pick a map and paint`);
  });
  const save = () => act(async () => {
    if (!sel) return;
    await api(`/zones/${encodeURIComponent(sel.id)}`, { method: "PUT", body: { zones } });
    await load(game);
    setDirty(false);
    setNote("saved");
  });
  const remove = (s: ZoneSet) => act(async () => {
    await api(`/zones/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    if (selId === s.id) setSelId(null);
    await load(game);
    setNote(`deleted "${s.name}"`);
  });

  const paintedCount = (s: ZoneSet) =>
    Object.values(s.zones ?? {}).reduce((n, z) => n + z.allies.length + z.axis.length + z.shared.length, 0);

  return (
    <>
    <PanelGroup viewId="mapzones">
      <Panel id="library" caps="open" title="Zone sets"
        subtitle="Painted once per map, enforced by any number of rules">
        {canManage && <AskNotice capability="moderation.zones" />}
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ margin: 0 }}>Game{" "}
            <select value={game} onChange={(e) => setGame(e.target.value)}>
              <option value="hll">Hell Let Loose</option>
              <option value="hllv">HLL: Vietnam</option>
            </select>
          </label>
          {canManage && (
            <>
              <input placeholder="new set name (e.g. Fight Club, Mid Only)" value={newName}
                onChange={(e) => setNewName(e.target.value)} style={{ maxWidth: "18rem" }} />
              <button disabled={busy || !newName.trim()} onClick={create}>Create</button>
            </>
          )}
        </div>
        {err && <ActionResult error={err} />}
        {note && !err && <p className="hint">{note}</p>}
        {resp && sets.length === 0 && !err && (
          <EmptyState icon="🗺️" title="No zone sets yet for this game">
            A zone set is a named paint over the tactical map&apos;s A1–J10 grid, one paint per
            map. Create one, paint the areas, then point a &ldquo;player outside the allowed
            area&rdquo; rule at it under Rules.
          </EmptyState>
        )}
        {sets.length > 0 && (
          <div className="chips" style={{ marginTop: 8 }}>
            {sets.map((s) => (
              <button key={s.id} type="button" className={selId === s.id ? "badge active chip-btn" : "badge chip-btn"}
                onClick={() => setSelId(s.id === selId ? null : s.id)}
                title={s.usedBy.length ? `enforced by: ${s.usedBy.join(", ")}` : "not referenced by any rule yet"}>
                {s.name} ({paintedCount(s)}){s.usedBy.length ? " ⚑" : ""}
              </button>
            ))}
          </div>
        )}
      </Panel>

      {sel && (
        <Panel id="painter" caps="open" title={`Painting "${sel.name}"`}
          subtitle={sel.usedBy.length ? `Enforced by: ${sel.usedBy.join(", ")} — edits apply on the next check` : "Not referenced by any rule yet"}>
          {!canManage && <Callout variant="info">You can view this set; painting needs the Map zones permission.</Callout>}
          <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <label style={{ margin: 0 }}>Map{" "}
              <select value={zoneMap} onChange={(e) => setZoneMap(e.target.value)}>
                {maps.map((m) => {
                  const drawn = zones[m.key];
                  const n = drawn ? drawn.allies.length + drawn.axis.length + drawn.shared.length : 0;
                  return <option key={m.key} value={m.key}>{m.label}{n ? ` (${n})` : ""}</option>;
                })}
              </select>
            </label>
            <span className="muted">Paint as</span>
            {(["allies", "axis", "shared"] as const).map((s) => (
              <button key={s} type="button" className={brush === s ? "badge active chip-btn" : "badge chip-btn"} onClick={() => setBrush(s)}>
                <span className="ss-sw" style={{ background: s === "shared" ? seriesVar(2) : seriesVar(s === "allies" ? 0 : 1), marginRight: 6 }} />
                {s === "shared" ? "Both teams" : sideNameIn(sides, s)}
              </button>
            ))}
            {(zone.allies.length + zone.axis.length + zone.shared.length) > 0 && canManage && (
              <button type="button" className="mini" onClick={clearMap}>Clear this map</button>
            )}
            {canManage && <button disabled={busy || !dirty} onClick={save}>{dirty ? "Save changes" : "Saved"}</button>}
          </div>
          {zoneMap && (
            <div className="zone-grid" role="group" aria-label="Map grid">
              {(() => {
                const label = maps.find((m) => m.key === zoneMap)?.label ?? zoneMap;
                const art = liveMapUrl(label, zoneMap, game);
                return art ? <img src={art} alt="" /> : <div className="zg-blank" />;
              })()}
              <div className="zg-cells" role="group" aria-label="Zone sectors">
                {GRID_CELLS.map((cell) => {
                  const side: ZoneSide | null = zone.allies.includes(cell) ? "allies" : zone.axis.includes(cell) ? "axis" : zone.shared.includes(cell) ? "shared" : null;
                  return (
                    <button key={cell} type="button" className={side ? `zg zg-${side}` : "zg"}
                      title={`${cell}${side ? ` — ${side === "shared" ? "both teams" : sideNameIn(sides, side)}` : ""}`}
                      aria-pressed={side !== null} onClick={() => toggleCell(cell)}>
                      {cell}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <Explanation>
            What a rule makes of the paint is the rule&apos;s choice: <strong>keep-in</strong> (each
            team must stay in its cells plus &ldquo;both teams&rdquo; ground; a team with no cells
            on a map is unrestricted there) or <strong>keep-out</strong> (the painted cells are
            no-go). The grid is the tactical map&apos;s own — A1 top-left, the same cells the in-game
            map shows.
          </Explanation>
          {canManage && (
            <div className="row" style={{ marginTop: 8 }}>
              <button className="ghost danger" disabled={busy || sel.usedBy.length > 0} onClick={() => remove(sel)}
                title={sel.usedBy.length ? `still enforced by: ${sel.usedBy.join(", ")}` : undefined}>
                Delete this set
              </button>
            </div>
          )}
        </Panel>
      )}
    </PanelGroup>
      {showGround && groundServers.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <GroundRules servers={groundServers} />
        </div>
      )}
    </>
  );
}
