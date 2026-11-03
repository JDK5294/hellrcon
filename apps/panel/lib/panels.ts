/**
 * The panel registry — layer 3 of the permission model.
 *
 * Layer 1 is `routes.ts`: every destination names the capabilities that open it, and a containment
 * test keeps it honest. Layer 2 is the API: every endpoint calls `can(...)`, and a coverage test
 * scans the source to prove it. Both stayed correct for exactly that reason.
 *
 * Layer 3 — the panels and tables INSIDE a page — had neither, and drifted: a tab you can open
 * shows every block on it, whether or not the capability behind that block is one you hold. The
 * fix is not to sweep eighty-four panels once. It is to give a panel the same obligation a route
 * has, so the next one written cannot skip it.
 *
 * So `<Panel>` requires `caps`, and `panel-registry.test.mjs` checks that every declaration is a
 * readable literal naming a capability that exists. `"open"` is a real answer — plenty of panels
 * genuinely belong to anyone who could reach the page — but it has to be *said*, because silence
 * and "anyone may see this" must not look the same in the source.
 *
 * This gate is a display gate and nothing more. It decides what the UI offers; it is not a
 * boundary, because the data may still be in the payload and anyone can read a network response.
 * Anything that must not LEAVE the server is data-gated at the API — the payload omits the block
 * and sends a flag saying it did, the way the player profile's ban status and watch provenance
 * now work. See docs/permissions-map.md for which is which and why.
 */
import type { ClientGrant } from "./access";
import { hasCap } from "./access";

/**
 * What a panel declares.
 *
 * - `"open"` — anyone who could reach this page may see it. Deliberate, not a default.
 * - a capability — held anywhere (globally or on some server), at `capLevel`.
 * - several — ANY of them is enough. Mirrors how a route lists `caps`: the hub opens if you hold
 *   one of the things it contains.
 */
export type PanelCaps = "open" | string | readonly string[];

/** The one place that answers "may this account see this panel?". */
export function panelVisible(
  grants: ClientGrant[],
  caps: PanelCaps | undefined,
  level: "read" | "write" = "read",
): boolean {
  // `undefined` is unreachable from TypeScript — the prop is required — and renders anyway. A
  // missing annotation must never become a blank screen: this is a UI convenience, and failing
  // open is the right direction for one. The type and the test are what make declaring compulsory.
  if (caps === undefined || caps === "open") return true;
  const list = typeof caps === "string" ? [caps] : caps;
  return list.some((c) => hasCap(grants, c, level));
}
