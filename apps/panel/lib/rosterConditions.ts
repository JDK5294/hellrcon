/**
 * The Rules tab's live-roster triggers, offered as Player trigger conditions ("when Bob plays Tank
 * Commander"). The panel's copy of @app/rules' PLAYER_ROSTER_EVENT_KIND (the panel imports no
 * workspace packages), held to it by test/rosterConditions.test.mjs.
 *
 * Each condition is set up with its Rules trigger's own form (StateTriggerParams), so its knobs
 * mean what they mean on a rule. "Plays a role" is the restricted-role trigger with nothing but a
 * role list.
 */
export const ROSTER_CONDITIONS = [
  { id: "role", kind: "app.state.bad_role", label: "plays a role" },
  { id: "lowlevel", kind: "app.state.low_level", label: "is below a level" },
  { id: "rolelevel", kind: "app.state.role_level", label: "is below a level on a role" },
  { id: "badname", kind: "app.state.bad_name", label: "has a name the filter catches" },
  { id: "outofzone", kind: "app.state.out_of_zone", label: "is outside the allowed area" },
  { id: "novip", kind: "app.state.no_vip", label: "has no VIP" },
  { id: "playtime", kind: "app.state.playtime", label: "reaches a playtime milestone" },
  { id: "nodiscord", kind: "app.state.no_discord", label: "has no Discord link" },
  { id: "killrate", kind: "app.state.kill_rate", label: "has a kill rate or K/D over a limit" },
  { id: "ratio", kind: "app.state.ratio", label: "has a ratio over or under a limit" },
  { id: "clantag", kind: "app.state.clan_tag", label: "wears a clan tag" },
  { id: "noleader", kind: "app.state.no_leader", label: "is in a squad with no leader" },
  { id: "solotank", kind: "app.state.solo_tank", label: "is in a solo tank" },
  { id: "soloheli", kind: "app.state.solo_heli", label: "is in a solo helicopter" },
] as const;

export type RosterCondition = (typeof ROSTER_CONDITIONS)[number]["id"];

export function isRosterCondition(event: string): event is RosterCondition {
  return ROSTER_CONDITIONS.some((c) => c.id === event);
}

/** The Rules trigger a condition is judged by, and whose form sets it up. */
export function rosterKindOf(event: RosterCondition): string {
  return ROSTER_CONDITIONS.find((c) => c.id === event)!.kind;
}

/** A new condition's starting settings: its Rules trigger's defaults (the rule editor's
 *  DEFAULT_PARAMS), and an empty role list for "plays a role". */
export const ROSTER_DEFAULTS: Record<RosterCondition, Record<string, unknown>> = {
  role: { roles: [] },
  lowlevel: { minLevel: 25 },
  rolelevel: { roles: [], minLevel: 50 },
  badname: { bannedSubstrings: "", blockUrls: false, bannedPattern: "" },
  outofzone: { zoneSet: "", keepOut: false, exemptRoles: [] },
  novip: { minMinutesOnline: 0 },
  playtime: { hours: 20, periodDays: 0, allServers: false },
  nodiscord: { minMinutesOnline: 5 },
  killrate: { minKills: 30, killsPer10Min: 25, minKd: 0 },
  ratio: { ratio: "teamkills:kills", direction: "above", limit: 2, minCount: 10 },
  clantag: { clans: [] },
  noleader: { minSquadSize: 2 },
  solotank: { tankRoles: [11, 12], minCrew: 2 },
  soloheli: { heliRoles: [16, 17], minCrew: 2 },
};

/** How long a condition must have been gone before "every time" fires on it again, in minutes —
 *  @app/rules' ROSTER_TRIGGER_CLEAR_MS, as the builder's hint says it. */
export const ROSTER_CLEAR_MINUTES = 2;
