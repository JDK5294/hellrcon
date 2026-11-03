"use client";
/**
 * Auto settings → Game rewards: paying players for how they play, per server. Each kind is its
 * own card with its own switch and dry-run (on by default — it records what it WOULD pay):
 *   - Top stats per match (like the topstats plugin): the best players per category, a reward per place.
 *   - Best squads per match: the best squad of each type (infantry, armor, recon…), every member paid.
 *   - Kill streaks: kills without dying, tiers.
 *   - Days played in a row: a minimum a day, progressive tiers, optional repeat.
 *   - Days seeding in a row: counted from paid seed rewards, progressive tiers, optional repeat.
 * Every reward is VIP hours and/or points. A permanent VIP is never shortened.
 */
import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "../lib/api";
import { useLatestLoad } from "../lib/resource";
import { useServers } from "../lib/servers";
import { ActionResult, AskNotice, SkeletonLines, Toggle, Explanation } from "./ui";
import { Panel, PanelGroup, usePanelOrder } from "./Panel";
import { PlaceholderHint } from "./Placeholders";
import { NumField } from "./NumField";
import { useGame } from "../lib/game";

interface Reward { vipHours: number; points: number }
type Category = "kills" | "kd" | "kpm" | "combat" | "offense" | "defense" | "support" | "teamplay" | "commander" | "vehicles";
interface Tier { days: number; reward: Reward; message?: string }
type Card = "matchEnd" | "topStats" | "bestSquads" | "killStreaks" | "playDays" | "seedDays";
const CARDS: Card[] = ["matchEnd", "topStats", "bestSquads", "killStreaks", "playDays", "seedDays"];
type SquadType = "infantry" | "armor" | "recon" | "artillery" | "mortar" | "helicopter";
type SquadMetric = "score" | "teamplay" | "kills" | "combat" | "offense" | "defense" | "support";
/** Each reward card's panel — its place in the arrangement is its place in a combined message. */
const CARD_TITLES: Record<Card, string> = {
  matchEnd: "Everyone at match end", topStats: "Top stats", bestSquads: "Best squads", killStreaks: "Kill streaks", playDays: "Days played", seedDays: "Days seeding",
};
const CARD_PANELS: Record<Card, string> = {
  matchEnd: "gamerewards-end", topStats: "gamerewards-top", bestSquads: "gamerewards-squads", killStreaks: "gamerewards-streaks", playDays: "gamerewards-days", seedDays: "gamerewards-seed",
};
interface Config {
  order: Card[];
  topStats: { enabled: boolean; dryRun: boolean; minMinutes: number; minPlayers: number; broadcast: boolean; showEveryone?: boolean; message: string; categories: { id: Category; enabled: boolean; ranks: Reward[]; message?: string }[] };
  bestSquads: {
    enabled: boolean; dryRun: boolean; minMinutes: number; minPlayers: number; minMembers: number; metric: SquadMetric; scoring: "total" | "average";
    broadcast: boolean; showEveryone?: boolean; message: string; types: { id: SquadType; enabled: boolean; ranks: Reward[]; message?: string }[];
  };
  killStreaks: { enabled: boolean; dryRun: boolean; message: string; minPlayers: number; tiers: { kills: number; reward: Reward; message?: string }[] };
  playDays: { enabled: boolean; dryRun: boolean; minMinutes: number; message: string; tiers: Tier[]; repeatEveryDays: number };
  seedDays: { enabled: boolean; dryRun: boolean; message: string; tiers: Tier[]; repeatEveryDays: number };
  matchEnd: { enabled: boolean; dryRun: boolean; minMatchMinutes: number; minPlayedMinutes: number; minPlayers: number; reward: Reward; message: string };
}

const CATEGORY_LABELS: Record<Category, string> = {
  kills: "Kills", kd: "K/D (5+ kills)", kpm: "Kills per minute (5+ kills)", combat: "Combat", offense: "Offense",
  defense: "Defense", support: "Support", teamplay: "Teamplay (combat + support)", commander: "Commander", vehicles: "Vehicles destroyed",
};
/** Each card's own placeholders — the winner's own numbers, the streak's kill, today's minutes. */
const TOP_EXTRA = ["category", "rank", "value", "reward", "kills", "deaths", "kd", "kpm", "combat", "offense", "defense", "support", "teamplay", "vehicles", "minutes", "map"];
const SQUAD_EXTRA = ["squad_type", "rank", "value", "reward", "squad_mates", "squad_size", "kills", "deaths", "kd", "combat", "offense", "defense", "support", "teamplay", "minutes", "map"];
const SQUAD_LABELS: Record<SquadType, string> = {
  infantry: "Infantry squads", armor: "Armor (tank crews)", recon: "Recon teams", artillery: "Artillery squads", mortar: "Mortar platoons", helicopter: "Helicopter platoons",
};
const SQUAD_METRIC_LABELS: Record<SquadMetric, string> = {
  score: "Score (combat + offense + defense + support)", teamplay: "Teamplay (combat + support)", kills: "Kills", combat: "Combat", offense: "Offense", defense: "Defense", support: "Support",
};
const STREAK_EXTRA = ["streak", "reward", "weapon", "victim_name"];
const PLAY_EXTRA = ["days", "reward", "minutes_today"];
const SEED_EXTRA = ["days", "reward"];
const END_EXTRA = ["reward", "match_minutes", "minutes", "map"];
interface RecentRow { at: string; summary: string; player: string | null; kind?: string }
/** The payout kinds a Recent rewards line can be, for its filter ("" = all). */
const RECENT_KINDS: [string, string][] = [
  ["", "All"], ["topStats", "Top stats"], ["bestSquad", "Best squads"], ["matchEnd", "Match end"], ["killStreak", "Kill streaks"], ["playDays", "Days played"], ["seedDays", "Days seeding"],
];
const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];

function RewardInput({ value, onChange, disabled }: { value: Reward; onChange: (r: Reward) => void; disabled?: boolean }) {
  return (
    <span className="control-row" style={{ gap: 6, flexWrap: "nowrap", display: "inline-flex" }}>
      <NumField min={0} max={8760} value={value.vipHours} disabled={disabled} style={{ width: 72 }} aria-label="VIP hours"
        onValue={(n) => onChange({ ...value, vipHours: Math.max(0, n || 0) })} />
      <span className="muted">h VIP</span>
      <NumField min={0} value={value.points} disabled={disabled} style={{ width: 84 }} aria-label="Points"
        onValue={(n) => onChange({ ...value, points: Math.max(0, n || 0) })} />
      <span className="muted">pts</span>
    </span>
  );
}

function Switches({ enabled, dryRun, onEnabled, onDryRun, disabled }: { enabled: boolean; dryRun: boolean; onEnabled: (v: boolean) => void; onDryRun: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="control-row" role="group" aria-label="Reward switches" style={{ gap: 16, flexWrap: "wrap" }}>
      <Toggle checked={enabled} onChange={onEnabled} disabled={disabled} label={enabled ? "On" : "Off"} />
      <Toggle checked={dryRun} onChange={onDryRun} disabled={disabled}
        label={dryRun ? "Dry run — records what it would pay, pays nothing" : "Live — pays for real"} />
    </div>
  );
}

/** A per-item message: folded away until wanted, blank = the card's message. */
function OwnMessage({ value, onChange, disabled, extra }: { value?: string; onChange: (v: string) => void; disabled?: boolean; extra: string[] }) {
  return (
    <details className="own-message" open={Boolean(value)}>
      <summary className="muted fs-sm">{value ? "Own message" : "Own message (blank = the card's message)"}</summary>
      <textarea rows={2} maxLength={1000} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)}
        placeholder="Leave blank to use the card's message" style={{ width: "100%" }} />
      <PlaceholderHint extra={extra} />
    </details>
  );
}

type TierRow = { n: number; reward: Reward; message?: string };
function DayTiers({ tiers, onChange, disabled, unit, extra }: { tiers: TierRow[]; onChange: (t: TierRow[]) => void; disabled?: boolean; unit: string; extra: string[] }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {tiers.map((t, i) => (
        <div key={i} style={{ display: "grid", gap: 2 }}>
        <div className="control-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="muted">At</span>
          <NumField min={1} value={t.n} disabled={disabled} style={{ width: 70 }} aria-label={unit}
            onValue={(n) => onChange(tiers.map((x, j) => (j === i ? { ...x, n: Math.max(1, n || 1) } : x)))} />
          <span className="muted">{unit} →</span>
          <RewardInput value={t.reward} disabled={disabled} onChange={(r) => onChange(tiers.map((x, j) => (j === i ? { ...x, reward: r } : x)))} />
          <button type="button" className="ghost mini" disabled={disabled} title="Remove this tier" onClick={() => onChange(tiers.filter((_, j) => j !== i))}>✕</button>
        </div>
        <OwnMessage value={t.message} disabled={disabled} extra={extra}
          onChange={(m) => onChange(tiers.map((x, j) => (j === i ? { ...x, message: m } : x)))} />
        </div>
      ))}
      {tiers.length < 10 && (
        <button type="button" className="ghost mini" disabled={disabled} style={{ justifySelf: "start" }}
          onClick={() => onChange([...tiers, { n: (tiers[tiers.length - 1]?.n ?? 0) + (unit === "kills" ? 10 : 7), reward: { vipHours: 0, points: 100 } }])}>
          + Add a tier
        </button>
      )}
    </div>
  );
}

/**
 * Reports the cards' order as arranged on screen (Arrange panels). Rendered inside the group,
 * because the arrangement lives there; renders nothing itself.
 */
function ArrangedOrder({ onOrder }: { onOrder: (order: Card[]) => void }) {
  const orderIndex = usePanelOrder();
  const key = orderIndex ? CARDS.map((c) => orderIndex(CARD_PANELS[c])).join(",") : "";
  useEffect(() => {
    if (!orderIndex) return;
    onOrder([...CARDS].sort((a, b) => orderIndex(CARD_PANELS[a]) - orderIndex(CARD_PANELS[b])));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the arrangement; orderIndex changes identity with it
  }, [key]);
  return null;
}

export default function GameRewards({ canManage }: { canManage: boolean }) {
  const { serverId, server } = useServers();
  // Which squad types this server's game has — a Vietnam server has mortar and helicopter
  // platoons and no artillery squads; a game without typed squads has none to rank.
  const { descriptor } = useGame();
  const gameSquadTypes = descriptor?.squadTypes ?? null;
  const [cfg, setCfg] = useState<Config | null>(null);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [recentKind, setRecentKind] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [arranged, setArranged] = useState<Card[] | null>(null);
  // The cards are arranged differently from the order the saved settings send messages in. The
  // arrangement is per staff member, so it is only ADOPTED when someone presses the button — a
  // save for any other reason keeps the saved order, never whatever this person's layout is.
  const savedOrder = cfg?.order ?? CARDS;
  const orderMoved = Boolean(cfg && arranged && arranged.join() !== savedOrder.join());
  const matchEndOrder = savedOrder.filter((c) => c === "matchEnd" || c === "topStats" || c === "bestSquads").map((c) => CARD_TITLES[c]).join(" → ");

  // Only the newest read may paint: a slow one from the server you left would land under the new
  // server's name, and Save would write that server's rewards onto this one.
  const claim = useLatestLoad();
  const load = useCallback(() => {
    const fresh = claim();
    if (!serverId) return;
    setDirty(false); setErr(""); setOk(""); setCfg(null);
    api<{ config: Config; recent: RecentRow[] }>(`/servers/${serverId}/game-rewards`)
      .then((r) => { if (fresh()) { setCfg(r.config); setRecent(r.recent ?? []); } })
      .catch((e) => { if (fresh()) setErr((e as Error).message); });
  }, [serverId, claim]);
  useEffect(() => { load(); }, [load]);

  const patch = <K extends keyof Config>(k: K, v: Partial<Config[K]>) => {
    setCfg((c) => (c ? { ...c, [k]: { ...c[k], ...v } } : c)); setDirty(true); setOk("");
  };

  async function save() {
    if (!cfg) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await api<{ config: Config }>(`/servers/${serverId}/game-rewards`, { method: "PUT", body: cfg });
      setCfg(r.config); setDirty(false); setOk("Saved.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (!serverId) return <div className="card"><p className="muted">Select a server.</p></div>;
  const ro = !canManage;
  const actions = canManage ? (<>
    {dirty && <button className="ghost" onClick={load}>Discard</button>}
    <button className="primary" onClick={save} disabled={!dirty || busy || !cfg}>{busy ? "Saving…" : "Save"}</button>
  </>) : undefined;

  return (
    <PanelGroup viewId="gamerewards">
      <ArrangedOrder onOrder={setArranged} />
      <Panel id="gamerewards-intro" caps="autosettings.profiles" title="Game rewards" actions={actions}
        subtitle={server?.engagementMode === "active" ? `Rewards for playing on ${server?.name ?? "this server"}` : "observe mode — rewards are only recorded, never paid"}>
        <Explanation>
          <p>
            Each reward below has its own switch, and starts in <b>dry run</b>: it records who it would
            have paid (listed at the bottom) without paying anyone, so you can see what it does before
            it costs anything. Rewards are VIP hours, points, or both — points need the player&apos;s
            Discord linked. A permanent VIP is never shortened. Each payout happens once, however
            often the app restarts.
          </p>
          <p>
            When a match ends, a player who earned more than one reward (a top-stats place and the
            everyone-at-match-end reward, say) gets <b>one message</b> with all of them. The parts go in
            the order these cards are arranged — move them with <b>Arrange panels</b>, then press
            <b> Use this arrangement for messages</b> — and, within
            Top stats, in the order of its categories (▲ ▼). Each part keeps its own wording, with a
            blank line between. The winners list everyone gets goes <b>last</b> and is shortened to fit
            one screen — a console can&apos;t scroll the message box, so a player&apos;s own reward always
            comes first. Keep messages short so more of the list fits.
          </p>
        </Explanation>
        {cfg && <p className="muted fs-sm">Match-end message order now: <b>{matchEndOrder}</b>.</p>}
        {orderMoved && canManage && (
          <p className="hint">
            Your cards are arranged differently from that.{" "}
            <button type="button" className="ghost mini" onClick={() => { setCfg((c) => (c && arranged ? { ...c, order: arranged } : c)); setDirty(true); setOk(""); }}>
              Use this arrangement for messages
            </button>{" "}
            then Save.
          </p>
        )}
        <AskNotice capability="autosettings.profiles" serverId={serverId} />
        <ActionResult ok={ok} error={err} />
        {!cfg && !err && <SkeletonLines lines={4} />}
      </Panel>

      {cfg && (
        <>
          <Panel id="gamerewards-end" caps="autosettings.profiles" title="Everyone at match end"
            subtitle="Every player on the server when a long enough match ends — any time of day, seeded or not">
            <Switches enabled={cfg.matchEnd.enabled} dryRun={cfg.matchEnd.dryRun} disabled={ro}
              onEnabled={(v) => patch("matchEnd", { enabled: v })} onDryRun={(v) => patch("matchEnd", { dryRun: v })} />
            <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
              <label className="inline">Only matches that run at least
                <NumField min={0} max={600} value={cfg.matchEnd.minMatchMinutes} disabled={ro} style={{ width: 70, margin: "0 6px" }}
                  onValue={(n) => patch("matchEnd", { minMatchMinutes: Math.max(0, n || 0) })} /> minutes
              </label>
              <label className="inline">A player must have played at least
                <NumField min={0} max={600} value={cfg.matchEnd.minPlayedMinutes} disabled={ro} style={{ width: 70, margin: "0 6px" }}
                  onValue={(n) => patch("matchEnd", { minPlayedMinutes: Math.max(0, n || 0) })} /> minutes of it (0 = being on at the end is enough)
              </label>
              <label className="inline">Only when at least
                <NumField min={0} max={100} value={cfg.matchEnd.minPlayers} disabled={ro} style={{ width: 70, margin: "0 6px" }}
                  onValue={(n) => patch("matchEnd", { minPlayers: Math.max(0, n || 0) })} /> players are on at the end (0 = any)
              </label>
              <div className="control-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>Each of them gets</span>
                <RewardInput value={cfg.matchEnd.reward} disabled={ro} onChange={(r) => patch("matchEnd", { reward: r })} />
              </div>
            </div>
            <Explanation>VIP is added on top of what they already have, so it adds up for regulars. A permanent VIP is never touched — they just get the thank-you.</Explanation>
            <label className="field">Message
              <textarea rows={3} maxLength={1000} value={cfg.matchEnd.message} disabled={ro} onChange={(e) => patch("matchEnd", { message: e.target.value })} />
            </label>
            <PlaceholderHint extra={END_EXTRA} />
          </Panel>

          <Panel id="gamerewards-top" caps="autosettings.profiles" title="Top stats per match"
            subtitle="At each match end, the best players in each category — a reward for each place">
            <Switches enabled={cfg.topStats.enabled} dryRun={cfg.topStats.dryRun} disabled={ro}
              onEnabled={(v) => patch("topStats", { enabled: v })} onDryRun={(v) => patch("topStats", { dryRun: v })} />
            <div className="control-row" style={{ gap: 12, flexWrap: "wrap", marginTop: 8 }}>
              <label className="inline">Only matches with at least
                <NumField min={0} max={100} value={cfg.topStats.minPlayers} disabled={ro} style={{ width: 64, margin: "0 6px" }}
                  onValue={(n) => patch("topStats", { minPlayers: Math.max(0, n || 0) })} /> players
              </label>
              <label className="inline">A player must play at least
                <NumField min={0} max={180} value={cfg.topStats.minMinutes} disabled={ro} style={{ width: 64, margin: "0 6px" }}
                  onValue={(n) => patch("topStats", { minMinutes: Math.max(0, n || 0) })} /> minutes
              </label>
            </div>
            <Toggle checked={cfg.topStats.showEveryone !== false} disabled={ro} onChange={(v) => patch("topStats", { showEveryone: v })}
              label={cfg.topStats.showEveryone !== false
                ? "Message every player the winners at match end (winners or not, like the topstats plugin)"
                : "Only the winners are messaged"} />
            <Toggle checked={cfg.topStats.broadcast} disabled={ro} onChange={(v) => patch("topStats", { broadcast: v })}
              label={cfg.topStats.broadcast ? "Broadcast each category's winner at match end" : "Don't broadcast the winners"} />
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              {cfg.topStats.categories.map((c, ci) => {
                const setCat = (v: Partial<typeof c>) => patch("topStats", { categories: cfg.topStats.categories.map((x, j) => (j === ci ? { ...x, ...v } : x)) });
                // Order here is the order a winner's parts appear in their match-end message.
                const moveCat = (dir: -1 | 1) => {
                  const next = [...cfg.topStats.categories];
                  [next[ci], next[ci + dir]] = [next[ci + dir]!, next[ci]!];
                  patch("topStats", { categories: next });
                };
                const last = cfg.topStats.categories.length - 1;
                return (
                  <div key={c.id} className="setting-card" style={{ padding: 8 }}>
                    <div className="control-row" style={{ gap: 8, alignItems: "center", flexWrap: "nowrap" }}>
                      <Toggle checked={c.enabled} disabled={ro} onChange={(v) => setCat({ enabled: v })} label={CATEGORY_LABELS[c.id]} />
                      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
                        <button type="button" className="ghost mini" disabled={ro || ci === 0} aria-label={`Move ${CATEGORY_LABELS[c.id]} up`} title="Move up" onClick={() => moveCat(-1)}>▲</button>
                        <button type="button" className="ghost mini" disabled={ro || ci === last} aria-label={`Move ${CATEGORY_LABELS[c.id]} down`} title="Move down" onClick={() => moveCat(1)}>▼</button>
                      </span>
                    </div>
                    {c.enabled && (
                      <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
                        {c.ranks.map((r, ri) => (
                          <div key={ri} className="control-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <span className="muted" style={{ width: 36 }}>{ORDINAL[ri]}</span>
                            <RewardInput value={r} disabled={ro} onChange={(v) => setCat({ ranks: c.ranks.map((x, j) => (j === ri ? v : x)) })} />
                            {c.ranks.length > 1 && <button type="button" className="ghost mini" disabled={ro} onClick={() => setCat({ ranks: c.ranks.filter((_, j) => j !== ri) })}>✕</button>}
                          </div>
                        ))}
                        {c.ranks.length < 10 && (
                          <button type="button" className="ghost mini" disabled={ro} style={{ justifySelf: "start" }}
                            onClick={() => setCat({ ranks: [...c.ranks, { vipHours: 0, points: 25 }] })}>+ Add a place</button>
                        )}
                        <OwnMessage value={c.message} disabled={ro} extra={TOP_EXTRA} onChange={(m) => setCat({ message: m })} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <label className="field">Message to each winner
              <textarea rows={2} maxLength={1000} value={cfg.topStats.message} disabled={ro} onChange={(e) => patch("topStats", { message: e.target.value })} />
            </label>
            <PlaceholderHint extra={TOP_EXTRA} />
          </Panel>

          {cfg.bestSquads && (
          <Panel id="gamerewards-squads" caps="autosettings.profiles" title="Best squads per match"
            subtitle="At each match end, the best squad of each type — every member of a placed squad is rewarded">
            <Switches enabled={cfg.bestSquads.enabled} dryRun={cfg.bestSquads.dryRun} disabled={ro}
              onEnabled={(v) => patch("bestSquads", { enabled: v })} onDryRun={(v) => patch("bestSquads", { dryRun: v })} />
            <div className="control-row" style={{ gap: 12, flexWrap: "wrap", marginTop: 8 }}>
              <label className="inline">Only matches with at least
                <NumField min={0} max={100} value={cfg.bestSquads.minPlayers} disabled={ro} style={{ width: 64, margin: "0 6px" }}
                  onValue={(n) => patch("bestSquads", { minPlayers: Math.max(0, n || 0) })} /> players
              </label>
              <label className="inline">A member must play at least
                <NumField min={0} max={180} value={cfg.bestSquads.minMinutes} disabled={ro} style={{ width: 64, margin: "0 6px" }}
                  onValue={(n) => patch("bestSquads", { minMinutes: Math.max(0, n || 0) })} /> minutes
              </label>
              <label className="inline">A squad needs at least
                <NumField min={1} max={6} value={cfg.bestSquads.minMembers} disabled={ro} style={{ width: 56, margin: "0 6px" }}
                  onValue={(n) => patch("bestSquads", { minMembers: Math.min(6, Math.max(1, n || 1)) })} /> such members
              </label>
            </div>
            <div className="control-row" style={{ gap: 12, flexWrap: "wrap", marginTop: 6 }}>
              <label className="inline">Rank squads by
                <select value={cfg.bestSquads.metric} disabled={ro} style={{ margin: "0 6px" }} onChange={(e) => patch("bestSquads", { metric: e.target.value as SquadMetric })}>
                  {(Object.keys(SQUAD_METRIC_LABELS) as SquadMetric[]).map((m) => <option key={m} value={m}>{SQUAD_METRIC_LABELS[m]}</option>)}
                </select>
              </label>
              <label className="inline">
                <select aria-label="How a squad's score is counted" value={cfg.bestSquads.scoring} disabled={ro} style={{ margin: "0 6px 0 0" }} onChange={(e) => patch("bestSquads", { scoring: e.target.value as "total" | "average" })}>
                  <option value="total">added up across the squad</option>
                  <option value="average">averaged per member (a short-handed squad can still win)</option>
                </select>
              </label>
            </div>
            <Toggle checked={cfg.bestSquads.showEveryone !== false} disabled={ro} onChange={(v) => patch("bestSquads", { showEveryone: v })}
              label={cfg.bestSquads.showEveryone !== false ? "Message every player the winning squads at match end" : "Only the winning squads are messaged"} />
            <Toggle checked={cfg.bestSquads.broadcast} disabled={ro} onChange={(v) => patch("bestSquads", { broadcast: v })}
              label={cfg.bestSquads.broadcast ? "Broadcast each type's winning squad at match end (with the top stats, in one broadcast)" : "Don't broadcast the winning squads"} />
            {gameSquadTypes === null
              ? <p className="hint">This server&apos;s game has no squad types to rank.</p>
              : (
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {cfg.bestSquads.types.map((t, ti) => {
                    if (!gameSquadTypes[t.id]) return null;
                    const setType = (v: Partial<typeof t>) => patch("bestSquads", { types: cfg.bestSquads.types.map((x, j) => (j === ti ? { ...x, ...v } : x)) });
                    return (
                      <div key={t.id} className="setting-card" style={{ padding: 8 }}>
                        <Toggle checked={t.enabled} disabled={ro} onChange={(v) => setType({ enabled: v })} label={SQUAD_LABELS[t.id]} />
                        {t.enabled && (
                          <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
                            {t.ranks.map((r, ri) => (
                              <div key={ri} className="control-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                <span className="muted" style={{ width: 36 }}>{ORDINAL[ri]}</span>
                                <RewardInput value={r} disabled={ro} onChange={(v) => setType({ ranks: t.ranks.map((x, j) => (j === ri ? v : x)) })} />
                                <span className="muted fs-sm">each member</span>
                                {t.ranks.length > 1 && <button type="button" className="ghost mini" disabled={ro} onClick={() => setType({ ranks: t.ranks.filter((_, j) => j !== ri) })}>✕</button>}
                              </div>
                            ))}
                            {t.ranks.length < 10 && (
                              <button type="button" className="ghost mini" disabled={ro} style={{ justifySelf: "start" }}
                                onClick={() => setType({ ranks: [...t.ranks, { vipHours: 0, points: 25 }] })}>+ Add a place</button>
                            )}
                            <OwnMessage value={t.message} disabled={ro} extra={SQUAD_EXTRA} onChange={(m) => setType({ message: m })} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            <p className="hint">A player counts in the squad they spent most of the match in. Commanders are in no squad.</p>
            <label className="field">Message to each member of a winning squad
              <textarea rows={2} maxLength={1000} value={cfg.bestSquads.message} disabled={ro} onChange={(e) => patch("bestSquads", { message: e.target.value })} />
            </label>
            <PlaceholderHint extra={SQUAD_EXTRA} />
          </Panel>
          )}

          <Panel id="gamerewards-streaks" caps="autosettings.profiles" title="Kill streaks"
            subtitle="Kills without dying — each tier once per life; team kills never count">
            <Switches enabled={cfg.killStreaks.enabled} dryRun={cfg.killStreaks.dryRun} disabled={ro}
              onEnabled={(v) => patch("killStreaks", { enabled: v })} onDryRun={(v) => patch("killStreaks", { dryRun: v })} />
            <label className="inline" style={{ display: "block", margin: "8px 0" }}>Only while at least
              <NumField min={0} max={100} value={cfg.killStreaks.minPlayers} disabled={ro} style={{ width: 64, margin: "0 6px" }}
                onValue={(n) => patch("killStreaks", { minPlayers: Math.max(0, n || 0) })} /> players are on (stops farming on an empty server)
            </label>
            <DayTiers unit="kills" disabled={ro} extra={STREAK_EXTRA}
              tiers={cfg.killStreaks.tiers.map((t) => ({ n: t.kills, reward: t.reward, message: t.message }))}
              onChange={(t) => patch("killStreaks", { tiers: t.map((x) => ({ kills: Math.max(2, x.n), reward: x.reward, message: x.message })) })} />
            <label className="field">Message
              <textarea rows={2} maxLength={1000} value={cfg.killStreaks.message} disabled={ro} onChange={(e) => patch("killStreaks", { message: e.target.value })} />
            </label>
            <PlaceholderHint extra={STREAK_EXTRA} />
          </Panel>

          <Panel id="gamerewards-days" caps="autosettings.profiles" title="Days played in a row"
            subtitle="Consecutive days on this server, counted in your community's timezone">
            <Switches enabled={cfg.playDays.enabled} dryRun={cfg.playDays.dryRun} disabled={ro}
              onEnabled={(v) => patch("playDays", { enabled: v })} onDryRun={(v) => patch("playDays", { dryRun: v })} />
            <label className="inline" style={{ marginTop: 8, display: "block" }}>A day counts after
              <NumField min={1} max={1440} value={cfg.playDays.minMinutes} disabled={ro} style={{ width: 70, margin: "0 6px" }}
                onValue={(n) => patch("playDays", { minMinutes: Math.max(1, n || 1) })} /> minutes played
            </label>
            <DayTiers unit="days" disabled={ro} extra={PLAY_EXTRA} tiers={cfg.playDays.tiers.map((t) => ({ n: t.days, reward: t.reward, message: t.message }))}
              onChange={(t) => patch("playDays", { tiers: t.map((x) => ({ days: x.n, reward: x.reward, message: x.message })) })} />
            <label className="inline" style={{ display: "block", marginTop: 6 }}>After the last tier, pay it again every
              <NumField min={0} max={365} value={cfg.playDays.repeatEveryDays} disabled={ro} style={{ width: 64, margin: "0 6px" }}
                onValue={(n) => patch("playDays", { repeatEveryDays: Math.max(0, n || 0) })} /> days (0 = never)
            </label>
            <p className="hint">Counting starts when you switch this on. Missing a day starts the streak again.</p>
            <label className="field">Message
              <textarea rows={2} maxLength={1000} value={cfg.playDays.message} disabled={ro} onChange={(e) => patch("playDays", { message: e.target.value })} />
            </label>
            <PlaceholderHint extra={PLAY_EXTRA} />
          </Panel>

          <Panel id="gamerewards-seed" caps="autosettings.profiles" title="Days seeding in a row"
            subtitle="Consecutive days a player was paid a seed reward — on top of the seed reward itself">
            <Switches enabled={cfg.seedDays.enabled} dryRun={cfg.seedDays.dryRun} disabled={ro}
              onEnabled={(v) => patch("seedDays", { enabled: v })} onDryRun={(v) => patch("seedDays", { dryRun: v })} />
            <DayTiers unit="days" disabled={ro} extra={SEED_EXTRA} tiers={cfg.seedDays.tiers.map((t) => ({ n: t.days, reward: t.reward, message: t.message }))}
              onChange={(t) => patch("seedDays", { tiers: t.map((x) => ({ days: x.n, reward: x.reward, message: x.message })) })} />
            <label className="inline" style={{ display: "block", marginTop: 6 }}>After the last tier, pay it again every
              <NumField min={0} max={365} value={cfg.seedDays.repeatEveryDays} disabled={ro} style={{ width: 64, margin: "0 6px" }}
                onValue={(n) => patch("seedDays", { repeatEveryDays: Math.max(0, n || 0) })} /> days (0 = never)
            </label>
            <p className="hint">Needs the seed reward itself switched on (Seeding tab) — a day counts when that reward is paid.</p>
            <label className="field">Message
              <textarea rows={2} maxLength={1000} value={cfg.seedDays.message} disabled={ro} onChange={(e) => patch("seedDays", { message: e.target.value })} />
            </label>
            <PlaceholderHint extra={SEED_EXTRA} />
          </Panel>

          <Panel id="gamerewards-recent" caps="autosettings.profiles" title="Recent rewards" subtitle="Newest first — dry-run entries say what would have been paid">
            {recent.length === 0
              ? <p className="muted mt-0">Nothing yet.</p>
              : (<>
                {/* A full server's match end is a line per player — the kind filter finds the
                    top-stats winners (or one streak) without scrolling past all of them. */}
                <div className="control-row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                  {RECENT_KINDS.filter(([k]) => !k || recent.some((r) => r.kind === k)).map(([k, label]) => (
                    <button key={k || "all"} type="button" className={`ghost mini${recentKind === k ? " active" : ""}`} aria-pressed={recentKind === k} onClick={() => setRecentKind(k)}>
                      {label}{k ? ` (${recent.filter((r) => r.kind === k).length})` : ""}
                    </button>
                  ))}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 480, overflowY: "auto" }}>
                  {recent.filter((r) => !recentKind || r.kind === recentKind).map((r, i) => <li key={i}><span className="muted fs-sm">{fmt(r.at)}</span> — {r.summary}</li>)}
                </ul>
              </>)}
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
