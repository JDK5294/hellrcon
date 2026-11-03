/**
 * Why a rule another screen manages is not acting right now — the Chat filter's two rules, which
 * live under Rules where staff can delete them, switch them off, file them in a section that gets
 * switched off, or pause them. Each is undone in a different place, so the screen that owns the
 * rule says which: a save there puts back a deleted rule or its own switch, while a section and a
 * pause are undone under Rules.
 */
export type NotActing = "deleted" | "off" | "section" | "paused";

export interface ManagedRuleState {
  id: string;
  enabled: boolean;
  /** filed in a section whose master switch is off */
  sectionOff?: boolean;
  /** paused until then; null or past = not paused */
  pausedUntil?: string | null;
}

/** null when the rule is acting. `nowMs` is the server's clock where the page has it. */
export function whyNotActing(rule: ManagedRuleState | null, nowMs: number): NotActing | null {
  if (!rule) return "deleted";
  if (!rule.enabled) return "off";
  if (rule.sectionOff) return "section";
  if (rule.pausedUntil && Date.parse(rule.pausedUntil) > nowMs) return "paused";
  return null;
}

/** Rules a move would set firing: each held only by a switched-off section it is leaving for a
 *  place that holds nothing — another section that is on, or none. */
export function rulesAMoveWouldArm<R extends { id: string; enabled: boolean; sectionOff?: boolean; sectionId?: string | null }>(
  rules: R[], moving: ReadonlySet<string>, toSectionId: string | null, sections: { id: string; enabled?: boolean }[],
): R[] {
  const destinationHolds = toSectionId !== null && sections.find((s) => s.id === toSectionId)?.enabled === false;
  if (destinationHolds) return [];
  return rules.filter((r) => moving.has(r.id) && r.enabled && r.sectionOff === true && (r.sectionId ?? null) !== toSectionId);
}
