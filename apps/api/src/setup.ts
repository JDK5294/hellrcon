/**
 * First-run setup: the one-time code that proves whoever creates the owner account is the person
 * who installed the panel, and the walk-through that follows it.
 *
 * Without the code, the first visitor to register became the owner. On a home PC that is the
 * person at the keyboard; on a VM with a public address it is whoever reaches the port first, and
 * scanners reach it within minutes. So while the install has no accounts it holds a code, shown
 * only where the installer can see it — the start script's window, which opens the setup page with
 * it filled in, and `docker compose logs api` — and the first account cannot be made without it.
 * The code is spent the moment that account exists.
 *
 * The walk-through's stage outlives the code: the owner, signed in, is taken through the remaining
 * steps (time zone, first server) until they finish or skip them. An install that already had
 * accounts before any of this never enters it.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import type { Repository } from "@app/db";

/** The code, while the install has no accounts. */
export const SETUP_CODE_KEY = "setup.code";
/** "walkthrough" from the owner's creation until they finish the remaining steps. */
export const SETUP_STAGE_KEY = "setup.stage";
/** Where the start scripts read the code inside the container (`docker compose exec api cat …`). */
export const setupCodeFile = (): string => process.env.SETUP_CODE_FILE || "/tmp/setup-code";
/**
 * The login throttle's key for setup-code attempts: no username can be it (usernames are trimmed
 * text), and its per-name budget — five wrong codes in fifteen minutes from anywhere — is what
 * puts guessing out of reach however many addresses a scanner rotates through.
 */
export const SETUP_THROTTLE_KEY = "\u0000setup-code";

/**
 * What a guess past the budget is told: the real wait, from the throttle. Five wrong codes lock the
 * page for fifteen minutes, which is not "a few", and someone who lost the code and is trying to
 * remember it is exactly who needs to know.
 */
export function setupLockedOut(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `too many wrong codes — try again in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Where the code is, for a refusal: the window that started the panel, which may be long closed. */
export const WHERE_THE_CODE_IS = "it is in the window that started the panel, and running the start script again shows it";

/** No 0/O or 1/I/L: the code is read off a terminal and typed, sometimes on a phone. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Eight characters as two groups of four — about forty bits, behind the throttle above. */
export function makeSetupCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Case, spaces and the dash are not part of the code: "abcd efgh" is ABCD-EFGH. */
export function normalizeSetupCode(s: unknown): string {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function setupCodesMatch(given: unknown, held: string): boolean {
  const a = Buffer.from(normalizeSetupCode(given));
  const b = Buffer.from(normalizeSetupCode(held));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Boot: hold a code while there are no accounts (the same one across restarts, until it is spent),
 * written where the start scripts read it; with accounts, make sure none is left behind.
 * Returns the code, or null when the install is set up.
 */
export async function settleSetupCode(repo: Pick<Repository, "users" | "installSettings">, file = setupCodeFile()): Promise<string | null> {
  if ((await repo.users.count()) > 0) {
    await spendSetupCode(repo, file);
    return null;
  }
  const code = await repo.installSettings.getOrCreate(SETUP_CODE_KEY, makeSetupCode, { secret: true });
  await writeFile(file, `${code}\n`, { mode: 0o600 }).catch(() => { /* the log line still carries it */ });
  return code;
}

/** The owner exists: the code is spent, here and in the file the scripts read. */
export async function spendSetupCode(repo: Pick<Repository, "installSettings">, file = setupCodeFile()): Promise<void> {
  await repo.installSettings.set(SETUP_CODE_KEY, null);
  await rm(file, { force: true }).catch(() => {});
}

/** How this install was put on its machine — the VM installer says so; anything else is a home install. */
export const deployRoute = (): "vm" | "home" => (process.env.DEPLOY_ROUTE === "vm" ? "vm" : "home");
