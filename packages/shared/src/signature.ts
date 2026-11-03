/**
 * Signatures — the lines appended to whatever a player is shown.
 *
 * A kick reason, a punish reason, an admin message: the player reads a sentence and has no idea
 * who wrote it or where to take it up. Two optional lines fix both, independently, because they
 * answer different questions:
 *
 *   • the STAFF line says who acted. It carries the staff member's panel/Discord name, never their
 *     in-game one — a moderator's HLL alias is not who the community knows them as, and half the
 *     staff never play under a recognisable name at all.
 *   • the CUSTOM line says where to go next. Free text on purpose: it is usually a Discord invite,
 *     but "read the rules at …" or "appeals close after 7 days" are the same shape of thing and a
 *     field called `discordLink` would have been wrong within a month.
 *
 * Each is switched on per action, and each independently: "signed by the admin" and "here is our
 * Discord" are separate decisions and a community may want either, both, or neither on any given
 * action.
 *
 * Pure and stringly-typed by design. Every caller — the manual action routes, the automation, the
 * camera announcement — composes exactly the same way, and the only thing that decides what a
 * player reads is the config plus this function.
 */

/** The lines themselves. Blank means "nothing to append", which is how a half is switched off. */
export interface SignatureLines {
  /** Template for the staff line. `{staff}` is replaced with the acting staff member's name. */
  staffLine: string;
  /** Free text, appended verbatim — a Discord invite, a rules link, an appeals note. */
  customLine: string;
}

/** Which halves this particular action wants. */
export interface SignatureUse {
  staff: boolean;
  custom: boolean;
}

export interface SignatureInput extends SignatureLines {
  use: SignatureUse;
  /** The acting staff member's display name, or null when the app itself acted. */
  staffName: string | null;
  /** How the lines are joined onto the body. The game renders a newline in a kick reason, so that
   *  is the default; a caller with a single-line surface can pass " ". */
  separator?: string;
}

/**
 * Append the requested signature lines to `body`.
 *
 * Three rules, all of them about not producing noise:
 *   - an empty body stays empty. A signature is a postscript, and a message that is nothing but a
 *     postscript is a message nobody meant to send.
 *   - the staff line is skipped when there is no staff member. Automation has no name, and
 *     "— " dangling on the end of a ban reason looks like a bug to the person reading it.
 *   - a line that renders to nothing is skipped rather than contributing a blank separator.
 */
export function applySignature(body: string, input: SignatureInput): string {
  const base = body.trim();
  if (!base) return base;
  const sep = input.separator ?? "\n";
  const parts = [base];
  if (input.use.staff && input.staffName) {
    const line = input.staffLine.replaceAll("{staff}", input.staffName).trim();
    if (line) parts.push(line);
  }
  if (input.use.custom) {
    const line = input.customLine.trim();
    if (line) parts.push(line);
  }
  return parts.join(sep);
}

/**
 * The actions a signature can be attached to: everything whose text a PLAYER reads.
 *
 * Deliberately not every admin action. A team switch shows the player nothing, and an unban shows
 * them nothing either — offering a signature toggle for those would be a switch that does nothing,
 * which is the kind of setting people spend an afternoon debugging.
 */
export const SIGNABLE_ACTIONS = ["message", "kick", "punish", "tempban", "permaban"] as const;
export type SignableAction = (typeof SIGNABLE_ACTIONS)[number];

/** Plain-words labels, so the panel and any log line agree on what each one is called. */
export const SIGNABLE_ACTION_LABELS: Record<SignableAction, string> = {
  message: "Message to a player",
  kick: "Kick",
  punish: "Punish",
  tempban: "Temporary ban",
  permaban: "Permanent ban",
};

/**
 * The one signable thing that is NOT an action: the standing join-screen text — "Welcome message"
 * on HLL, "Notice message" on HLL: Vietnam (same logical field, the game tables carry the naming).
 * Nobody SENDS it, so the staff half is meaningless and is forced off at parse time; only the
 * second line may attach, appended wherever the message is set — the Live settings card and an
 * Auto settings profile alike.
 */
export const WELCOME_SIGNATURE_ACTION = "welcome" as const;

/** Per-action switches. An action absent from the map wants neither half. */
export type SignatureActionMap = Partial<Record<SignableAction | typeof WELCOME_SIGNATURE_ACTION, SignatureUse>>;

/** What an action wants, with "neither" as the answer for anything unconfigured. */
export function signatureUseFor(actions: SignatureActionMap | null | undefined, action: string): SignatureUse {
  const found = actions?.[action as SignableAction];
  return { staff: found?.staff === true, custom: found?.custom === true };
}

/** Coerce a stored/POSTed action map, dropping anything that is not a signable action. Shared by
 *  the API validator and both stores so an unknown key cannot survive a round trip. */
export function parseSignatureActions(raw: unknown): SignatureActionMap {
  const out: SignatureActionMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const a of SIGNABLE_ACTIONS) {
    const v = (raw as Record<string, unknown>)[a];
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    out[a] = { staff: r.staff === true, custom: r.custom === true };
  }
  // The welcome/notice message: custom-only. `staff` is FORCED off rather than validated, so a
  // smuggled `staff: true` cannot survive a round trip — nobody sends a standing setting, and a
  // staff name on the join screen would credit whoever last saved a config field.
  const w = (raw as Record<string, unknown>)[WELCOME_SIGNATURE_ACTION];
  if (w && typeof w === "object") {
    out[WELCOME_SIGNATURE_ACTION] = { staff: false, custom: (w as Record<string, unknown>).custom === true };
  }
  return out;
}

/**
 * The second line, appended to the welcome/notice message — the one signature that attaches to a
 * SETTING rather than an action. Both surfaces that write the message (the Live settings card's
 * config route and the Auto settings profile runner) pass through here, so what players read on
 * the join screen cannot depend on which door set it. The staff half never applies (see
 * WELCOME_SIGNATURE_ACTION); a blank message stays blank, per applySignature's own rule.
 */
export function appendWelcomeSignature(
  cfg: { customLine: string; actions: SignatureActionMap | null | undefined },
  text: string,
): string {
  if (!signatureUseFor(cfg.actions, WELCOME_SIGNATURE_ACTION).custom) return text;
  return applySignature(text, { staffLine: "", customLine: cfg.customLine, use: { staff: false, custom: true }, staffName: null });
}

/**
 * Fill the player-name token in an admin-camera announcement.
 *
 * `{player}` and `{staff}` sit in adjacent features and look like the same kind of token, so this
 * lives beside the signature code to make the difference impossible to miss:
 *
 *   • `{staff}` is the acting staff member's PANEL name. The action came from an authenticated
 *     request, so the app knows exactly whose account it was.
 *   • `{player}` is the IN-GAME name off the CAMERA log line. All the app has is a line of text
 *     from the game; nothing links a game player to a panel account (see the standing note about
 *     player linking), so the Discord name is simply not available here.
 *
 * `{admin}` is accepted as a silent alias because that is what the field was called when it
 * shipped. Rejecting it would render the literal text "{admin}" to everybody on the server, which
 * is a far worse outcome than honouring an old spelling — but it is nowhere in the UI, so nobody
 * learns it from us.
 */
export function fillPlayerToken(template: string, playerName: string): string {
  return template.replaceAll("{player}", playerName).replaceAll("{admin}", playerName).trim();
}

/**
 * A signer for an action the APP took, rather than a person.
 *
 * Automation has no name, so the staff half can never apply — and rather than leaving each caller
 * to remember that, this hard-codes it. What is left is the second line, which is exactly the half
 * automation most needs: a rule that fires on every teamkill otherwise arrives as an
 * unattributable sentence with nowhere to appeal it.
 *
 * Takes the config rather than a repository so it stays in this package and both the API's
 * enforcer and the worker's runners can use the one implementation.
 */
export function automatedSignerFrom(cfg: SignatureLines & { actions: SignatureActionMap }, action: string): (text: string) => string {
  const use = signatureUseFor(cfg.actions, action);
  if (!use.custom) return (text) => text; // nothing to add; skip the work entirely
  return (text) => applySignature(text, { ...cfg, use: { staff: false, custom: true }, staffName: null });
}
