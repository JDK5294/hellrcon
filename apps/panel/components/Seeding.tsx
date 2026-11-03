"use client";
/**
 * Seeding enforcement + seed-reward config for the active server, shown under Auto settings. While a server
 * fills, players on "disallowed" roles are warned → punished → kicked; the instant it crosses into
 * "live", everyone who seeded long enough is granted VIP. The disallowed-role picker is driven by
 * the game descriptor (useGame), so it's game-agnostic. Gated by seeding.config.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../lib/resource";
import { useServers } from "../lib/servers";
import { useGame } from "../lib/game";
import { useGrants } from "../lib/grants";
import { canOnServer } from "../lib/access";
import { ActionResult, AskNotice, Callout, Nothing, ObserveBanner, Pager, SettingCard, Toggle, Explanation } from "./ui";
import { useClientPages } from "../lib/paged";
import { PanelGroup, Panel } from "./Panel";
import { PresetBar } from "./PresetBar";
import { PlaceholderHint } from "./Placeholders";
import { NumField } from "./NumField";


interface SeedingConfig {
  serverId: string;
  enabled: boolean;
  dryRun: boolean;
  seedTarget: number;
  minPlayers: number;
  disallowedRoles: number[];
  disallowedWeaponClasses: string[];
  disallowedWeapons: string[];
  disallowedWeaponNames: string[];
  disallowedCommanderAbilities: string[];
  capFightEnabled: boolean;
  capFightMaxCaps: number;
  capFightSkipWarning: boolean;
  capFightNotice: string;
  immuneLevel: number;
  immuneTags: string[];
  announceMessage: string;
  maxWarnings: number;
  warnIntervalSec: number;
  warnMessage: string;
  maxPunishes: number;
  punishIntervalSec: number;
  punishMessage: string;
  kickAfter: boolean;
  kickMessage: string;
  rewardEnabled: boolean;
  rewardHours: number;
  rewardPoints: number;
  rewardLinkedNote: string;
  rewardUnlinkedNote: string;
  minSeedMinutes: number;
  rewardCumulative: boolean;
  /** extra servers this reward also lands on, each with its own hours — the bridge. */
  rewardBridge?: { serverId: string; hours: number }[];
  rewardMessage: string;
  rewardDelaySec: number;
  rewardRepeatMessage?: string;
  phaseConfirmSec: number;
  phaseHysteresis: number;
  checkSec?: number | null;
  chaseCheckSec?: number | null;
}
interface PayoutRound {
  round: string; at: string; manual: boolean; dryRun: boolean;
  receipts: { playerId: string | null; name: string | null; summary: string; outcome: "paid" | "partial" | "failed" | "dryRun" }[];
}
interface Status {
  state: { phase: "idle" | "seeding" | "live"; liveCount: number; seederCount: number; updatedAt: string } | null;
  progressCount: number;
  enabled: boolean;
  dryRun: boolean;
  /** the archived last seed cycle — what "Pay last seed" replays when the payout was missed. */
  lastCycle: { endedAt: string; rewarded: boolean; qualifying: number; refusal?: string | null; owed?: number } | null;
}

export default function Seeding({ canManage = true }: { canManage?: boolean }) {
  const { serverId, server, servers } = useServers();
  const { descriptor } = useGame();
  // The seed reward is a permission of its own, held per server: without it here the config comes
  // back without the reward, and its panel and receipts are not this reader's to see.
  const grants = useGrants();
  const seesReward = Boolean(serverId && canOnServer(grants, "seeding.rewards", serverId, "read"));
  const [cfg, setCfg] = useState<SeedingConfig | null>(null);
  const [roles, setRoles] = useState<Record<number, string>>({});
  const [weaponClasses, setWeaponClasses] = useState<{ id: string; label: string }[]>([]);
  const [weapons, setWeapons] = useState<{ name: string; classId: string }[]>([]);
  const [commanderAbilities, setCommanderAbilities] = useState<string[]>([]);
  const [announcePreview, setAnnouncePreview] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  // Config is an edit form, so it is fetched then copied into local state; the live status polls.
  // Both take their stale-response guard from useResource rather than hand-rolling one.
  const cfgLoader = useMemo(
    () => (serverId ? () => api<{ config: SeedingConfig; roles: Record<number, string>; weaponClasses?: { id: string; label: string }[]; weapons?: { name: string; classId: string }[]; commanderAbilities?: string[]; announcePreview?: string }>(`/servers/${serverId}/seeding`) : null),
    [serverId],
  );
  const { data: cfgResp, error: loadErr, reload: load } = useResource(cfgLoader);
  useEffect(() => {
    // Another server picked: its settings are on their way, and the last server's go now rather than
    // when these land. Kept on screen meanwhile, they could be edited and saved to this server.
    if (!cfgResp) { setCfg(null); setDirty(false); return; }
    setCfg(cfgResp.config); setRoles(cfgResp.roles ?? {}); setWeaponClasses(cfgResp.weaponClasses ?? []);
    setWeapons(cfgResp.weapons ?? []); setCommanderAbilities(cfgResp.commanderAbilities ?? []);
    setAnnouncePreview(cfgResp.announcePreview ?? "");
    setDirty(false); setErr(""); setOk("");
  }, [cfgResp]);

  const statusLoader = useMemo(
    () => (serverId ? () => api<Status>(`/servers/${serverId}/seeding/status`) : null),
    [serverId],
  );
  const { data: status, reload: reloadStatus } = useResource(statusLoader, { refreshMs: 15_000 });
  const payoutsLoader = useMemo(
    () => (serverId && seesReward ? () => api<{ rounds: PayoutRound[] }>(`/servers/${serverId}/seeding/payouts`) : null),
    [serverId, seesReward],
  );
  const { data: payouts, reload: reloadPayouts } = useResource(payoutsLoader, { refreshMs: 60_000 });
  // The reward rounds a page at a time, newest first; the page is kept for the server it was read on.
  const roundPages = useClientPages(payouts ? payouts.rounds ?? [] : null, "seeding.payouts", serverId ?? "");

  // Prefer the API-served role labels; fall back to the descriptor so labels always resolve.
  const roleLabels: Record<number, string> = Object.keys(roles).length ? roles : (descriptor?.roles ?? {});

  // The picker groups the game's weapon table by the same classes as the chips, in chip order,
  // with anything the classifier didn't place under "Other" at the end.
  const weaponGroups = useMemo(() => {
    if (!weapons.length) return [] as { id: string; label: string; names: string[] }[];
    const byClass = new Map<string, string[]>();
    for (const w of weapons) {
      const list = byClass.get(w.classId) ?? [];
      list.push(w.name);
      byClass.set(w.classId, list);
    }
    const groups = weaponClasses
      .map((c) => ({ id: c.id, label: c.label, names: byClass.get(c.id) ?? [] }))
      .filter((g) => g.names.length > 0);
    const covered = new Set(weaponClasses.map((c) => c.id));
    const other = weapons.filter((w) => !covered.has(w.classId)).map((w) => w.name);
    if (other.length) groups.push({ id: "other", label: "Other", names: other });
    return groups;
  }, [weapons, weaponClasses]);

  // Stored picks the current weapon table no longer offers (a game patch retired the gun, or the
  // config predates a table update). Without their own group they would be enforced yet invisible
  // — and unremovable, wedging every save behind "unknown weapon" refusals. Shown as ordinary
  // chips so deselecting them is one click.
  const staleWeaponNames = useMemo(() => {
    if (!cfg || !weapons.length) return [] as string[];
    const known = new Set(weapons.map((w) => w.name.toUpperCase()));
    return (cfg.disallowedWeaponNames ?? []).filter((n) => !known.has(n));
  }, [cfg, weapons]);
  const set = <K extends keyof SeedingConfig>(k: K, v: SeedingConfig[K]) => { setCfg((c) => (c ? { ...c, [k]: v } : c)); setDirty(true); setOk(""); };

  /** The one cross-field rule the API also enforces (seedRewardRefusal): a reward that is on has
   *  to be a reward. Held here too so the button says no before the round trip does. */
  const rewardEmpty = Boolean(cfg?.rewardEnabled) && (cfg?.rewardHours ?? 0) <= 0 && (cfg?.rewardPoints ?? 0) <= 0;

  async function payLast() {
    setPayBusy(true); setErr(""); setOk("");
    try {
      const r = await api<{ queued: boolean; qualifying: number; mode?: "full" | "retry" }>(`/servers/${serverId}/seeding/pay-last`, { method: "POST", body: {} });
      setOk(r.mode === "retry"
        ? `Queued — the worker retries the ${r.qualifying} unpaid seeder(s) on its next tick, paying only what each is still owed. Results appear under Recent seed payouts.`
        : `Queued — the worker pays ${r.qualifying} seeder(s) on its next tick (within a minute). Results appear under Recent seed payouts.`);
      reloadStatus(); setTimeout(reloadPayouts, 45_000);
    } catch (e) { setErr((e as Error).message); } finally { setPayBusy(false); }
  }

  async function save() {
    if (!cfg) return;
    setBusy(true); setErr(""); setOk("");
    try {
      // An added bridge row whose server was never picked is a blank line, not a stop. The
      // fields this tab does not show are stripped too: the read may include them for some
      // accounts, and echoing them back would overwrite edits made where they ARE shown. A config
      // read without the reward sends none of it, bridge included.
      const body: Record<string, unknown> = { ...cfg };
      if (cfg.rewardBridge) body.rewardBridge = cfg.rewardBridge.filter((t) => t.serverId);
      for (const k of ["containEnabled", "containAutoEnabled", "positionalEnabled", "containGraceSec", "containMaxPlayers", "containNotice", "containZones", "paceEnabled", "paceUnlockMinutes", "paceNotice", "layoutLearnEnabled"]) delete body[k];
      const r = await api<{ config: SeedingConfig }>(`/servers/${serverId}/seeding`, { method: "PUT", body });
      setCfg(r.config); setDirty(false); setOk("Saved."); reloadStatus();
      // The preview is composed server-side by the same code the worker sends with, so it is
      // re-read rather than re-derived here — one implementation, no drift.
      load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (!serverId) return <div className="card"><p className="muted">Select a server to configure seeding.</p></div>;
  if ((err || loadErr) && !cfg) return <div className="card"><ActionResult error={err || loadErr} /></div>;
  if (!cfg) return <div className="card"><p className="muted">Loading seeding config…</p></div>;

  const num = (k: keyof SeedingConfig) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);
  const text = (k: keyof SeedingConfig) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, e.target.value as never);
  const toggleRole = (id: number) => set("disallowedRoles", cfg.disallowedRoles.includes(id) ? cfg.disallowedRoles.filter((r) => r !== id) : [...cfg.disallowedRoles, id]);
  /**
   * The "Select all" beside a family. A REAL class is stored as its class id, not as its current
   * members: that is what keeps matching when a patch adds a new gun to the family, and it is why
   * the button cannot simply tick every chip. Turning a family on therefore also drops the
   * individual picks inside it — they are now covered, and left behind they would sit invisible in
   * the config and reappear the moment the family was cleared.
   *
   * A synthetic group (anything the classifier could not place) has no class id to store, so there
   * the button does mean "tick every weapon in it".
   */
  const toggleWeaponFamily = (g: { id: string; names: string[] }) => {
    const isRealClass = weaponClasses.some((c) => c.id === g.id);
    const names = new Set(g.names.map((n) => n.toUpperCase()));
    if (!isRealClass) {
      const allOn = g.names.every((n) => (cfg.disallowedWeaponNames ?? []).includes(n.toUpperCase()));
      set("disallowedWeaponNames", allOn
        ? (cfg.disallowedWeaponNames ?? []).filter((n) => !names.has(n))
        : [...new Set([...(cfg.disallowedWeaponNames ?? []), ...names])]);
      return;
    }
    const classes = cfg.disallowedWeaponClasses ?? [];
    if (classes.includes(g.id)) {
      set("disallowedWeaponClasses", classes.filter((c) => c !== g.id));
    } else {
      setCfg((c) => (c ? {
        ...c,
        disallowedWeaponClasses: [...classes, g.id],
        disallowedWeaponNames: (c.disallowedWeaponNames ?? []).filter((n) => !names.has(n)),
      } : c));
      setDirty(true); setOk("");
    }
  };
  // Individual names and abilities are stored upper-cased (that is how the config matches them);
  // the chips keep showing the catalogue's own casing.
  const toggleWeaponName = (name: string) => {
    const key = name.toUpperCase();
    set("disallowedWeaponNames", (cfg.disallowedWeaponNames ?? []).includes(key)
      ? (cfg.disallowedWeaponNames ?? []).filter((n) => n !== key)
      : [...(cfg.disallowedWeaponNames ?? []), key]);
  };
  const toggleAbility = (name: string) => {
    const key = name.toUpperCase();
    set("disallowedCommanderAbilities", (cfg.disallowedCommanderAbilities ?? []).includes(key)
      ? (cfg.disallowedCommanderAbilities ?? []).filter((a) => a !== key)
      : [...(cfg.disallowedCommanderAbilities ?? []), key]);
  };

  const phase = status?.state?.phase;
  const phaseBadge = phase === "live" ? "active" : phase === "seeding" ? "observe" : "";

  return (
    <div>
      <div className="card">
        <div className="page-header">
          <div className="page-header-main">
            <h1 className="m-0">Seeding</h1>
            <div className="page-subtitle">
              Enforcement + VIP reward for {server?.name ?? "this server"}. While the server fills, disallowed roles and weapons are warned → punished → kicked; when it goes live, players who seeded long enough get VIP.
            </div>
          </div>
          <div className="page-header-actions">
            <button className="primary" onClick={save} disabled={!dirty || busy || rewardEmpty} title={rewardEmpty ? "The seed reward is on but gives nothing — set VIP hours, points, or both" : undefined}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
        <ObserveBanner server={server} when="later">Seeding rules still evaluate — every action is logged as dry-run instead of being carried out.</ObserveBanner>

        {/* Live status strip */}
        <div className="row" style={{ gap: 16, marginBottom: 12, alignItems: "center" }}>
          <span>Phase {phase ? <span className={`badge ${phaseBadge}`}>{phase}</span> : <span className="muted">unknown</span>}</span>
          <span className="muted">Players online: <strong>{status?.state?.liveCount ?? "—"}</strong></span>
          <span className="muted">Seeding credit: <strong>{status?.state?.seederCount ?? status?.progressCount ?? "—"}</strong></span>
          {status?.enabled === false && <span className="badge observe">disabled</span>}
          {status?.dryRun && <span className="badge observe">dry-run</span>}
        </div>

        <AskNotice capability={seesReward ? ["seeding.config", "seeding.rewards"] : "seeding.config"} serverId={serverId} />
        <ActionResult ok={ok} error={err || loadErr} />

        <SettingCard title="Enable seeding automation" description="Master switch for enforcement + rewards on this server.">
          <Toggle checked={cfg.enabled} onChange={(v) => set("enabled", v)} label={cfg.enabled ? "On" : "Off"} />
        </SettingCard>
        <SettingCard title="Dry-run" description="Log what would happen to Activity, but never message/punish/kick or grant VIP. Leave on until you've tuned the rules.">
          <Toggle checked={cfg.dryRun} onChange={(v) => set("dryRun", v)} label={cfg.dryRun ? "Dry-run" : "Live"} />
        </SettingCard>
      </div>

      {serverId && <PresetBar feature="seeding" featureLabel="Seeding" serverId={serverId} canManage={canManage} dirty={dirty} onApplied={load} />}

      <PanelGroup viewId="seeding">
        <Panel id="population" caps="open" title="Population thresholds">
          <div className="grid">
            <label>Seed target (players to go live)<input type="number" min={1} max={200} value={cfg.seedTarget} onChange={num("seedTarget")} /></label>
            <label>Min players (below this = idle)<input type="number" min={0} value={cfg.minPlayers} onChange={num("minPlayers")} /></label>
          </div>
        </Panel>

        <Panel id="phase" caps="open" title="Phase stability">
          <div className="grid">
            <label>Confirm delay (seconds)<input type="number" min={0} value={cfg.phaseConfirmSec} onChange={num("phaseConfirmSec")} /></label>
            <label>Hysteresis (players)<input type="number" min={0} value={cfg.phaseHysteresis} onChange={num("phaseHysteresis")} /></label>
          </div>
          <Explanation>Stops the phase churning when the count flaps at a boundary — which would otherwise wipe accrued seed progress and reset escalation. <strong>Confirm delay</strong>: the count must hold in a new phase for this long before it commits. <strong>Hysteresis</strong>: once in a phase, the count must drop this many players below the boundary before it falls back. 0 = off.</Explanation>
        </Panel>

        <Panel id="check-speed" caps="open" title="Check speed">
          <div className="grid">
            <label>Check the server every (seconds)
              <input type="number" min={5} max={300} placeholder="30 (default)" value={cfg.checkSec == null ? "" : String(cfg.checkSec)}
                onChange={(e) => set("checkSec", (e.target.value === "" ? null : Number(e.target.value.replace(/^0+(?=\d)/, ""))) as never)} />
            </label>
            <label>Fast check while seeding (seconds)
              <input type="number" min={3} max={60} placeholder="10 (default)" value={cfg.chaseCheckSec == null ? "" : String(cfg.chaseCheckSec)}
                onChange={(e) => set("chaseCheckSec", (e.target.value === "" ? null : Number(e.target.value.replace(/^0+(?=\d)/, ""))) as never)} />
            </label>
          </div>
          <Explanation>
            How often the seeding rules look at the server — roles, weapons, the player count, and who
            is earning the seed reward. <strong>Fast check</strong> is used only while a rule that follows
            where players are is actually watching (like the cap fight while seeding), so a push is
            caught before it caps. Slower checks react later, not more gently — to give players more
            room, raise the warn and punish intervals instead. Seed-reward minutes count real time,
            so a slower check never shortens anyone&apos;s seeding. Blank = the default. Takes effect at
            the next check, no restart.
          </Explanation>
        </Panel>

        <Panel id="disallowed" caps="open" title="Disallowed roles while seeding">
          <p className="hint">Players on these roles are escalated. Everything else is allowed.</p>
          <div className="chips">
            {Object.entries(roleLabels).length === 0 && <Nothing>No roles known for this game.</Nothing>}
            {Object.entries(roleLabels).map(([id, label]) => {
              const rid = Number(id);
              const on = cfg.disallowedRoles.includes(rid);
              return (
                <button key={id} type="button" className={on ? "badge active chip-btn" : "badge chip-btn"} onClick={() => toggleRole(rid)}>
                  {on ? "✓ " : ""}{label}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel id="disallowed-weapons" caps="open" title="Disallowed weapons while seeding">
          <Explanation>
            Kills with these while the server is filling are escalated through the same
            warn&nbsp;→&nbsp;punish&nbsp;→&nbsp;kick ladder below. Open a family to ban the one gun
            that is overpowered on a quiet server, or use <strong>Select all</strong> to ban the
            whole family — which keeps matching when a patch adds a new gun to it. The list also
            includes every weapon this server&apos;s own kill logs have recorded, spelled exactly as
            the game spells it — so a game update&apos;s new or renamed weapons appear here on their
            own once they have seen action.
          </Explanation>
          {weaponGroups.length === 0 && <Nothing>No weapon table known for this game — use the extra weapons field below.</Nothing>}
          {weaponGroups.map((g) => {
            const wholeClass = (cfg.disallowedWeaponClasses ?? []).includes(g.id);
            const picked = g.names.filter((n) => (cfg.disallowedWeaponNames ?? []).includes(n.toUpperCase()));
            return (
              // The family switch sits beside its own dropdown rather than in a separate chip row
              // above: one place per family, and no reading back and forth to see what a row means.
              // Outside the <summary> on purpose — a button nested in a summary toggles the
              // disclosure as well as itself, and nests one control inside another for a reader.
              <div key={g.id} className="weapon-group">
                <details className="role-disclosure">
                  <summary>
                    <span>{g.label}</span>{" "}
                    {wholeClass
                      ? <span className="muted">whole family blocked</span>
                      : picked.length
                        ? <span>{picked.length} of {g.names.length} blocked</span>
                        : <span className="muted">none of {g.names.length} blocked</span>}
                  </summary>
                  <div className="chips">
                    {g.names.map((n) => {
                      const on = wholeClass || (cfg.disallowedWeaponNames ?? []).includes(n.toUpperCase());
                      return (
                        <button
                          key={n}
                          type="button"
                          className={on ? "badge active chip-btn" : "badge chip-btn"}
                          disabled={wholeClass}
                          title={wholeClass ? "The whole family is blocked — clear it to pick weapons individually" : undefined}
                          onClick={() => toggleWeaponName(n)}
                        >
                          {on ? "✓ " : ""}{n}
                        </button>
                      );
                    })}
                  </div>
                </details>
                <button type="button" className="mini" onClick={() => toggleWeaponFamily(g)}>
                  {wholeClass ? "Clear all" : "Select all"}
                </button>
              </div>
            );
          })}
          {staleWeaponNames.length > 0 && (
            <details className="role-disclosure" open>
              <summary>
                <span>No longer in this game&apos;s weapon table</span>{" "}
                <span>{staleWeaponNames.length} still configured</span>
              </summary>
              <p className="hint notice">These picks aren&apos;t offered by the current weapon table (a patch retired them, or the table changed). Deselect them to save.</p>
              <div className="chips">
                {staleWeaponNames.map((n) => (
                  <button key={n} type="button" className="badge active chip-btn" onClick={() => toggleWeaponName(n)}>✓ {n}</button>
                ))}
              </div>
            </details>
          )}
          <label>Extra weapons (comma-separated, for the odd one a chip doesn&apos;t cover)
            <input value={(cfg.disallowedWeapons ?? []).join(", ")}
              onChange={(e) => set("disallowedWeapons", e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))}
              placeholder="e.g. 150MM, 155MM" />
          </label>
        </Panel>

        <Panel id="commander-restrictions" caps="open" title="Commander restrictions">
          <Explanation>
            The commander abilities that kill. Blocking one escalates the commander through the
            same warn&nbsp;→&nbsp;punish&nbsp;→&nbsp;kick ladder when it takes a life while the
            server is filling — supply and reinforcement abilities are untouched.
          </Explanation>
          <div className="chips">
            {commanderAbilities.length === 0 && <Nothing>No commander-ability table is available for this game yet — use the extra-weapons field below the weapon chips to match one by name.</Nothing>}
            {commanderAbilities.map((a) => {
              const on = (cfg.disallowedCommanderAbilities ?? []).includes(a.toUpperCase());
              return (
                <button key={a} type="button" className={on ? "badge active chip-btn" : "badge chip-btn"} onClick={() => toggleAbility(a)}>
                  {on ? "✓ " : ""}{a}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel id="cap-fight" caps="open" title="Cap fight (warfare)">
          <SettingCard title="Block attacking the next point" description="While the server fills, the winning team may hold the middle but not push on. A player whose offense score climbs while their team already holds the cap limit is walked up the warn → punish → kick ladder.">
            <Toggle checked={cfg.capFightEnabled} onChange={(v) => set("capFightEnabled", v)} label={cfg.capFightEnabled ? "On" : "Off"} />
          </SettingCard>
          <div className="grid">
            <label>Team counts as winning at (caps held, 2–4)
              <input type="number" min={2} max={4} value={cfg.capFightMaxCaps} onChange={num("capFightMaxCaps")} />
            </label>
          </div>
          <SettingCard title="Skip warnings" description="First offence goes straight to punish — the warning steps count as already spent.">
            <Toggle checked={cfg.capFightSkipWarning} onChange={(v) => set("capFightSkipWarning", v)} label={cfg.capFightSkipWarning ? "Punish first" : "Warn first"} />
          </SettingCard>
          <label>How the rule is worded
            <input value={cfg.capFightNotice ?? ""} onChange={(e) => set("capFightNotice", e.target.value)}
              placeholder="Attacking the next point while your team is winning" />
          </label>
          <Explanation>
            <p>
              Used twice, deliberately as the same words: the line under &ldquo;Not allowed while
              seeding&rdquo; in the greeting, and the <code>{"{violation}"}</code> in the warn and
              punish messages — the player is warned in the words the greeting used. Leave it blank
              to keep the line out of the greeting (enforcement still runs; warnings then use the
              stock phrase).
            </p>
            <p>
              Warfare mode only — there the team score counts caps held (0–5), so &ldquo;holding
              3&rdquo; means winning the middle. Offensive-mode scores measure something else
              entirely, so this rule stands down there instead of firing on bad data.
            </p>
            <p>
              Timing: attacking is detected from the offense score climbing between two roster reads
              (about 30 seconds apart) — the first read only sets the baseline, so the earliest
              action comes roughly a minute after the push starts. With warnings on, the punish lands
              two warnings later (one per climb, at least a minute apart); “Punish first” is the
              switch that makes the first offence the punish. Every step it takes — or would take
              in dry-run — is on Moderation as a <code>seed.*</code> action.
            </p>
          </Explanation>
        </Panel>

        <Panel id="immunity" caps="open" title="Immunity">
          <div className="grid">
            <label>Immune at/below level (0 = off)<input type="number" min={0} value={cfg.immuneLevel} onChange={num("immuneLevel")} /></label>
            <label>Immune tags (comma-separated)
              <input value={cfg.immuneTags.join(", ")} onChange={(e) => set("immuneTags", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} placeholder="e.g. staff, trusted" />
            </label>
          </div>
        </Panel>

        <Panel id="announcement" caps="open" title="Announcement">
          <label>Message for each player who joins while seeding
            <textarea rows={3} value={cfg.announceMessage} onChange={text("announceMessage")} placeholder="Blank = no announcement" />
          </label>
          <Explanation>
            The restrictions above are listed underneath automatically, so the greeting can never
            promise a rule the server isn&apos;t enforcing. To place them mid-sentence instead,
            write {"{disallowed_roles}"}, {"{disallowed_weapons}"} or {"{disallowed_commander_abilities}"}
            and they&apos;ll be substituted there.
          </Explanation>
          <PlaceholderHint extra={["disallowed_roles", "disallowed_weapons", "disallowed_commander_abilities"]} />
          {announcePreview && (
            <>
              <div className="field-label">What a joining player sees{dirty ? " (before your unsaved edits)" : ""}</div>
              <pre className="announce-preview">{announcePreview}</pre>
            </>
          )}
        </Panel>

        <Panel id="warnings" caps="open" title="Escalation — warnings">
          <div className="grid">
            <label>Max warnings<input type="number" min={0} value={cfg.maxWarnings} onChange={num("maxWarnings")} /></label>
            <label>Warn interval (sec)<input type="number" min={0} value={cfg.warnIntervalSec} onChange={num("warnIntervalSec")} /></label>
          </div>
          <label>Warn message<input value={cfg.warnMessage} onChange={text("warnMessage")} /></label>
          <PlaceholderHint extra={["violation", "received_warnings", "max_warnings"]} />
        </Panel>

        <Panel id="punishes" caps="open" title="Escalation — punishes & kick">
          <div className="grid">
            <label>Max punishes<input type="number" min={0} value={cfg.maxPunishes} onChange={num("maxPunishes")} /></label>
            <label>Punish interval (sec)<input type="number" min={0} value={cfg.punishIntervalSec} onChange={num("punishIntervalSec")} /></label>
          </div>
          <label>Punish message<input value={cfg.punishMessage} onChange={text("punishMessage")} /></label>
          <PlaceholderHint extra={["violation", "received_punishes", "max_punishes"]} />
          <SettingCard title="Kick after max punishes" description="Once warnings and punishes are exhausted, remove the player from the server.">
            <Toggle checked={cfg.kickAfter} onChange={(v) => set("kickAfter", v)} label={cfg.kickAfter ? "Kick" : "Don't kick"} />
          </SettingCard>
          <label>Kick message<input value={cfg.kickMessage} onChange={text("kickMessage")} /></label>
          <PlaceholderHint extra={["violation"]} />
        </Panel>

        {/* The panel id is a saved-layout key — the title changed when the reward gained a second
            currency, the id must not. The reward and its receipts are Seeding rewards, per server. */}
        {seesReward && <>
        <Panel id="reward" caps="seeding.rewards" title="Seed reward">
          {status?.lastCycle && (
            <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <span className="hint" style={{ margin: 0 }}>
                Last seed ended {new Date(status.lastCycle.endedAt).toLocaleString()} — {status.lastCycle.rewarded
                  ? ((status.lastCycle.owed ?? 0) > 0
                    ? `reward round fired, but ${status.lastCycle.owed} seeder(s) are still owed part of it (see Recent seed payouts)`
                    : "reward round fired")
                  : status.lastCycle.refusal
                    ? status.lastCycle.refusal
                    : `NOT paid; ${status.lastCycle.qualifying} seeder(s) met the minimum`}.
              </span>
              {!status.lastCycle.refusal && status.lastCycle.qualifying > 0 && canManage && (
                <button className="mini" onClick={payLast} disabled={payBusy}>{payBusy ? "Queuing…" : "Pay last seed"}</button>
              )}
              {status.lastCycle.rewarded && (status.lastCycle.owed ?? 0) > 0 && canManage && (
                <button className="mini" onClick={payLast} disabled={payBusy}>{payBusy ? "Queuing…" : `Retry ${status.lastCycle.owed} unpaid`}</button>
              )}
            </div>
          )}
          <SettingCard title="Reward seeders" description="When the server crosses into live, pay everyone who seeded for the minimum time.">
            <Toggle checked={cfg.rewardEnabled} onChange={(v) => set("rewardEnabled", v)} label={cfg.rewardEnabled ? "On" : "Off"} />
          </SettingCard>
          {/* Two independent currencies: either, both, or neither. Zero means "don't give this
              one", which is why both boxes start at 0 rather than 1. */}
          <div className="grid">
            <label>VIP duration (hours)<input type="number" min={0} value={cfg.rewardHours} onChange={num("rewardHours")} /></label>
            <label>Points<input type="number" min={0} value={cfg.rewardPoints ?? 0} onChange={num("rewardPoints")} /></label>
            <label>Minimum seed time (minutes)<input type="number" min={0} value={cfg.minSeedMinutes} onChange={num("minSeedMinutes")} /></label>
            <label>Don&apos;t pay the same seeder again within (minutes)<NumField min={0} value={Math.round(cfg.rewardDelaySec / 60)} onValue={(n) => set("rewardDelaySec", Math.max(0, n) * 60)} /></label>
          </div>
          <Explanation>
            Set either to 0 to leave it out — VIP only, points only, or both. Points are a balance on
            a Discord account, so a seeder who has never linked theirs gets the VIP half and the
            skip is recorded on their reward entry.
          </Explanation>
          {cfg.rewardEnabled && cfg.rewardHours <= 0 && cfg.rewardPoints <= 0 && (
            <Callout variant="warn">The reward is on but gives nothing — set VIP hours, points, or both. Saving is refused until you do.</Callout>
          )}
          <Explanation>
            If the population drops and the server goes live again within this many minutes of a
            reward, anyone <strong>already paid</strong> in that time gets the already-paid message below
            instead of a second reward — only seeders who weren&apos;t paid yet are rewarded. 0 = every
            go-live pays everyone who seeded long enough.
          </Explanation>
          {cfg.rewardDelaySec > 0 && (
            <>
              <label>Already-paid message<textarea rows={2} value={cfg.rewardRepeatMessage ?? ""} onChange={text("rewardRepeatMessage")} /></label>
              <PlaceholderHint extra={["window"]} />
              <Explanation>Sent to a seeder paid within the window above when the server goes live again. {"{window}"} writes the window (&ldquo;1 hour&rdquo;). Leave it blank to say nothing.</Explanation>
            </>
          )}
          <SettingCard title="Cumulative VIP" description="Add to any existing VIP instead of overwriting it, so repeat seeders stack time.">
            <Toggle checked={cfg.rewardCumulative} onChange={(v) => set("rewardCumulative", v)} label={cfg.rewardCumulative ? "Stack" : "Replace"} />
          </SettingCard>

          <h4 style={{ marginBottom: 4 }}>Bridge rewards</h4>
          <Explanation>
            Also pay VIP on <strong>other servers</strong> when this one&apos;s seed round pays out — each
            stop with its own hours (&ldquo;seed here, get 3 days here and 1 day there&rdquo;). A server of the
            same game pays every qualifying seeder. A server of <strong>another game</strong> pays only
            seeders registered for that game — their Discord link is the bridge — and anyone else&apos;s
            slice is skipped with the reason on their reward entry. The in-game reward message says
            both halves: what landed (&ldquo;Bridge bonus: 24h VIP on X&rdquo;) and any miss the player can fix
            (&ldquo;no Discord link&rdquo;, &ldquo;not registered&rdquo;) — a miss on our side stays out of their message and
            lives on the entry. Points aren&apos;t bridged: the balance
            already lives on the Discord account. Adding or changing a stop needs VIP-grant rights on
            that server. Follows the Stack/Replace switch above; permanent VIP is never touched.
          </Explanation>
          {(cfg.rewardBridge ?? []).map((t, i) => {
            const rows = cfg.rewardBridge ?? [];
            const target = servers.find((s) => s.id === t.serverId);
            const crossGame = Boolean(target?.game && server?.game && target.game !== server.game);
            return (
              <div key={t.serverId || i} className="row" style={{ gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                <select
                  value={t.serverId}
                  onChange={(e) => set("rewardBridge", rows.map((r, j) => (j === i ? { ...r, serverId: e.target.value } : r)))}
                >
                  <option value="">Pick a server…</option>
                  {/* A stop whose target left the live list (retired since it was saved) must stay
                      legible and removable — without this the row reads "Pick a server…" while
                      silently holding an id. The worker skips it at payout with the reason. */}
                  {t.serverId && !servers.some((s) => s.id === t.serverId) && (
                    <option value={t.serverId}>(unavailable server — skipped at payout)</option>
                  )}
                  {servers
                    .filter((s) => s.id !== serverId && (s.id === t.serverId || !rows.some((r) => r.serverId === s.id)))
                    .map((s) => <option key={s.id} value={s.id}>{s.name}{s.game && server?.game && s.game !== server.game ? " (other game)" : ""}</option>)}
                </select>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  VIP hours
                  <input type="number" min={1} style={{ width: 90 }} value={t.hours}
                    onChange={(e) => set("rewardBridge", rows.map((r, j) => (j === i ? { ...r, hours: Number(e.target.value) } : r)))} />
                </label>
                {crossGame && <span className="badge observe">registered seeders only</span>}
                <button className="mini ghost" onClick={() => set("rewardBridge", rows.filter((_, j) => j !== i))}>Remove</button>
              </div>
            );
          })}
          {(cfg.rewardBridge ?? []).length < 8 && servers.some((s) => s.id !== serverId && !(cfg.rewardBridge ?? []).some((r) => r.serverId === s.id)) && (
            <button className="mini" onClick={() => set("rewardBridge", [...(cfg.rewardBridge ?? []), { serverId: "", hours: 24 }])}>Add a bridge server</button>
          )}
          <label>Reward message<input value={cfg.rewardMessage} onChange={text("rewardMessage")} /></label>
          <PlaceholderHint extra={["reward", "reward_hours", "reward_points"]} />
          <Explanation>
            {"{reward}"} writes whichever halves are switched on (&ldquo;1d of VIP&rdquo;, &ldquo;500 Points&rdquo;, or both), so one
            message reads correctly in every combination. {"{vip_until}"} is when the player&apos;s VIP on this
            server now runs out (in the auto-settings timezone); leave it out and the date is appended as its
            own sentence, like CRCON does. A permanent VIP is never rewritten — those players are thanked and
            told their VIP already covers it.
          </Explanation>
          {/* The footnote only exists where there is a currency to talk about. It is the half that
              reaches the seeder who got NOTHING — without it they never learn the reward exists. */}
          {cfg.rewardPoints > 0 && (
            <>
              <label>Currency note — linked seeder<input value={cfg.rewardLinkedNote ?? ""} onChange={text("rewardLinkedNote")} /></label>
              <label>Currency note — unlinked seeder<input value={cfg.rewardUnlinkedNote ?? ""} onChange={text("rewardUnlinkedNote")} /></label>
              <Explanation>
                Sent with the reward whenever points are on. The unlinked line is the only thing an
                unlinked seeder hears — they collect the VIP half and would otherwise never learn
                the currency exists — so put your Discord invite in it. Tokens:{" "}
                {"{currency} {reward_points} {player_name}"}, plus {"{balance}"} on the linked line
                (an unlinked player has no balance, so it renders as nothing there). Leave either
                blank to say nothing to that half.
              </Explanation>
            </>
          )}
          {cfg.rewardEnabled && cfg.rewardPoints > 0 && cfg.rewardHours <= 0 && /\{reward_hours\}/.test(cfg.rewardMessage) && (
            <Callout variant="info">This message still mentions {"{reward_hours}"}, which is now 0 — it will read &ldquo;0h&rdquo;. {"{reward}"} says what is actually being given.</Callout>
          )}
        </Panel>

        <Panel id="payouts" caps="seeding.rewards" title="Recent seed payouts" defaultCollapsed>
          <Explanation>
            Every seeder of every reward round gets one receipt: paid, partly paid (points skipped or
            capped), or FAILED with the reason. Only players online at the go-live moment who met the
            minimum seed time qualify — nobody else gets a row, so a short list is who qualified.
          </Explanation>
          {!payouts && <p className="muted">Loading…</p>}
          {payouts && (payouts.rounds ?? []).length === 0 && <p className="muted">No reward rounds on record for this server yet.</p>}
          {(roundPages.items ?? []).map((r) => {
            const failed = (r.receipts ?? []).filter((x) => x.outcome === "failed").length;
            return (
              <details key={r.round} className="subcard" style={{ marginBottom: 8 }} open={failed > 0}>
                <summary>
                  <strong>{new Date(r.at).toLocaleString()}</strong>{" "}
                  <span className="badge active">{r.receipts.length} seeder{r.receipts.length === 1 ? "" : "s"}</span>{" "}
                  {failed > 0 && <span className="badge danger">{failed} failed</span>}{" "}
                  {r.dryRun && <span className="badge observe">dry-run — nothing was granted</span>}{" "}
                  {r.manual && <span className="badge">paid late (pay last seed)</span>}
                </summary>
                <ul style={{ margin: "6px 0 0 18px" }}>
                  {r.receipts.map((x, i) => (
                    <li key={`${x.playerId}-${i}`} className={x.outcome === "failed" ? "error" : x.outcome === "partial" ? "hint" : undefined}>{x.summary}</li>
                  ))}
                </ul>
              </details>
            );
          })}
          {(payouts?.rounds ?? []).length > 0 && <Pager list={roundPages} noun="round" />}
        </Panel>
        </>}
      </PanelGroup>

      <div className="actions" style={{ marginTop: 16 }}>
        <button className="primary" onClick={save} disabled={!dirty || busy || rewardEmpty} title={rewardEmpty ? "The seed reward is on but gives nothing — set VIP hours, points, or both" : undefined}>{busy ? "Saving…" : "Save seeding config"}</button>
        {dirty && <button className="ghost" onClick={load}>Discard</button>}
      </div>
    </div>
  );
}
