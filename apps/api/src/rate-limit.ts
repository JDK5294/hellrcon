/**
 * Login throttling — the answer to a password list being fed to POST /api/auth/login.
 *
 * Until this existed the login had no throttle, no attempt counter and no lockout, which on an
 * internet-facing panel means credentials could be guessed as fast as the proxy would relay them.
 * (CRCON added the same protection to its auth endpoints in v11.12.0, which is a fair signal of
 * how this class of tool gets probed — see docs/crcon-releases.md.)
 *
 * Two independent sliding windows, because they answer different attacks:
 *
 *  - per USERNAME: someone hammering one account. This is the limit that matters, because it does
 *    not care where the requests come from — a botnet rotating addresses still hits it. Cleared on
 *    a successful login, since its normal trigger is a real staffer mistyping.
 *  - per ADDRESS: someone spraying many usernames from one place. Coarser and never cleared by a
 *    success — guessing one password right does not refund the budget.
 *
 * The check runs BEFORE password verification, so a locked-out attacker also stops burning bcrypt
 * time — under attack the hashing work is exactly the load you want to shed.
 *
 * In memory on purpose: the API is one process, counters lose nothing worth keeping across a
 * restart, and a table would turn every failed login into a write. Only FAILURES are recorded, so
 * the maps hold nothing in normal operation; timestamps age out of the window lazily. The maps
 * are capped, and at the cap unseen keys are denied rather than old ones evicted — eviction would
 * let an attacker flush the counters by spraying invented usernames, which is the exact bypass
 * the cap exists to prevent. Ten thousand distinct failing keys inside fifteen minutes is an
 * attack, and fail-closed is the only honest answer to it.
 */

const WINDOW_MS = 15 * 60_000;
/** Failures one username may accumulate in the window before it locks. */
const PER_NAME = 5;
/** Failures one address may accumulate in the window — looser, it nets whole sprays. */
const PER_ADDR = 30;
/** Max tracked keys per map — the fail-closed threshold described above. */
const MAX_KEYS = 10_000;

export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the decision relaxes — what a 429 sends as retry-after. */
  retryAfterSec: number;
}

export class LoginThrottle {
  private byName = new Map<string, number[]>();
  private byAddr = new Map<string, number[]>();
  constructor(private now: () => number = Date.now) {}

  /** Call before verifying anything. A denial means "answer 429 and do no crypto work". */
  check(username: string, addr: string): ThrottleDecision {
    const t = this.now();
    const name = this.recent(this.byName, keyOf(username), t);
    const ip = this.recent(this.byAddr, addr, t);
    const overName = name.length >= PER_NAME;
    const overAddr = ip.length >= PER_ADDR;
    if (overName || overAddr) {
      const oldest = Math.min(overName ? name[0]! : Infinity, overAddr ? ip[0]! : Infinity);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - t) / 1000)) };
    }
    // The fail-closed cap: an unseen key that a full map could not track would be unthrottleable,
    // so it is denied instead. Checked only for unseen keys, and after a full prune so a map that
    // merely REMEMBERS an old attack does not keep new users out.
    if ((!name.length && this.full(this.byName, t)) || (!ip.length && this.full(this.byAddr, t))) {
      return { allowed: false, retryAfterSec: Math.ceil(WINDOW_MS / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Record a failed attempt against both keys. */
  fail(username: string, addr: string): void {
    const t = this.now();
    this.push(this.byName, keyOf(username), t);
    this.push(this.byAddr, addr, t);
  }

  /** A real sign-in: the username's slate is wiped (a staffer found their password), the
   *  address's is not (success must never refund an attacker's budget). */
  succeed(username: string): void {
    this.byName.delete(keyOf(username));
  }

  /** The key's failures still inside the window, pruning as it reads. */
  private recent(map: Map<string, number[]>, key: string, t: number): number[] {
    const hits = (map.get(key) ?? []).filter((ts) => ts > t - WINDOW_MS);
    if (hits.length) map.set(key, hits); else map.delete(key);
    return hits;
  }

  private push(map: Map<string, number[]>, key: string, t: number): void {
    if (!map.has(key) && this.full(map, t)) return; // check() already denied this key
    map.set(key, [...(map.get(key) ?? []), t]);
  }

  /** At cap, after dropping every fully-aged-out key. O(keys), and only runs at the cap —
   *  i.e. only while an attack is actually underway. */
  private full(map: Map<string, number[]>, t: number): boolean {
    if (map.size < MAX_KEYS) return false;
    for (const [key, hits] of map) if (!hits.some((ts) => ts > t - WINDOW_MS)) map.delete(key);
    return map.size >= MAX_KEYS;
  }
}

/** Usernames are matched case-insensitively at login, so the throttle folds case the same way —
 *  otherwise "Admin"/"admin" would be two separate budgets against one account. */
const keyOf = (username: string) => username.trim().toLowerCase();

/**
 * The client address for throttling, behind the deployment's real topology: Cloudflare in front,
 * so the socket peer is the proxy and the caller is in the headers. `cf-connecting-ip` is set by
 * Cloudflare itself; `x-forwarded-for`'s FIRST hop is the original client. A direct (proxyless)
 * caller could spoof either header — which only buys them out of the coarse per-address net, never
 * the per-username one, and that is the acceptable trade for working correctly behind the proxy.
 */
export function clientAddrOf(headers: Record<string, string | string[] | undefined>, socketAddr: string | undefined): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const cf = one(headers["cf-connecting-ip"]).trim();
  if (cf) return cf;
  const xff = one(headers["x-forwarded-for"]).split(",")[0]?.trim();
  if (xff) return xff;
  return socketAddr ?? "unknown";
}
