/**
 * How many steps a rule's escalation ladder may have after its first action — the rule editor
 * stops offering "+ escalate on repeat" here.
 *
 * Offences are remembered per player for the rule's forget window, through a kick and a rejoin,
 * and once the ladder runs out its last step repeats. Four steps meant a player kicked at the top
 * of the ladder could rejoin and be kicked again for the rest of the window, with no step left to
 * go on to a ban. Nine leaves that room (ten offences in all).
 *
 * The API refuses a longer ladder at the same number (MAX_ESCALATION_STEPS in
 * apps/api/src/routes/kit.ts); test/ruleLadder.test.mjs holds the two together, because an editor
 * that offers a step the server refuses fails only at Save.
 */
export const MAX_ESCALATION_STEPS = 9;
