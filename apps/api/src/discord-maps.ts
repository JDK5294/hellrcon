/**
 * Maps & vote on the staff panel — the map room, one server at a time.
 *
 * Pick a server and its round is one card: what's playing, what the rotation serves next, and
 * what the automated vote is doing. Under it, the writes staff actually reach for from Discord:
 * change the map NOW (round ends, everybody reloads — so it confirms first), queue the next map,
 * walk the five objective sectors, and drive the live vote (pause/resume, skip, re-roll, start).
 *
 * The map writes are the SAME implementations the web routes run (map-actions.ts) — the accepted-
 * list dance, the staging, the verification and the audit rows all live there once. The vote
 * controls mirror their routes' one-line patchState + audit exactly. Every write button is gated
 * per press by the presser's own grants (`maps.next` / `mapvote.control` on THAT server), and
 * observe mode blocks the game-touching ones with the web's own words.
 */
import type { DiscordButton, DiscordModuleDef, DiscordModuleEvent, DiscordModuleResult, DiscordView } from "@app/plugin-sdk";
import type { Repository, ServerRow } from "@app/db";
import { can } from "@app/access";
import { stateReaderFor } from "@app/games";
import { normalizeSession } from "@app/rcon-core";
import { describeMap, zoneKeyOf } from "@app/maps";
import { displayNameOf, resolveAccess } from "./auth.js";
import { serverByKey } from "./discord-economy.js";
import { connectGameClient, gameClientFor } from "./routes/kit.js";
import { applyObjectives, changeMapNow, clearStoredLayout, parseStoredLayouts, readObjectivesLive, setNextMapNow, type MapActor } from "./map-actions.js";
import type { StaffPartPreview } from "./discord-preview.js";

const MAP_PAGE = 25;

const keyOf = (s: ServerRow): string => s.id.replaceAll("-", "").slice(0, 8);

/** `<key>` then colon-joined extras — every screen after the pick carries the server. */
function parts(state: string): string[] { return state.split(":"); }

const pretty = (mapId: string): string => describeMap(mapId).prettyName;

export function mapsModule(repo: Repository): DiscordModuleDef & StaffPartPreview {
  const grantsOf = async (ev: DiscordModuleEvent) =>
    ev.staffUserId ? (await resolveAccess(repo, ev.staffUserId)).grants : [];

  /** The presser as the person every audit row names — their PANEL account, never the Discord id. */
  const actorOf = async (ev: DiscordModuleEvent): Promise<MapActor | null> => {
    const account = ev.staffUserId ? await repo.users.findById(ev.staffUserId) : null;
    return account ? { userId: account.id, name: displayNameOf(account) } : null;
  };

  const serverOf = async (key: string): Promise<ServerRow | null> => serverByKey(await repo.servers.list(), key);

  const serverPick = async (ev: DiscordModuleEvent, note = ""): Promise<DiscordView> => {
    const [servers, grants] = await Promise.all([repo.servers.list(), grantsOf(ev)]);
    const visible = servers.filter((s) => can(grants, "server.view", "read", { serverId: s.id }));
    if (!visible.length) return { content: "No server your permissions can see.", rows: [] };
    return {
      content: `**Maps & vote** — pick a server.${note ? `\n${note}` : ""}`,
      select: {
        customId: "srv", placeholder: "Pick a server",
        options: visible.slice(0, 25).map((s) => ({
          label: s.name.slice(0, 100), value: keyOf(s),
          description: s.engagementMode === "active" ? s.game : `${s.game} · observe mode (read-only)`,
        })),
      },
    };
  };

  /** The server's map card: round, rotation, vote — and the writes the presser's grants allow. */
  const hub = async (ev: DiscordModuleEvent, key: string, note = ""): Promise<DiscordView> => {
    const server = await serverOf(key);
    if (!server) return serverPick(ev, "⚠️ That server is gone or ambiguous.");
    const grants = await grantsOf(ev);
    const lines: string[] = [`**Maps & vote** — **${server.name}**${server.engagementMode === "active" ? "" : " · ⚠️ observe mode (read-only)"}${note ? `\n${note}` : ""}`];

    // One dial for the whole card; a server that's down still renders (the vote half is ours).
    try {
      const client = gameClientFor(server);
      try {
        await connectGameClient(client, server);
        const session = normalizeSession(await client.readState("session").catch(() => null));
        const rot = stateReaderFor(server.game).rotation(await client.readState("maprotation"));
        const current = session.mapId || rot.maps[rot.currentIndex] || "";
        const next = rot.maps.length ? rot.maps[(rot.currentIndex + 1) % rot.maps.length] : null;
        lines.push(
          `**Current map:** ${current ? pretty(current) : session.mapName || "?"}${session.playerCount != null ? ` · ${session.playerCount} player(s)` : ""}`,
          `**Next in rotation:** ${next ? pretty(next) : "_rotation is empty_"} (${rot.maps.length} map(s) in rotation)`,
        );
        // Vietnam STORES layouts per map — the panel shows whether one stands, so this card must
        // too, or the "Clear saved layout…" door below is a button into the dark. Same read and
        // the same match rule as the web objectives GET, on the connection already open.
        if (server.game === "hllv" && session.mapId) {
          const stored = parseStoredLayouts(await client.execute("getObjectives").catch(() => null))
            .find((e) => e.mapId.toLowerCase() === session.mapId!.toLowerCase());
          if (stored) {
            const expiry = await repo.layoutExpiries.get(server.id, session.mapId);
            lines.push(`**Saved objective layout (current map):** standing — ${expiry ? `next ${expiry.playsLeft} play(s), then back to random` : "until cleared"}`);
          }
        }
      } finally {
        await client.disconnect().catch(() => {});
      }
    } catch (err) {
      lines.push(`**Current map:** ⚠️ could not reach the server — ${(err as Error).message}`);
    }

    const [cfg, st] = await Promise.all([repo.mapVote.getConfig(server.id), repo.mapVote.getState(server.id)]);
    const votes = (st?.tallies ?? []).reduce((a, b) => a + b, 0);
    lines.push(!cfg?.enabled
      ? "**Map vote:** not enabled on this server"
      : st?.paused
        ? `**Map vote:** ⏸ paused${st.pauseReason === "staff" ? " by staff" : " (server below the player floor)"}`
        : st?.activeMessageId
          ? `**Map vote:** 🗳 open — ${st.options.length} option(s), ${votes} vote(s) so far`
          : "**Map vote:** idle (opens on the worker's schedule)");
    if (st?.overrideMapId) lines.push(`**Override standing:** next map is forced to ${pretty(st.overrideMapId)}`);

    const rows: DiscordButton[][] = [];
    if (can(grants, "maps.next", "write", { serverId: server.id })) {
      rows.push([
        { label: "Change map now…", customId: `mp:${key}:c:0`, style: "danger" },
        { label: "Set next map…", customId: `mp:${key}:n:0`, style: "primary" },
        { label: "Objectives…", customId: `ob:${key}` },
        // Only Vietnam STORES layouts (docs/hll-vietnam.md p11) — a WW2 hub has nothing to clear,
        // so the door does not exist there rather than existing and refusing.
        ...(server.game === "hllv" ? [{ label: "Clear saved layout…", customId: `obc:${key}` }] : []),
      ]);
    }
    if (cfg?.enabled && can(grants, "mapvote.control", "write", { serverId: server.id })) {
      rows.push([
        st?.paused && st.pauseReason === "staff"
          ? { label: "▶ Resume vote", customId: `vp:${key}:0`, style: "success" }
          : { label: "⏸ Pause vote", customId: `vp:${key}:1` },
        { label: "⏭ Skip current", customId: `vs:${key}` },
        { label: "🎲 Re-roll options", customId: `vr:${key}` },
        { label: "🚀 Start a vote now", customId: `vn:${key}` },
      ]);
    }
    rows.push([
      { label: "Refresh", customId: `hub:${key}` },
      { label: "All servers", customId: "" },
    ]);
    return { content: lines.join("\n"), rows };
  };

  /** The shared map picker: the rotation first (marked ↻ — those switch cleanly), then the rest
   *  of the installable catalogue, one select page at a time. */
  const mapPicker = async (ev: DiscordModuleEvent, key: string, verb: "c" | "n", page: number): Promise<DiscordView> => {
    const server = await serverOf(key);
    if (!server) return serverPick(ev, "⚠️ That server is gone.");
    const client = gameClientFor(server);
    let rotation: string[];
    let catalogue: string[];
    try {
      await connectGameClient(client, server);
      const reader = stateReaderFor(server.game);
      rotation = reader.rotation(await client.readState("maprotation")).maps;
      catalogue = reader.mapCatalogue(await client.execute("getMapReferenceList").catch(() => null));
    } catch (err) {
      return hub(ev, key, `⚠️ Couldn't read the map list — ${(err as Error).message}`);
    } finally {
      await client.disconnect().catch(() => {});
    }
    const inRotation = new Set(rotation.map((m) => m.toLowerCase()));
    const ordered = [...rotation, ...catalogue.filter((m) => !inRotation.has(m.toLowerCase())).sort()];
    if (!ordered.length) return hub(ev, key, "⚠️ The server answered with no maps at all.");
    const pages = Math.max(1, Math.ceil(ordered.length / MAP_PAGE));
    const p = Math.min(Math.max(page, 0), pages - 1);
    const nav: DiscordButton[] = [];
    if (p > 0) nav.push({ label: "‹ Prev", customId: `mp:${key}:${verb}:${p - 1}` });
    if (p < pages - 1) nav.push({ label: "Next ›", customId: `mp:${key}:${verb}:${p + 1}` });
    nav.push({ label: "Type a map id…", customId: `mpm:${key}:${verb}` }, { label: "‹ Server", customId: `hub:${key}` });
    return {
      content: [
        `**${verb === "c" ? "Change map now" : "Set next map"}** — **${server.name}** · ${ordered.length} map(s) · page ${p + 1}/${pages}`,
        "↻ marks maps already in the rotation.",
      ].join("\n"),
      select: {
        customId: `mps:${key}:${verb}:${p}`, placeholder: "Pick a map",
        options: ordered.slice(p * MAP_PAGE, (p + 1) * MAP_PAGE).map((m) => ({
          label: `${inRotation.has(m.toLowerCase()) ? "↻ " : ""}${pretty(m)}`.slice(0, 100),
          value: m, description: m.slice(0, 100),
        })),
      },
      rows: [nav],
    };
  };

  /** The consent screen. Changing NOW ends the round in front of everybody — it is never one press. */
  const confirmMap = (key: string, verb: "c" | "n", mapId: string, serverName: string, backPage: number): DiscordView => ({
    content: verb === "c"
      ? [
          `**Change map now** — **${serverName}**`,
          `Switch to **${pretty(mapId)}** (\`${mapId}\`) immediately. **The round in progress ends and everybody reloads.**`,
          "If the map isn't in the rotation it is added first (staged) — that's what this build needs for the switch to take.",
        ].join("\n")
      : [
          `**Set next map** — **${serverName}**`,
          `Queue **${pretty(mapId)}** (\`${mapId}\`) to play after the current round. The round in progress is left alone.`,
        ].join("\n"),
    rows: [[
      verb === "c"
        ? { label: "Change it now", customId: `cma:${key}:${mapId}`, style: "danger" }
        : { label: "Queue it", customId: `nma:${key}:${mapId}`, style: "primary" },
      { label: "‹ Back to the list", customId: `mp:${key}:${verb}:${backPage}` },
      { label: "‹ Server", customId: `hub:${key}` },
    ]],
  });

  /** Guard shared by every write: the grant on THIS server, re-read at press time, and the
   *  engagement mode for anything that touches the game. */
  const refuseWrite = async (ev: DiscordModuleEvent, server: ServerRow, cap: string, touchesGame: boolean): Promise<string | null> => {
    if (!can(await grantsOf(ev), cap, "write", { serverId: server.id })) return `⛔ You don't hold ${cap} on ${server.name}.`;
    if (touchesGame && server.engagementMode !== "active") return "⛔ server is in observe mode (read-only)";
    return null;
  };

  const applyMap = async (ev: DiscordModuleEvent, key: string, verb: "c" | "n", mapId: string): Promise<DiscordView> => {
    const server = await serverOf(key);
    if (!server) return serverPick(ev, "⚠️ That server is gone.");
    const refusal = await refuseWrite(ev, server, "maps.next", true);
    if (refusal) return hub(ev, key, refusal);
    const actor = await actorOf(ev);
    if (!actor) return hub(ev, key, "⛔ Your panel account has vanished.");
    try {
      if (verb === "n") {
        const { pretty: name, voteHoldUntil } = await setNextMapNow(repo, actor, server, mapId);
        return hub(ev, key, `✅ **${name}** plays after this round.` +
          (voteHoldUntil ? "\n🗳️ Map voting stands down for 5 minutes so it can't re-queue its own pick — pause it if this should stick longer." : ""));
      }
      const out = await changeMapNow(repo, actor, server, mapId, true);
      if ("refusal" in out) return hub(ev, key, `⛔ ${out.refusal}`);
      return hub(ev, key, [
        `✅ Told the server to load **${out.pretty}** now${out.staged ? " (added to the rotation first)" : ""}.`,
        out.verified ? "The switch is confirmed." : "The switch takes a load screen — refresh in a moment to see it land.",
        out.listed ? "" : "⚠️ The server's own change list still doesn't show it, so watch that it actually flips.",
        out.voteHoldUntil ? "🗳️ Map voting stands down for 5 minutes so it can't override this — pause it if the change should stick longer." : "",
      ].filter(Boolean).join("\n"));
    } catch (err) {
      return hub(ev, key, `⛔ ${(err as Error).message}`);
    }
  };

  /** One sector at a time: the walk carries picks as row INDICES ('r' = random) so five long
   *  objective names never have to fit in a custom_id. */
  const sectorStep = async (ev: DiscordModuleEvent, key: string, n: number, acc: string): Promise<DiscordView> => {
    const server = await serverOf(key);
    if (!server) return serverPick(ev, "⚠️ That server is gone.");
    // State validation FIRST, before the game is dialed: the sector counter and the accumulator
    // both ride the custom_id, and a forged counter (-7, 99) walked past the bounded accumulator
    // into rows[n] — undefined.map, a TypeError in the failure banner. 0–4 are the pick steps,
    // 5 is the review; anything else never came from our buttons.
    if (!Number.isInteger(n) || n < 0 || n > 5) return hub(ev, key, "⚠️ That objectives walk went stale — start it again.");
    if (!/^[0-9r]{0,5}$/.test(acc)) return hub(ev, key, "⚠️ That objectives walk went stale — start it again.");
    let rows: string[][];
    let mapId: string;
    try {
      ({ rows, mapId } = await readObjectivesLive(server));
    } catch (err) {
      return hub(ev, key, `⛔ ${(err as Error).message}`);
    }
    if (rows.length !== 5) return hub(ev, key, "⚠️ The server did not return the five objective rows (is a match loading?).");
    // The staff-taught location layer: Vietnam's wire names its options "0/1/2", so the label a
    // moderator reads is the taught name where one exists — the WIRE string still travels in the
    // select value, because it is what applyObjectives validates against.
    const mapKey = zoneKeyOf(mapId);
    const points = mapKey ? await repo.objectivePoints.forMap(server.game, mapKey) : [];
    const optionName = (wire: string, i: number, j: number) =>
      /^\d+$/.test(wire) ? points.find((pt) => pt.row === i && pt.idx === j)?.name ?? `Option ${j + 1}` : wire;
    // (`rows[i]` stays optional-chained below: the accumulator is bounded above, but the digits
    // inside it are still attacker-chosen and may point past the grid.)
    const pickName = (ch: string, i: number) => {
      if (ch === "r") return "🎲 random";
      const wire = rows[i]?.[Number(ch)];
      return wire === undefined ? "?" : optionName(wire, i, Number(ch));
    };
    if (n >= 5) {
      const chosen = acc.split("").map(pickName);
      const content = [
        `**Objectives** — **${server.name}** · review`,
        ...chosen.map((c, i) => `Sector ${i + 1}: **${c}**`),
        server.game === "hllv"
          ? "_Saves this layout for the map. Pick below how long it stands — the game itself keeps it forever, so a play limit is enforced by this app's worker. Picks are re-checked against the live grid on apply._"
          : "_Applies to the round in play — the game restarts the round to take the layout. Picks are re-checked against the live grid on apply._",
      ].join("\n");
      // On Vietnam the apply control IS the duration choice (the select is the consent, the same
      // pattern as VIP revoke); WW2 stores nothing, so it keeps its one plain Apply button.
      if (server.game === "hllv") {
        return {
          content,
          select: {
            customId: `oba:${key}:${acc}`, placeholder: "Apply the layout — and keep it for…",
            options: [
              { label: "Apply — keep until cleared", value: "0" },
              { label: "Apply — next play only", value: "1" },
              { label: "Apply — next 3 plays", value: "3" },
              { label: "Apply — next 5 plays", value: "5" },
              { label: "Apply — next 10 plays", value: "10" },
            ],
          },
          rows: [[{ label: "Start over", customId: `ob:${key}` }, { label: "‹ Server", customId: `hub:${key}` }]],
        };
      }
      return {
        content,
        rows: [[
          { label: "Apply the layout", customId: `oba:${key}:${acc}`, style: "primary" },
          { label: "Start over", customId: `ob:${key}` },
          { label: "‹ Server", customId: `hub:${key}` },
        ]],
      };
    }
    const done = acc.split("").map((ch, i) => `Sector ${i + 1}: ${pickName(ch, i)}`);
    return {
      content: [
        `**Objectives** — **${server.name}** · sector ${n + 1} of 5`,
        ...done,
      ].join("\n"),
      select: {
        customId: `obs:${key}:${n}:${acc}`, placeholder: `Pick sector ${n + 1}'s objective`,
        options: [
          ...rows[n]!.map((name, i) => ({ label: optionName(name, n, i).slice(0, 100), value: String(i) })),
          { label: "🎲 Random", value: "r" },
        ],
      },
      rows: [[{ label: "Start over", customId: `ob:${key}` }, { label: "‹ Server", customId: `hub:${key}` }]],
    };
  };

  const applySectors = async (ev: DiscordModuleEvent, key: string, acc: string, keepRaw: string): Promise<DiscordView> => {
    const server = await serverOf(key);
    if (!server) return serverPick(ev, "⚠️ That server is gone.");
    const refusal = await refuseWrite(ev, server, "maps.next", true);
    if (refusal) return hub(ev, key, refusal);
    const actor = await actorOf(ev);
    if (!actor) return hub(ev, key, "⛔ Your panel account has vanished.");
    if (!/^[0-9r]{5}$/.test(acc)) return hub(ev, key, "⚠️ That objectives walk went stale — start it again.");
    // The keep duration rides a select VALUE, which is as attacker-influenceable as any state:
    // garbage or an out-of-range count refuses, never a countdown nobody chose.
    if (!/^\d{0,2}$/.test(keepRaw)) return hub(ev, key, "⚠️ That objectives walk went stale — start it again.");
    const keepPlays = server.game === "hllv" && Number(keepRaw) >= 1 ? Number(keepRaw) : null;
    try {
      // Indices → names against the grid as it stands NOW; applyObjectives re-validates the names
      // against the same read, so a map change mid-walk surfaces as its refusal, not a mis-fire.
      const { rows, mapId } = await readObjectivesLive(server);
      if (rows.length !== 5) return hub(ev, key, "⚠️ The server did not return the five objective rows (is a match loading?).");
      const wanted = acc.split("").map((ch, i) => (ch === "r" ? "random" : rows[i]![Number(ch)] ?? ""));
      if (wanted.some((w) => w === "")) return hub(ev, key, "⚠️ The objective grid changed under the walk — start it again.");
      const out = await applyObjectives(repo, actor, server, wanted, { keepPlays });
      if ("refusal" in out) return hub(ev, key, `⛔ ${out.refusal}`);
      // The confirmation reads like the review screen did: the taught name where the wire gives
      // only a digit (Vietnam), the wire name everywhere else — and it says what really
      // happened, which on Vietnam is a SAVE, not a one-round set.
      const mapKey = zoneKeyOf(mapId);
      const points = mapKey ? await repo.objectivePoints.forMap(server.game, mapKey) : [];
      const label = (o: string, i: number) => {
        if (!/^\d+$/.test(o)) return o;
        const j = rows[i]!.indexOf(o);
        return points.find((pt) => pt.row === i && pt.idx === j)?.name ?? `Option ${j + 1}`;
      };
      const set = out.objectives.map(label).join(" / ");
      return hub(ev, key, server.game === "hllv"
        ? `✅ Layout saved for ${keepPlays ? `the next ${keepPlays} play(s) of this map` : "this map, until it is cleared"}: ${set}`
        : `✅ Objectives set: ${set}`);
    } catch (err) {
      return hub(ev, key, `⛔ ${(err as Error).message}`);
    }
  };

  /** Clear a Vietnam map's SAVED layout — the same shared core, refusal wording and audit row as
   *  the web route, because a layout that re-applies forever needs its exit on every surface
   *  that offers its entrance. */
  const clearLayout = async (ev: DiscordModuleEvent, key: string): Promise<DiscordView> => {
    const server = await serverOf(key);
    if (!server) return serverPick(ev, "⚠️ That server is gone.");
    const refusal = await refuseWrite(ev, server, "maps.next", true);
    if (refusal) return hub(ev, key, refusal);
    const actor = await actorOf(ev);
    if (!actor) return hub(ev, key, "⛔ Your panel account has vanished.");
    try {
      const out = await clearStoredLayout(repo, actor, server, "");
      if ("refusal" in out) return hub(ev, key, `⛔ ${out.refusal}`);
      return hub(ev, key, `✅ Saved layout cleared for ${pretty(out.mapId)} — the server picks its own objectives for that map again.`);
    } catch (err) {
      return hub(ev, key, `⛔ ${(err as Error).message}`);
    }
  };

  /** The vote controls — the same patchState + audit their web routes write, word for word. */
  const voteControl = async (ev: DiscordModuleEvent, key: string, kind: "vp" | "vs" | "vr" | "vn", arg: string): Promise<DiscordView> => {
    const server = await serverOf(key);
    if (!server) return serverPick(ev, "⚠️ That server is gone.");
    const refusal = await refuseWrite(ev, server, "mapvote.control", false);
    if (refusal) return hub(ev, key, refusal);
    const actor = await actorOf(ev);
    if (!actor) return hub(ev, key, "⛔ Your panel account has vanished.");
    const audit = (action: string, summary: string, data?: Record<string, unknown>) => repo.audit.create({
      actorUserId: actor.userId, actorName: actor.name, action,
      targetType: "server", targetId: server.id, targetName: server.name, serverId: server.id, summary, data,
    });
    if (kind === "vp") {
      const paused = arg === "1";
      await repo.mapVote.patchState(server.id, { paused, pauseReason: paused ? "staff" : null });
      await audit("mapvote.pause", `${paused ? "paused" : "resumed"} the map vote on ${server.name}`);
      return hub(ev, key, paused ? "✅ Vote paused — it stays paused until staff resumes it." : "✅ Vote resumed.");
    }
    if (kind === "vs") {
      await repo.mapVote.patchState(server.id, { skipNext: true });
      await audit("mapvote.skip", `skipped the current map vote on ${server.name}`);
      return hub(ev, key, "✅ The worker will close the open poll without applying a winner.");
    }
    if (kind === "vr") {
      await repo.mapVote.patchState(server.id, { reroll: true });
      await audit("mapvote.reroll", `re-rolled the map vote options on ${server.name}`);
      return hub(ev, key, "✅ The worker will put up fresh options on its next pass.");
    }
    await repo.mapVote.patchState(server.id, {
      startNow: true, paused: false, pauseReason: null, overrideMapId: null,
      skipNext: false, reroll: false, reopenAt: null,
    });
    await audit("mapvote.start", `started a new map vote on ${server.name}`);
    return hub(ev, key, "✅ Everything standing is cleared — a brand-new vote opens on the worker's next pass.");
  };

  const open = async (ev: DiscordModuleEvent): Promise<DiscordModuleResult> => serverPick(ev);

  /** One server's card for the panel's drawing of this panel (Help's Discord walkthrough): what
   *  picking it here shows, its round read from the game as the card always reads it. Nothing is
   *  changed. */
  const serverScreen = async (ev: DiscordModuleEvent, key: string): Promise<DiscordView> => {
    const server = await serverOf(key);
    if (!server || !can(await grantsOf(ev), "server.view", "read", { serverId: server.id })) return serverPick(ev, "⚠️ That server is gone, or your permissions don't reach it.");
    return hub(ev, key);
  };

  const action = async (ev: DiscordModuleEvent): Promise<DiscordModuleResult> => {
    const st = parts(ev.state);
    switch (ev.action) {
      case "srv": return hub(ev, ev.selected?.[0] ?? "");
      case "hub": return hub(ev, st[0] ?? "");
      case "mp": return mapPicker(ev, st[0] ?? "", st[1] === "n" ? "n" : "c", Number(st[2]) || 0);
      case "mps": {
        const server = await serverOf(st[0] ?? "");
        if (!server) return serverPick(ev, "⚠️ That server is gone.");
        const mapId = ev.selected?.[0] ?? "";
        // An empty selection (a retried interaction with no values) must not mint a confirm
        // screen whose button would ask the game for map "". No hub here — this handler is
        // undeferred and the hub dials the game; hand back a door instead.
        if (!mapId) return { content: "Nothing was picked — open the list again.", rows: [[{ label: "‹ Server", customId: `hub:${st[0]}` }]] };
        return confirmMap(st[0]!, st[1] === "n" ? "n" : "c", mapId, server.name, Number(st[2]) || 0);
      }
      case "mpm":
        return { modal: {
          title: st[1] === "n" ? "Set next map by id" : "Change map by id", action: "mpc", state: ev.state,
          fields: [{ id: "mapid", label: "Map id (e.g. carentan_warfare)", maxLength: 80 }],
        } };
      case "mpc": {
        const server = await serverOf(st[0] ?? "");
        if (!server) return serverPick(ev, "⚠️ That server is gone.");
        const mapId = (ev.values?.mapid ?? "").trim();
        // Undeferred (modal submits must answer fast), so no hub here — it dials the game.
        if (!/^[A-Za-z0-9_.-]{3,80}$/.test(mapId)) {
          return { content: "⚠️ That doesn't look like a map id.", rows: [[{ label: "‹ Server", customId: `hub:${st[0]}` }]] };
        }
        return confirmMap(st[0]!, st[1] === "n" ? "n" : "c", mapId, server.name, 0);
      }
      case "cma": return applyMap(ev, st[0] ?? "", "c", st.slice(1).join(":"));
      case "nma": return applyMap(ev, st[0] ?? "", "n", st.slice(1).join(":"));
      case "ob": return sectorStep(ev, st[0] ?? "", 0, "");
      case "obc": {
        const server = await serverOf(st[0] ?? "");
        if (!server) return serverPick(ev, "⚠️ That server is gone.");
        if (server.game !== "hllv") return hub(ev, st[0] ?? "", "⚠️ Only HLL: Vietnam stores objective layouts.");
        return {
          content: [
            `**Clear saved layout** — **${server.name}**`,
            "The server forgets the objectives stored for the CURRENT map and goes back to picking its own. The round in play is not touched.",
          ].join("\n"),
          rows: [[
            { label: "Clear it", customId: `obcy:${st[0]}`, style: "danger" },
            { label: "‹ Server", customId: `hub:${st[0]}` },
          ]],
        };
      }
      case "obcy": return clearLayout(ev, st[0] ?? "");
      case "obs": return sectorStep(ev, st[0] ?? "", (Number(st[1]) || 0) + 1, (st[2] ?? "") + (ev.selected?.[0] ?? "r"));
      case "oba": return applySectors(ev, st[0] ?? "", st[1] ?? "", ev.selected?.[0] ?? "");
      case "vp": return voteControl(ev, st[0] ?? "", "vp", st[1] ?? "");
      case "vs": return voteControl(ev, st[0] ?? "", "vs", "");
      case "vr": return voteControl(ev, st[0] ?? "", "vr", "");
      case "vn": return voteControl(ev, st[0] ?? "", "vn", "");
      default: return open(ev);
    }
  };

  return {
    id: "maps",
    label: "Maps & vote",
    description: "Current map and vote at a glance; change or queue maps, set objectives, drive the vote.",
    capability: "server.view",
    capabilityLevel: "read",
    // Everything that dials the game — the vote controls included, because their result screen
    // is the hub, which reads the round. Modal openers (mpm) and their submits (mpc — renders
    // the confirm screen from repo data alone) stay undeferred.
    deferActions: ["srv", "hub", "mp", "cma", "nma", "ob", "obs", "oba", "obcy", "vp", "vs", "vr", "vn"],
    open,
    action,
    serverScreen,
  };
}
