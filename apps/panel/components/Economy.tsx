"use client";
/**
 * The community economy, staff side (docs/vip-module.md).
 *
 * Three panels: the settings (currency, cap, claims, gifting), the shop offers — each offer
 * carrying its own SERVER SCOPE, because "sold per server" vs "sold community-wide" is
 * configuration here, never code on the Discord side — and the member roster with ledgers and
 * audited manual adjustments. The player-facing half of all of this lives on Discord; this page
 * is where staff decide what that half offers and repair what it gets wrong.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { api, authHeaders, refusal } from "../lib/api";
import { useServers } from "../lib/servers";
import { useConfirm, useToast } from "../lib/feedback";
import { PanelGroup, Panel } from "./Panel";
import { ActionResult, AskNotice, Callout, EmptyState, Pager, RoleDisclosure, SearchInput, SettingSwitch, SkeletonRows, Toggle, roleListNote, type GuildRole, Explanation } from "./ui";
import { usePagedList } from "../lib/paged";
import { isText, isTextOrNull, useRemembered } from "../lib/remembered";
import { PlayerLink } from "./PlayerLink";
import { useGrants } from "../lib/grants";
import { hasCap } from "../lib/access";
import { Time } from "./Time";
import { fmtExact } from "../lib/time";

interface Offer {
  id: string; label: string; points: number; days: number;
  scope: { mode: "all" } | { mode: "servers"; serverIds: string[] };
  enabled: boolean;
  /** Discord roles allowed to buy it. Empty = everyone linked. */
  roleIds: string[];
}
interface Claim { enabled: boolean; min: number; max: number; roleIds: string[] }
interface Config {
  currencyName: string;
  balanceCap: number | null;
  claims: { daily: Claim; monthly: Claim };
  gifting: { enabled: boolean; minAmount: number; maxAmount: number | null };
  vipGifting: { enabled: boolean; roleIds: string[] };
  offers: Offer[];
  registration: { bonusDays: number; bonusPoints: number; bonusAllGames: boolean; bonusPerGame: boolean; gameRoles: Record<string, string>; serverIds: string[] };
  updatedAt: string;
}
/** What the server says Discord would draw for one member, and why (GET /economy/gate-check). */
interface GateCheck {
  guildId: string;
  member: { found: boolean; name?: string; roles?: { id: string; name: string | null }[]; reason?: string };
  checks: {
    key: string; label: string; enabled: boolean;
    required: { id: string; name: string | null; inGuild: boolean | null }[];
    verdict: "ungated" | "allowed" | "lacks-role" | "no-roles-seen";
    wouldShow: boolean;
  }[];
}
interface Member { discordId: string; discordName: string | null; balance: number; updatedAt: string }
/** What a VIP shop purchase landed as on one server: when its days start and when that VIP now ends. */
interface VipBought { serverId: string | null; serverName: string; playerId: string; from: string | null; until: string | null; held: boolean }
interface ActivityEntry {
  id: string; discordId: string; discordName: string | null;
  delta: number; reason: string; ref: string | null; actorName: string | null; createdAt: string; kind: string;
  vip?: VipBought[];
}

interface Entry { id: string; delta: number; reason: string; ref: string | null; actorName: string | null; createdAt: string; vip?: VipBought[] }
interface LinkedPlayer { id: string; name: string; game?: string; platform: string; platformId: string; lastSeen: string }
interface ImportReport {
  usersSeen: number;
  links: { imported: number; already: number; conflicts: string[] };
  balances: { imported: number; already: number; totalPoints: number };
  members: number;
  welcomeMarkers: number;
}

/** Under a VIP purchase's line: on each server, when the days bought start and when that VIP now ends. */
function VipDates({ vip }: { vip?: VipBought[] }) {
  if (!vip?.length) return null;
  return (
    <div className="muted vip-bought" style={{ fontSize: "0.78rem" }}>
      {vip.map((b, i) => (
        <div key={`${b.serverId ?? ""}:${i}`}>
          {b.serverName}: {b.held ? "days saved for when the group's permanent VIP ends"
            : b.until ? <>VIP {b.from ? <>from {fmtExact(b.from)} </> : null}until {fmtExact(b.until)}</> : null}
        </div>
      ))}
    </div>
  );
}

/** The offer's reach: all servers, or exactly these — same chips as the ban scope picker, minus
 *  the modes that make no sense for a shop (an "everywhere but" offer is not a thing staff ask for). */
function OfferScope({ value, onChange, disabled }: {
  value: Offer["scope"]; onChange: (s: Offer["scope"]) => void; disabled?: boolean;
}) {
  const { servers, numberOf } = useServers();
  return (
    <span className="scope-pick" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span className="seg" role="group" aria-label="Where it lands">
        <button type="button" className={`seg-btn ${value.mode === "all" ? "active" : ""}`} disabled={disabled}
          onClick={() => onChange({ mode: "all" })}>All servers</button>
        <button type="button" className={`seg-btn ${value.mode === "servers" ? "active" : ""}`} disabled={disabled}
          onClick={() => onChange({ mode: "servers", serverIds: value.mode === "servers" ? value.serverIds : [] })}>Only these</button>
      </span>
      {value.mode === "servers" && servers.map((s) => {
        const on = value.serverIds.includes(s.id);
        return (
          <button key={s.id} type="button" className={`scope-chip${on ? " on" : ""}`} aria-pressed={on} title={s.name} disabled={disabled}
            onClick={() => onChange({ mode: "servers", serverIds: on ? value.serverIds.filter((x) => x !== s.id) : [...value.serverIds, s.id] })}>
            <span className="scope-no">{numberOf(s.id) ?? "?"}</span>
          </button>
        );
      })}
    </span>
  );
}

const num = (v: string): number => Number(v) || 0;

export default function Economy({ canManage = false }: { canManage?: boolean }) {
  /*
   * `canManage` is economy.config at read — the settings. The shop's offers are economy.shop, and
   * member balances economy.balances (read to look, write to mint): each a DIFFERENT trust, as the
   * API splits them. The panel used to run everything off canManage, which both hid the member
   * list from a balances-read reviewer and showed the adjust form to a config admin the route would
   * refuse. Any of them, held at read, edits too: a change made without write is sent for approval
   * — everything a role can see, it can ask for. The bot.db import is a file upload, which never
   * asks (a request cannot carry the file), so it stays with economy.config write.
   */
  const grants = useGrants();
  const canBalances = hasCap(grants, "economy.balances");
  const canShop = hasCap(grants, "economy.shop");
  const mayImport = hasCap(grants, "economy.config", "write");
  const toast = useToast();
  const confirm = useConfirm();
  const [cfg, setCfg] = useState<Config | null>(null);
  // The document as the SERVER last confirmed it. Every field here is a local edit until Save, and
  // nothing said so — a toggle flipped and left unsaved looks exactly like a toggle that is live,
  // which is indistinguishable from a broken feature when Discord disagrees with the screen.
  const [savedJson, setSavedJson] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Balances ALREADY above the cap. A credit written without the cap overshoots for good — the
  // clamp runs at write time and nothing revisits a balance later — so the count has to be shown
  // rather than assumed away, with the correction next to it.
  const [overCap, setOverCap] = useState<{ members: number; excess: number } | null>(null);
  const [trimming, setTrimming] = useState(false);

  // The settings and the offers are one document, read by either's holders. Read by anyone else,
  // its refusal took the screen, and a balances reviewer never saw the members they may see.
  const readsConfig = canManage || canShop;
  const loadConfig = useCallback(async () => {
    if (!readsConfig) return;
    try {
      const r = await api<{ config: Config; overCap?: { members: number; excess: number } }>("/economy/config");
      setCfg(r.config);
      setSavedJson(JSON.stringify(r.config));
      setOverCap(r.overCap ?? null);
    } catch (e) { setError((e as Error).message); }
  }, [readsConfig]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  const [resyncing, setResyncing] = useState(false);
  const [progress, setProgress] = useState("");

  // Discord paces role writes to a few per window, so this is minutes of mostly waiting. The run
  // lives on the server and this only watches it — a held-open request timed out in the browser
  // while the reconcile carried on invisibly.
  interface RoleRun { status: "idle" | "running" | "done" | "error"; done?: number; total?: number; error?: string;
    result?: { members: number; applied: number; removed: number; absent: number; refused: number } }

  const pollRoles = useCallback(async () => {
    for (;;) {
      const st = await api<RoleRun>("/economy/resync-game-roles/status");
      if (st.status === "running") {
        setProgress(st.total ? `${st.done ?? 0} of ${st.total}` : "starting…");
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      return st;
    }
  }, []);

  async function resyncRoles() {
    setResyncing(true); setProgress("starting…");
    try {
      await api("/economy/resync-game-roles", { method: "POST" });
      const st = await pollRoles();
      if (st.status === "error") throw new Error(st.error ?? "the reconcile failed");
      const r = st.result;
      if (!r) { toast.success("Reconcile finished"); return; }
      const notes = [`${r.applied} applied`, `${r.removed} removed`];
      // "Absent" is the ordinary case of a member who left the guild; "refused" is the one an
      // operator can actually fix (the role sits above the bot) — worth keeping apart.
      if (r.absent) notes.push(`${r.absent} not in the guild`);
      if (r.refused) notes.push(`${r.refused} refused by Discord`);
      toast.success(`Checked ${r.members} linked member(s): ${notes.join(", ")}`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setResyncing(false); setProgress(""); }
  }

  async function trimBalances() {
    if (!cfg || cfg.balanceCap === null) return;
    if (!(await confirm({
      title: `Trim ${overCap?.members ?? 0} balance(s) to ${cfg.balanceCap.toLocaleString()}?`,
      body: `Every balance above the cap is brought down to it, removing ${(overCap?.excess ?? 0).toLocaleString()} ${cfg.currencyName} in total. Each one is written as a real ledger entry, so the member can see what happened and why, rather than their number quietly changing.`,
      confirmLabel: "Trim to cap",
      danger: true,
    }))) return;
    setTrimming(true);
    try {
      const r = await api<{ members: number; removed: number }>("/economy/trim-balances", { method: "POST" });
      toast.success(`Trimmed ${r.members} balance(s), removing ${r.removed.toLocaleString()} ${cfg.currencyName}`);
      await loadConfig();
    } catch (e) { toast.error((e as Error).message); }
    finally { setTrimming(false); }
  }

  async function save(next: Config) {
    setSaving(true);
    try {
      const r = await api<{ config: Config }>("/economy/config", { method: "PUT", body: next });
      setCfg(r.config);
      // The SERVER's echo, not what was sent — validation normalises fields (a typed "0500" comes
      // back 500), so a baseline taken from the request would claim edits that do not exist.
      setSavedJson(JSON.stringify(r.config));
      toast.success("Economy settings saved");
      // Lowering the cap can put people over it who were not before — re-read rather than leaving
      // a stale count under a number that just changed.
      await loadConfig();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  }

  const dirty = cfg !== null && savedJson !== null && JSON.stringify(cfg) !== savedJson;

  // --- "why can't they see the button" ---
  // A role gate says nothing when it refuses; that is the point, and it is why a misconfigured gate
  // is invisible to staff too. This asks the server to run the real gate against a real member's
  // real roles and report the verdict, instead of handing somebody a role and watching Discord.
  const [gateId, setGateId] = useState("");
  const [gateBusy, setGateBusy] = useState(false);
  const [gate, setGate] = useState<GateCheck | null>(null);
  async function runGateCheck() {
    setGateBusy(true);
    setGate(null);
    try { setGate(await api<GateCheck>(`/economy/gate-check?discordId=${encodeURIComponent(gateId.trim())}`)); }
    catch (e) { toast.error((e as Error).message); }
    finally { setGateBusy(false); }
  }

  const patch = (p: Partial<Config>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const patchClaim = (kind: "daily" | "monthly", p: Partial<Claim>) =>
    setCfg((c) => (c ? { ...c, claims: { ...c.claims, [kind]: { ...c.claims[kind], ...p } } } : c));

  // The PUBLIC server's roles, not the staff server's — these gate what members can claim, and
  // members are in the public Discord. Absent (no bot token, no public server set, no permission)
  // is not an error here: the claim just shows its stored ids instead of names.
  //
  // `fellBack` means no public server is configured and these are the STAFF server's roles standing
  // in. Right for a one-server community; for a two-server one it is the quiet way a gate dies —
  // role ids are per-server, so a gate set from this list matches nobody in the server the panel
  // actually runs in, and a claim nobody can make is exactly what a hidden button looks like.
  const [guildRoles, setGuildRoles] = useState<GuildRole[]>([]);
  const [rolesNote, setRolesNote] = useState("");
  const [rolesFellBack, setRolesFellBack] = useState(false);
  useEffect(() => {
    api<{ roles?: GuildRole[]; error?: string; fellBack?: boolean; botConfigured?: boolean }>("/discord/roles?guild=community")
      .then((r) => { setGuildRoles(r.roles ?? []); setRolesNote(roleListNote(r)); setRolesFellBack(r.fellBack === true); })
      // Said as what it is: the chips' own fallback sends staff to set up the bot.
      .catch((e) => { setGuildRoles([]); setRolesNote(`Couldn't read the Discord role list: ${(e as Error).message}`); });
  }, []);

  // Which games actually have servers here (the registration-role rows), with their proper names.
  const { servers, numberOf } = useServers();
  const [gameLabels, setGameLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    api<{ games?: { id: string; label: string }[] }>("/games")
      .then((r) => setGameLabels(Object.fromEntries((r.games ?? []).map((g) => [g.id, g.label]))))
      .catch(() => {});
  }, []);
  const gamesWithServers = [...new Set(servers.map((s) => s.game).filter((g): g is string => Boolean(g)))];

  // --- members (paged, searchable) ---
  // The search, the activity filter, both pages and the member open below are kept for the
  // sitting: a linked player's profile opened from a ledger comes back to the same member.
  const [q, setQ] = useRemembered("economy.search", "", isText, "session");
  // usePagedList calls (offset, limit) — IN THAT ORDER. These two swapped once, and the symptom
  // was maximally confusing: page one asked for limit=0&offset=25, the route turned the zero into
  // a sane default, and the offset skipped past every member — "Members 1" over an empty table.
  const fetchMembers = useCallback(async (offset: number, limit: number) => {
    // Without balances read the panel below is hidden; asking anyway would only 403 into a toast.
    if (!canBalances) return { items: [], total: 0 };
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (q.trim()) params.set("q", q.trim());
    const r = await api<{ members: Member[]; total: number }>(`/economy/members?${params.toString()}`);
    return { items: r.members, total: r.total };
  }, [q, canBalances]);
  const members = usePagedList<Member>(fetchMembers, "economy.members");

  // --- one open member: their ledger + the adjust form ---
  const [dbFile, setDbFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  // Raw fetch, not the api() helper: the body is the SQLite file's bytes, not JSON.
  const runImport = async () => {
    if (!dbFile) return;
    setImporting(true); setImportReport(null);
    try {
      const res = await fetch("/api/economy/import-botdb", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/octet-stream" },
        body: await dbFile.arrayBuffer(),
      });
      if (!res.ok) throw await refusal(res);
      setImportReport((await res.json()) as ImportReport);
      toast.success("Import finished");
      void members.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  // --- the cross-member activity feed: every ledger movement in one list ---
  const [actKind, setActKind] = useRemembered("economy.activityKind", "", isText, "session");
  const [actKinds, setActKinds] = useState<{ id: string; label: string }[]>([]);
  const fetchActivity = useCallback(async (offset: number, limit: number) => {
    if (!canBalances) return { items: [], total: 0 };
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (actKind) params.set("kind", actKind);
    const r = await api<{ entries: ActivityEntry[]; total: number; kinds: { id: string; label: string }[] }>(`/economy/activity?${params.toString()}`);
    // An answer missing its fields (a feature with no data yet) is no kinds, not a crash.
    setActKinds(r.kinds ?? []);
    return { items: r.entries, total: r.total };
  }, [actKind, canBalances]);
  const activity = usePagedList<ActivityEntry>(fetchActivity, "economy.activity");

  const [openId, setOpenId] = useRemembered<string | null>("economy.member", null, isTextOrNull, "session");
  const [ledger, setLedger] = useState<Entry[] | null>(null);
  const [linked, setLinked] = useState<LinkedPlayer[]>([]);
  const [adj, setAdj] = useState({ delta: "", reason: "" });
  // A second press while the first is in flight would apply the amount twice: an adjustment has no
  // idempotency key, by design (two real corrections of the same size are legitimate).
  const [adjusting, setAdjusting] = useState(false);
  // The open member's ledger is read whenever the open member changes — including on the way back
  // to the tab, for the one that was open when a linked profile was followed.
  useEffect(() => {
    setLedger(null); setLinked([]);
    if (!openId || !canBalances) return;
    let live = true;
    api<{ ledger: Entry[]; players?: LinkedPlayer[] }>(`/economy/members/${encodeURIComponent(openId)}?limit=25`)
      .then((r) => { if (live) { setLedger(r.ledger); setLinked(r.players ?? []); } })
      .catch((e) => { if (live) toast.error((e as Error).message); });
    return () => { live = false; };
  }, [openId, canBalances, toast]);
  const openMember = (id: string) => {
    setAdj({ delta: "", reason: "" });
    setOpenId(openId === id ? null : id);
  };
  async function adjust(id: string) {
    setAdjusting(true);
    try {
      const r = await api<{ member: Member; entry: Entry }>(`/economy/members/${encodeURIComponent(id)}/adjust`, {
        method: "POST", body: { delta: Number(adj.delta), reason: adj.reason.trim() },
      });
      toast.success(`Balance is now ${r.member.balance.toLocaleString()}${r.entry.delta !== Number(adj.delta) ? ` (applied ${r.entry.delta} — the cap trimmed it)` : ""}`);
      setAdj({ delta: "", reason: "" });
      setLedger((l) => (l ? [r.entry, ...l] : [r.entry]));
      members.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setAdjusting(false); }
  }

  if (error) return <div className="card"><ActionResult error={error} /></div>;

  const cur = cfg?.currencyName ?? "Points";
  // The welcome has no `enabled` of its own — 0 and 0 IS off, so the switch reads and writes that
  // rather than carrying a fourth piece of state that could disagree with the numbers.
  const reg = cfg?.registration ?? { bonusDays: 0, bonusPoints: 0, bonusAllGames: false, bonusPerGame: false, gameRoles: {}, serverIds: [] };
  const welcomeOn = reg.bonusPoints > 0 || reg.bonusDays > 0;
  return (
    <PanelGroup viewId="economy">
      <Panel id="settings" caps="economy.config" title="Settings"
        subtitle={cfg ? `${cur}${cfg.balanceCap !== null ? ` · cap ${cfg.balanceCap.toLocaleString()}` : ""}` : undefined}>
        {canManage && <AskNotice capability="economy.config" />}
        {!cfg ? <SkeletonRows rows={4} /> : (
          <div>
            <div className="grid">
              <label>Currency name
                <input value={cfg.currencyName} disabled={!canManage} onChange={(e) => patch({ currencyName: e.target.value })} />
              </label>
              <label>Balance cap <span className="muted">(blank = uncapped; credits trim, never fail)</span>
                <input type="number" min="0" value={cfg.balanceCap ?? ""} disabled={!canManage}
                  onChange={(e) => patch({ balanceCap: e.target.value === "" ? null : num(e.target.value) })} />
              </label>
            </div>
            {overCap && overCap.members > 0 && cfg.balanceCap !== null && (
              <div className="setting-card" style={{ marginTop: 8 }}>
                <strong>{overCap.members.toLocaleString()} member(s) are above the cap</strong>
                <p className="hint" style={{ margin: "4px 0 8px" }}>
                  {overCap.excess.toLocaleString()} {cfg.currencyName} over the {cfg.balanceCap.toLocaleString()} ceiling in total.
                  Credits clamp when they are written, so nothing reaching this state came through a
                  normal claim or purchase — trimming is a one-off correction, not a recurring chore.
                </p>
                {canManage && (
                  <button className="danger" disabled={trimming} onClick={() => void trimBalances()}>
                    {trimming ? "Trimming…" : "Trim to cap"}
                  </button>
                )}
              </div>
            )}
            {/* Said once, above every gate on this screen, because it is the one failure none of
                them can report: a gate set from the wrong server's roles matches nobody, and a
                claim nobody can make is drawn exactly the same as a claim switched off. */}
            {rolesFellBack && (
              <Callout variant="warn">
                These are your <strong>staff</strong> Discord server&apos;s roles — no public server is set. If your
                VIP panel runs in a separate public Discord, set that server&apos;s id under Administration → Discord
                first: role ids never carry across servers, so a gate chosen here would hide the feature from
                everyone. If you run one Discord for everything, this is fine.
              </Callout>
            )}
            {/* Each switchable feature is a Switch row; its numbers only exist once it is on.
                A screen of greyed-out inputs for things nobody uses is noise on a desktop and
                unusable scrolling on a phone. */}
            {(["daily", "monthly"] as const).map((kind) => (
              <SettingSwitch key={kind} label={`${kind === "daily" ? "Daily" : "Monthly"} claim`} checked={cfg.claims[kind].enabled} disabled={!canManage}
                onChange={(v) => patchClaim(kind, { enabled: v })}
                hint={`A random whole amount in the band, once per ${kind === "daily" ? "day" : "month"} in the app's time zone. No linked game account needed — the balance is the member's.`}>
                <label className="num">min
                  <input type="number" inputMode="numeric" min="0" value={cfg.claims[kind].min} disabled={!canManage}
                    onChange={(e) => patchClaim(kind, { min: num(e.target.value) })} />
                </label>
                <label className="num">max
                  <input type="number" inputMode="numeric" min="0" value={cfg.claims[kind].max} disabled={!canManage}
                    onChange={(e) => patchClaim(kind, { max: num(e.target.value) })} />
                </label>
                <RoleDisclosure label="Who can claim" emptyLabel="anyone" roles={guildRoles} note={rolesNote} value={cfg.claims[kind].roleIds ?? []} disabled={!canManage}
                  onChange={(roleIds) => patchClaim(kind, { roleIds })} />
              </SettingSwitch>
            ))}

            {/* A gate that refuses says nothing — to the member by design, and to staff by accident.
                "Switched off", "pointed at a role nobody here holds" and "working correctly" are all
                drawn as an absent button, so the only way to tell them apart used to be to hand
                somebody a role and go look in Discord. This asks the server instead. */}
            <details className="role-disclosure">
              <summary><span className="claim-roles-label">Why can&apos;t someone see a button?</span> <span className="muted">check a member against the saved gates</span></summary>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "8px 0" }}>
                <input value={gateId} onChange={(e) => setGateId(e.target.value)} placeholder="Discord user id"
                  inputMode="numeric" style={{ minWidth: 220 }}
                  onKeyDown={(e) => { if (e.key === "Enter" && /^\d{5,25}$/.test(gateId.trim())) void runGateCheck(); }} />
                <button disabled={gateBusy || !/^\d{5,25}$/.test(gateId.trim())} onClick={() => void runGateCheck()}>
                  {gateBusy ? "Checking…" : "Check"}
                </button>
                {dirty && <span className="hint">Checks the SAVED settings — save first to test your edits.</span>}
              </div>
              <p className="hint">Discord → Developer Mode on → right-click the member → Copy User ID.</p>
              {gate && (
                <div style={{ marginTop: 8 }}>
                  {!gate.member.found ? (
                    <p className="hint">{gate.member.reason}</p>
                  ) : (
                    <>
                      <p className="hint">
                        <strong>{gate.member.name}</strong> holds {gate.member.roles?.length ?? 0} role(s) in that server:{" "}
                        {gate.member.roles?.map((r) => r.name ?? r.id).join(", ") || "none"}
                      </p>
                      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                        {gate.checks.map((c) => (
                          <li key={c.key} style={{ marginBottom: 4 }}>
                            <strong>{c.label}:</strong>{" "}
                            {c.wouldShow ? <span style={{ color: "var(--ok)" }}>would show</span> : <span style={{ color: "var(--warn)" }}>hidden</span>}
                            {" — "}
                            {!c.enabled ? "switched off in these settings."
                              : c.verdict === "ungated" ? "no role gate; open to everyone."
                              : c.verdict === "allowed" ? `they hold ${c.required.filter((r) => gate.member.roles?.some((h) => h.id === r.id)).map((r) => r.name ?? r.id).join(", ")}.`
                              : c.verdict === "no-roles-seen" ? "the gate needs a role and no roles could be read for them."
                              : `they hold none of ${c.required.map((r) => r.name ?? r.id).join(", ")}.`}
                            {/* The misdirected gate: a role id that is not one of THIS server's roles
                                can never be held by anyone here, so the feature is off for everybody. */}
                            {c.required.some((r) => r.inGuild === false) && (
                              <div style={{ color: "var(--err)" }}>
                                Not a role in this Discord server: {c.required.filter((r) => r.inGuild === false).map((r) => r.id).join(", ")} — nobody can ever match it.
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </details>

            <SettingSwitch label={`Member-to-member ${cur} gifts`} checked={cfg.gifting.enabled} disabled={!canManage}
              onChange={(v) => patch({ gifting: { ...cfg.gifting, enabled: v } })}
              hint="Both members must be linked. The maximum bounds ONE gift — leave it blank for no maximum.">
              <label className="num">minimum
                <input type="number" inputMode="numeric" min="1" value={cfg.gifting.minAmount} disabled={!canManage}
                  onChange={(e) => patch({ gifting: { ...cfg.gifting, minAmount: num(e.target.value) } })} />
              </label>
              <label className="num">maximum
                <input type="number" inputMode="numeric" min="1" placeholder="none" value={cfg.gifting.maxAmount ?? ""} disabled={!canManage}
                  onChange={(e) => patch({ gifting: { ...cfg.gifting, maxAmount: e.target.value === "" ? null : num(e.target.value) } })} />
              </label>
            </SettingSwitch>

            <SettingSwitch label="Gifting VIP" checked={cfg.vipGifting?.enabled ?? false} disabled={!canManage}
              onChange={(v) => patch({ vipGifting: { ...cfg.vipGifting, enabled: v } })}
              hint={cfg.offers.some((o) => o.enabled)
                ? "Members can buy any enabled shop offer for somebody else. Both must be linked."
                : "Members could buy shop offers for each other — but no offer is enabled yet, so no buttons will show."}>
              <RoleDisclosure label="Who can gift" roles={guildRoles} note={rolesNote} value={cfg.vipGifting?.roleIds ?? []} disabled={!canManage}
                onChange={(roleIds) => patch({ vipGifting: { ...cfg.vipGifting, roleIds } })} />
            </SettingSwitch>

            <SettingSwitch label="Registration welcome" checked={welcomeOn} disabled={!canManage}
              onChange={(v) => patch({ registration: v ? { ...reg, bonusPoints: 100, bonusDays: 0 } : { ...reg, bonusPoints: 0, bonusDays: 0 } })}
              hint={reg.bonusPerGame
                ? "Paid once per game, so registering on a second game pays it again — however the link is made: the in-game code, or staff linking them from Discord or the panel."
                : "Paid once per Discord account, ever, on their first link — whether they verify the in-game code or staff link them from Discord or the panel."}>
              <label className="num">{cur}
                <input type="number" inputMode="numeric" min="0" value={reg.bonusPoints} disabled={!canManage}
                  onChange={(e) => patch({ registration: { ...reg, bonusPoints: num(e.target.value) } })} />
              </label>
              <label className="num">VIP days
                <input type="number" inputMode="numeric" min="0" value={reg.bonusDays} disabled={!canManage}
                  onChange={(e) => patch({ registration: { ...reg, bonusDays: num(e.target.value) } })} />
              </label>
              {/* HOW OFTEN, then HOW FAR — in that order, because the first answer decides whether
                  the second one is even a question. */}
              <Toggle checked={reg.bonusPerGame} disabled={!canManage}
                onChange={(v) => patch({ registration: { ...reg, bonusPerGame: v } })}
                label="Pay it again for each new game they register"
                title="Off: one welcome per Discord account, ever — someone who registers a second game gets nothing for it. On: one per game, so each game's first registration pays. Never twice for the same game." />
              {/* Meaningless while per-game is on — the same week counted twice — so it is taken
                  away rather than left to be ticked and quietly ignored. */}
              {!reg.bonusPerGame && (
                <Toggle checked={reg.bonusAllGames} disabled={!canManage}
                  onChange={(v) => patch({ registration: { ...reg, bonusAllGames: v } })}
                  label="VIP days on all games they've linked"
                  title="Off: the days land only on the game they registered for. On: every game they have an account linked for gets them too — a game they haven't linked is skipped, since its servers have no id of theirs to grant to." />
              )}
            </SettingSwitch>

            {/* Which servers the PUBLIC panel offers when a member picks where they're playing.
                None ticked = all of them, so a fresh install works without being configured and
                "I ticked nothing" never means "nobody can register". Staff's own manual
                registration is unaffected — this is about what players are shown. */}
            {servers.length > 1 && (
              <div className="setting-switch on">
                <div className="setting-switch-head">
                  <span style={{ fontWeight: 600 }}>Registration servers</span>
                  <div className="setting-switch-fields">
                    <span className="scope-pick" style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <span className="seg">
                        <button type="button" className={`seg-btn ${reg.serverIds.length === 0 ? "active" : ""}`} disabled={!canManage}
                          onClick={() => patch({ registration: { ...reg, serverIds: [] } })}>All servers</button>
                        <button type="button" className={`seg-btn ${reg.serverIds.length > 0 ? "active" : ""}`} disabled={!canManage}
                          onClick={() => patch({ registration: { ...reg, serverIds: reg.serverIds.length ? reg.serverIds : servers.map((s) => s.id) } })}>Only these</button>
                      </span>
                      {reg.serverIds.length > 0 && servers.map((s) => {
                        const on = reg.serverIds.includes(s.id);
                        return (
                          <button key={s.id} type="button" className={`scope-chip${on ? " on" : ""}`} aria-pressed={on} title={s.name} disabled={!canManage}
                            onClick={() => patch({ registration: { ...reg, serverIds: on ? reg.serverIds.filter((x) => x !== s.id) : [...reg.serverIds, s.id] } })}>
                            <span className="scope-no">{numberOf(s.id) ?? "?"}</span>
                          </button>
                        );
                      })}
                    </span>
                  </div>
                </div>
                <p className="hint">
                  {reg.serverIds.length === 0
                    ? "Members are offered every server when they register."
                    : `Members are offered ${reg.serverIds.length} of ${servers.length} servers. A game with no offered server stops showing the link button entirely.`}
                </p>
              </div>
            )}

            {/* Per-game registration roles: no on/off switch of its own — "(no role)" IS off, and
                a switch on top of that would be a second state that could disagree with it. Only
                games that actually have a server get a row; the picker offers only roles the bot
                could actually hand out (the booster role can gate claims, but nobody can assign it). */}
            {gamesWithServers.length > 0 && (
              <div className="setting-switch on">
                <div className="setting-switch-head">
                  <span style={{ fontWeight: 600 }}>Registration roles</span>
                  <div className="setting-switch-fields" role="group" aria-label="Registration roles">
                    {gamesWithServers.map((g) => (
                      <label key={g} className="inline">{gameLabels[g] ?? g}
                        <select value={reg.gameRoles?.[g] ?? ""} disabled={!canManage}
                          onChange={(e) => patch({ registration: { ...reg, gameRoles: { ...reg.gameRoles, [g]: e.target.value } } })}>
                          <option value="">(no role)</option>
                          {guildRoles.filter((r) => !r.managed).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                          {/* A saved role we can't currently list still shows, by id — a restriction
                              that renders as "(no role)" is one nobody knows is there. */}
                          {(reg.gameRoles?.[g] ?? "") !== "" && !guildRoles.some((r) => r.id === reg.gameRoles[g]) && (
                            <option value={reg.gameRoles[g]}>{reg.gameRoles[g]}</option>
                          )}
                        </select>
                      </label>
                    ))}
                  </div>
                </div>
                <Explanation>Given in the community Discord when a member registers an account for that game, and taken back when staff clear the link.{rolesNote ? ` (${rolesNote})` : ""}</Explanation>
                {/* The role is granted when a link is WRITTEN, and nothing revisits it afterwards —
                    so a link created by a path that skipped that step (the cutover import did) leaves a
                    member linked but role-less forever. This reconciles every linked member at
                    once: adds what their links have earned, removes what they no longer hold. */}
                {canManage && (
                  <div className="actions" style={{ marginTop: 6 }}>
                    <button disabled={resyncing} onClick={() => void resyncRoles()}>
                      {resyncing ? `Reconciling… ${progress}` : "Reapply roles to all linked members"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {canManage && (
              <div className="actions" style={{ alignItems: "center", gap: 10 }}>
                <button className="primary" disabled={saving} onClick={() => save(cfg)}>{saving ? "Saving…" : "Save settings"}</button>
                {/* Discord reads the STORED document, so an unsaved edit is a screen that disagrees
                    with the bot — exactly "my toggle is on but the button never appears". */}
                {dirty && <span className="hint" style={{ color: "var(--warn, #b45309)" }}>Unsaved changes — Discord is still using the last saved settings.</span>}
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel id="offers" caps="economy.shop" title="Shop offers" subtitle={cfg ? String(cfg.offers.length) : undefined}>
        {canShop && <AskNotice capability="economy.shop" />}
        {!cfg ? <SkeletonRows rows={3} /> : (
          <div>
            <Explanation>One Discord button per enabled offer. The scope is where the VIP days land — a per-server
              shop is several offers with one-server scopes; a community-wide shop is one offer covering all.
              <br />
              &ldquo;Who can receive&rdquo; limits an offer to members holding a role — hidden from everyone else, and refused
              if pressed anyway. Point each game&rsquo;s offers at that game&rsquo;s registration role (set under Registration
              below) and members are only shown VIP for the games they actually play. It gates the <em>recipient</em>, so
              someone who plays one game can still gift the other game&rsquo;s VIP to a friend who plays it.</Explanation>
            {cfg.offers.length === 0 && <EmptyState icon="🛒" title="No offers yet">Add one below — nothing is purchasable until an offer exists and is enabled.</EmptyState>}
            {cfg.offers.map((o, i) => (
              <div key={o.id} className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 0", borderTop: i ? "1px solid var(--border)" : undefined }}>
                <label className="inline" title="Shown on the Discord button">
                  <input value={o.label} disabled={!canShop} style={{ width: 140 }}
                    onChange={(e) => patch({ offers: cfg.offers.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                </label>
                <label className="inline muted">{cur}
                  <input type="number" min="1" value={o.points} disabled={!canShop} style={{ width: 90 }}
                    onChange={(e) => patch({ offers: cfg.offers.map((x, j) => (j === i ? { ...x, points: num(e.target.value) } : x)) })} />
                </label>
                <label className="inline muted">days
                  <input type="number" min="1" value={o.days} disabled={!canShop} style={{ width: 70 }}
                    onChange={(e) => patch({ offers: cfg.offers.map((x, j) => (j === i ? { ...x, days: num(e.target.value) } : x)) })} />
                </label>
                <OfferScope value={o.scope} disabled={!canShop}
                  onChange={(scope) => patch({ offers: cfg.offers.map((x, j) => (j === i ? { ...x, scope } : x)) })} />
                <Toggle checked={o.enabled} disabled={!canShop}
                  onChange={(v) => patch({ offers: cfg.offers.map((x, j) => (j === i ? { ...x, enabled: v } : x)) })}
                  label="enabled" />
                {canShop && <button className="mini ghost" onClick={() => patch({ offers: cfg.offers.filter((_, j) => j !== i) })}>Remove</button>}
                {/* Its own line: the gate is a sentence about who the offer is for, not another
                    number to sit between "days" and "enabled". */}
                <div style={{ flexBasis: "100%" }}>
                  <RoleDisclosure label="Who can receive" emptyLabel="anyone linked" roles={guildRoles} note={rolesNote}
                    value={o.roleIds ?? []} disabled={!canShop}
                    onChange={(roleIds) => patch({ offers: cfg.offers.map((x, j) => (j === i ? { ...x, roleIds } : x)) })} />
                </div>
              </div>
            ))}
            {canShop && (
              <div className="actions">
                <button className="mini" onClick={() => {
                  // Id from a counter, not the label: it ends up in custom_ids and purchase refs,
                  // where renaming the button must not orphan the history.
                  const id = `offer_${Date.now().toString(36)}`;
                  patch({ offers: [...cfg.offers, { id, label: "Two Weeks", points: 250, days: 14, scope: { mode: "all" }, enabled: false, roleIds: [] }] });
                }}>Add offer</button>
                <button className="primary" disabled={saving} onClick={() => save(cfg)}>{saving ? "Saving…" : "Save offers"}</button>
              </div>
            )}
          </div>
        )}
      </Panel>

      {/*
        Every movement across every member, newest first — the answer to "show me all purchases /
        gifts / payouts" that used to require opening members one at a time. The kinds come from
        the API so these chips can never drift from what the store classifies; clicking a member
        opens their full ledger down in Members, same as clicking them there.
      */}
      <Panel id="activity" caps="economy.balances" title="Activity" subtitle={activity.total !== null ? activity.total.toLocaleString() : undefined}>
        <div className="control-row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
          <button type="button" className={`scope-chip${actKind === "" ? " on" : ""}`} aria-pressed={actKind === ""} onClick={() => setActKind("")}>All</button>
          {actKinds.map((k) => (
            <button key={k.id} type="button" className={`scope-chip${actKind === k.id ? " on" : ""}`} aria-pressed={actKind === k.id} onClick={() => setActKind(k.id)}>{k.label}</button>
          ))}
        </div>
        {activity.items === null ? <SkeletonRows rows={5} /> : activity.items.length === 0 ? (
          actKind
            ? <EmptyState icon="🔍" title="Nothing of this kind yet">No {actKinds.find((k) => k.id === actKind)?.label.toLowerCase() ?? actKind} on the ledger yet.</EmptyState>
            : <EmptyState icon="📒" title="No activity yet">Entries appear the moment anything moves {cur} — a claim, a purchase, a payout, a staff adjustment.</EmptyState>
        ) : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>When</th><th>Member</th><th style={{ textAlign: "right" }}>{cur}</th><th>What</th><th>By</th></tr></thead>
              <tbody>
                {activity.items.map((e) => (
                  <tr key={e.id}>
                    <td><Time iso={e.createdAt} /></td>
                    <td>
                      <button type="button" className="linklike" onClick={() => openMember(e.discordId)} title="Open this member below (full ledger + adjust)">
                        {e.discordName || <span className="muted">{e.discordId}</span>}
                      </button>
                    </td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: e.delta >= 0 ? "var(--ok)" : "var(--err)" }}>
                      {e.delta >= 0 ? "+" : ""}{e.delta.toLocaleString()}
                    </td>
                    <td>{e.reason}<VipDates vip={e.vip} /></td>
                    <td className="muted">{e.actorName ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager list={activity} noun="entry" />
          </div>
        )}
      </Panel>

      <Panel id="members" caps="economy.balances" title="Members" subtitle={members.total !== null ? members.total.toLocaleString() : undefined}>
        <AskNotice capability="economy.balances" />
        <div className="control-row" style={{ marginBottom: 8 }}>
          <SearchInput value={q} onChange={setQ} placeholder="Search by Discord name or id…" />
        </div>
        {members.items === null ? <SkeletonRows rows={5} /> : members.items.length === 0 ? (
          // A search with no hits is NOT "no members yet" — saying so sent people hunting for an
          // import problem when the only thing wrong was the needle.
          q.trim()
            ? <EmptyState icon="🔍" title="No matches">Nobody matches &ldquo;{q.trim()}&rdquo; — the search covers Discord names and ids. A member registered before we learned their name shows as their id.</EmptyState>
            : <EmptyState icon="💰" title="No members yet">Members appear when they first touch the economy — a claim, a grant, or a staff adjustment. The v4 balances arrive with the cutover import.</EmptyState>
        ) : (
          <div className="scroll-x">
            <table>
              <thead><tr><th>Member</th><th>Discord id</th><th style={{ textAlign: "right" }}>{cur}</th><th>Updated</th></tr></thead>
              <tbody>
                {members.items.map((m) => (
                  <Fragment key={m.discordId}>
                    <tr onClick={() => openMember(m.discordId)} style={{ cursor: "pointer" }}>
                      <td>{m.discordName || <span className="muted">(unknown)</span>}</td>
                      <td className="muted">{m.discordId}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{m.balance.toLocaleString()}</td>
                      <td><Time iso={m.updatedAt} /></td>
                    </tr>
                    {openId === m.discordId && (
                      <tr>
                        <td colSpan={4}>
                          {/* Linked game accounts — what "linked" means for claims, purchases and
                              gifts. Plural on purpose: one per game once Vietnam exists. */}
                          {ledger !== null && (
                            <div className="control-row" style={{ gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                              <span className="muted" style={{ fontSize: "0.78rem", textTransform: "uppercase", fontWeight: 700 }}>Linked</span>
                              {linked.length === 0
                                ? <span className="hint">Not linked to any game account — claims, purchases and gifts will refuse. Link from the player&apos;s profile (Set Discord).</span>
                                : linked.map((lp) => (
                                    <span key={lp.id}>
                                      <PlayerLink playerId={lp.platformId} name={lp.name} />{" "}
                                      {/* The GAME, not the platform: a member holds one account per
                                          game, and which is which is what this list is read for. */}
                                      <span className="muted" style={{ fontSize: "0.78rem" }}>({lp.game ? gameLabels[lp.game] ?? lp.game : lp.platform})</span>
                                    </span>
                                  ))}
                            </div>
                          )}
                          {canBalances && (
                            <div className="control-row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
                              <input type="number" placeholder="+/- amount" style={{ width: 120 }} value={adj.delta}
                                onChange={(e) => setAdj((s) => ({ ...s, delta: e.target.value }))} />
                              <input placeholder="Reason (goes on the ledger and the audit trail)" style={{ flex: "1 1 16rem" }} value={adj.reason}
                                onChange={(e) => setAdj((s) => ({ ...s, reason: e.target.value }))} />
                              <button className="mini" disabled={adjusting || !Number(adj.delta) || !adj.reason.trim()} onClick={() => adjust(m.discordId)}>{adjusting ? "Applying…" : "Apply"}</button>
                            </div>
                          )}
                          {ledger === null ? <SkeletonRows rows={2} /> : ledger.length === 0 ? <p className="muted">No ledger entries.</p> : (
                            <table>
                              <tbody>
                                {ledger.map((e) => (
                                  <tr key={e.id}>
                                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: e.delta >= 0 ? "var(--ok)" : "var(--err)" }}>
                                      {e.delta >= 0 ? "+" : ""}{e.delta.toLocaleString()}
                                    </td>
                                    <td>{e.reason}<VipDates vip={e.vip} /></td>
                                    <td className="muted">{e.actorName ?? ""}</td>
                                    <td><Time iso={e.createdAt} /></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            <Pager list={members} noun="member" />
          </div>
        )}
      </Panel>

      {/* The cutover terminal (decision 4): upload the old bot's SQLite file once, at conversion
          time. Converging — re-running reports "already" instead of paying anything twice. */}
      {canManage && <LauncherPanel />}

      {mayImport && (
        <Panel id="v4import" caps="economy.config" title="v4 cutover import" defaultCollapsed>
          <Explanation>
            Upload the v4 bot&apos;s <code>bot.db</code> to bring over Discord↔game links, {cur} balances
            (as opening-balance ledger rows) and registration state. Safe to re-run — a second pass
            changes nothing it already imported.
          </Explanation>
          <div className="control-row" style={{ gap: 10, alignItems: "center" }}>
            <input type="file" aria-label="The v4 bot.db file" accept=".db,.sqlite,.sqlite3" onChange={(e) => setDbFile(e.target.files?.[0] ?? null)} />
            <button className="primary" disabled={!dbFile || importing} onClick={() => void runImport()}>
              {importing ? "Importing…" : "Import"}
            </button>
          </div>
          {importReport && (
            <div style={{ marginTop: 10 }}>
              <p style={{ margin: 0 }}>
                {importReport.usersSeen} member(s) read — {importReport.links.imported} link(s) imported
                ({importReport.links.already} already there), {importReport.balances.imported} opening balance(s)
                totalling {importReport.balances.totalPoints} {cur} ({importReport.balances.already} already there),
                {" "}{importReport.welcomeMarkers} welcome marker(s).
              </p>
              {importReport.links.conflicts.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <span className="hint">Conflicts (left as they were — resolve from the player profiles):</span>
                  <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {importReport.links.conflicts.slice(0, 20).map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Panel>
      )}
    </PanelGroup>
  );
}


/**
 * Post the public VIP panel opener into a channel.
 *
 * The posted message is permanent and stateless, so this is a one-off per channel — and posting a
 * second one makes a second working launcher rather than breaking the first. The same thing can be
 * done from inside Discord (the panel's VIP launcher module); this exists for the operator who is
 * already in the app with the channel id to hand.
 */
function LauncherPanel() {
  const toast = useToast();
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);
  const post = async () => {
    setBusy(true);
    try {
      await api("/discord/vip-launcher", { method: "POST", body: { channelId: channelId.trim() } });
      toast.success("Posted — members can open the VIP panel from that channel.");
      setChannelId("");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Panel id="launcher" caps="economy.config" title="VIP panel launcher">
      <Explanation>
        Posts a permanent message whose button opens each member&apos;s own VIP panel — status, claims, purchases, gifts and account linking. It keeps working across restarts, so post it once per channel.
      </Explanation>
      <label>Channel id
        <input value={channelId} inputMode="numeric" placeholder="e.g. 112233445566778899"
          onChange={(e) => setChannelId(e.target.value.replace(/[^0-9]/g, ""))} />
      </label>
      <div className="actions">
        <button className="primary" disabled={busy || !/^\d{5,25}$/.test(channelId.trim())} onClick={post}>
          {busy ? "Posting…" : "Post launcher"}
        </button>
      </div>
      <Explanation>Discord → Developer Mode on → right-click the channel → Copy Channel ID. You can also run the slash command in the channel and use <strong>VIP launcher</strong> there.</Explanation>
    </Panel>
  );
}
