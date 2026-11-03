/**
 * Client-side mirror of @app/access `can()` for ONE server — used to decide what the UI offers
 * (e.g. which servers appear in a bulk action's "Apply on" selector). The API re-checks every
 * request with full context; this only keeps the panel from offering a choice that can only 403.
 * Group-scoped grants are ignored here, matching the server (nothing populates server groups).
 *
 * Veto semantics mirror the server's resolveLevel exactly: an explicit `none` binds only the
 * grants of its own SOURCE (one role, or the personal grants — `source` rides in on /api/me).
 * Across sources the best level wins, so holding a restricted role beside an admin role never
 * subtracts. A personal `none` (no source) is the per-person lockout and vetoes everything.
 */
export interface ClientGrant { capability: string; level: string; scopeType?: string; scopeId?: string | null; source?: string }

const ORDER: Record<string, number> = { none: 0, read: 1, write: 2 };

function bySource(grants: ClientGrant[]): Map<string, ClientGrant[]> {
  const groups = new Map<string, ClientGrant[]>();
  for (const g of grants) {
    const key = g.source ?? "";
    const list = groups.get(key);
    if (list) list.push(g);
    else groups.set(key, [g]);
  }
  return groups;
}

/**
 * Does this account hold `capability` ANYWHERE — globally, or on any one server?
 *
 * The question the nav asks to decide whether an area is worth offering, and the question a panel
 * asks to decide whether to render. It lived inline in page.tsx while the nav was its only caller;
 * it moved here the moment panels needed it, because two copies of a permission predicate is how
 * layer 1 and layer 3 end up disagreeing about the same account.
 *
 * A server-scoped grant counts, since the area exists for that one server. A GLOBAL explicit
 * `none` silences its own source (personal → hides the area outright); a server-scoped `none`
 * only blocks that server, so the area stays visible.
 */
export function hasCap(grants: ClientGrant[], capability: string, level: "read" | "write" = "read"): boolean {
  for (const [source, group] of bySource(grants)) {
    let ok = false;
    let silenced = false;
    for (const g of group) {
      if (g.capability !== capability && g.capability !== "*") continue;
      if (g.level === "none") {
        if (g.scopeType !== "server") {
          if (source === "") return false; // personal lockout
          silenced = true;
        }
        continue;
      }
      if ((ORDER[g.level] ?? 0) >= (ORDER[level] ?? 0)) ok = true;
    }
    if (ok && !silenced) return true;
  }
  return false;
}

/**
 * Is this account an OWNER — the global wildcard at write?
 *
 * Not `hasCap(grants, "*", "write")`, which is scope-blind on purpose (it asks "anywhere?") and so
 * says yes to a "*" confined to one server. That grant is full control of THAT server, which is a
 * different and much smaller thing than ownership, and the API's owner-only routes refuse it
 * (`can(grants, "*", "write")` with no server context resolves global grants only). Asking the
 * looser question here offered a tab whose every call then answered 404.
 *
 * The request builder's view elevation is a global "*" too, but at READ and under its own source;
 * it is excluded by name as well as by level, so no future widening of that elevation can make a
 * staff member building a request look like an owner. Vetoes follow resolveLevel: a global `none`
 * on "*" silences its own source, and a personal one is the per-person lockout.
 */
export function isOwner(grants: ClientGrant[]): boolean {
  // Every source is read before answering: the personal lockout outranks a role that happens to be
  // listed ahead of it, so an early "yes" from the first owner role would be order-dependent.
  let owner = false;
  for (const [source, group] of bySource(grants)) {
    if (source === "request-view") continue;
    let write = false;
    let vetoed = false;
    for (const g of group) {
      if (g.capability !== "*" || (g.scopeType ?? "global") !== "global") continue;
      if (g.level === "none") {
        if (source === "") return false; // personal lockout
        vetoed = true;
        continue;
      }
      if (g.level === "write") write = true;
    }
    if (write && !vetoed) owner = true;
  }
  return owner;
}

/**
 * Mirror of @app/access `holdsOutright`: does the account ITSELF hold `capability` everywhere?
 * Global grants only, never the request builder's view elevation — a "*" confined to one server is
 * not a key to every server, and an open request draft's global read must not open a destination
 * nobody actually granted.
 */
export function holdsOutright(grants: ClientGrant[], capability: string, level: "read" | "write" = "read"): boolean {
  return hasCap(grants.filter((g) => g.source !== "request-view" && (g.scopeType ?? "global") === "global"), capability, level);
}

export function canOnServer(grants: ClientGrant[], capability: string, serverId: string, level: "read" | "write" = "write"): boolean {
  let best = 0;
  for (const [source, group] of bySource(grants)) {
    let groupBest = 0;
    let vetoed = false;
    for (const g of group) {
      if (g.capability !== capability && g.capability !== "*") continue;
      const applies = !g.scopeType || g.scopeType === "global" || (g.scopeType === "server" && g.scopeId === serverId);
      if (!applies) continue;
      // An explicit `none` in scope vetoes ITS source, exactly like the server's resolveLevel.
      if (g.level === "none") {
        if (source === "") return false; // personal lockout
        vetoed = true;
        continue;
      }
      if ((ORDER[g.level] ?? 0) > groupBest) groupBest = ORDER[g.level] ?? 0;
    }
    if (!vetoed && groupBest > best) best = groupBest;
  }
  return best >= ORDER[level];
}

/**
 * The grant set to render the panel with while PREVIEWING a role — what someone holding only that
 * role, but never more than the previewer holds, would see.
 *
 * Pure NARROWING: for each capability the role confers, the effective level is the smaller of what
 * the role gives and what the previewer actually has (`hasCap` answers the latter, honouring their
 * own blocks and sources). A role `none` becomes a block; a capability the previewer lacks is
 * omitted entirely. So a preview can only ever show LESS than the previewer's own view — never a
 * screen they could not open themselves, which is what keeps "view as a trial mod" from becoming
 * a way to see more than you should.
 *
 * Roles here are global-grained (the role editor confers global grants), so the synthetic grants
 * are global; a wildcard role grant expands to the previewer's own capabilities at the role's
 * level, so "preview the owner role" shows the previewer's whole view, not god mode.
 *
 * The one exception to "global" is the wildcard itself. A GLOBAL "*" at write is ownership
 * (isOwner), and owner-only screens open on nothing else, so only a real owner may carry one into
 * a preview. A previewer whose "*" is confined to servers keeps it at those servers: widening it to
 * global would turn a per-server owner into an owner the moment they previewed the Owner role, and
 * offer them the owner-only tabs (whose every call then answers 404).
 *
 * `outright` names the capabilities that only ever count when held outright (holdsOutright). The
 * grant a preview mints is global and its own source, so it would pass that test; the previewer's
 * ceiling for such a capability is therefore asked the same outright question, never `hasCap`.
 */
export function previewGrantsForRole(
  real: ClientGrant[],
  roleGrants: { capability: string; level: "none" | "read" | "write" }[],
  outright: ReadonlySet<string> = new Set(),
): ClientGrant[] {
  const out: ClientGrant[] = [];
  const emit = (capability: string, roleLevel: "none" | "read" | "write") => {
    if (roleLevel === "none") { out.push({ capability, level: "none", scopeType: "global", scopeId: null, source: "role-preview" }); return; }
    // The previewer's own ceiling for this capability, so the preview never exceeds it.
    const holds = outright.has(capability) ? holdsOutright : hasCap;
    const realLevel = holds(real, capability, "write") ? "write" : holds(real, capability, "read") ? "read" : "none";
    const eff = ORDER[roleLevel] < ORDER[realLevel] ? roleLevel : realLevel;
    if (eff === "none") return; // role grants it, but the previewer does not hold it — omit
    out.push({ capability, level: eff, scopeType: "global", scopeId: null, source: "role-preview" });
  };
  const realHasWildcard = real.some((g) => g.capability === "*" && g.level !== "none");
  const owner = isOwner(real);
  for (const g of roleGrants) {
    if (g.capability === "*") {
      // A wildcard role grant expands to the previewer's OWN reach: an owner keeps the wildcard and
      // sees everything; anyone else expands it to the capabilities they actually hold. Either way
      // the preview is bounded by the previewer — never god mode.
      if (realHasWildcard && (owner || g.level === "none")) { emit("*", g.level); continue; }
      // Any other "*" the previewer holds (one server's, or a global one short of ownership) is kept
      // where they hold it. Not `emit("*")`: emit asks the scope-blind hasCap, which says yes to a
      // "*" confined to one server and would mint a GLOBAL "*" at write from it — ownership.
      if (realHasWildcard && g.level !== "none") wildcardsAtTheirScope(real, g.level, out);
      for (const c of new Set(real.map((r) => r.capability).filter((c) => c !== "*"))) emit(c, g.level);
      continue;
    }
    emit(g.capability, g.level);
  }
  // A wildcard minted above opens every outright capability with it, and the test that let it be
  // minted (`hasCap` on "*", or ownership) cannot see the previewer's own veto on one of them — a
  // global-read auditor kept out of a screen granted by name, or an owner who locked themselves out
  // of one.
  // So each outright capability the previewer does not hold outright gets a veto in the preview's
  // own source, which silences that source's wildcard for it and nothing else.
  for (const c of outright) {
    if (!holdsOutright(real, c, "read")) out.push({ capability: c, level: "none", scopeType: "global", scopeId: null, source: "role-preview" });
  }
  return out;
}

/**
 * A non-owner's own "*" grants, carried into a preview at the scope they hold them, clamped to the
 * role's level. One grant per server their "*" reaches, at the level it resolves to THERE — so their
 * own vetoes (a role's `none`, the personal lockout) still bind — plus a global one only if they
 * hold "*" globally short of ownership, and then never above read: a global "*" at write IS
 * ownership, which a preview must not hand to someone who does not already have it.
 *
 * The request builder's view elevation is left out. It is a global "*" under its own source, and as
 * a "role-preview" grant it would lose the source that keeps it from ever reading as ownership; the
 * capabilities the previewer holds outright are expanded beside this anyway.
 */
function wildcardsAtTheirScope(real: ClientGrant[], roleLevel: "read" | "write", out: ClientGrant[]): void {
  const own = real.filter((r) => r.source !== "request-view");
  const clamp = (level: "read" | "write") => (ORDER[roleLevel] < ORDER[level] ? roleLevel : level);
  // hasCap over the global grants alone is exactly "does the previewer hold '*' everywhere?", with
  // a global veto silencing its source and the personal lockout answering no.
  if (hasCap(own.filter((r) => (r.scopeType ?? "global") === "global"), "*", "read")) {
    out.push({ capability: "*", level: clamp("read"), scopeType: "global", scopeId: null, source: "role-preview" });
  }
  const servers = new Set(own.flatMap((r) => (r.capability === "*" && r.level !== "none" && r.scopeType === "server" && r.scopeId ? [r.scopeId] : [])));
  for (const server of servers) {
    const level = canOnServer(own, "*", server, "write") ? "write" : canOnServer(own, "*", server, "read") ? "read" : null;
    if (level) out.push({ capability: "*", level: clamp(level), scopeType: "server", scopeId: server, source: "role-preview" });
  }
}
