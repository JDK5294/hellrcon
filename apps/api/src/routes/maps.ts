/**
 * Maps: the rotation, the catalogue and its display names, and everything about the map vote.
 *
 * Lifted verbatim out of app.ts; the order within this file is the order these were declared in.
 */
import { TEXT_MAX, boundedText, readJsonBody, sendError, sendJson, str } from "../http.js";
import { can } from "@app/access";
import { MAPVOTE_MESSAGE_LAYOUTS } from "@app/db";
import type { MapVoteMessageLayout } from "@app/db";
import { stateReaderFor } from "@app/games";
import { normalizeSession } from "@app/rcon-core";
import { DEFAULT_POOL_CONFIG, buildPoll, describeCoverage, describeMap, describeMaps, explicitRotationOf, inferEnvironmentGroup, isSectorId, planRotationApply, resolveActivePool, resolveCurrentMapId, resolveListedMapId, zoneKeyOf } from "@app/maps";
import type { MapPoolConfig, MapVoteProfile } from "@app/maps";
import { errors } from "@app/shared";
import { applyObjectives, changeMapNow, clearStoredLayout, parseStoredLayouts, setNextMapNow } from "../map-actions.js";
import { libraryWithUsage } from "./map-library.js";
import { connectGameClient, emptyVoteState, gameClientFor, pageLimit, pageOffset, parseMapVoteConfig, parseObjectiveRows, parsePoolConfig, requirePrincipal, route, sendForbidden, serverRoute, type Route } from "./kit.js";

export const mapsRoutes: Route[] = [
  // Map rotation for one server (current index + upcoming maps) — powers the Map Rotation card.
  serverRoute("GET", "/api/servers/:id/maprotation", "server.view", "read", async ({ res, id, server }) => {
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const mapRotation = await client.readState("maprotation");
      sendJson(res, 200, { mapRotation });
    } catch (err) {
      throw errors.upstream(`could not read map rotation: ${(err as Error).message}`, { serverId: id });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  // --- Map tools: authoritative map catalogue + current rotation, and force-next-map ---
  // GET returns the full installable-map list (discovery) with derived name/mode/environment/family,
  // plus the current rotation and current map. Read-only (server.view).
  serverRoute("GET", "/api/servers/:id/maps", "server.view", "read", async ({ res, ctx, id, server }) => {
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const [rawList, rawChangeable, rawRotation, rawSession, overrideRows, rawSequence, rawShuffle] = await Promise.all([
        client.execute("getMapReferenceList").catch(() => null),
        // ChangeMap's OWN option list — see the change route below for why the two cannot be
        // assumed equal. A build that doesn't answer leaves this empty, which the panel reads as
        // "unknown, don't restrict" rather than "nothing is switchable".
        client.execute("getChangeMapList").catch(() => null),
        client.readState("maprotation").catch(() => null),
        // What is PLAYING, which the rotation cannot answer — see resolveCurrentMapId.
        client.readState("session").catch(() => null),
        ctx.repo.mapNames.list(server.game),
        // The game's own play queue and its shuffle switch: the rotation page's "Check from game"
        // shows what the GAME says comes next beside what the rotation implies. A server that
        // does not answer either leaves it unknown, never an error on the page.
        client.execute("getMapSequence").catch(() => null),
        client.execute("getMapShuffleEnabled").catch(() => null),
      ]);
      // Overlay staff display-name overrides on top of the inferred names. `id` stays the raw RCON
      // map id everything acts on; only the shown name changes. `defaultName` + `custom` let the
      // editor show what's overridden.
      const overrides = new Map(overrideRows.map((r) => [r.mapId, r]));
      // `envGroup` is the coarse day/night the VOTE ENGINE buckets by, sent alongside the raw
      // `environment`. The panel must not re-derive it: HLL has six environments (day, night, dusk,
      // morning, overcast, rain) and only `night` counts as night, so a second copy of that rule in
      // the UI drifts and offers staff maps their chosen bucket can never draw.
      // The family override rides alongside: it decides which variants count as "the same map" for
      // the vote's de-duplication and its family rest, and it used to be derivable only from rules
      // in code — so a map the game shipped with an unexpected id grouped wrong until a new build.
      // `defaultFamily` + `customFamily` let the catalogue page show and fix a stray.
      const withName = <T extends { id: string; prettyName: string; environment?: string; family?: string }>(m: T) => {
        const ov = overrides.get(m.id);
        return {
          ...m, prettyName: ov?.displayName ?? m.prettyName, defaultName: m.prettyName, custom: ov?.displayName != null,
          family: ov?.family ?? m.family, defaultFamily: m.family, customFamily: ov?.family != null,
          envGroup: inferEnvironmentGroup(m.environment ?? ""),
        };
      };
      const catalogue = describeMaps(stateReaderFor(server.game).mapCatalogue(rawList)).map(withName);
      const rot = stateReaderFor(server.game).rotation(rawRotation);
      const rotation = rot.maps.map((m) => withName(describeMap(m)));
      // The map in play comes from the SESSION. Taken from the rotation it was wrong on every
      // server running the vote: the live-leader tracker collapses the rotation to the one map it
      // is queuing, so the rotation's "current" is the map about to play, and this screen renamed
      // itself every time the poll's lead changed.
      const currentId = resolveCurrentMapId({ session: normalizeSession(rawSession), rotation: rot, catalogue });
      const current = currentId ? withName(describeMap(currentId)) : null;
      // Where it sits in the rotation, or -1 when it is not in it at all — which is the normal
      // state mid-vote, and must not badge an unrelated entry as the one being played.
      const currentIndex = currentId ? rot.maps.findIndex((m) => m.toLowerCase() === currentId.toLowerCase()) : -1;
      /*
       * What the game will actually play next — the entry after ITS OWN place in the list, which
       * is not entry 1 and not necessarily the entry after the map in play. The editor only ever
       * showed a numbered list, so staff read it as a queue from the top; in the field a paused
       * vote, two skirmish maps at 1 and 2 and two more appended at 3 and 4 played entry 3 — the
       * map already in play — with nothing on this page to say it would. -1 when the server does
       * not say where it is.
       */
      const nextIndex = stateReaderFor(server.game).nextInRotation(rawRotation) ?? -1;
      const next = nextIndex >= 0 ? rotation[nextIndex] ?? null : null;
      // The second answer the game can give: its play queue, which shuffle reorders. When the two
      // name different maps, the page says so rather than picking one to believe.
      // The queue names its maps by level path, not the rotation's layer id — each entry is matched
      // to the map the game describes the same way, or it reads "Game Bnw Maps Fra…" and never
      // compares equal to the rotation's own entry for the same map.
      const reader = stateReaderFor(server.game);
      const rotationEntries = reader.mapEntries(rawRotation);
      const catalogueRef = catalogue.map((m) => ({ id: m.id, prettyName: m.defaultName ?? m.prettyName, mode: m.mode }));
      const queueNextIndex = reader.nextInRotation(rawSequence) ?? -1;
      const queueMaps = reader.mapEntries(rawSequence)
        .map((e) => withName(describeMap(resolveListedMapId(e, { rotation: rotationEntries, catalogue: catalogueRef }))));
      const queue = queueMaps.length
        ? { maps: queueMaps, nextIndex: queueNextIndex, next: queueNextIndex >= 0 ? queueMaps[queueNextIndex] ?? null : null }
        : null;
      const shuffle = stateReaderFor(server.game).mapShuffle(rawShuffle);
      const changeable = stateReaderFor(server.game).mapCatalogue(rawChangeable);
      // Whether the automated vote is managing this rotation — a boolean, not the vote config
      // (this page's cap doesn't grant that). The rotation editor uses it to say WHY the rotation
      // looks collapsed and why hand edits may be rewritten, instead of leaving staff to discover
      // the fight the way the field did. A paused vote leaves the rotation alone, and the warning
      // has to say so: it told staff with the vote paused that their edits would be rewritten.
      const voteManaged = (await ctx.repo.mapVote.getConfig(id).catch(() => null))?.enabled === true;
      const votePaused = voteManaged && (await ctx.repo.mapVote.getState(id).catch(() => null))?.paused === true;
      sendJson(res, 200, {
        maps: catalogue, rotation, current, currentIndex, nextIndex, next, queue, shuffle, voteManaged, votePaused,
        // When the game was asked — every field above is a live read, and the page shows its age.
        checkedAt: new Date().toISOString(),
        // null, not [], when the server didn't tell us: the panel must not grey out every button
        // because an older build has no opinion about which maps ChangeMap takes.
        changeable: changeable.length ? changeable : null,
      });
    } catch (err) {
      throw errors.upstream(`could not read maps: ${(err as Error).message}`, { serverId: id });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  // Force the next map: collapse the rotation to the chosen map (the troubleshooted placement
  // algorithm) and verify. Write → requires server.config and an active (non-observe) server.
  serverRoute("POST", "/api/servers/:id/maps/next", "maps.next", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const mapId = str(body.mapId).trim();
    if (!mapId) return sendError(res, 400, "mapId is required");
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    try {
      // Shared with the Discord panel (map-actions.ts) — one implementation, one audit shape.
      const { result, pretty, voteHoldUntil } = await setNextMapNow(ctx.repo, { userId: p.user.id, name: p.name }, server, mapId);
      sendJson(res, 200, { ...result, pretty, voteHoldUntil });
    } catch (err) {
      throw errors.upstream(`could not set next map: ${(err as Error).message}`, { serverId: id, mapId });
    }
  }),

  /**
   * Load a map RIGHT NOW, ending the round in progress.
   *
   * The sibling above queues a map by rewriting the rotation and leaves the current round alone;
   * this one is the blunt instrument — the game switches immediately and everybody on the server
   * loads in again. The rotation is otherwise left alone, so whatever was going to follow still
   * follows; the one exception is the staged case below, which appends the map and says so.
   *
   * `changeMap` has been in the command table since the descriptor was written (ChangeMap on
   * binary-v2, `map <name>` on legacy text); it simply had nothing calling it.
   *
   * WHICH NAMES IT TAKES is the whole difficulty, and the reason this route reads a list before it
   * writes. The catalogue the panel shows comes from GetClientReferenceData("AddMapToRotation") —
   * the options the ROTATION command accepts. Reference data is per-command, and nothing had ever
   * checked that ChangeMap answers with the same vocabulary. When it doesn't, the game does not
   * complain: ChangeMap returns 200 and does nothing, the adapter only throws on a non-200, and the
   * panel reported a success that never happened. So the route asks ChangeMap what IT accepts.
   *
   * What that list turned out to BE is the part this route got wrong. It is not a permission list —
   * it is the option list the official client's own map-change dropdown is built from, and on a
   * live server it follows the ROTATION (the legacy client says as much: its Map Change parameter
   * reads `usegetter="MapsInRotation"`). A server whose rotation the vote has collapsed to a single
   * map therefore answers with a single map, and treating that as "the only map this server will
   * load" left staff with a catalogue of hundreds where one map could be switched to.
   *
   * So the list stops being a veto and becomes something we can satisfy. An id the list doesn't
   * have is put INTO the rotation first — `stage` — which is exactly what an admin does by hand,
   * and then asked for again; the map appearing in it confirms what the list is made of. Either way
   * the switch is attempted and the rotation edit is reported, because a change staff asked for
   * that quietly did half the job is the failure this whole route exists to stop.
   */
  serverRoute("POST", "/api/servers/:id/maps/change", "maps.next", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const mapId = str(body.mapId).trim();
    // Staging is the DEFAULT: an unlisted map is put into the rotation and switched to in one
    // request. It used to be opt-in "consent", and the field showed why that was wrong — the
    // panel decided whether to consent from a snapshot of the ChangeMap list, the vote collapsed
    // the rotation after the page loaded, and staff got a refusal lecture instead of the map they
    // clicked. Every caller of this route has already confirmed with a human that the round ends
    // now; a rotation append is the smaller half of that decision, it is reported back
    // (`staged: true`), and `stage: false` remains for a caller that truly wants refusal instead.
    const stage = body.stage !== false;
    if (!mapId) return sendError(res, 400, "mapId is required");
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    try {
      // Shared with the Discord panel (map-actions.ts) — the accepted-list dance, the staging
      // consent and the post-switch verification live there now, once.
      const out = await changeMapNow(ctx.repo, { userId: p.user.id, name: p.name }, server, mapId, stage);
      if ("refusal" in out) return sendError(res, 400, out.refusal);
      sendJson(res, 200, out);
    } catch (err) {
      throw errors.upstream(`could not change the map: ${(err as Error).message}`, { serverId: id, mapId });
    }
  }),

  // --- Map rotation editor: add / remove / move a map in the live rotation. Everything acts on raw
  // map ids (display names are cosmetic). server.config-gated; refused on observe. ---
  serverRoute("POST", "/api/servers/:id/maprotation/add", "maps.rotation", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const mapId = str(body.mapId).trim();
    if (!mapId) return sendError(res, 400, "mapId is required");
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const rot = stateReaderFor(server.game).rotation(await client.readState("maprotation"));
      // Append by default; an explicit in-range index inserts there.
      const rawIndex = body.index === undefined || body.index === null ? rot.maps.length : Number(body.index);
      const index = Math.max(0, Math.min(Number.isFinite(rawIndex) ? Math.round(rawIndex) : rot.maps.length, rot.maps.length));
      await client.execute("addMapToRotation", { mapName: mapId, index });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "map.rotation.add",
        targetType: "server", targetId: id, targetName: server.name, serverId: id,
        summary: `added ${describeMap(mapId).prettyName} to the rotation on ${server.name}`,
        data: { mapId, index },
      });
      sendJson(res, 200, { ok: true, index });
    } catch (err) {
      throw errors.upstream(`could not add map to rotation: ${(err as Error).message}`, { serverId: id, mapId });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  serverRoute("POST", "/api/servers/:id/maprotation/remove", "maps.rotation", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const mapId = str(body.mapId).trim();
    if (!mapId) return sendError(res, 400, "mapId is required");
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const rot = stateReaderFor(server.game).rotation(await client.readState("maprotation"));
      // Trust the caller's index only if it still points at this map (rotation may have shifted);
      // otherwise fall back to the first occurrence.
      const hinted = Number(body.index);
      const index = Number.isInteger(hinted) && rot.maps[hinted] === mapId ? hinted : rot.maps.indexOf(mapId);
      if (index < 0) return sendError(res, 400, "map is not in the current rotation");
      /*
       * THE LAST MAP IS NOT REMOVABLE.
       *
       * An empty rotation is not an empty rotation to HLL: the server repopulates it with the
       * ENTIRE map list, which then has to be deleted by hand, one entry at a time, to get back to
       * the handful you wanted. So the destructive-looking step (removing the second-to-last map)
       * is fine and the innocent-looking one (removing the last) is the one that costs an evening.
       *
       * Refused here rather than only in the panel because the panel is one caller: the same route
       * serves the API directly. Swap the order instead — add the replacement first, then remove
       * this one, which is also what leaves the server with a sane rotation the whole time.
       */
      if (rot.maps.length <= 1) {
        return sendError(res, 409, "the rotation must keep at least one map — emptying it makes the game refill it with every map in the catalogue, which then has to be cleared by hand. Add the next map first, then remove this one.");
      }
      await client.execute("removeMapFromRotation", { mapName: mapId, index });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "map.rotation.remove",
        targetType: "server", targetId: id, targetName: server.name, serverId: id,
        summary: `removed ${describeMap(mapId).prettyName} from the rotation on ${server.name}`,
        data: { mapId, index },
      });
      sendJson(res, 200, { ok: true, index });
    } catch (err) {
      throw errors.upstream(`could not remove map from rotation: ${(err as Error).message}`, { serverId: id, mapId });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  // The sets a rotation could be replaced with: this game's library sets, each saying whether it
  // resolves to a concrete lineup (and how long) or is a vote recipe the apply would refuse. Its
  // own read under maps.rotation, so the rotation tab and the event editor need no vote grant.
  serverRoute("GET", "/api/servers/:id/maprotation/sets", "maps.rotation", "read", async ({ res, ctx, server }) => {
    const sets = (await ctx.repo.mapSets.list(server.game)).map((s) => {
      const lineup = explicitRotationOf(s.pool as Partial<MapPoolConfig>);
      return { id: s.id, name: s.name, lineup: lineup && lineup.length ? lineup.length : null };
    });
    sendJson(res, 200, { sets });
  }),

  /**
   * Replace the whole rotation with a library map set, in one confirmed operation — what used to
   * be a map-at-a-time chore (one staffer's card reads map.rotation.remove ×72). Only sets that
   * describe a CONCRETE lineup apply: an explicit `sequence` (what "save rotation as a set"
   * writes) or a recipe whose every counted bucket lists its maps — a counts-and-rules recipe is
   * refused, because applying it would mean silently rolling dice. The plan adds the new lineup
   * first and removes the old entries after, so the rotation is never empty mid-flight (HLL
   * answers an empty rotation by refilling it with the entire catalogue). One audit row: this is
   * one act of staffing however many maps move.
   */
  serverRoute("POST", "/api/servers/:id/maprotation/apply-set", "maps.rotation", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const setId = str(body.setId).trim();
    if (!setId) return sendError(res, 400, "setId is required");
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const set = await ctx.repo.mapSets.get(setId);
    if (!set) return sendError(res, 404, "map set not found");
    if (set.game !== server.game) {
      return sendError(res, 400, `"${set.name}" is a ${set.game} set — ${server.name} runs ${server.game}, and map ids do not cross games`);
    }
    const target = explicitRotationOf(set.pool as Partial<MapPoolConfig>);
    if (!target || !target.length) {
      return sendError(res, 400, `"${set.name}" is a vote recipe (counts and rules), not a concrete lineup — save a live rotation as a set, or give this set's buckets explicit maps, to make it applicable to a rotation`);
    }
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const before = stateReaderFor(server.game).rotation(await client.readState("maprotation")).maps;
      const plan = planRotationApply(before, target);
      for (const s of plan) {
        if (s.op === "add") await client.execute("addMapToRotation", { mapName: s.mapId, index: s.index });
        else await client.execute("removeMapFromRotation", { mapName: s.mapId, index: s.index });
      }
      const rotation = stateReaderFor(server.game).rotation(await client.readState("maprotation")).maps;
      if (plan.length) {
        await ctx.repo.audit.create({
          actorUserId: p.user.id, actorName: p.name, action: "map.rotation.apply_set",
          targetType: "server", targetId: id, targetName: server.name, serverId: id,
          summary: `replaced the rotation on ${server.name} with the set "${set.name}" — ${target.length} map(s)`,
          data: { setId: set.id, setName: set.name, maps: target, before },
        });
      }
      sendJson(res, 200, { ok: true, changed: plan.length > 0, rotation: rotation.map((m) => describeMap(m)) });
    } catch (err) {
      throw errors.upstream(`could not apply the set to the rotation: ${(err as Error).message}`, { serverId: id, setId });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  serverRoute("POST", "/api/servers/:id/maprotation/move", "maps.rotation", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const mapId = str(body.mapId).trim();
    if (!mapId) return sendError(res, 400, "mapId is required");
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const rot = stateReaderFor(server.game).rotation(await client.readState("maprotation"));
      const hintedFrom = Number(body.fromIndex);
      const from = Number.isInteger(hintedFrom) && rot.maps[hintedFrom] === mapId ? hintedFrom : rot.maps.indexOf(mapId);
      if (from < 0) return sendError(res, 400, "map is not in the current rotation");
      // Position in the list AFTER removing the map, so up/down land where the user expects.
      const without = rot.maps.filter((_, i) => i !== from);
      const to = Math.max(0, Math.min(Number.isFinite(Number(body.toIndex)) ? Math.round(Number(body.toIndex)) : from, without.length));
      if (to === from) return sendJson(res, 200, { ok: true, from, to }); // no-op
      // Reposition on one connection: pull it out, then re-insert at the target slot.
      await client.execute("removeMapFromRotation", { mapName: mapId, index: from });
      await client.execute("addMapToRotation", { mapName: mapId, index: to });
      await ctx.repo.audit.create({
        actorUserId: p.user.id, actorName: p.name, action: "map.rotation.move",
        targetType: "server", targetId: id, targetName: server.name, serverId: id,
        summary: `moved ${describeMap(mapId).prettyName} to position ${to + 1} in the rotation on ${server.name}`,
        data: { mapId, from, to },
      });
      sendJson(res, 200, { ok: true, from, to });
    } catch (err) {
      throw errors.upstream(`could not move map in rotation: ${(err as Error).message}`, { serverId: id, mapId });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  // The current map's objective grid: five sectors, three choices each. Read straight from the
  // game (GetClientReferenceData "SetSectorLayout"), so it always matches the map in play — plus
  // the staff-taught location layer for that map family (names for Vietnam's bare digits, and the
  // tactical-map cell each option sits in, which is what the picker highlights).
  serverRoute("GET", "/api/servers/:id/maps/objectives", "server.view", "read", async ({ res, ctx, id, server }) => {
    const client = gameClientFor(server);
    let rows: string[][];
    let mapId: string;
    let saved: number[] | null = null;
    try {
      await connectGameClient(client, server);
      rows = parseObjectiveRows(await client.execute("getObjectiveRows"));
      if (rows.length !== 5) return sendError(res, 502, "the server did not return the five objective rows (is a match loading?)");
      mapId = normalizeSession(await client.readState("session").catch(() => null)).mapId ?? "";
      // Vietnam STORES a layout per map (docs/hll-vietnam.md p11) — re-applied every time the
      // map plays until removed. HLL stores nothing, so `saved` stays null there and the panel
      // must never imply a WW2 set outlives the round it reset.
      if (server.game === "hllv" && mapId) {
        saved = parseStoredLayouts(await client.execute("getObjectives").catch(() => null))
          .find((e) => e.mapId.toLowerCase() === mapId.toLowerCase())?.sectors ?? null;
      }
    } catch (err) {
      throw errors.upstream(`could not read objectives: ${(err as Error).message}`, { serverId: id });
    } finally {
      await client.disconnect().catch(() => {});
    }
    const mapKey = zoneKeyOf(mapId);
    const points = mapKey ? await ctx.repo.objectivePoints.forMap(server.game, mapKey) : [];
    // The plays-left countdown, when one stands — null means "until cleared". Only meaningful
    // beside a saved layout, so it is only looked up when one was found.
    const savedPlays = saved && mapId ? (await ctx.repo.layoutExpiries.get(id, mapId))?.playsLeft ?? null : null;
    sendJson(res, 200, { rows, mapKey, points, mapId, saved, savedPlays });
  }),

  /**
   * Clear a Vietnam map's SAVED objective layout (RemoveSectorLayout, p11). Only Vietnam has
   * anything to clear: a saved layout there re-applies every time its map plays, so without this
   * route "set" would be a one-way door. Defaults to the map in play; a body mapId clears any map.
   */
  serverRoute("POST", "/api/servers/:id/maps/objectives/clear", "maps.next", "write", async ({ req, res, ctx, p, id, server }) => {
    if (server.game !== "hllv") return sendError(res, 400, "only HLL: Vietnam stores objective layouts — a WW2 set applies once to the round in play and leaves nothing to clear");
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const body = await readJsonBody(req);
    try {
      // Shared with the Discord panel (map-actions.ts): same wire, same audit row. The game
      // check above is repeated by the core; it stays here too so a WW2 caller is answered
      // before the body is even read for a map id.
      const out = await clearStoredLayout(ctx.repo, { userId: p.user.id, name: p.name }, server, str(body.mapId));
      if ("refusal" in out) return sendError(res, 400, out.refusal);
      sendJson(res, 200, { cleared: true, mapId: out.mapId });
    } catch (err) {
      throw errors.upstream(`could not clear the saved layout: ${(err as Error).message}`, { serverId: id });
    }
  }),

  /**
   * Teach one objective option its place and name — the staff-supplied layer the wire cannot
   * provide: Vietnam answers the grid with bare digits, and neither game says WHERE an option
   * sits. The cell vocabulary is the tactical map's own A1–J10 grid (printed on the art), so
   * teaching is reading the map, not calibrating anything. Keyed by map FAMILY, shared by every
   * server running that map. maps.names because it is the same kind of act as renaming a map:
   * cosmetic truth-keeping, no game state touched.
   */
  serverRoute("PUT", "/api/servers/:id/maps/objective-points", "maps.names", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const mapKey = str(body.mapKey).trim().toLowerCase();
    if (!/^[a-z0-9]{1,60}$/.test(mapKey)) return sendError(res, 400, "mapKey must be a map family key (letters and digits)");
    const row = Number(body.row), idx = Number(body.idx);
    if (!Number.isInteger(row) || row < 0 || row > 4) return sendError(res, 400, "row must be 0–4");
    if (!Number.isInteger(idx) || idx < 0 || idx > 2) return sendError(res, 400, "idx must be 0–2");
    const patch: { name?: string | null; sector?: string | null } = {};
    if (body.name !== undefined) {
      const name = str(body.name).trim();
      if (name.length > 60) return sendError(res, 400, "name must be 60 characters or fewer");
      patch.name = name || null;
    }
    if (body.sector !== undefined) {
      const sector = str(body.sector).trim().toUpperCase();
      if (sector && !isSectorId(sector)) return sendError(res, 400, "sector must be a tactical-map cell like E6 (A1–J10), or blank to clear");
      patch.sector = sector || null;
    }
    if (patch.name === undefined && patch.sector === undefined) return sendError(res, 400, "nothing to teach — send name and/or sector");
    const saved = await ctx.repo.objectivePoints.set(server.game, mapKey, row, idx, patch);
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "map.objectivePoints",
      targetType: "map", targetId: mapKey, targetName: mapKey, serverId: id,
      summary: `taught objective row ${row + 1} option ${idx + 1} on ${mapKey}${patch.name !== undefined ? ` — name ${patch.name ? `"${patch.name}"` : "cleared"}` : ""}${patch.sector !== undefined ? ` — cell ${patch.sector ?? "cleared"}` : ""}`,
      data: { game: server.game, mapKey, row, idx, ...patch },
    });
    sendJson(res, 200, { point: saved });
  }),

  // Choose the objective each sector runs THIS match. Body: { objectives: [five entries — an
  // objective name from that row, or "random" to let us pick one] }. Applies immediately in game.
  serverRoute("POST", "/api/servers/:id/maps/objectives", "maps.next", "write", async ({ req, res, ctx, p, id, server }) => {
    if (server.engagementMode !== "active") return sendError(res, 409, "server is in observe mode (read-only)");
    const body = await readJsonBody(req);
    const wanted = Array.isArray(body.objectives) ? (body.objectives as unknown[]).map((x) => str(x).trim()) : [];
    if (wanted.length !== 5) return sendError(res, 400, "objectives must list exactly 5 entries (one per row; use \"random\" to leave a row to chance)");
    // "Keep it for the next N plays" — Vietnam only, because only Vietnam stores anything to
    // keep. On WW2 the set applies once to the round in play, so a keepPlays there is a
    // misunderstanding worth answering, not ignoring.
    let keepPlays: number | null = null;
    if (body.keepPlays !== undefined && body.keepPlays !== null && body.keepPlays !== "") {
      if (server.game !== "hllv") return sendError(res, 400, "keepPlays only means something on HLL: Vietnam — a WW2 set applies once to the round in play and stores nothing");
      const n = Number(body.keepPlays);
      if (!Number.isInteger(n) || n < 1 || n > 50) return sendError(res, 400, "keepPlays must be a whole number of plays, 1-50");
      keepPlays = n;
    }
    try {
      // Shared with the Discord panel (map-actions.ts): live-grid validation, the dual name+index
      // wire form, the layout recording — one implementation for every surface.
      const out = await applyObjectives(ctx.repo, { userId: p.user.id, name: p.name }, server, wanted, { keepPlays });
      // The five-rows refusal keeps its 502 (the server failed to answer); a stale pick is the
      // caller's 400, same split as before the extraction.
      if ("refusal" in out) return sendError(res, out.refusal.includes("five objective rows") ? 502 : 400, out.refusal);
      sendJson(res, 200, out);
    } catch (err) {
      throw errors.upstream(`could not set objectives: ${(err as Error).message}`, { serverId: id });
    }
  }),

  // Set (or clear, with a blank name) a map's DISPLAY name for this server's game. Cosmetic only —
  // the raw map id is unchanged and remains what every code path uses. Applies to all servers of the
  // same game. Requires server.config; no RCON call (it's our own metadata).
  serverRoute("PUT", "/api/servers/:id/maps/:mapId/name", "maps.names", "write", async ({ req, res, ctx, params, p, id, server }) => {
    const mapId = params.mapId!.trim();
    if (!mapId) return sendError(res, 400, "mapId is required");
    const body = await readJsonBody(req);
    // Bounded like every other name in this app. It was the one that was not, and a display name
    // is not confined to the panel: it rides into the Discord status board's "Next map" field and
    // into the in-game vote announcement, both of which have hard limits that reject the WHOLE
    // message when exceeded — so an over-long rename would not look like a rename problem, it
    // would look like the status board quietly stopping. Empty is still "reset to the default".
    const displayName = boundedText(body.displayName, TEXT_MAX.name, "displayName");
    const row = await ctx.repo.mapNames.set(server.game, mapId, displayName);
    const effective = row?.displayName ?? describeMap(mapId).prettyName;
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "map.name",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: row
        ? `renamed map ${mapId} → "${row.displayName}" (${server.game})`
        : `reset the display name for map ${mapId} (${server.game})`,
      data: { game: server.game, mapId, displayName: row?.displayName ?? null },
    });
    sendJson(res, 200, { mapId, displayName: effective, custom: row != null });
  }),

  /**
   * Set (or clear) a map's FAMILY. The family is what the vote engine treats as "the same map" —
   * it powers one-option-per-map and resting every variant after one plays — and until now it came
   * only from rules that read the map id, with a hardcoded list of exceptions for the ids those
   * rules get wrong. That made every new map release a code change. This makes it data: staff can
   * see a stray in the catalogue and fix it in a couple of clicks, and the rules stay as the
   * default for everything nobody has had to correct.
   */
  serverRoute("PUT", "/api/servers/:id/maps/:mapId/family", "maps.names", "write", async ({ req, res, ctx, params, p, id, server }) => {
    const mapId = params.mapId!.trim();
    if (!mapId) return sendError(res, 400, "mapId is required");
    const body = await readJsonBody(req);
    const family = str(body.family).trim().toLowerCase();
    if (family.length > 64) return sendError(res, 400, "family must be 64 characters or fewer");
    const row = await ctx.repo.mapNames.setFamily(server.game, mapId, family);
    const inferred = describeMap(mapId).family;
    const effective = row?.family ?? inferred;
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "map.family",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: row?.family
        ? `grouped map ${mapId} under family "${row.family}" (${server.game})`
        : `reset map ${mapId} to its inferred family "${inferred}" (${server.game})`,
      data: { game: server.game, mapId, family: row?.family ?? null },
    });
    sendJson(res, 200, { mapId, family: effective, defaultFamily: inferred, customFamily: row?.family != null });
  }),

  // Preview a composed vote poll from the live catalogue + a pool config (day/night/wildcard buckets,
  // family de-dup, allow/deny/recent/previous exclusion). Read-only — the winner would later be
  // applied by the tested placement logic. Options carry effective display names but raw ids.
  serverRoute("POST", "/api/servers/:id/maps/poll/preview", "server.view", "read", async ({ req, res, ctx, id, server }) => {
    const body = await readJsonBody(req);
    // With an explicit `config`, preview that manually; otherwise resolve the ACTIVE profile from the
    // stored map-vote config (by schedule + live player count) and preview what the vote would use now.
    const explicit = body.config !== undefined;
    const recentIds = Array.isArray(body.recentIds) ? (body.recentIds as unknown[]).map(String) : [];
    const previousPollIds = Array.isArray(body.previousPollIds) ? (body.previousPollIds as unknown[]).map(String) : [];
    const client = gameClientFor(server);
    try {
      await connectGameClient(client, server);
      const [rawList, rawRotation, rawSession, overrideRows, voteCfg] = await Promise.all([
        client.execute("getMapReferenceList").catch(() => null),
        client.readState("maprotation").catch(() => null),
        client.readState("session").catch(() => null),
        ctx.repo.mapNames.list(server.game),
        ctx.repo.mapVote.getConfig(id),
      ]);
      const overrides = new Map(overrideRows.map((r) => [r.mapId, r]));
      const catalogue = describeMaps(stateReaderFor(server.game).mapCatalogue(rawList))
        .map((m) => ({ ...m, prettyName: overrides.get(m.id)?.displayName ?? m.prettyName, family: overrides.get(m.id)?.family ?? m.family }));
      const rot = stateReaderFor(server.game).rotation(rawRotation);
      const playerCount = stateReaderFor(server.game).playerCount(rawSession);
      let config: MapPoolConfig;
      let profileName: string | null = null;
      if (explicit) {
        config = parsePoolConfig(body.config as Record<string, unknown>);
      } else {
        const resolved = resolveActivePool((voteCfg?.profiles ?? []) as unknown as MapVoteProfile[], new Date(), { playerCount }, voteCfg?.timezone);
        config = resolved.config; profileName = resolved.profileName;
      }
      // Excluding "the current map" has to mean the one being played. From the rotation it meant
      // the map the vote had just queued — so the winner was barred from the next poll and the map
      // players were actually on could be offered again immediately.
      const currentMapId = resolveCurrentMapId({ session: normalizeSession(rawSession), rotation: rot, catalogue }) ?? undefined;
      const result = buildPoll({ catalogue, config, currentMapId, recentIds, previousPollIds });
      sendJson(res, 200, { ...result, profile: profileName, playerCount, timezone: voteCfg?.timezone ?? "UTC" });
    } catch (err) {
      throw errors.upstream(`could not preview poll: ${(err as Error).message}`, { serverId: id });
    } finally {
      await client.disconnect().catch(() => {});
    }
  }),

  // Map-vote scheduled profiles: an ordered list of pool configs gated by schedule + player count.
  // No RCON — our own config. Read/write gated by server.config.
  serverRoute("GET", "/api/servers/:id/mapvote/config", "mapvote.config", "read", async ({ res, ctx, id, server }) => {
    const cfg = await ctx.repo.mapVote.getConfig(id);
    const profiles = (cfg?.profiles ?? []) as unknown as MapVoteProfile[];
    /*
     * Which set is in charge right now — judged on the clock AND the player count, as the vote
     * itself is. This read used the clock alone, and a set gated on players ("under 50" / "50+")
     * can never match an unknown count, so a server whose every set is count-gated read "none
     * matched" while its vote ran on the right set. The count is the worker's latest roster
     * reading (no RCON from here); one older than five minutes is not a reading of now.
     */
    const snap = await ctx.repo.rosterSnapshots.latest(id).catch(() => null);
    const activeCount = snap && Date.now() - Date.parse(snap.ts) < 5 * 60_000 ? snap.playerCount : null;
    const active = resolveActivePool(profiles, new Date(), activeCount === null ? {} : { playerCount: activeCount }, cfg?.timezone);
    // When nothing matched only for want of a count, say so rather than "none matched".
    const countGated = profiles.some((p) => p.spec?.playersBelow !== undefined || p.spec?.playersAbove !== undefined);
    const st = await ctx.repo.mapVote.getState(id);
    // The library rides along with the config so the editor paints its two dropdowns from the
    // first response instead of flashing empty while a second request lands.
    const { sets, schedules } = await libraryWithUsage(ctx, server.game);
    sendJson(res, 200, {
      enabled: cfg?.enabled ?? false, surface: cfg?.surface ?? "native", channelId: cfg?.channelId ?? null, pollHours: cfg?.pollHours ?? 24,
      timezone: cfg?.timezone ?? "UTC", reminders: cfg?.reminders ?? [], profiles, activeProfile: active.profileName, defaultPool: DEFAULT_POOL_CONFIG,
      activeProfileCount: activeCount, activeProfileNeedsCount: active.profileName === null && activeCount === null && countGated,
      // What this server actually stores — which library set, on which library schedule, in order.
      profileLinks: cfg?.profileLinks ?? [],
      sets, schedules,
      liveApply: cfg?.liveApply ?? true,
      postMatchApplyDelaySeconds: cfg?.postMatchApplyDelaySeconds ?? 300,
      pollResetDelaySeconds: cfg?.pollResetDelaySeconds ?? 180,
      tidyChannel: cfg?.tidyChannel ?? true,
      pauseBelowPlayers: cfg?.pauseBelowPlayers ?? 0,
      registeredOnlyIngame: cfg?.registeredOnlyIngame ?? false,
      registeredOnlyDiscord: cfg?.registeredOnlyDiscord ?? false,
      startupState: cfg?.startupState ?? "remember",
      state: {
        paused: st?.paused ?? false, pauseReason: st?.pauseReason ?? null, overrideMapId: st?.overrideMapId ?? null,
        skipNext: st?.skipNext ?? false, reroll: st?.reroll ?? false,
        startNow: st?.startNow ?? false, resyncNow: st?.resyncNow ?? false,
        lastOpenError: st?.lastOpenError ?? null,
        sendMessageLayout: st?.sendMessageLayout ?? null,
        savedOptions: st?.savedOptions ?? [],
        liveAppliedMapId: st?.liveAppliedMapId ?? null,
        liveApplyNote: st?.liveApplyNote ?? null,
        reopenAt: st?.reopenAt ?? null,
        lastMatchEndAt: st?.lastMatchEndAt ?? null,
        // Vote counts are parked on the state row by the worker, so this read never touches Discord.
        activePoll: st?.activeMessageId
          ? {
              options: st.options.map((o, i) => ({ ...o, votes: st.tallies?.[i] ?? 0 })),
              profile: st.profile, openedAt: st.openedAt,
              totalVotes: (st.tallies ?? []).reduce((n, v) => n + v, 0),
              talliedAt: st.talliedAt ?? null,
            }
          : null,
      },
    });
  }),

  /**
   * Which map set is in charge across BOTH axes the schedule turns on — time of day and player
   * count — as exact regions rather than a reading taken at one count. Sets are matched first-wins
   * against a window AND a player gate, so "evenings use prime time" is only true above whatever
   * count the seeding set claims: any answer that fixes one axis to describe the other is wrong
   * somewhere. describeCoverage cuts each axis at the bounds the config itself names and reports
   * whole regions, including the ones no set matches (where the engine falls back to its built-in
   * defaults) — the hole nobody notices until a Tuesday-morning vote offers the wrong maps.
   */
  serverRoute("GET", "/api/servers/:id/mapvote/coverage", "mapvote.config", "read", async ({ res, ctx, id }) => {
    const cfg = await ctx.repo.mapVote.getConfig(id);
    const profiles = (cfg?.profiles ?? []) as unknown as MapVoteProfile[];
    // The config timezone rules the axes; a profile carrying its own `spec.timezone` is shifted
    // inside describeCoverage to where it actually fires on those axes.
    sendJson(res, 200, { timezone: cfg?.timezone ?? "UTC", ...describeCoverage(profiles, cfg?.timezone ?? "UTC") });
  }),

  serverRoute("PUT", "/api/servers/:id/mapvote/config", "mapvote.config", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const parsed = parseMapVoteConfig(body);
    if ("error" in parsed) return sendError(res, 400, parsed.error);
    const v = parsed.value;
    // A pairing that names nothing real would not fail at save time — it would fail silently at
    // vote time, by resolving to nothing and letting the engine offer the whole catalogue. So the
    // names are checked here, against the library, while there is still a person to tell.
    const [sets, schedules] = await Promise.all([ctx.repo.mapSets.list(), ctx.repo.voteSchedules.list()]);
    const setByName = new Map(sets.map((s) => [s.name.toLowerCase(), s]));
    const schedNames = new Set(schedules.map((s) => s.name.toLowerCase()));
    for (const link of v.profiles) {
      const set = setByName.get(link.mapSet.toLowerCase());
      if (!set) return sendError(res, 400, `there is no map set called "${link.mapSet}"`);
      // The set is a list of MAP IDS. Pointing a Vietnam server at a WW2 set composes a poll of maps
      // that server does not have — every option unpickable, and nothing wrong to see until players
      // are looking at the ballot in Discord. Refused here, by name, while there is someone to tell.
      if (set.game !== server.game) {
        return sendError(res, 400, `"${set.name}" is a ${set.game} map set and ${server.name} runs ${server.game} — its maps do not exist on this server`);
      }
      if (link.schedule && !schedNames.has(link.schedule.toLowerCase())) return sendError(res, 400, `there is no schedule called "${link.schedule}"`);
    }
    const row = await ctx.repo.mapVote.setConfig(id, {
      timezone: v.timezone, profiles: v.profiles,
      enabled: v.enabled, surface: v.surface, channelId: v.channelId, pollHours: v.pollHours, reminders: v.reminders,
      liveApply: v.liveApply, postMatchApplyDelaySeconds: v.postMatchApplyDelaySeconds,
      pollResetDelaySeconds: v.pollResetDelaySeconds, tidyChannel: v.tidyChannel, pauseBelowPlayers: v.pauseBelowPlayers,
      registeredOnlyIngame: v.registeredOnlyIngame, registeredOnlyDiscord: v.registeredOnlyDiscord, startupState: v.startupState,
    });
    await ctx.repo.audit.create({
      actorUserId: p.user.id, actorName: p.name, action: "mapvote.config",
      targetType: "server", targetId: id, targetName: server.name, serverId: id,
      summary: `updated map-vote config for ${server.name} (${v.enabled ? "enabled" : "disabled"}, ${v.profiles.length} map set${v.profiles.length === 1 ? "" : "s"})`,
      data: { enabled: v.enabled, surface: v.surface, timezone: v.timezone, profiles: v.profiles.map((x) => x.mapSet) },
    });
    sendJson(res, 200, {
      enabled: row.enabled, surface: row.surface, channelId: row.channelId, pollHours: row.pollHours,
      timezone: row.timezone, reminders: row.reminders, profiles: row.profiles, profileLinks: row.profileLinks,
      liveApply: row.liveApply, postMatchApplyDelaySeconds: row.postMatchApplyDelaySeconds,
      pollResetDelaySeconds: row.pollResetDelaySeconds, tidyChannel: row.tidyChannel, pauseBelowPlayers: row.pauseBelowPlayers,
      registeredOnlyIngame: row.registeredOnlyIngame, registeredOnlyDiscord: row.registeredOnlyDiscord,
      startupState: row.startupState,
    });
  }),

  // Staff controls over the running vote: pause/resume and force-next-map override. These write the
  // worker's runtime state (server.config, audited); the worker acts on them next tick.
  serverRoute("POST", "/api/servers/:id/mapvote/pause", "mapvote.control", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const paused = body.paused === true;
    // A staff pause outranks an automatic one: an auto-pause lifts itself when players come back,
    // a staff pause stays until staff resumes it.
    await ctx.repo.mapVote.patchState(id, { paused, pauseReason: paused ? "staff" : null });
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "mapvote.pause", targetType: "server", targetId: id, targetName: server.name, serverId: id, summary: `${paused ? "paused" : "resumed"} the map vote on ${server.name}` });
    sendJson(res, 200, { paused });
  }),

  serverRoute("POST", "/api/servers/:id/mapvote/override", "mapvote.control", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const mapId = str(body.mapId).trim() || null; // blank clears the override
    await ctx.repo.mapVote.patchState(id, { overrideMapId: mapId });
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "mapvote.override", targetType: "server", targetId: id, targetName: server.name, serverId: id, summary: mapId ? `set map-vote override to ${describeMap(mapId).prettyName} on ${server.name}` : `cleared the map-vote override on ${server.name}`, data: { mapId } });
    sendJson(res, 200, { overrideMapId: mapId });
  }),

  // Abandon the vote that is currently open: the worker closes the poll and applies no winner.
  // A request rather than a direct action, because only the worker holds the Discord token.
  serverRoute("POST", "/api/servers/:id/mapvote/skip", "mapvote.control", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const skipNext = body.skip !== false;
    await ctx.repo.mapVote.patchState(id, { skipNext });
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "mapvote.skip", targetType: "server", targetId: id, targetName: server.name, serverId: id, summary: `${skipNext ? "skipped the current map vote" : "cancelled the skip"} on ${server.name}` });
    sendJson(res, 200, { skipNext });
  }),

  // Throw away the current options and open a fresh poll from the active map set.
  serverRoute("POST", "/api/servers/:id/mapvote/reroll", "mapvote.control", "write", async ({ res, ctx, p, id, server }) => {
    await ctx.repo.mapVote.patchState(id, { reroll: true });
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "mapvote.reroll", targetType: "server", targetId: id, targetName: server.name, serverId: id, summary: `re-rolled the map vote options on ${server.name}` });
    sendJson(res, 200, { reroll: true });
  }),

  // Start a vote right now, whatever state things are in: un-pause, drop any forced map, bin
  // whatever poll is open and put up a brand-new one. The "just fix it" button — the one thing
  // staff can always reach for when the vote has got itself stuck.
  serverRoute("POST", "/api/servers/:id/mapvote/start", "mapvote.control", "write", async ({ res, ctx, p, id, server }) => {
    await ctx.repo.mapVote.patchState(id, {
      startNow: true, paused: false, pauseReason: null, overrideMapId: null,
      skipNext: false, reroll: false, reopenAt: null,
    });
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "mapvote.start", targetType: "server", targetId: id, targetName: server.name, serverId: id, summary: `started a new map vote on ${server.name}` });
    sendJson(res, 200, { startNow: true });
  }),

  // Re-read the server's map list from scratch, then start a fresh vote from it. For when the game
  // has added or renamed maps and our catalogue has gone stale.
  serverRoute("POST", "/api/servers/:id/mapvote/resync", "mapvote.control", "write", async ({ res, ctx, p, id, server }) => {
    await ctx.repo.mapVote.patchState(id, {
      resyncNow: true, startNow: true, paused: false, pauseReason: null, overrideMapId: null,
      recentMaps: [], skipNext: false, reroll: false, reopenAt: null,
    });
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "mapvote.resync", targetType: "server", targetId: id, targetName: server.name, serverId: id, summary: `re-read the map list and restarted the vote on ${server.name}` });
    sendJson(res, 200, { resyncNow: true });
  }),

  // Push the vote to everyone in game right now — either just the map names, or the names with how
  // the vote currently stands. The worker holds the RCON connection, so this is a request it picks up.
  serverRoute("POST", "/api/servers/:id/mapvote/announce", "mapvote.control", "write", async ({ req, res, ctx, p, id, server }) => {
    const body = await readJsonBody(req);
    const layout = body.layout === undefined ? "vote_counts" : str(body.layout).trim();
    if (layout === "none" || !MAPVOTE_MESSAGE_LAYOUTS.includes(layout as MapVoteMessageLayout)) {
      return sendError(res, 400, `layout must be map_list or vote_counts`);
    }
    const st = (await ctx.repo.mapVote.getState(id)) ?? emptyVoteState(id);
    if (!st.activeMessageId) return sendError(res, 409, "no vote is running to announce");
    await ctx.repo.mapVote.patchState(id, { sendMessageLayout: layout });
    await ctx.repo.audit.create({ actorUserId: p.user.id, actorName: p.name, action: "mapvote.announce", targetType: "server", targetId: id, targetName: server.name, serverId: id, summary: `announced the map vote in game on ${server.name} (${layout === "map_list" ? "map list" : "vote counts"})`, data: { layout } });
    sendJson(res, 200, { sendMessageLayout: layout });
  }),

  // What actually happened: recent concluded votes + per-map offered/won totals.
  route("GET", "/api/servers/:id/mapvote/history", async (req, res, ctx, params) => {
    const p = await requirePrincipal(req, res, ctx);
    if (!p) return;
    const id = params.id!;
    if (!can(p.grants, "mapvote.config", "read", { serverId: id })) return sendForbidden(res, "mapvote.config", "read");
    const u = new URL(req.url ?? "", "http://x").searchParams;
    const limit = pageLimit(u, 25, 200);
    const offset = pageOffset(u);
    // The rounds are paged; the tally, voters and summary always describe the WHOLE record —
    // "decided by players 80% of the time" must not change meaning when the reader turns a page.
    const [history, total, summary, tally, voters] = await Promise.all([
      ctx.repo.mapVote.history(id, limit, offset),
      ctx.repo.mapVote.historyCount(id),
      ctx.repo.mapVote.historySummary(id),
      ctx.repo.mapVote.mapTally(id),
      ctx.repo.mapVote.voterSummary(id, 100),
    ]);
    // Reading the vote and reading who cast it are the same job, so map-vote access covers both —
    // votes are public in the Discord channel anyway, and a ballot with the names stripped out
    // can't answer the questions this page exists to answer.
    sendJson(res, 200, { history, total, offset, limit, summary, tally, voters, canSeeVoters: true });
  }),
];
