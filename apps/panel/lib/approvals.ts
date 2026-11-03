/**
 * The approvals vocabulary. There is deliberately NO per-capability "askable" list and no Ask
 * grant level: any signed-in user may propose any requestable action — lacking the permission IS
 * the ask — and whoever holds the write signs it. The API decides both halves per line.
 */

/** How a request line reads as a verb — the panel's one vocabulary for line kinds. */
export const KIND_LABEL: Record<string, string> = {
  message: "Message", kick: "Kick", punish: "Punish", tempban: "Temp ban", permaban: "Perma ban",
  unban_temp: "Lift temp ban", unban_perma: "Lift perma ban",
  switch: "Switch team", switch_death: "Switch on death",
  vip: "Grant VIP", vipRevoke: "Revoke VIP",
  tempban_extend: "Extend temp ban",
  watch: "Add to watchlist", unwatch: "Take off the watchlist",
};
