"use client";
/**
 * Auto settings — the master control point, edited as SENTENCES rather than forms. A profile is
 * "WHEN these conditions hold, THEN set these things": conditions and effects are each added one
 * row at a time from a menu, so a profile only ever shows what it actually uses (the old editor
 * rendered every possible field blank, which read like a tax form; CRCON's answer was raw JSON —
 * this is the third option). The worker applies the FIRST matching profile, on the change edge.
 *
 * "Then" covers three families through one menu: the game's writable config fields (RCON), the
 * app's own automation switches (broadcast/map vote/seeding/relay — the "app:" catalog), and
 * one-shot actions (queue next map, apply template, force player rules while active).
 *
 * The "Right now" banner shows which profile currently wins, resolved server-side against the
 * latest roster snapshot — see it working instead of guessing. Gated by Auto settings.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useResource } from "../lib/resource";
import { useServers } from "../lib/servers";
import { useGame } from "../lib/game";
import { ActionResult, AskNotice, Callout, Divider, EmptyState, ObserveBanner, SettingCard, SkeletonLines, Toggle, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { MapPicker, type CatalogueMap } from "./MapPicker";
import { CoverageMap } from "./CoverageMap";
import { useConfirm } from "../lib/feedback";
import { Time } from "./Time";
import { localWindowHint, overnightSpillHint } from "../lib/time";
import { readUserPrefs } from "../lib/userPrefs";
import { NumField } from "./NumField";
import { PlaceholderHint } from "./Placeholders";
import { useCommunityZone, zoneOptions } from "../lib/zones";
import { useGrants } from "../lib/grants";
import { hasCap } from "../lib/access";

const WD = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

interface Spec {
  timezone?: string; daysOfWeek?: string[]; dates?: string[]; months?: number[]; years?: number[];
  start?: string; end?: string; playersBelow?: number; playersAbove?: number;
  alliedBelow?: number; alliedAbove?: number; axisBelow?: number; axisAbove?: number;
  teamDiffBelow?: number; teamDiffAbove?: number;
  matchMinutesAtLeast?: number; matchMinutesBelow?: number;
}
interface MatchMessage { minutes: number; message: string; minPlayers: number; enabled: boolean }
type SettingValue = string | number | boolean;
interface Profile {
  name: string; spec?: Spec; settings: Record<string, SettingValue>;
  nextMap?: string; applyTemplate?: string;
}
interface Field { field: string; label: string; kind: "bool" | "num" | "str"; group?: string }
interface ConfigResp { config: { enabled: boolean; dryRun: boolean; timezone: string; profiles: Profile[]; matchMessages?: MatchMessage[] }; fields: Field[] }
interface TemplateRow { id: string; name: string; config: { profiles: unknown[] }; createdByName: string; updatedAt: string }
interface StatusResp { enabled: boolean; dryRun: boolean; active: string | null; playerCount: number | null; alliedCount: number | null; axisCount: number | null; sampledAt: string | null; matchMinutes?: number | null }

const csv = (a?: string[]) => (a ?? []).join(", ");
const toCsv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const numCsv = (s: string) => toCsv(s).map(Number).filter((n) => Number.isFinite(n));

/** The condition vocabulary: one entry per row type the "+ When…" menu can add. Number conditions
 *  share one shape; time/days/dates/months/timezone get bespoke rows. `keys` is what a row owns in
 *  the spec — adding seeds them, removing deletes them, presence of any means the row renders.
 *  A `side` condition's label follows that side's name in the server's game ("US players…"). */
const NUM_CONDITIONS: { key: keyof Spec; label: string; seed: number; side?: "allies" | "axis" }[] = [
  { key: "playersBelow", label: "Total players are below", seed: 40 },
  { key: "playersAbove", label: "Total players are above", seed: 60 },
  { key: "alliedBelow", side: "allies", label: "players are below", seed: 20 },
  { key: "alliedAbove", side: "allies", label: "players are above", seed: 30 },
  { key: "axisBelow", side: "axis", label: "players are below", seed: 20 },
  { key: "axisAbove", side: "axis", label: "players are above", seed: 30 },
  { key: "teamDiffBelow", label: "Team-size gap is below", seed: 5 },
  { key: "teamDiffAbove", label: "Team-size gap is above", seed: 10 },
  // Minutes into the current match: "at least" includes the minute, "less than" doesn't, so
  // 30 / 60 on two profiles meet exactly without overlapping.
  { key: "matchMinutesAtLeast", label: "Match has been running at least (minutes)", seed: 30 },
  { key: "matchMinutesBelow", label: "Match has been running less than (minutes)", seed: 60 },
];

export default function AutoSettings({ canManage }: { canManage: boolean }) {
  const { serverId, server } = useServers();
  const game = useGame();
  const conditionLabel = (c: (typeof NUM_CONDITIONS)[number]) => (c.side ? `${game.sideName(c.side)} ${c.label}` : c.label);
  const confirm = useConfirm();
  // Display preference: read a schedule window back on the viewer's own clock beside the stored one.
  const showLocal = useMemo(() => readUserPrefs().localTimes, []);
  const communityTz = useCommunityZone();
  const [enabled, setEnabled] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [tz, setTz] = useState("UTC");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [matchMessages, setMatchMessages] = useState<MatchMessage[]>([]);
  const [fields, setFields] = useState<Field[]>([]);
  const [dirty, setDirty] = useState(false);
  // Bumped when a save lands, so the coverage map refetches exactly when the stored config could
  // have changed — the same contract the map vote's coverage keeps.
  const [savedGen, setSavedGen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  // Two steps for an edit form: useResource decides which response is allowed to land (a stale
  // one would be edited and saved back to the wrong server), this effect copies it into the form.
  const loader = useMemo(() => (serverId ? () => api<ConfigResp>(`/servers/${serverId}/autosettings`) : null), [serverId]);
  const { data: resp, error: loadErr, reload: load } = useResource(loader);

  // "Which profile wins right now" — resolved server-side from the stored config + the latest
  // roster snapshot, so it reflects what the WORKER would do, not the form's unsaved edits.
  const statusLoader = useMemo(() => (serverId ? () => api<StatusResp>(`/servers/${serverId}/autosettings/status`).catch(() => null) : null), [serverId]);
  const { data: status, reload: reloadStatus } = useResource(statusLoader);

  // Supporting catalogues for the profile effects. All soft-fail: the editor still works without
  // them (the map picker degrades to a raw-id input, the template picker just stays empty).

  const catalogueLoader = useMemo(() => (serverId ? () => api<{ maps: CatalogueMap[] }>(`/servers/${serverId}/maps`).catch(() => ({ maps: [] as CatalogueMap[] })) : null), [serverId]);
  const { data: catalogueResp } = useResource(catalogueLoader);
  const catalogue = useMemo(() => catalogueResp?.maps ?? [], [catalogueResp]);

  // Names of every feature preset the user may read, for the "Apply … preset" value pickers.
  const presetsLoader = useMemo(() => () => api<{ presets: Record<string, { id: string; name: string }[]> }>(`/presets`).catch(() => ({ presets: {} as Record<string, { id: string; name: string }[]> })), []);
  const { data: presetsResp } = useResource(presetsLoader);
  const presetNames = (feature: string) => presetsResp?.presets?.[feature]?.map((p) => p.name) ?? [];

  // The templates are a permission of their own (autosettings.templates). Without it the list is
  // not asked for; a list that was refused, or failed, is not "no templates" — read as empty, it
  // said "No templates yet" and called a profile's chosen template missing.
  const readsTemplates = hasCap(useGrants(), "autosettings.templates");
  const templatesLoader = useMemo(() => (readsTemplates ? () => api<{ templates: TemplateRow[] }>(`/autosettings/templates`) : null), [readsTemplates]);
  const { data: templatesResp, error: templatesErr, reload: reloadTemplates } = useResource(templatesLoader);
  const templates = useMemo(() => templatesResp?.templates ?? [], [templatesResp]);
  const [tplName, setTplName] = useState("");
  const [tplPick, setTplPick] = useState("");
  const [tplBusy, setTplBusy] = useState(false);
  const [tplErr, setTplErr] = useState("");
  const [tplOk, setTplOk] = useState("");
  useEffect(() => {
    if (!resp) return;
    // A server with auto-settings never configured has no config row, so the whole object is
    // absent — which is "off, no profiles", not a page that refuses to render.
    const cfg = resp.config ?? { enabled: false, dryRun: false, timezone: "", profiles: [] };
    // A server that has never been configured inherits the community clock rather than landing on
    // UTC — the default nobody wanted and everybody had to notice and change.
    setEnabled(cfg.enabled ?? false); setDryRun(cfg.dryRun ?? false); setTz(cfg.timezone || communityTz || "UTC");
    setProfiles(cfg.profiles ?? []); setFields(resp.fields ?? []);
    setMatchMessages((cfg as { matchMessages?: MatchMessage[] }).matchMessages ?? []);
    setOk(""); setDirty(false);
    // communityTz is a FALLBACK read once per response, deliberately not a dependency: re-running
    // this effect when the community clock loads a beat later would wipe whatever the person has
    // already edited on screen. The next real response picks the fresh value up anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resp]);

  const gameFields = useMemo(() => fields.filter((f) => !f.field.startsWith("app:") && !f.field.startsWith("preset:")), [fields]);
  const appFields = useMemo(() => fields.filter((f) => f.field.startsWith("app:")), [fields]);
  const presetFields = useMemo(() => fields.filter((f) => f.field.startsWith("preset:")), [fields]);
  const fieldOf = (key: string) => fields.find((f) => f.field === key);
  const mutate = (fn: (p: Profile[]) => Profile[]) => { setProfiles((prev) => fn(prev)); setDirty(true); setOk(""); };
  const setProfile = (i: number, patch: Partial<Profile>) => mutate((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setSpec = (i: number, patch: Partial<Spec>) => setProfile(i, { spec: { ...profiles[i]?.spec, ...patch } });
  const dropSpecKeys = (i: number, keys: (keyof Spec)[]) => {
    const s = { ...profiles[i]?.spec };
    for (const k of keys) delete s[k];
    setProfile(i, { spec: s });
  };
  const setMsg = (i: number, patch: Partial<MatchMessage>) => { setMatchMessages((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m))); setDirty(true); setOk(""); };
  const move = (i: number, d: number) => mutate((p) => { const n = [...p]; const j = i + d; if (j < 0 || j >= n.length) return p; [n[i], n[j]] = [n[j]!, n[i]!]; return n; });

  const setSetting = (i: number, field: string, value: SettingValue) => setProfile(i, { settings: { ...profiles[i]!.settings, [field]: value } });
  const removeSetting = (i: number, field: string) => { const s = { ...profiles[i]!.settings }; delete s[field]; setProfile(i, { settings: s }); };

  /** One handler behind the "+ When…" menu. */
  const addCondition = (i: number, id: string) => {
    if (id === "time") setSpec(i, { start: "22:00", end: "06:00" });
    else if (id === "days") setSpec(i, { daysOfWeek: [] });
    else if (id === "dates") setSpec(i, { dates: [] });
    else if (id === "months") setSpec(i, { months: [] });
    else if (id === "timezone") setSpec(i, { timezone: tz || "UTC" });
    else {
      const def = NUM_CONDITIONS.find((c) => c.key === id);
      if (def) setSpec(i, { [def.key]: def.seed } as Partial<Spec>);
    }
  };

  /** One handler behind the grouped "+ Then…" menu. */
  const addEffect = (i: number, id: string) => {
    if (id === "action:nextMap") setProfile(i, { nextMap: catalogue[0]?.id ?? "" });
    else if (id === "action:applyTemplate") setProfile(i, { applyTemplate: templates[0]?.name ?? "" });
    else if (id.startsWith("preset:")) setSetting(i, id, presetNames(id.slice("preset:".length))[0] ?? "");
    else {
      const f = fieldOf(id); if (!f) return;
      setSetting(i, id, f.kind === "bool" ? true : f.kind === "num" ? 0 : "");
    }
  };

  async function save() {
    setBusy(true); setErr(""); setOk("");
    try {
      await api(`/servers/${serverId}/autosettings`, { method: "PUT", body: { enabled, dryRun, timezone: tz, profiles, matchMessages } });
      setOk("Saved."); setSavedGen((n) => n + 1); load(); reloadStatus();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // The snapshot is taken server-side from the STORED config — exactly what is running, not the
  // form's unsaved edits (hence the "save first" hint when dirty).
  async function saveTemplate() {
    setTplBusy(true); setTplErr(""); setTplOk("");
    try {
      const { template } = await api<{ template: TemplateRow }>(`/autosettings/templates`, { method: "POST", body: { name: tplName.trim(), serverId } });
      setTplOk(`Saved "${template.name}".`); setTplName(""); reloadTemplates();
    } catch (e) { setTplErr((e as Error).message); } finally { setTplBusy(false); }
  }

  async function applyTemplate() {
    const t = templates.find((x) => x.id === tplPick);
    if (!t) return;
    if (!(await confirm({ title: `Apply template "${t.name}" to ${server?.name ?? "this server"}?\n\nIts profiles and player rules replace this server's. The on/off and dry-run switches are not touched.`, confirmLabel: "Apply", danger: false }))) return;
    setTplBusy(true); setTplErr(""); setTplOk("");
    try {
      await api(`/servers/${serverId}/autosettings/apply-template`, { method: "POST", body: { name: t.name } });
      setTplOk(`Applied "${t.name}".`); load();
    } catch (e) { setTplErr((e as Error).message); } finally { setTplBusy(false); }
  }

  async function deleteTemplate(t: TemplateRow) {
    if (!(await confirm({ title: `Delete template "${t.name}"?\n\nProfiles that apply it by name will log a warning and skip the action.`, confirmLabel: "Delete", danger: true }))) return;
    setTplBusy(true); setTplErr(""); setTplOk("");
    try {
      await api(`/autosettings/templates/${t.id}`, { method: "DELETE" });
      setTplOk(`Deleted "${t.name}".`); reloadTemplates();
    } catch (e) { setTplErr((e as Error).message); } finally { setTplBusy(false); }
  }

  // Only a profile that asks about the match clock needs telling that it can't be read right now.
  const usesMatchClock = profiles.some((p) => p.spec?.matchMinutesAtLeast !== undefined || p.spec?.matchMinutesBelow !== undefined);

  if (!serverId) return <div className="card"><p className="muted">Select a server to configure auto-settings.</p></div>;
  // Not before this server's settings are in. Drawn from the form's starting values, the page read
  // "Off" and "No profiles yet" while they loaded (seconds, on a phone), and after a switch it kept
  // the last server's profiles: a Save then would have written either over this server's real ones.
  // A failed read says so, with nothing on screen to save.
  if (!resp) return <div className="card">{loadErr ? <ActionResult error={loadErr} /> : <SkeletonLines lines={6} />}</div>;

  return (
    <PanelGroup viewId="autosettings">
      <ObserveBanner server={server} when="later" />
      <Panel
        id="scheduled"
        caps="open"
        title="Profiles"
        actions={<>
          {dirty && <button className="ghost" onClick={load}>Discard</button>}
          <button className="primary" onClick={save} disabled={!dirty || busy || !canManage}>{busy ? "Saving…" : "Save"}</button>
        </>}
      >
      <Explanation>A profile reads as a sentence: <em>when</em> its conditions hold, <em>then</em> its settings and actions apply. The first matching profile wins (order = priority); one with no conditions is a default — put it last. While a profile is active its settings are <em>held</em>, not just set once: every few minutes the server&apos;s values are checked, and if it reset them (a patch, a restore) the drifted ones are re-applied — settings that can&apos;t be read back (VIP slots, welcome message) are re-applied in the same pass — with the fix noted in Activity.</Explanation>

      <AskNotice capability="autosettings.profiles" serverId={serverId} />
      <ActionResult ok={ok} error={err || loadErr} />

      {status && profiles.length > 0 && (
        <Callout variant="info">
          Right now: {status.active
            ? <>profile <strong>{status.active}</strong> is the match</>
            : <>no profile matches</>}
          {status.playerCount != null && <>
            {" — "}{status.playerCount} player{status.playerCount === 1 ? "" : "s"}
            {status.alliedCount != null && status.axisCount != null && <> ({status.alliedCount} vs {status.axisCount})</>}
            {status.sampledAt && <>, sampled <Time iso={status.sampledAt} /></>}
          </>}
          {status.playerCount == null && <> — no roster sample yet, so player-count conditions can&apos;t match</>}
          {status.matchMinutes != null
            ? <>; the match has been running {status.matchMinutes} min</>
            : usesMatchClock && <>; no match in progress that the app has seen start, so match-time conditions can&apos;t match</>}
          {!status.enabled && <>. Profiles are <strong>off</strong></>}
          {status.enabled && status.dryRun && <>. Running in <strong>dry-run</strong></>}
          {" "}<button className="ghost mini" onClick={reloadStatus} title="Refresh">↻</button>
        </Callout>
      )}

      <SettingCard title="Enable auto settings" description="Master switch. The worker applies the first matching profile and re-applies whenever the active one changes.">
        <Toggle checked={enabled} onChange={(v) => { setEnabled(v); setDirty(true); }} label={enabled ? "On" : "Off"} disabled={!canManage} />
      </SettingCard>
      <SettingCard title="Dry-run" description="Log what would be applied to Activity, but don't change anything. Leave on until you've reviewed the profiles.">
        <Toggle checked={dryRun} onChange={(v) => { setDryRun(v); setDirty(true); }} label={dryRun ? "Dry-run" : "Live"} disabled={!canManage} />
      </SettingCard>
      <label className="field">Default timezone (for profiles that don&apos;t set their own)
        <select value={tz} onChange={(e) => { setTz(e.target.value); setDirty(true); }} disabled={!canManage} style={{ maxWidth: 260 }}>
          {zoneOptions(communityTz).map((z) => <option key={z} value={z}>{z}{z === communityTz ? " (community)" : ""}</option>)}
        </select>
      </label>

      {profiles.length === 0 && (
        <EmptyState icon="⏱" title="No profiles yet">
          A profile runs the server for you — quieter rules overnight, seeding settings until it fills,
          map vote off during events. Add one, give it conditions with <em>When…</em> and effects with
          <em> Then…</em>.
        </EmptyState>
      )}

      {profiles.map((p, i) => {
        const spec = p.spec ?? {};
        const hasTime = spec.start !== undefined || spec.end !== undefined;
        const conditionCount =
          (hasTime ? 1 : 0) + (spec.daysOfWeek !== undefined ? 1 : 0) + (spec.dates !== undefined ? 1 : 0) +
          (spec.months !== undefined ? 1 : 0) + (spec.timezone !== undefined ? 1 : 0) +
          NUM_CONDITIONS.filter((c) => spec[c.key] !== undefined).length;
        const unusedGame = gameFields.filter((f) => !(f.field in p.settings));
        const unusedApp = appFields.filter((f) => !(f.field in p.settings));
        const isActiveNow = status?.active != null && status.active === p.name && !dirty;
        return (
          <div key={i} className="setting-card" style={{ marginTop: 10 }}>
            <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
              <span className="row" style={{ alignItems: "center", gap: 8 }}>
                <input value={p.name} placeholder="profile name" onChange={(e) => setProfile(i, { name: e.target.value })} disabled={!canManage} style={{ maxWidth: 220, fontWeight: 600 }} />
                {isActiveNow && <span className="badge active">active now</span>}
              </span>
              {canManage && (
                <div className="actions" style={{ marginTop: 0, gap: 4 }}>
                  <button className="ghost" onClick={() => move(i, -1)} disabled={i === 0} title="Higher priority">↑</button>
                  <button className="ghost" onClick={() => move(i, 1)} disabled={i === profiles.length - 1} title="Lower priority">↓</button>
                  <button className="danger" onClick={() => mutate((ps) => ps.filter((_, j) => j !== i))}>Delete</button>
                </div>
              )}
            </div>

            <Divider label="When" />
            {conditionCount === 0 && <p className="hint">Always — no conditions, so this profile matches whenever nothing above it does. Good for a default at the bottom.</p>}
            <div style={{ display: "grid", gap: 6 }}>
              {hasTime && (
                <div className="control-row sentence-row">
                  <span className="field-label">Time is between</span>
                  <input aria-label="From" value={spec.start ?? ""} onChange={(e) => setSpec(i, { start: e.target.value || undefined })} disabled={!canManage} placeholder="22:00" style={{ width: 90 }} />
                  <span className="muted">and</span>
                  <input aria-label="To" value={spec.end ?? ""} onChange={(e) => setSpec(i, { end: e.target.value || undefined })} disabled={!canManage} placeholder="06:00" style={{ width: 90 }} />
                  {canManage && <button className="ghost mini" title="Remove condition" onClick={() => dropSpecKeys(i, ["start", "end"])}>✕</button>}
                  {showLocal && localWindowHint(spec.timezone ?? tz, spec.start, spec.end) && (
                    <span className="hint" style={{ margin: 0 }}>({localWindowHint(spec.timezone ?? tz, spec.start, spec.end)})</span>
                  )}
                </div>
              )}
              {spec.daysOfWeek !== undefined && (
                <div className="control-row sentence-row">
                  <span className="field-label">Day is</span>
                  <span className="chips">
                    {WD.map((d) => {
                      const on = spec.daysOfWeek?.includes(d) ?? false;
                      return <button key={d} type="button" className={on ? "badge active chip-btn" : "badge chip-btn"} disabled={!canManage}
                        onClick={() => setSpec(i, { daysOfWeek: on ? (spec.daysOfWeek ?? []).filter((x) => x !== d) : [...(spec.daysOfWeek ?? []), d] })}>{d}</button>;
                    })}
                  </span>
                  {(spec.daysOfWeek?.length ?? 0) === 0 && <span className="hint" style={{ margin: 0 }}>none picked = every day</span>}
                  {canManage && <button className="ghost mini" title="Remove condition" onClick={() => dropSpecKeys(i, ["daysOfWeek"])}>✕</button>}
                </div>
              )}
              {overnightSpillHint(spec.daysOfWeek, spec.start, spec.end) && (
                <p className="hint" style={{ margin: 0 }}>⚠ {overnightSpillHint(spec.daysOfWeek, spec.start, spec.end)}</p>
              )}
              {spec.dates !== undefined && (
                <div className="control-row sentence-row">
                  <span className="field-label">Date is one of</span>
                  <input aria-label="Dates" value={csv(spec.dates)} onChange={(e) => setSpec(i, { dates: toCsv(e.target.value) })} disabled={!canManage} placeholder="06-06, 12-24" className="grow-min" />
                  {canManage && <button className="ghost mini" title="Remove condition" onClick={() => dropSpecKeys(i, ["dates"])}>✕</button>}
                </div>
              )}
              {spec.months !== undefined && (
                <div className="control-row sentence-row">
                  <span className="field-label">Month is one of</span>
                  <input aria-label="Months" value={csv(spec.months?.map(String))} onChange={(e) => setSpec(i, { months: numCsv(e.target.value) })} disabled={!canManage} placeholder="6, 7, 8" className="grow-min" />
                  {canManage && <button className="ghost mini" title="Remove condition" onClick={() => dropSpecKeys(i, ["months"])}>✕</button>}
                </div>
              )}
              {NUM_CONDITIONS.filter((c) => spec[c.key] !== undefined).map((c) => (
                <div key={c.key} className="control-row sentence-row">
                  <span className="field-label">{conditionLabel(c)}</span>
                  {/* Clearing the input must not delete the condition (undefined unmounts this row
                      mid-edit) — an empty box holds 0 until a number is typed; ✕ removes the row. */}
                  <input type="number" min={0} aria-label={conditionLabel(c)} value={Number(spec[c.key])} onChange={(e) => setSpec(i, { [c.key]: e.target.value === "" ? 0 : Number(e.target.value) } as Partial<Spec>)} disabled={!canManage} style={{ width: 90 }} />
                  {canManage && <button className="ghost mini" title="Remove condition" onClick={() => dropSpecKeys(i, [c.key])}>✕</button>}
                </div>
              ))}
              {spec.timezone !== undefined && (
                <div className="control-row sentence-row">
                  <span className="field-label">Use timezone</span>
                  <input aria-label="Time zone" value={spec.timezone ?? ""} onChange={(e) => setSpec(i, { timezone: e.target.value || undefined })} disabled={!canManage} placeholder="Europe/Berlin" style={{ width: 200 }} />
                  {canManage && <button className="ghost mini" title="Remove condition" onClick={() => dropSpecKeys(i, ["timezone"])}>✕</button>}
                </div>
              )}
            </div>
            {canManage && (
              <div className="control-row" style={{ marginTop: 8 }}>
                <select aria-label="Add a condition" value="" onChange={(e) => { if (e.target.value) addCondition(i, e.target.value); }}>
                  <option value="">+ When…</option>
                  {!hasTime && <option value="time">Time is between…</option>}
                  {spec.daysOfWeek === undefined && <option value="days">Day is…</option>}
                  {spec.dates === undefined && <option value="dates">Date is one of…</option>}
                  {spec.months === undefined && <option value="months">Month is one of…</option>}
                  {NUM_CONDITIONS.filter((c) => spec[c.key] === undefined).map((c) => <option key={c.key} value={c.key}>{conditionLabel(c)}…</option>)}
                  {spec.timezone === undefined && <option value="timezone">Use a different timezone…</option>}
                </select>
              </div>
            )}

            <Divider label="Then" />
            {Object.keys(p.settings).length === 0 && !p.nextMap && !p.applyTemplate && (
              <p className="hint">Nothing yet — add an effect below. Settings apply when this profile becomes the active one.</p>
            )}
            <div style={{ display: "grid", gap: 6 }}>
              {Object.entries(p.settings).map(([field, value]) => {
                const f = fieldOf(field);
                const isApp = field.startsWith("app:");
                // "Apply <feature> preset" rows: the value is a preset NAME, picked from the
                // feature's saved presets (a name that no longer exists renders as missing).
                if (field.startsWith("preset:")) {
                  const names = presetNames(field.slice("preset:".length));
                  return (
                    <div key={field} className="control-row sentence-row" role="group" aria-label={`Apply ${f?.label ?? field}`}>
                      <span className="field-label">Apply {f?.label ?? field}</span>
                      <select value={String(value)} onChange={(e) => setSetting(i, field, e.target.value)} disabled={!canManage}>
                        {names.map((n) => <option key={n} value={n}>{n}</option>)}
                        {value !== "" && !names.some((n) => n.toLowerCase() === String(value).toLowerCase()) && <option value={String(value)}>{String(value)} (missing)</option>}
                        {value === "" && <option value="">— pick a preset —</option>}
                      </select>
                      {canManage && <button className="ghost mini" title="Remove" onClick={() => removeSetting(i, field)}>✕</button>}
                    </div>
                  );
                }
                return (
                  <div key={field} className="control-row sentence-row" role="group" aria-label={`${isApp ? "Turn" : "Set"} ${f?.label ?? field}${isApp ? "" : " to"}`}>
                    <span className="field-label">{isApp ? "Turn" : "Set"} {f?.label ?? field}{isApp ? "" : " to"}</span>
                    {(f?.kind ?? "bool") === "bool"
                      ? <Toggle checked={value === true} onChange={(v) => setSetting(i, field, v)} label={value === true ? "On" : "Off"} disabled={!canManage} />
                      : f?.kind === "num"
                        ? <input type="number" value={Number(value)} onChange={(e) => setSetting(i, field, Number(e.target.value))} disabled={!canManage} style={{ width: 120 }} />
                        : <input value={String(value)} onChange={(e) => setSetting(i, field, e.target.value)} disabled={!canManage} className="grow-min" />}
                    {canManage && <button className="ghost mini" title="Remove" onClick={() => removeSetting(i, field)}>✕</button>}
                  </div>
                );
              })}
              {p.nextMap !== undefined && (
                <div className="control-row sentence-row" style={{ alignItems: "flex-start" }} role="group" aria-label="Queue next map">
                  <span className="field-label">Queue next map</span>
                  {catalogue.length > 0
                    ? <div className="grow-min"><MapPicker catalogue={catalogue} value={p.nextMap ? [p.nextMap] : []} onChange={(v) => setProfile(i, { nextMap: v[0] ?? "" })} multiple={false} disabled={!canManage} placeholder="Search a map to queue…" /></div>
                    : <input value={p.nextMap} onChange={(e) => setProfile(i, { nextMap: e.target.value })} disabled={!canManage} placeholder="map id (map list unavailable)" className="grow-min" />}
                  {canManage && <button className="ghost mini" title="Remove" onClick={() => setProfile(i, { nextMap: undefined })}>✕</button>}
                </div>
              )}
              {p.applyTemplate !== undefined && (
                <div className="control-row sentence-row" role="group" aria-label="Apply template">
                  <span className="field-label">Apply template</span>
                  <select value={p.applyTemplate} onChange={(e) => setProfile(i, { applyTemplate: e.target.value })} disabled={!canManage}>
                    {templates.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                    {/* "Missing" only when the list was read and it is not on it. */}
                    {p.applyTemplate && !templates.some((t) => t.name.toLowerCase() === p.applyTemplate!.toLowerCase()) && <option value={p.applyTemplate}>{p.applyTemplate}{templatesResp ? " (missing)" : ""}</option>}
                  </select>
                  <span className="hint" style={{ margin: 0 }}>replaces this server&apos;s profiles &amp; rules (10-min loop guard)</span>
                  {canManage && <button className="ghost mini" title="Remove" onClick={() => setProfile(i, { applyTemplate: undefined })}>✕</button>}
                </div>
              )}
            </div>
            {canManage && (
              <div className="control-row" style={{ marginTop: 8 }}>
                <select aria-label="Add a change" value="" onChange={(e) => { if (e.target.value) addEffect(i, e.target.value); }}>
                  <option value="">+ Then…</option>
                  {unusedGame.length > 0 && (
                    <optgroup label="Server settings">
                      {unusedGame.map((f) => <option key={f.field} value={f.field}>Set {f.label}…</option>)}
                    </optgroup>
                  )}
                  {unusedApp.length > 0 && (
                    <optgroup label="App automation">
                      {unusedApp.map((f) => <option key={f.field} value={f.field}>Turn {f.label} on/off…</option>)}
                    </optgroup>
                  )}
                  {/* Only features with at least one saved preset are offered — picking one with
                      none would seed an empty name the save then rejects. Same for templates. */}
                  {presetFields.some((f) => !(f.field in p.settings) && presetNames(f.field.slice("preset:".length)).length > 0) && (
                    <optgroup label="Apply presets">
                      {presetFields.filter((f) => !(f.field in p.settings) && presetNames(f.field.slice("preset:".length)).length > 0).map((f) => <option key={f.field} value={f.field}>Apply {f.label}…</option>)}
                    </optgroup>
                  )}
                  {(p.nextMap === undefined || (p.applyTemplate === undefined && templates.length > 0)) && (
                    <optgroup label="Actions (once, on activation)">
                      {p.nextMap === undefined && <option value="action:nextMap">Queue next map…</option>}
                      {p.applyTemplate === undefined && templates.length > 0 && <option value="action:applyTemplate">Apply a template…</option>}
                    </optgroup>
                  )}
                </select>
              </div>
            )}
          </div>
        );
      })}

      {canManage && (
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="ghost" onClick={() => mutate((p) => [...p, { name: `profile ${p.length + 1}`, spec: {}, settings: {} }])}>Add profile</button>
        </div>
      )}
      {!canManage && <p className="hint">You need the Auto settings permission to change this.</p>}

      <CoverageMap
        endpoint={profiles.length > 0 ? `/servers/${serverId}/autosettings/coverage` : null}
        noun="profile" fallbackName="stored settings"
        gapAdvice={<>Nothing is applied there — the server simply keeps whatever settings it already has. That can be
        exactly right; if it isn&apos;t, widen a profile&apos;s times or player range, or add a profile with no
        conditions at the bottom as the default.</>}
        dirty={dirty} reloadKey={savedGen} showLocal={showLocal}
      />
      </Panel>

      <Panel
        id="match-messages"
        caps="open"
        title="Timed match messages"
        actions={<>
          {dirty && <button className="ghost" onClick={load}>Discard</button>}
          <button className="primary" onClick={save} disabled={!dirty || busy || !canManage}>{busy ? "Saving…" : "Save"}</button>
        </>}
      >
        <Explanation>
          Messages sent to everyone in game at set times after each match starts — &ldquo;20 minutes in:
          remember to join our Discord&rdquo;. Each goes out once per match, as the message that stays on
          screen until the player closes it. They follow the <strong>Enable auto settings</strong> and
          <strong> Dry-run</strong> switches above, and don&apos;t touch which profile is active. The clock
          starts at the game&apos;s own match-start line; one that should have gone out more than
          5 minutes ago (a restart, or switching this on mid-match) is skipped rather than sent late.
        </Explanation>
        <ActionResult ok={ok} error={err} />
        {matchMessages.length === 0 && <p className="hint">No timed messages yet.</p>}
        <div style={{ display: "grid", gap: 10 }}>
          {matchMessages.map((m, i) => (
            <div key={i} className="setting-card" style={{ display: "grid", gap: 6 }}>
              <div className="control-row sentence-row">
                <span className="field-label">At</span>
                <NumField min={0} max={600} aria-label="Minutes into the match" value={m.minutes} onValue={(n) => setMsg(i, { minutes: Math.min(600, Math.max(0, n)) })} disabled={!canManage} style={{ width: 80 }} />
                <span className="muted">minutes into the match</span>
                <span className="field-label" style={{ marginLeft: 12 }}>if at least</span>
                <NumField min={0} aria-label="Players on at least" value={m.minPlayers} onValue={(n) => setMsg(i, { minPlayers: Math.max(0, n) })} disabled={!canManage} style={{ width: 70 }} />
                <span className="muted">players are on</span>
                <Toggle checked={m.enabled} onChange={(v) => setMsg(i, { enabled: v })} label={m.enabled ? "On" : "Off"} disabled={!canManage} />
                {canManage && <button className="ghost mini" title="Remove" onClick={() => { setMatchMessages((ms) => ms.filter((_, j) => j !== i)); setDirty(true); setOk(""); }}>✕</button>}
              </div>
              <textarea rows={3} aria-label="Message" value={m.message} maxLength={1000} placeholder="What everyone is told" onChange={(e) => setMsg(i, { message: e.target.value })} disabled={!canManage} />
            </div>
          ))}
        </div>
        {matchMessages.length > 0 && <PlaceholderHint />}
        <Explanation>Press Enter for a new line. Consoles can&apos;t scroll a message, so keep each one short. 0 players = send whatever the population.</Explanation>
        {canManage && matchMessages.length < 20 && (
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="ghost" onClick={() => { setMatchMessages((ms) => [...ms, { minutes: (ms[ms.length - 1]?.minutes ?? 0) + 15, message: "", minPlayers: 0, enabled: true }]); setDirty(true); setOk(""); }}>Add a timed message</button>
          </div>
        )}
      </Panel>

      <Panel id="templates" caps="autosettings.templates" title="Templates">
        <Explanation>A template is a saved behaviour set — the profiles, player rules and timezone, community-wide. Apply one here, or from a profile&apos;s <em>Apply template</em> effect so auto settings reconfigures itself. Templates never carry the on/off or dry-run switches.</Explanation>
        <ActionResult ok={tplOk} error={tplErr} />
        {canManage && (
          <div className="control-row">
            <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="template name" maxLength={80} style={{ maxWidth: 220 }} />
            <button onClick={saveTemplate} disabled={!tplName.trim() || tplBusy}>Save current as template</button>
            {dirty && <span className="hint" style={{ margin: 0 }}>Unsaved edits are not included — save the config first.</span>}
          </div>
        )}
        {canManage && templates.length > 0 && (
          <div className="control-row" style={{ marginTop: 8 }}>
            <select value={tplPick} onChange={(e) => setTplPick(e.target.value)} aria-label="Template to apply">
              <option value="">Pick a template…</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button onClick={applyTemplate} disabled={!tplPick || tplBusy}>Apply to this server</button>
          </div>
        )}
        {templatesErr ? <ActionResult error={`Couldn't load the templates: ${templatesErr}`} />
          : !templatesResp ? <SkeletonLines lines={2} />
          : templates.length === 0
          ? <p className="hint">No templates yet{canManage ? " — save this server's config under a name to create one." : "."}</p>
          : (
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
              {templates.map((t) => (
                <div key={t.id} className="control-row sentence-row">
                  <span className="field-label">{t.name}</span>
                  <span className="muted fs-xs">{(t.config.profiles ?? []).length} profile(s) — saved by {t.createdByName}</span>
                  {canManage && <button className="ghost mini" title="Delete template" onClick={() => deleteTemplate(t)}>✕</button>}
                </div>
              ))}
            </div>
          )}
      </Panel>
    </PanelGroup>
  );
}
