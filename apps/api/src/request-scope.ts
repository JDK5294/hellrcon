/**
 * What the code deep inside a write handler needs to know about the call it is serving, without
 * every handler passing it down by hand.
 *
 * Two questions, both asked at a point the handler reaches on its own:
 *
 *   - `requirePrincipal` — who is this? An approved request replays the handler later, with no
 *     socket and no session, so the replay hands the answer in here: the approver's grants under
 *     the requester's name. Someone building a request gets their write grants held back here, so
 *     that nothing they press happens before they submit.
 *   - `sendForbidden` — they lack a write: refuse, or ask? Inside a write that can be asked for,
 *     the refusal becomes the request — filed for whoever holds the permission, or captured into the
 *     request being built — carrying exactly the permission the handler found missing, at the scope
 *     it checked. That is why it is asked HERE rather than at the door: a write can need a second
 *     key the door knows nothing about (adding someone to a VIP-perk group needs the VIP key on the
 *     perk's servers), and only the handler knows it.
 *
 * Carried on AsyncLocalStorage, so it follows the handler through every await and nothing else.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import type { AppContext } from "./context.js";
import type { Principal } from "./auth.js";

export interface AskableWrite {
  method: string;
  /** The route PATTERN — the replay registry's key. */
  path: string;
  params: Record<string, string>;
  req: IncomingMessage;
  ctx: AppContext;
}

export interface RequestScope {
  /** Set for every write that can be asked for. Absent: refusals refuse, as they always did. */
  ask?: AskableWrite;
  /** Resolved once per call by requirePrincipal — or handed in by a replay. */
  principal?: Principal;
  /** The caller has an open request draft: a write they are refused is captured into it. */
  building?: boolean;
  /** An approved request being carried out. Its refusals refuse — they never file again. */
  replay?: boolean;
  /** Set when a replay was refused a write: what it lacked, so the caller can ask for it instead. */
  refused?: { capability: string; serverId: string | null };
}

export const requestScope = new AsyncLocalStorage<RequestScope>();

/** The server a write is about when its path names one (`/api/servers/:id/...`), else null. */
export function pathServerId(path: string, params: Record<string, string>): string | null {
  return path.startsWith("/api/servers/:id") && params.id ? params.id : null;
}
