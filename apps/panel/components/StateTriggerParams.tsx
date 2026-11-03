"use client";
/**
 * The knobs of the Rules tab's live-roster triggers (and its restricted-weapon trigger), in one
 * form shared by the rule editor and Player triggers. A condition offered in both places is set
 * up with the same fields, labels and limits in both, and a change to one is a change to both.
 *
 * Roles are the GAME's. The rule editor's come from the server being configured; a player trigger
 * passes its player's game's roles (`roles`), because role ids collide across games (Vietnam's
 * Pilot is WW2's artillery Gunner).
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useGame } from "../lib/game";
import { NumField } from "./NumField";
import { Toggle } from "./ui";

/** A clan key as a card can show it without asking the server: a split spelling's key is the
 *  spelling itself, a symbol-only tag's is its text. */
export const clanKeyText = (k: string) => (k.startsWith("s:") ? k.slice(2) : k.startsWith("~") ? k.slice(1) : k);

/** One chip per role the game names; a chip toggles the role in or out of the list. */
export function RoleChips({ label, roles, value, onChange }: {
  label: string;
  roles: Record<number, string>;
  value: unknown;
  onChange: (ids: number[]) => void;
}) {
  const sel: number[] = Array.isArray(value) ? (value as unknown[]).map(Number) : [];
  const toggle = (rid: number) => onChange(sel.includes(rid) ? sel.filter((x) => x !== rid) : [...sel, rid]);
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="chips">
        {Object.keys(roles).length === 0 && <span className="muted">No roles known for this game.</span>}
        {Object.entries(roles).map(([id, name]) => {
          const rid = Number(id); const on = sel.includes(rid);
          return <button key={id} type="button" className={on ? "badge active chip-btn" : "badge chip-btn"} onClick={() => toggle(rid)}>{on ? "✓ " : ""}{name}</button>;
        })}
      </div>
    </div>
  );
}

const ZONE_KIND = "app.state.out_of_zone";
const CLAN_KIND = "app.state.clan_tag";
const RATIO_KIND = "app.state.ratio";
/** The ratio check's pairs, first count to second — @app/rules' RATIO_TYPES in words, held to
 *  them by test/rosterConditions.test.mjs. */
const RATIO_CHOICES = [
  { value: "teamkills:kills", label: "team kills to kills" },
  { value: "teamkills:deaths", label: "team kills to deaths" },
  { value: "kills:deaths", label: "kills to deaths (K/D)" },
  { value: "kills:teamkills", label: "kills to team kills" },
  { value: "deaths:kills", label: "deaths to kills" },
  { value: "deaths:teamkills", label: "deaths to team kills" },
];

export function StateTriggerParams({ kind, value, onChange, roles: gameRoles }: {
  kind: string;
  value: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
  /** The roles to offer — a player trigger's player's game. Absent: the configured server's game. */
  roles?: Record<number, string>;
}) {
  const { descriptor } = useGame();
  const roles: Record<number, string> = gameRoles ?? descriptor?.roles ?? {};
  const put = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  // The zone trigger references the zone-set library; the picker lists every set (labelled with
  // its game) because a rule can be community-wide — the worker enforces only where set and
  // server agree on the game.
  const [zoneSets, setZoneSets] = useState<{ id: string; name: string; game: string }[] | null>(null);
  // A list that could not be read is said as that — "none yet, paint one first" sent staff to make
  // what was already there.
  const [zoneSetsErr, setZoneSetsErr] = useState("");
  useEffect(() => {
    if (kind !== ZONE_KIND) return;
    let alive = true;
    api<{ sets: { id: string; name: string; game: string }[] }>("/zones")
      .then((r) => { if (alive) setZoneSets(r.sets ?? []); })
      .catch((e) => { if (alive) { setZoneSets([]); setZoneSetsErr((e as Error).message); } });
    return () => { alive = false; };
  }, [kind]);
  // The clan tag trigger picks from Players → Clans: one chip per clan, however it is spelled.
  const [clanList, setClanList] = useState<{ key: string; label: string; ever: number }[] | null>(null);
  const [clanListErr, setClanListErr] = useState("");
  const [clanSearch, setClanSearch] = useState("");
  useEffect(() => {
    if (kind !== CLAN_KIND) return;
    let alive = true;
    api<{ clans: { key: string; label: string; ever: number }[] }>("/clans?limit=500")
      .then((r) => { if (alive) setClanList(r.clans ?? []); })
      .catch((e) => { if (alive) { setClanList([]); setClanListErr((e as Error).message); } });
    return () => { alive = false; };
  }, [kind]);
  const int = (k: string, label: string, min = 0, help?: string) => (
    <label key={k}>{label}<NumField min={min} value={Number(value[k] ?? 0)} onValue={(n) => put(k, n)} />{help && <span className="hint">{help}</span>}</label>
  );
  const text = (k: string, label: string, placeholder?: string) => (
    <label key={k}>{label}<input value={String(value[k] ?? "")} onChange={(e) => put(k, e.target.value)} placeholder={placeholder} /></label>
  );
  const roleChips = (k: string, label: string) => <RoleChips key={k} label={label} roles={roles} value={value[k]} onChange={(ids) => put(k, ids)} />;
  // No population field here: the bounds live on the RULE (beside active hours), one knob for
  // state and event triggers alike.
  if (kind === "app.state.no_leader") return <div className="grid">{int("minSquadSize", "Minimum squad size to enforce", 1)}</div>;
  if (kind === "app.state.low_level") return <div className="grid">{int("minLevel", "Minimum level to play", 1)}</div>;
  if (kind === "app.state.role_level") return (
    <div>
      {roleChips("roles", "Roles this floor covers")}
      <div className="grid">{int("minLevel", "Minimum level for these roles", 1, "Players on a chosen role below this are flagged; the whole-roster level rule stays separate.")}</div>
    </div>
  );
  if (kind === "app.state.bad_role") return <div>{roleChips("disallowedRoles", "Disallowed roles")}{roleChips("allowedRoles", "Allowed roles (leave empty unless allowlisting)")}</div>;
  if (kind === "app.state.bad_name") return (
    <div>
      <div className="grid">
        {text("bannedSubstrings", "Banned words (comma-separated)")}
        {text("bannedPattern", "Blocked pattern (regex, optional)")}
      </div>
      <Toggle checked={value.blockUrls === true} onChange={(v) => put("blockUrls", v)} label="Block adverts / URLs in names" />
    </div>
  );
  if (kind === ZONE_KIND) return (
    <div>
      <div className="grid">
        <label>Zone set
          <select value={String(value.zoneSet ?? "")} onChange={(e) => put("zoneSet", e.target.value)}>
            <option value="">— pick a zone set —</option>
            {(zoneSets ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.game})</option>)}
          </select>
          {zoneSetsErr && <span className="hint">Couldn&apos;t read the zone sets: {zoneSetsErr}</span>}
          {zoneSets !== null && zoneSets.length === 0 && !zoneSetsErr && (
            <span className="hint">No zone sets yet — paint one under Auto settings → Map zones first.</span>
          )}
        </label>
      </div>
      <Toggle checked={value.keepOut === true} onChange={(v) => put("keepOut", v)}
        label="Forbid the painted cells instead (off = each team must stay in its painted area)" />
      {roleChips("exemptRoles", "Exempt roles (may roam anywhere — e.g. the commander, recon)")}
    </div>
  );
  if (kind === "app.state.no_vip" || kind === "app.state.no_discord") return (
    <div className="grid">
      {int("minMinutesOnline", "Only after they've been on for (minutes)", 0, "0 = as soon as they join. Counted from when this server's roster first showed them; leaving resets it.")}
    </div>
  );
  if (kind === "app.state.playtime") return (
    <div>
      <div className="grid">
        {int("hours", "Hours played", 1)}
        {int("periodDays", "Over the last (days, 0 = all time)", 0, "30 = hours played in the last 30 days.")}
      </div>
      <Toggle checked={value.allServers === true} onChange={(v) => put("allServers", v)} label="Count every server (off = this server only)" />
    </div>
  );
  if (kind === CLAN_KIND) {
    const sel: string[] = Array.isArray(value.clans) ? (value.clans as unknown[]).map(String) : [];
    const toggleClan = (k: string) => put("clans", sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]);
    const needle = clanSearch.trim().toLowerCase();
    const known = new Map((clanList ?? []).map((c) => [c.key, c]));
    const shown = (clanList ?? []).filter((c) => !sel.includes(c.key) && (!needle || c.label.toLowerCase().includes(needle))).slice(0, 60);
    return (
      <div className="field">
        <div className="field-label">Clan tags</div>
        <div className="chips">
          {sel.length === 0 && <span className="muted">None picked yet — pick at least one below.</span>}
          {sel.map((k) => (
            <button key={k} type="button" className="badge active chip-btn" onClick={() => toggleClan(k)} title="Remove">✓ {known.get(k)?.label ?? clanKeyText(k)}</button>
          ))}
        </div>
        <input value={clanSearch} onChange={(e) => setClanSearch(e.target.value)} placeholder="Find a clan tag…" style={{ margin: "8px 0", maxWidth: 260 }} />
        <div className="chips">
          {clanList === null && <span className="muted">Loading clan tags…</span>}
          {clanListErr && <span className="muted">Couldn&apos;t read the clan tags: {clanListErr}</span>}
          {clanList !== null && clanList.length === 0 && !clanListErr && <span className="muted">No clan tags recorded yet — they are read from the live roster.</span>}
          {shown.map((c) => (
            <button key={c.key} type="button" className="badge chip-btn" onClick={() => toggleClan(c.key)} title={`${c.ever} player(s) have worn it`}>{c.label}</button>
          ))}
        </div>
        <span className="hint">Each tag covers every spelling of it — Players → Clans is where spellings are combined or split.</span>
      </div>
    );
  }
  if (kind === "app.state.kill_rate") return (
    <div className="grid">
      {int("minKills", "Only once they have at least (kills this match)", 1)}
      {int("killsPer10Min", "Kills per 10 minutes at or above (0 = off)", 0, "25 = two and a half kills a minute, sustained.")}
      {int("minKd", "K/D at or above (0 = off)", 0, "Kills divided by deaths this match.")}
    </div>
  );
  if (kind === RATIO_KIND) return (
    <div className="grid">
      <label>Ratio
        <select value={String(value.ratio ?? "teamkills:kills")} onChange={(e) => put("ratio", e.target.value)}>
          {RATIO_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <span className="hint">This match&apos;s counts, the first divided by the second. A second count of 0 counts as 1.</span>
      </label>
      <label>Fires when it is
        <select value={value.direction === "below" ? "below" : "above"} onChange={(e) => put("direction", e.target.value)}>
          <option value="above">at or above the limit</option>
          <option value="below">at or below the limit</option>
        </select>
      </label>
      <label>Limit<NumField min={0} step="any" inputMode="decimal" value={Number(value.limit ?? 0)} onValue={(n) => put("limit", n)} />
        <span className="hint">Up to two decimal places: 2 is two for every one, 0.5 one for every two.</span></label>
      {int("minCount", "Only once the two add up to at least", 1, "A ratio on a handful of kills is noise.")}
    </div>
  );
  if (kind === "app.state.solo_tank") return <div>{roleChips("tankRoles", "Tank roles (a squad with any of these counts as armor)")}<div className="grid">{int("minCrew", "Minimum crew", 1)}</div></div>;
  if (kind === "app.state.solo_heli") return <div>{roleChips("heliRoles", "Helicopter roles (a platoon with any of these counts as a helicopter crew)")}<div className="grid">{int("minCrew", "Minimum crew", 1)}</div></div>;
  if (kind === "app.weapon.restricted") return (
    <div className="grid">
      {text("disallowedWeapons", "Disallowed weapons (comma-separated substrings)", "e.g. FLAMETHROWER, SATCHEL, 150MM")}
      {text("allowedWeapons", "Allowed weapons (leave blank unless allowlisting)")}
    </div>
  );
  return null;
}
