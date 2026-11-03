/**
 * The Moderation panel — a volley builder behind the /staff command.
 *
 * The web panel's moderation is one player, one action, one form. Discord staff work the other
 * way: something happens in a channel and three names need the same kick, or one name needs a
 * message AND a watch. So this module is a CART — pick the server, stack targets (from the live
 * roster or by id), toggle the actions, and send the whole volley at once.
 *
 * What makes it safe to hand to everyone with panel access is fire-or-file, the same rule the
 * web routes live by: each line is checked against the presser's OWN grants at send time — a
 * line they hold the write for executes through the approvals executor (same signatures, same
 * audit rows, same ban records as the web), and every line they lack lands in ONE filed request
 * for the approvals queue, card and all. Nobody is told "no"; they are told "asked".
 *
 * Execution and filing live in the approvals spine, and the spine's own guard test forbids it
 * from sitting in any import cycle — which importing `approvals.ts` from HERE would create,
 * because this file is reached through `context → plugin-host → discord-modules`. So the two
 * functions arrive as injected dependencies instead: `setModerationDeps` is called at startup by
 * `discord-moderation-wiring.ts` (imported only from the server root, outside the knot), and a
 * module pressed before wiring says "warming up" rather than crashing.
 */
import type { DiscordButton, DiscordModuleDef, DiscordModuleEvent, DiscordModuleResult, DiscordView } from "@app/plugin-sdk";
import type { ApprovalLineRow, NewApprovalLine, Repository, ServerRow } from "@app/db";
import { can, canAnywhere, type Grant } from "@app/access";
import { discordLiteral as asTyped } from "@app/shared";
import { displayNameOf, resolveAccess, type Principal } from "./auth.js";
import { readRoster } from "./discord-public.js";
import { serverByKey } from "./discord-economy.js";
import { ADMIN_ACTIONS, tempbanMaxHours } from "./routes/kit.js";
import type { StaffPartPreview } from "./discord-preview.js";

/** The two doors into the approvals spine, injected so this file never imports it (see above). */
export interface ModerationDeps {
  /** Run one line the presser's own write covers — `executeApprovedLine` with the app context
   *  already bound. Signs, audits and records exactly as an approved request line would.
   *  `banId` is the decision row a fired ban minted — the over-cap split files against it. */
  executeLine(approver: Principal, line: ApprovalLineRow, opts: { suffix?: string }): Promise<{ error: string | null; banId?: string }>;
  /** File ONE request carrying every line the presser lacks, and post its card. */
  fileVolley(requester: Principal, lines: NewApprovalLine[], note: string): Promise<{ requestId: string }>;
}

let moderationDeps: ModerationDeps | null = null;
export function setModerationDeps(deps: ModerationDeps): void { moderationDeps = deps; }

/** A cart older than this is abandoned work, not a pending decision — it prunes on next touch. */
const CART_TTL_MS = 15 * 60_000;
/** The roster re-reads after this — a picker page press must not dial the game every time. */
const ROSTER_TTL_MS = 60_000;
const MAX_TARGETS = 15;
/** targets × actions — past this a "volley" is a script, and scripts belong on the web panel. */
const MAX_LINES = 30;
const ROSTER_PAGE = 25;

/** The actions the cart can stack. Every one takes a modal so the trail always says WHY — the
 *  panel learned that lesson from a blank punish screen (see ADMIN_ACTIONS in routes/kit). */
const CART_KINDS: { kind: string; label: string; fields: ("message" | "reason" | "hours")[] }[] = [
  { kind: "message", label: "💬 Message", fields: ["message"] },
  { kind: "punish", label: "☠️ Punish", fields: ["reason"] },
  { kind: "kick", label: "👢 Kick", fields: ["reason"] },
  { kind: "tempban", label: "⏱️ Temp ban", fields: ["hours", "reason"] },
  { kind: "permaban", label: "🔨 Perma ban", fields: ["reason"] },
  { kind: "watch", label: "👁️ Watch", fields: ["reason"] },
];
const kindDef = (kind: string) => CART_KINDS.find((k) => k.kind === kind);

interface CartAct { kind: string; reason?: string; message?: string; hours?: number }
interface Cart {
  serverKey: string;
  serverName: string;
  players: { platformId: string; name: string }[];
  acts: CartAct[];
  roster: { list: { platformId: string; name: string }[]; at: number } | null;
  touched: number;
}

const keyOf = (s: ServerRow): string => s.id.replaceAll("-", "").slice(0, 8);

/** One act as a summary phrase: "⏱️ Temp ban 24h — teamkilling". */
function actLabel(a: CartAct): string {
  const def = kindDef(a.kind);
  const words = def ? def.label : a.kind;
  const detail = a.kind === "message" ? a.message : a.reason;
  return `${words}${a.kind === "tempban" ? ` ${a.hours}h` : ""}${detail ? ` — ${asTyped(detail.slice(0, 60))}` : ""}`;
}

/** The capability a line of this kind is gated by (watch is community-wide, the rest per-server). */
const capOf = (kind: string): string => (kind === "watch" ? "player.watchlist" : ADMIN_ACTIONS[kind]?.cap ?? "");

/** Would THIS presser's grants fire this kind on this server right now? */
function mayFire(grants: Grant[], kind: string, serverId: string): boolean {
  return kind === "watch"
    ? canAnywhere(grants, "player.watchlist", "write")
    : can(grants, capOf(kind), "write", { serverId });
}

/**
 * The executor takes a decided approval line; a permitted volley line IS one — decided by the
 * presser's own write, with no request behind it. `requestId` rides as undefined so the audit
 * data's JSON drops the key instead of pointing the trail at a request that never existed.
 */
function asDecidedLine(l: NewApprovalLine): ApprovalLineRow {
  return {
    id: "", requestId: undefined as unknown as string, seq: 0,
    serverId: l.serverId ?? null, capability: l.capability, kind: l.kind, payload: l.payload,
    playerId: l.playerId ?? null, playerName: l.playerName ?? null,
    state: "approved", decidedByUserId: null, decidedByName: null, decidedAt: null,
    denyReason: null, modified: null, appliedAt: null, applyError: null,
    createdAt: new Date().toISOString(),
  };
}

export function moderationModule(repo: Repository): DiscordModuleDef & StaffPartPreview {
  const carts = new Map<string, Cart>();

  const cartOf = (ev: DiscordModuleEvent): Cart | null => {
    // Prune EVERY expired cart on any touch, not just the presser's own — the map must not
    // accumulate one abandoned cart per staff member who ever opened the panel.
    for (const [who, c] of carts) if (Date.now() - c.touched > CART_TTL_MS) carts.delete(who);
    const c = carts.get(ev.discordUserId);
    if (!c) return null;
    c.touched = Date.now();
    return c;
  };

  const grantsOf = async (ev: DiscordModuleEvent) =>
    ev.staffUserId ? (await resolveAccess(repo, ev.staffUserId)).grants : [];

  /** The presser as a full Principal — what the executor and the hour-cap math both need. */
  const principalOf = async (ev: DiscordModuleEvent): Promise<Principal | null> => {
    const account = ev.staffUserId ? await repo.users.findById(ev.staffUserId) : null;
    if (!account) return null;
    const access = await resolveAccess(repo, account.id);
    return { user: account, name: displayNameOf(account), ...access };
  };

  /** Pick (or switch) the server. Only servers the presser can VIEW are offered — the same gate
   *  the web sidebar draws with. */
  const serverPick = async (ev: DiscordModuleEvent, note = ""): Promise<DiscordView> => {
    const [servers, grants] = await Promise.all([repo.servers.list(), grantsOf(ev)]);
    const visible = servers.filter((s) => can(grants, "server.view", "read", { serverId: s.id }));
    if (!visible.length) return { content: "No server your permissions can see.", rows: [] };
    return {
      content: [
        `**Moderation** — pick the server the volley targets.${note ? `\n${note}` : ""}`,
        "Then stack targets and actions, review, and send: what your permissions cover fires, the rest is filed as ONE approval request.",
      ].join("\n"),
      select: {
        customId: "srv", placeholder: "Pick a server",
        options: visible.slice(0, 25).map((s) => ({
          label: s.name.slice(0, 100), value: keyOf(s),
          description: s.engagementMode === "active" ? undefined : "observe mode (read-only)",
        })),
      },
    };
  };

  /** The cart itself — the screen every step returns to. */
  const builder = (ev: DiscordModuleEvent, note = ""): DiscordView => {
    const cart = cartOf(ev);
    if (!cart) return { content: "The cart expired — start again.", rows: [[{ label: "Start over", customId: "" }]] };
    return cartView(cart, note);
  };

  /** How a cart reads, whoever's it is. */
  const cartView = (cart: Cart, note = ""): DiscordView => {
    // Names as the players wrote them — this is Discord text, and "*ABC* Smith" is not italics.
    const names = cart.players.map((p) => asTyped(p.name || p.platformId));
    const shown = names.slice(0, 12).join(", ") + (names.length > 12 ? ` … +${names.length - 12} more` : "");
    const toggles: DiscordButton[] = CART_KINDS.map(({ kind, label }) => {
      const active = cart.acts.some((a) => a.kind === kind);
      return { label: active ? `✔ ${label}` : label, customId: `tog:${kind}`, style: active ? "success" as const : "secondary" as const };
    });
    return {
      content: [
        `**Moderation** — **${cart.serverName}**${note ? `\n${note}` : ""}`,
        `**Targets (${cart.players.length}):** ${cart.players.length ? shown : "_none yet — add from the roster or by id_"}`,
        `**Actions (${cart.acts.length}):**${cart.acts.length ? "\n" + cart.acts.map((a) => `· ${actLabel(a)}`).join("\n") : " _none yet — toggle below (each asks its reason)_"}`,
        "",
        "_Toggling an action on asks for its details; toggling again removes it. Watch is community-wide; the rest land on this server._",
      ].join("\n"),
      rows: [
        [
          { label: "Add from roster", customId: "pl", style: "primary" },
          { label: "Add by id…", customId: "addm" },
          { label: "Clear targets", customId: "drop" },
          { label: "Switch server", customId: "sw" },
        ],
        toggles.slice(0, 5),
        [
          ...toggles.slice(5),
          { label: "Review & send", customId: "rev", style: "primary" },
          { label: "Empty the cart", customId: "clr", style: "danger" },
        ],
      ],
    };
  };

  /**
   * The roster picker: one select page of the live roster, ✓ on names already in the cart.
   *
   * `mode` is about Discord's 3-second budget, not freshness taste: "force" and "fresh" may dial
   * the game and belong to DEFERRED actions only ("pl", "pg"); "cachedOnly" is what the select's
   * own handler uses — an undeferred press must render from whatever roster is in hand, stale
   * included, because a name that just left still names the right id.
   */
  const rosterPicker = async (ev: DiscordModuleEvent, page: number, mode: "force" | "fresh" | "cachedOnly"): Promise<DiscordView> => {
    const cart = cartOf(ev);
    if (!cart) return builder(ev);
    const stale = !cart.roster || Date.now() - cart.roster.at > ROSTER_TTL_MS;
    if (mode === "force" || (mode === "fresh" && stale)) {
      const server = serverByKey(await repo.servers.list(), cart.serverKey);
      if (!server) return builder(ev, "⚠️ That server is gone.");
      try {
        const list = await readRoster(repo, server);
        cart.roster = { list: list.map((r) => ({ platformId: r.platformId, name: r.name })), at: Date.now() };
      } catch (err) {
        return builder(ev, `⚠️ Couldn't read the roster — ${(err as Error).message}`);
      }
    }
    if (!cart.roster) return builder(ev);
    const list = cart.roster.list;
    const pages = Math.max(1, Math.ceil(list.length / ROSTER_PAGE));
    const p = Math.min(Math.max(page, 0), pages - 1);
    const slice = list.slice(p * ROSTER_PAGE, (p + 1) * ROSTER_PAGE);
    const inCart = new Set(cart.players.map((x) => x.platformId));
    const nav: DiscordButton[] = [];
    if (p > 0) nav.push({ label: "‹ Prev", customId: `pg:${p - 1}` });
    if (p < pages - 1) nav.push({ label: "Next ›", customId: `pg:${p + 1}` });
    nav.push({ label: "Re-read roster", customId: "pl" }, { label: "Done", customId: "b", style: "primary" });
    return {
      content: [
        `**Add targets** — **${cart.serverName}** · ${list.length} online · page ${p + 1}/${pages}`,
        `In the cart (${cart.players.length}): ${cart.players.map((x) => asTyped(x.name || x.platformId)).slice(0, 10).join(", ") || "_nobody yet_"}`,
      ].join("\n"),
      select: slice.length ? {
        customId: `padd:${p}`, placeholder: "Pick a player to add",
        options: slice.map((r) => ({
          label: `${inCart.has(r.platformId) ? "✓ " : ""}${r.name}`.slice(0, 100),
          value: r.platformId, description: r.platformId.slice(0, 100),
        })),
      } : undefined,
      rows: [nav],
    };
  };

  /** The dress rehearsal: every line named, each action marked fires ✅ or files 📨 — no surprises
   *  on Send. The grants are read HERE and again at send; both moments must tell the same story. */
  const review = async (ev: DiscordModuleEvent): Promise<DiscordView> => {
    const cart = cartOf(ev);
    if (!cart) return builder(ev);
    if (!cart.players.length || !cart.acts.length) return builder(ev, "⚠️ A volley needs at least one target and one action.");
    const lineCount = cart.players.length * cart.acts.length;
    if (lineCount > MAX_LINES) return builder(ev, `⚠️ ${lineCount} lines is past the ${MAX_LINES}-line cap — trim targets or actions (bigger jobs belong on the web panel).`);
    const [servers, principal] = await Promise.all([repo.servers.list(), principalOf(ev)]);
    const grants = principal?.grants ?? [];
    const server = serverByKey(servers, cart.serverKey);
    if (!server) return builder(ev, "⚠️ That server is gone.");
    // The over-cap split must be disclosed HERE, not discovered on Send: a 72h ask against a 24h
    // limit fires at 24h and files the rest (the web action route's own rule).
    let tempbanCap: number | null = null;
    const tb = cart.acts.find((a) => a.kind === "tempban");
    if (tb && principal && mayFire(grants, "tempban", server.id)) {
      const max = await tempbanMaxHours(repo, principal, server.id);
      if (Number.isFinite(max) && max > 0 && (tb.hours ?? 0) > max) tempbanCap = max;
    }
    const marks = cart.acts.map((a) => {
      const fires = mayFire(grants, a.kind, server.id);
      const observed = fires && a.kind !== "watch" && server.engagementMode !== "active";
      if (fires && !observed && a.kind === "tempban" && tempbanCap !== null) {
        return `✅ ${actLabel(a)} — fires at your ${tempbanCap}h limit now; the remaining hours file for approval`;
      }
      return `${observed ? "⛔" : fires ? "✅" : "📨"} ${actLabel(a)} — ${observed ? "server is in observe mode (read-only)" : fires ? "fires now, on your own permission" : "filed for approval"}`;
    });
    return {
      content: [
        `**Review** — **${cart.serverName}** · ${cart.players.length} target(s) × ${cart.acts.length} action(s) = ${lineCount} line(s)`,
        `**Targets:** ${cart.players.map((x) => asTyped(x.name || x.platformId)).join(", ")}`,
        marks.join("\n"),
        "",
        "_✅ lines execute the moment you press Send. 📨 lines become one request in the approvals queue._",
      ].join("\n"),
      rows: [[
        { label: "Send it", customId: "go", style: "danger" },
        { label: "‹ Back to the cart", customId: "b" },
      ]],
    };
  };

  /** Presses whose volley is firing right now — see the claim in `execute`. */
  const sending = new Set<string>();
  const alreadySending = (): DiscordView => ({
    content: "That volley is already on its way — its results show on the panel that sent it.",
    rows: [[{ label: "New volley", customId: "", style: "primary" }]],
  });

  /** Send: fire what the presser's grants cover, collect the rest into one filed request. */
  const execute = async (ev: DiscordModuleEvent): Promise<DiscordView> => {
    const deps = moderationDeps;
    if (!deps) return { content: "The moderation panel isn't fully wired yet — try again in a moment.", rows: [[{ label: "Start over", customId: "" }]] };
    const cart = cartOf(ev);
    if (!cart) return sending.has(ev.discordUserId) ? alreadySending() : builder(ev);
    if (!cart.players.length || !cart.acts.length) return builder(ev, "⚠️ A volley needs at least one target and one action.");
    if (cart.players.length * cart.acts.length > MAX_LINES) return review(ev);
    const principal = await principalOf(ev);
    if (!principal) return { content: "Your panel account has vanished — nothing was sent.", rows: [] };
    const server = serverByKey(await repo.servers.list(), cart.serverKey);
    if (!server) return builder(ev, "⚠️ That server is gone — nothing was sent.");

    // The cart is spent the moment it starts firing, not when it finishes. A volley takes as long
    // as its slowest game command, and a Send pressed meanwhile on another open panel found the
    // cart still there and fired every line again — each kick, ban and message twice, and a second
    // request filed. Taken here, with no await since the check, so exactly one press sends it.
    if (carts.get(ev.discordUserId) !== cart) return alreadySending();
    carts.delete(ev.discordUserId);
    sending.add(ev.discordUserId);
    try {
      const results: string[] = [];
      const toFile: NewApprovalLine[] = [];
      for (const act of cart.acts) {
        /*
         * THE SPLIT, the web action route's own rule (routes/servers.ts): a temp ban past the
         * presser's hour cap fires AT THE CAP — that much was always theirs to give — and the
         * remainder files as a tempban_extend against the decision row the fire mints, so approval
         * grows the same sentence instead of stacking a second ban. Before this, the cart was the
         * one surface that answered an over-cap ask with a flat refusal.
         */
        let capHours: number | null = null;
        if (act.kind === "tempban" && mayFire(principal.grants, "tempban", server.id)) {
          const max = await tempbanMaxHours(repo, principal, server.id);
          if (Number.isFinite(max) && max > 0 && (act.hours ?? 0) > max) capHours = max;
        }
        for (const target of cart.players) {
          const who = asTyped(target.name || target.platformId);
          const tag = actLabel({ ...act, message: undefined, reason: undefined });
          if (act.kind === "watch") {
            // A watch is a fact about a PERSON, community-wide — it needs their profile row, which
            // exists once the panel has seen them; a brand-new name may not have one yet.
            const profile = await repo.players.findByPlatformId(target.platformId).catch(() => null);
            if (!profile) { results.push(`⚠️ ${tag} **${who}** — no profile on record yet, add the watch from the web panel once they've been seen`); continue; }
            const line: NewApprovalLine = {
              serverId: null, capability: "player.watchlist", kind: "watch",
              payload: { playerDbId: profile.id, playerId: profile.platformId, playerName: profile.name, reason: act.reason },
              playerId: profile.platformId, playerName: profile.name,
            };
            if (!canAnywhere(principal.grants, "player.watchlist", "write")) { toFile.push(line); results.push(`📨 ${tag} **${who}** — filed`); continue; }
            const { error } = await deps.executeLine(principal, asDecidedLine(line), { suffix: " (via Discord panel)" });
            results.push(error ? `⛔ ${tag} **${who}** — ${error}` : `✅ ${tag} **${who}**`);
            continue;
          }
          // capHours is only ever set on the PERMITTED path, so a filed line always carries the
          // full requested hours — the ask, not the presser's ceiling.
          const fireHours = act.kind === "tempban" && capHours !== null ? capHours : act.hours;
          const line: NewApprovalLine = {
            serverId: server.id, capability: capOf(act.kind), kind: act.kind,
            payload: {
              playerId: target.platformId, playerName: target.name || null,
              reason: act.reason, message: act.message,
              ...(act.kind === "tempban" ? { hours: fireHours } : {}),
            },
            playerId: target.platformId, playerName: target.name || null,
          };
          if (!mayFire(principal.grants, act.kind, server.id)) { toFile.push(line); results.push(`📨 ${tag} **${who}** — filed`); continue; }
          // The permitted path honors observe mode exactly like the web action route's 409 —
          // holding the write is not a way around a server someone deliberately set read-only.
          if (server.engagementMode !== "active") { results.push(`⛔ ${tag} **${who}** — server is in observe mode (read-only)`); continue; }
          const { error, banId } = await deps.executeLine(principal, asDecidedLine(line), { suffix: " (via Discord panel)" });
          if (error) { results.push(`⛔ ${tag} **${who}** — ${error}`); continue; }
          if (act.kind === "tempban" && capHours !== null) {
            if (banId) {
              toFile.push({
                serverId: server.id, capability: "action.tempban", kind: "tempban_extend",
                payload: {
                  playerId: target.platformId, playerName: target.name || null,
                  reason: act.reason || undefined,
                  hours: act.hours, appliedHours: capHours,
                  banStart: new Date().toISOString(), banDecisionId: banId,
                },
                playerId: target.platformId, playerName: target.name || null,
              });
              results.push(`✅ ${tag} **${who}** — ${capHours}h applied (your limit); the rest is filed as an extension`);
            } else {
              // The fire recorded no decision row to hang the remainder on — say so instead of
              // filing an extension that could never apply.
              results.push(`✅ ${tag} **${who}** — ${capHours}h applied (your limit); ask for the extension from the web panel`);
            }
            continue;
          }
          results.push(`✅ ${tag} **${who}**`);
        }
      }
      if (toFile.length) {
        await deps.fileVolley(principal, toFile, `Discord moderation panel — ${server.name}`);
        results.push("", `📨 **One request filed** with ${toFile.length} line(s) — it's in the approvals queue for someone who holds the write.`);
      }
      return {
        content: [`**Sent** — **${server.name}**`, ...results].join("\n").slice(0, 1900),
        rows: [[{ label: "New volley", customId: "", style: "primary" }]],
      };
    } finally {
      sending.delete(ev.discordUserId);
    }
  };

  const open = async (ev: DiscordModuleEvent): Promise<DiscordModuleResult> =>
    cartOf(ev) ? builder(ev) : serverPick(ev);

  /** One server's cart for the panel's drawing of this panel (Help's Discord walkthrough): what
   *  picking it here shows — an empty cart, kept nowhere, so nobody's cart in Discord is started or
   *  touched. */
  const serverScreen = async (ev: DiscordModuleEvent, key: string): Promise<DiscordView> => {
    const server = serverByKey(await repo.servers.list(), key);
    if (!server) return serverPick(ev, "⚠️ That server is gone or ambiguous.");
    if (!can(await grantsOf(ev), "server.view", "read", { serverId: server.id })) return serverPick(ev, "⚠️ Your permissions don't reach that server.");
    return cartView({ serverKey: keyOf(server), serverName: server.name, players: [], acts: [], roster: null, touched: 0 });
  };

  const action = async (ev: DiscordModuleEvent): Promise<DiscordModuleResult> => {
    switch (ev.action) {
        case "srv": {
          const key = ev.selected?.[0] ?? "";
          const server = serverByKey(await repo.servers.list(), key);
          if (!server) return serverPick(ev, "⚠️ That server is gone or ambiguous.");
          if (!can(await grantsOf(ev), "server.view", "read", { serverId: server.id })) return serverPick(ev, "⚠️ Your permissions don't reach that server.");
          carts.set(ev.discordUserId, { serverKey: keyOf(server), serverName: server.name, players: [], acts: [], roster: null, touched: Date.now() });
          return builder(ev);
        }
        case "sw": return serverPick(ev, "_Picking a server starts a fresh cart._");
        case "pl": return rosterPicker(ev, 0, "force");
        case "pg": return rosterPicker(ev, Number(ev.state) || 0, "fresh");
        case "padd": {
          const cart = cartOf(ev);
          if (!cart) return builder(ev);
          const platformId = ev.selected?.[0] ?? "";
          if (cart.players.length >= MAX_TARGETS) return builder(ev, `⚠️ The cart holds at most ${MAX_TARGETS} targets.`);
          if (platformId && !cart.players.some((x) => x.platformId === platformId)) {
            const name = cart.roster?.list.find((r) => r.platformId === platformId)?.name ?? "";
            cart.players.push({ platformId, name });
          }
          return rosterPicker(ev, Number(ev.state) || 0, "cachedOnly");
        }
        case "addm": {
          if (!cartOf(ev)) return builder(ev);
          return { modal: { title: "Add a target by id", action: "addid", fields: [
            { id: "pid", label: "Player id (Steam64 or gamertag id)", maxLength: 64 },
          ] } };
        }
        case "addid": {
          const cart = cartOf(ev);
          if (!cart) return builder(ev);
          const platformId = (ev.values?.pid ?? "").trim();
          if (!/^[A-Za-z0-9_.:-]{3,64}$/.test(platformId)) return builder(ev, "⚠️ That doesn't look like a player id — nothing was added.");
          if (cart.players.length >= MAX_TARGETS) return builder(ev, `⚠️ The cart holds at most ${MAX_TARGETS} targets.`);
          if (!cart.players.some((x) => x.platformId === platformId)) {
            const known = await repo.players.findByPlatformId(platformId).catch(() => null);
            cart.players.push({ platformId, name: known?.name ?? "" });
          }
          return builder(ev);
        }
        case "drop": {
          const cart = cartOf(ev);
          if (cart) cart.players = [];
          return builder(ev);
        }
        case "clr": {
          carts.delete(ev.discordUserId);
          return serverPick(ev, "_Cart emptied._");
        }
        case "tog": {
          const cart = cartOf(ev);
          if (!cart) return builder(ev);
          const def = kindDef(ev.state);
          if (!def) return builder(ev);
          if (cart.acts.some((a) => a.kind === def.kind)) {
            cart.acts = cart.acts.filter((a) => a.kind !== def.kind);
            return builder(ev);
          }
          if (cart.acts.length >= CART_KINDS.length) return builder(ev);
          return { modal: { title: `${def.label.replace(/^[^ ]+ /, "")} — details`.slice(0, 45), action: "det", state: def.kind, fields: [
            ...(def.fields.includes("hours") ? [{ id: "hours", label: "Hours (whole number)", placeholder: "24", maxLength: 5 }] : []),
            ...(def.fields.includes("reason") ? [{ id: "reason", label: "Reason (the player and the trail see it)", maxLength: 300 }] : []),
            ...(def.fields.includes("message") ? [{ id: "message", label: "Message to send", maxLength: 300 }] : []),
          ] } };
        }
        case "det": {
          const cart = cartOf(ev);
          if (!cart) return builder(ev);
          const def = kindDef(ev.state);
          if (!def || cart.acts.some((a) => a.kind === def.kind)) return builder(ev);
          const act: CartAct = { kind: def.kind };
          if (def.fields.includes("reason")) act.reason = (ev.values?.reason ?? "").trim().slice(0, 300);
          if (def.fields.includes("message")) act.message = (ev.values?.message ?? "").trim().slice(0, 300);
          if (def.fields.includes("hours")) {
            const hours = Number((ev.values?.hours ?? "").trim());
            if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 365) return builder(ev, "⚠️ Hours must be a whole number between 1 and 8760 — the action wasn't added.");
            act.hours = hours;
          }
          if ((def.fields.includes("reason") && !act.reason) || (def.fields.includes("message") && !act.message)) {
            return builder(ev, "⚠️ A blank reason explains nothing — the action wasn't added.");
          }
          cart.acts.push(act);
          return builder(ev);
        }
        case "rev": return review(ev);
        case "go": return execute(ev);
        case "b": return builder(ev);
        default: return open(ev);
    }
  };

  return {
    id: "moderation",
    label: "Moderation",
    description: "Kick, ban, message and watch players — volleys that fire on your permissions or file as requests.",
    capability: "server.view",
    capabilityLevel: "read",
    // The slow steps only: roster reads and the send dial the game. Everything that can open a
    // modal (tog, addm) MUST stay undeferred — a modal is only accepted as the first response.
    deferActions: ["pl", "pg", "go"],
    open,
    action,
    serverScreen,
  };
}
