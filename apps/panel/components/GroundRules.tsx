"use client";
/**
 * The position-rule seeding controls — the settings where live positions drive enforcement.
 * They render on Auto settings → Map zones, beside the zone-set library they look so much like
 * (the owner merged the two: two painters on two screens read as one feature split in half), and
 * answer to that page's permission: admin.moderation (a global capability), read to see them and
 * write to change them, on top of the seeding config's own permission on the server. The ordinary
 * Seeding tab neither shows nor sends them; the API strips these fields from its seeding reads and
 * writes for anyone without the rules permission, so the fence holds against a hand-crafted
 * request too.
 *
 * Saves PATCH exactly these fields and nothing else: the rest of the seeding config is the
 * Seeding tab's business, and a colleague's edit over there must never be overwritten from here.
 */
import { useEffect, useMemo, useState } from "react";
import { useGrants } from "../lib/grants";
import { canOnServer, hasCap } from "../lib/access";
import { api } from "../lib/api";
import { sideNameIn, useGameDescriptor } from "../lib/game";
import { ActionResult, AskNotice, ObserveBanner, SettingCard, Toggle, Explanation } from "./ui";
import { liveMapUrl } from "../lib/gameAssets";
import { seriesVar } from "./viz";

/** The tactical map's own 10×10 grid — columns A–J west→east, rows 1–10 north→south. The worker
 *  judges positions with the same constants, so a cell painted here IS the cell enforced. */
const GRID_LETTERS = "ABCDEFGHIJ";
const GRID_CELLS: string[] = [];
for (let row = 1; row <= 10; row++) for (const col of GRID_LETTERS) GRID_CELLS.push(`${col}${row}`);

type ZoneSide = "allies" | "axis" | "shared";
type ZoneLists = { allies: string[]; axis: string[]; shared: string[] };
const EMPTY_ZONE: ZoneLists = { allies: [], axis: [], shared: [] };

/** Exactly the seeding-config fields this screen owns — the shape of every save from here. One
 *  control per job: the zones (Off / Learn only / On — containEnabled with layoutLearnEnabled),
 *  the cap fight by position (positionalEnabled) and steamroll protection (paceEnabled). */
interface GroundConfig {
  positionalEnabled: boolean;
  containEnabled: boolean;
  layoutLearnEnabled: boolean;
  containGraceSec: number;
  containMaxPlayers: number;
  containNotice: string;
  containZones: Record<string, ZoneLists>;
  paceEnabled: boolean;
  paceUnlockMinutes: number[];
  paceNotice: string;
}

/** What the API says it has learned about one layer's attack geometry. `autoZone`: auto zones
 *  fences this layer from it (warfare) wherever no paint covers the layer — its own, or its
 *  `family`'s. */
type LearnedEntry =
  | { status: "learned"; axis: "x" | "y"; alliesDir: -1 | 1; rounds: number; agree: number; prefill: ZoneLists; autoZone?: boolean; family?: string | null }
  | { status: "learning"; rounds: number };

const painted = (z: ZoneLists | null | undefined) => Boolean(z && (z.allies.length || z.axis.length || z.shared.length));

/** Plain words for a learned layout: which way the fight runs and which end the Allies start —
 *  named as the paint buttons beside it name them, in the server's game's words (US on Vietnam). */
function layoutWords(l: { axis: "x" | "y"; alliesDir: -1 | 1 }, allies: string): string {
  return l.axis === "x"
    ? `horizontal, ${allies} ${l.alliesDir === -1 ? "left (west)" : "right (east)"}`
    : `vertical, ${allies} ${l.alliesDir === -1 ? "top (north)" : "bottom (south)"}`;
}

export function GroundRules({ servers: allServers }: { servers: { id: string; name: string; game: string; engagementMode: string }[] }) {
  // Only servers whose seeding config this viewer may read (the page opens on the rules
  // permission, which says nothing about any server's seeding), and only for holders of that
  // permission — the API serves these fields to nobody else. Saving needs write on both; without
  // it the save is sent for approval, since everything a role can see it can ask for.
  const grants = useGrants();
  const servers = useMemo(() => (hasCap(grants, "admin.moderation") ? allServers.filter((s) => canOnServer(grants, "seeding.config", s.id, "read")) : []), [allServers, grants]);
  const [sid, setSid] = useState(servers[0]?.id ?? "");
  const canSave = Boolean(sid);
  const [cfg, setCfg] = useState<GroundConfig | null>(null);
  const [containMaps, setContainMaps] = useState<{ key: string; label: string; layerId?: string }[]>([]);
  const [learned, setLearned] = useState<Record<string, LearnedEntry>>({});
  // Seeding's own on/off and dry-run (the Seeding tab): off, the seeding runner idles and nothing
  // here runs; in dry-run every warn, punish and kick here is only logged. Said on this page, not
  // only there. Read only; this screen never saves either.
  const [seeding, setSeeding] = useState({ on: true, dryRun: false });
  const [zoneMap, setZoneMap] = useState("");
  const [brush, setBrush] = useState<ZoneSide>("allies");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const game = servers.find((s) => s.id === sid)?.game;
  // The sides are painted in this server's game's words (US/NVA on Vietnam).
  const sides = useGameDescriptor(game);

  useEffect(() => { setSid((cur) => (servers.some((s) => s.id === cur) ? cur : servers[0]?.id ?? "")); }, [servers]);

  useEffect(() => {
    if (!sid) return;
    let alive = true;
    setCfg(null); setErr(""); setOk(""); setDirty(false);
    Promise.all([
      api<{ config: Partial<GroundConfig> & { enabled?: boolean; dryRun?: boolean }; containMaps?: { key: string; label: string }[]; learnedLayouts?: Record<string, LearnedEntry> }>(`/servers/${sid}/seeding`),
      // The server's own LAYER list — the ids the game runs, the same ones the Catalogue tab
      // shows. Unreachable server: the family list below still lets staff paint.
      api<{ catalogue?: { id: string; prettyName: string }[] }>(`/servers/${sid}/maps`).catch(() => ({ catalogue: [] as { id: string; prettyName: string }[] })),
    ])
      .then(([r, m]) => {
        if (!alive) return;
        const c = r.config ?? {};
        setSeeding({ on: c.enabled !== false, dryRun: c.dryRun === true });
        setCfg({
          positionalEnabled: c.positionalEnabled ?? false,
          containEnabled: c.containEnabled ?? false,
          layoutLearnEnabled: c.layoutLearnEnabled ?? true,
          containGraceSec: c.containGraceSec ?? 60,
          containMaxPlayers: c.containMaxPlayers ?? 0,
          containNotice: c.containNotice ?? "",
          containZones: c.containZones ?? {},
          paceEnabled: c.paceEnabled ?? false,
          paceUnlockMinutes: [0, 1, 2, 3, 4].map((k) => c.paceUnlockMinutes?.[k] ?? 0),
          paceNotice: c.paceNotice ?? "",
        });
        const learnedMap = r.learnedLayouts ?? {};
        setLearned(learnedMap);
        // Layers first (what attack direction actually hangs on); a FAMILY entry is listed only
        // where family paint already exists (so it can be seen and cleared), or as the whole list
        // when the server could not be asked for its layers.
        const layers = [...new Map((m.catalogue ?? []).map((x) => [x.id.toLowerCase(), x])).values()]
          .sort((a, b) => a.prettyName.localeCompare(b.prettyName))
          .map((x) => ({ key: `@${x.id.toLowerCase().replace(/[^a-z0-9_]/g, "")}`, label: x.prettyName, layerId: x.id }));
        const families = r.containMaps ?? [];
        const paintedFamilies = families.filter((f) => (c.containZones ?? {})[f.key]).map((f) => ({ ...f, label: `${f.label} (whole family — any layer)` }));
        const maps = layers.length ? [...layers, ...paintedFamilies] : families;
        setContainMaps(maps);
        setZoneMap((cur) => (maps.some((x) => x.key === cur) ? cur : maps[0]?.key ?? ""));
      })
      .catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [sid]);

  const set = <K extends keyof GroundConfig>(k: K, v: GroundConfig[K]) => { setCfg((c) => (c ? { ...c, [k]: v } : c)); setDirty(true); setOk(""); };
  const num = (k: "containGraceSec" | "containMaxPlayers") => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value));

  async function save() {
    if (!cfg || !sid) return;
    setBusy(true); setErr(""); setOk("");
    try {
      // The body IS the GroundConfig object — only this screen's fields, nothing of the rest.
      await api(`/servers/${sid}/seeding`, { method: "PUT", body: cfg });
      setDirty(false); setOk("Saved.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  /** Seeding zones' three positions: Off; Learn only (layouts learned, nothing enforced); On. */
  const zonesMode: "off" | "learn" | "on" = cfg?.containEnabled ? "on" : cfg?.layoutLearnEnabled ? "learn" : "off";
  const setZonesMode = (m: "off" | "learn" | "on") => {
    setCfg((c) => (c ? { ...c, containEnabled: m === "on", layoutLearnEnabled: m !== "off" } : c)); setDirty(true); setOk("");
  };
  /** The zones the bot enforces on a layer nobody painted (or will, once the zones are On): its
   *  learned layout's paint, while the zones learn or enforce and no paint covers the layer (its
   *  own or its family's wins). Shown in the painter so they can be reviewed; nothing is saved
   *  until staff paint over them. */
  const autoZoneOf = (key: string): ZoneLists | null => {
    const l = learned[key];
    if (!cfg || zonesMode === "off" || l?.status !== "learned" || !l.autoZone) return null;
    if (painted(cfg.containZones?.[key]) || (l.family && painted(cfg.containZones?.[l.family]))) return null;
    return l.prefill;
  };
  const autoZone = autoZoneOf(zoneMap);
  /** Paint the clicked cell with the current brush; a cell already wearing it is cleared. A cell
   *  belongs to exactly one of allies/axis/shared, so painting removes it from the other two. On
   *  an auto zone the first click starts the layer's own paint from it. */
  const zone: ZoneLists = autoZone ?? cfg?.containZones?.[zoneMap] ?? EMPTY_ZONE;
  const toggleZoneCell = (cell: string) => {
    if (!cfg || !zoneMap) return;
    const had = zone[brush].includes(cell);
    const next: ZoneLists = {
      allies: zone.allies.filter((c) => c !== cell),
      axis: zone.axis.filter((c) => c !== cell),
      shared: zone.shared.filter((c) => c !== cell),
    };
    if (!had) next[brush] = [...next[brush], cell];
    set("containZones", { ...(cfg.containZones ?? {}), [zoneMap]: next });
  };
  const clearZoneMap = () => {
    if (!cfg || !zoneMap) return;
    const next = { ...(cfg.containZones ?? {}) };
    delete next[zoneMap];
    set("containZones", next);
  };
  /** Paint this layer from its learned layout — each side's own ground less its HQ line, the
   *  middle left empty (free for both, the fence auto zones enforce) — as a starting point staff
   *  adjust by hand. */
  const selectedLearned = learned[zoneMap];
  const prefillFromLearned = () => {
    if (!cfg || !zoneMap || selectedLearned?.status !== "learned") return;
    set("containZones", { ...(cfg.containZones ?? {}), [zoneMap]: selectedLearned.prefill });
  };

  if (!servers.length) return null;

  return (
    <div className="card" role="region" aria-label="Ground rules">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
        <div>
          <strong>Ground rules</strong>
          <div className="muted fs-sm">Seeding enforcement judged from live positions. Configured here and nowhere else.</div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          {servers.length > 1 && (
            <select value={sid} onChange={(e) => setSid(e.target.value)}>
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {canSave && <button className="primary" onClick={save} disabled={!dirty || busy || !cfg}>{busy ? "Saving…" : "Save"}</button>}
        </div>
      </div>
      {canSave && <AskNotice capability={["seeding.config", "admin.moderation"]} serverId={sid} />}
      <ActionResult ok={ok} error={err} />
      <ObserveBanner server={servers.find((s) => s.id === sid)} when="later">
        These rules still evaluate — every action is logged as dry-run instead of being carried out.
      </ObserveBanner>
      {cfg && !seeding.on && (
        <p className="hint notice">
          Seeding is switched off for this server (Auto settings → Seeding), so nothing here runs —
          not learning, the zones or steamroll protection — until it is switched on.
        </p>
      )}
      {cfg && seeding.on && seeding.dryRun && (
        <p className="hint notice">
          Seeding is in dry-run on this server (Auto settings → Seeding), so these rules only log what
          they would do — nobody is warned, punished or kicked — until it is set to Live.
        </p>
      )}
      {!cfg && !err && <p className="muted">Loading…</p>}
      {cfg && (
        <>
          <h3>Seeding zones</h3>
          <SettingCard icon="🧭" title="Seeding zones"
            description="Off: nothing. Learn only: the bot learns each layer's layout from players walking out of their own end in a round's first 10 minutes (two rounds that agree make it learned) and enforces nothing — learned layers show their zones in the painter below, to review before you turn it on. On: while the server fills, a player standing on the other team's ground gets a grace period, then the same warn → punish → kick ladder as every other seeding rule; a layer you painted uses your paint, every other warfare layer its learned zones (or the round read live until it is learned), and learning carries on. The HQ line at each end is never judged, and players on the deploy screen are never flagged.">
            <div className="seg" role="group" aria-label="Seeding zones">
              {([["off", "Off"], ["learn", "Learn only"], ["on", "On"]] as const).map(([id, label]) => (
                <button key={id} type="button" className={`seg-btn ${zonesMode === id ? "active" : ""}`} aria-pressed={zonesMode === id} onClick={() => setZonesMode(id)}>{label}</button>
              ))}
            </div>
          </SettingCard>
          <div className="grid">
            <label>Grace period (seconds outside before the ladder)
              <input type="number" min={0} value={cfg.containGraceSec} onChange={num("containGraceSec")} />
            </label>
            <label>Stand down at (players; 0 = whole seeding phase)
              <input type="number" min={0} value={cfg.containMaxPlayers} onChange={num("containMaxPlayers")} />
            </label>
          </div>
          <label>How the rule is worded
            <input value={cfg.containNotice ?? ""} onChange={(e) => set("containNotice", e.target.value)}
              placeholder="Going onto the other team's ground (watch the map)" />
          </label>
          <Explanation>
            The greeting line and the <code>{"{violation}"}</code> in the warns — same contract as
            the rule wordings on the Seeding tab. Blank keeps it out of the greeting.
          </Explanation>
          <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <label style={{ margin: 0 }}>Map{" "}
              <select value={zoneMap} onChange={(e) => setZoneMap(e.target.value)}>
                {containMaps.map((m) => {
                  const drawn = cfg.containZones?.[m.key];
                  const n = drawn ? drawn.allies.length + drawn.axis.length + drawn.shared.length : 0;
                  const l = learned[m.key];
                  const tag = autoZoneOf(m.key) ? " · auto zone" : l?.status === "learned" ? " · learned" : l?.status === "learning" ? " · learning" : "";
                  return <option key={m.key} value={m.key}>{m.label}{tag}{n ? ` (${n} painted)` : ""}</option>;
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
            {painted(cfg.containZones?.[zoneMap]) && (
              <button type="button" className="mini" onClick={clearZoneMap}>Clear this map</button>
            )}
          </div>
          {zoneMap.startsWith("@") && (
            <p className="hint" style={{ marginTop: 0 }}>
              {autoZone && selectedLearned?.status === "learned"
                ? <><strong>Auto zone</strong> — what the bot {zonesMode === "on" ? "enforces" : "will enforce once Seeding zones is On"} on this layer, from its learned layout:
                    <strong> {layoutWords(selectedLearned, sideNameIn(sides, "allies"))}</strong> ({selectedLearned.agree} of {selectedLearned.rounds} round(s) agree).
                    Paint a square to make it this layer&apos;s own paint, which then wins.</>
                : selectedLearned?.status === "learned"
                ? <>Learned layout: <strong>{layoutWords(selectedLearned, sideNameIn(sides, "allies"))}</strong> — {selectedLearned.agree} of {selectedLearned.rounds} round(s) agree.{" "}
                    <button type="button" className="mini" onClick={prefillFromLearned}>Prefill from learned layout</button></>
                : selectedLearned?.status === "learning"
                  ? <>Still learning this layer — {selectedLearned.rounds} round(s) seen; it needs two rounds that agree before it is trusted.</>
                  : <>Nothing learned for this layer yet — it learns from players walking out of their end in a round&apos;s first 10 minutes, while Seeding zones is on Learn only or On.</>}
            </p>
          )}
          {zoneMap && (
            <div className="zone-grid" role="group" aria-label="Map grid">
              {(() => {
                const entry = containMaps.find((m) => m.key === zoneMap);
                const art = liveMapUrl(entry?.label ?? zoneMap, entry?.layerId ?? zoneMap, game);
                return art ? <img src={art} alt="" /> : <div className="zg-blank" />;
              })()}
              <div className="zg-cells" role="group" aria-label="Seeding area sectors">
                {GRID_CELLS.map((cell) => {
                  const side: ZoneSide | null = zone.allies.includes(cell) ? "allies" : zone.axis.includes(cell) ? "axis" : zone.shared.includes(cell) ? "shared" : null;
                  return (
                    <button key={cell} type="button" className={side ? `zg zg-${side}${autoZone ? " zg-auto" : ""}` : "zg"} title={`${cell}${side ? ` — ${side === "shared" ? "both teams" : sideNameIn(sides, side)}${autoZone ? " (auto zone)" : ""}` : ""}`}
                      aria-pressed={side !== null} onClick={() => toggleZoneCell(cell)}>
                      {cell}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <Explanation>
            Paint per <strong>layer</strong>: the layer (not the map family) fixes which end each side
            attacks from. A layer&apos;s own paint wins; a whole-family paint covers any layer that has
            none. The grid is the tactical map&apos;s own (A1 top-left). A player is only judged on
            the <strong>other team&apos;s</strong> painted squares: <strong>empty squares are free for
            both teams</strong>, exactly like &ldquo;Both teams&rdquo; ones, so leave the middle
            empty. A warfare layer with nothing painted uses its auto zone. The <strong>first grid line at each
            end</strong> (the HQ line) is never judged, so it never needs painting: nobody from the
            other team reaches it without crossing three grid lines of the home team&apos;s ground
            first.
          </Explanation>

          <h3>Cap fight</h3>
          <SettingCard icon="📍" title="Also judge the cap fight by position"
            description="The cap fight (Seeding tab) catches a winning-team player attacking the next point by their offense score, the way CRCON does. On, it also catches one standing past the front line, judged from live positions — only players whose team their own spawn confirms, after a short grace. Live positions and team reads at the start of a round can be stale, so leave this off unless you have checked it on your servers.">
            <Toggle checked={cfg.positionalEnabled} onChange={(v) => set("positionalEnabled", v)} label={cfg.positionalEnabled ? "On" : "Off"} />
          </SettingCard>

          <h3>Offensive pace</h3>
          <SettingCard icon="⏱️" title="Steamroll protection (offensive rounds)"
            description="An offensive round runs through five points in order, and a stacked attack can eat all five in minutes. Set the earliest round-minute the ATTACKING team may set foot in each point's fifth of the map; an attacker pushing ahead of the clock gets a short grace, then the warn → punish → kick ladder. Defenders are never touched, and unlike the seeding-phase rules this one runs through the whole round.">
            <Toggle checked={cfg.paceEnabled} onChange={(v) => set("paceEnabled", v)} label={cfg.paceEnabled ? "On" : "Off"} />
          </SettingCard>
          <div className="grid">
            {[0, 1, 2, 3, 4].map((i) => (
              <label key={i}>Point {i + 1} unlocks at (min, 0 = always open)
                <input type="number" min={0} max={240} value={cfg.paceUnlockMinutes[i] ?? 0}
                  onChange={(e) => {
                    const next = [0, 1, 2, 3, 4].map((k) => cfg.paceUnlockMinutes[k] ?? 0);
                    next[i] = Number(e.target.value);
                    set("paceUnlockMinutes", next);
                  }} />
              </label>
            ))}
          </div>
          <label>How the rule is worded
            <input value={cfg.paceNotice ?? ""} onChange={(e) => set("paceNotice", e.target.value)}
              placeholder="Blank = the warn names the locked point and its unlock minute" />
          </label>
          <Explanation>
            <p>
              Points count from the <strong>attackers&apos;</strong> end — point 1 is the first
              objective they cap, point 5 the defenders&apos; last stand. Who attacks is read off
              the map itself (works in both games), so there is nothing to set per map.
            </p>
            <p>
              Runs on the same round layout as the seeding zones — learned per layer, or read live,
              which takes a couple of minutes of players on the ground — judges only players whose
              team label their own spawns corroborate, and holds entirely rather than guess — the
              worker log says which. The round clock starts when the match tracker sees the round
              open.
            </p>
          </Explanation>
        </>
      )}
    </div>
  );
}
