/**
 * A fake Hell Let Loose server speaking just enough binary-v2 RCON for tests.
 *
 * Every other test in this project points a server at a closed port, which proves routing and
 * refusal but can never prove the half of a route that runs AFTER `client.execute` succeeds — the
 * audit row, the player_ban record, the reconciler's apply. This is the missing endpoint: a real
 * TCP listener doing the real handshake (ServerConnect → XOR key, Login → token) and the real
 * magic-header framing, holding an in-memory ban list the test can read back.
 *
 * Deliberately NOT a general game simulator. It answers the ban verbs and getters with the exact
 * shapes `normalizeGameBans` expects, plus the map rotation and its reference data — the one place
 * where a real server's ANSWER (not its refusal) is the thing under test — and returns an empty 200
 * for everything else. A fake that grows past that becomes a second implementation to keep correct.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

const MAGIC = 0xde450508;

export interface FakeBan {
  playerId: string;
  playerName?: string | null;
  reason: string;
  by: string;
  hours?: number;
  /** When the ban was placed (default: whenever the list is read). A temp ban whose `hours` have
   *  passed since stays on the list and refuses removal with a 400, as HLL does. */
  at?: string;
}

export class FakeHllServer {
  readonly password: string;
  /** The game-side ban lists, readable by tests and pre-loadable for seed/reconcile scenarios. */
  tempBans = new Map<string, FakeBan>();
  permaBans = new Map<string, FakeBan>();
  /** The live roster the players read answers with — pre-load for registration scenarios. */
  players: ({ iD: string; name: string; platform?: string } & Record<string, unknown>)[] = [];
  /** Punishes the fake accepted (the target was on the roster). */
  punished: { playerId: string; reason: string }[] = [];
  /** Force PunishPlayer to refuse even for rostered players — the real game does while they're dead. */
  punishRefusal: string | null = null;
  /** Make Remove*Ban answer 200 while deleting nothing — the lying-lift case the post-verify
   *  exists for (an entry the remove command doesn't address, kept while the server says done). */
  unbanSilentlyFails = false;
  /** The match state the session read answers with. Empty by default, so a test that does not care
   *  about the round sees exactly what it always did; set it to exercise the match header. */
  session: Record<string, unknown> = {};
  /** What `GetServerInformation("serverconfig")` answers. The casing is the wire's, not ours. */
  serverConfig: Record<string, unknown> = {
    serverName: "Fake Server", buildNumber: "123456", buildRevision: "abcdef",
    supportedPlatforms: ["Steam", "WinGDK"], passwordProtected: false,
  };
  /** The game-side VIP list (AddVip/RemoveVip + the vipplayers info request) — pre-loadable, and
   *  clearable to stage the wiped-list incident the reconciler exists for. */
  vips = new Map<string, { playerId: string; comment: string }>();
  /** Every in-game message sent through MessagePlayer, so a test can read the code back out. */
  messages: { playerId: string; message: string }[] = [];
  /** Player ids whose NEXT MessagePlayer fails (once) — models a busy server losing a send. */
  dropFirstMessageTo = new Set<string>();
  /** Every command name received, in order — lets a test assert what was (not) sent. */
  received: string[] = [];
  /** …and with its decoded content, for a test that must read WHAT was sent and in which order
   *  (a Vietnam store before the switch, the put-back after it) rather than only the last one. */
  sent: { name: string; content: Record<string, unknown> }[] = [];
  /** Command names the fake refuses (500) while listed — a server failing one step mid-protocol,
   *  which is the case write-ahead bookkeeping exists for. */
  failing = new Set<string>();
  /** GetServerInformation reads, by info name ("players", "serverconfig"…), the fake refuses (500)
   *  while listed — one read failing while the others down the same connection answer. */
  failingInfo = new Set<string>();
  /** Command names the fake hangs up on instead of answering — a reply that never came (a round
   *  restarting under it, say), as distinct from one the server refused (`failing`). */
  dropOn = new Set<string>();
  /** Command names the fake CARRIES OUT and then answers 500 for — a lagging server whose reply
   *  is lost to the client's timeout while the write itself landed, so the caller cannot know
   *  what stands. */
  lostReplies = new Set<string>();
  /** Command names the fake answers 200 for and then ignores — a write the server accepted and
   *  did not keep. */
  swallowing = new Set<string>();
  /**
   * Called with every command as it arrives, before it is answered, so a test can stage what
   * happens BETWEEN two steps of a protocol: another actor's write landing, a read that starts
   * failing right after a store. The answer waits for it (it may be async), and later commands on
   * the same connection queue behind it, so they are still answered in the order sent. Unset, the
   * fake answers synchronously exactly as it always has.
   */
  onCommand: ((name: string, content: Record<string, unknown>) => void | Promise<void>) | null = null;
  /**
   * The map side, modelled the way a live server actually behaves rather than the way the panel
   * once assumed: every installed map is addable to the rotation, but ChangeMap's OWN option list
   * is the ROTATION — and a switch to a map outside it is swallowed with a 200 and no effect.
   * That silent no-op is the whole reason the change route reads a list before it writes.
   */
  catalogue: string[] = [];
  rotation: string[] = [];
  /** The game's own place in the rotation (what it reports as currentIndex). It plays the entry
   *  AFTER this one — and edits do not move it the way the list order suggests. */
  rotationIndex = 0;
  /** The game's play queue (GetServerInformation "mapsequence") and its place in it. null = the
   *  server does not answer, which is what every test not about it wants. */
  sequence: (string | Record<string, unknown>)[] | null = null;
  sequenceIndex = 0;
  /** What the game says each rotation entry IS (name, mode, time of day) — the words the play
   *  queue's entries carry too, which is the only thing the two lists share. */
  mapDetails = new Map<string, { name: string; gameMode: string; timeOfDay: string }>();
  /** GetMapShuffleEnabled's answer; null = not answered. */
  shuffle: boolean | null = null;
  /** The map the last accepted ChangeMap switched to; null while every attempt was swallowed. */
  changedTo: string | null = null;
  /** The current map's 5×3 objective grid (GetClientReferenceData "SetSectorLayout") — empty
   *  means the server has nothing to say, which is what a loading match looks like. */
  objectiveRows: string[][] = [];
  /** Per-map grids, by the session's map id: when the map in play has one, it answers instead of
   *  `objectiveRows` — the game only ever names the options of the map PLAYING. */
  objectiveRowsByMap = new Map<string, string[][]>();
  /** Off by default (every older test expects the session to hold still): when on, an accepted
   *  ChangeMap also moves the session onto the new map, as if the load screen took no time. */
  followChangeMap = false;
  /** Raw admin-log lines GetAdminLog answers with ("[1 min (1759000000)] MATCH START …"). Empty by
   *  default — the same nothing the fake always answered — so older tests read no log at all. */
  adminLog: string[] = [];
  /** The last SetSectorLayout payload, so a test can read back what was actually sent. */
  sectorLayout: Record<string, unknown> | null = null;
  /** Vietnam's PERSISTENT layouts: a Set that names a MapId stores here (re-applied every time
   *  that map plays, per the p11 semantics), RemoveSectorLayout deletes, GetSectorLayout lists.
   *  WW2's set names no map and stores nothing — exactly the split the panel must respect. */
  storedLayouts = new Map<string, number[]>();
  /** The last welcome/notice write — command name kept because WW2 says SetWelcomeMessage and
   *  Vietnam says SetNoticeMessage, and a test proving the game split must see which arrived. */
  welcomeSet: { command: string; message: string } | null = null;
  private server: Server | null = null;
  private key = Buffer.from("fake-key");

  constructor(password = "x") {
    this.password = password;
  }

  async listen(): Promise<number> {
    this.server = createServer((sock) => this.handle(sock));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return (this.server!.address() as AddressInfo).port;
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  private handle(sock: Socket): void {
    let recv = Buffer.alloc(0);
    let keyed = false; // becomes true after ServerConnect — from then on both directions XOR
    /** A command still waiting on onCommand: everything after it on this socket answers after it. */
    let behind: Promise<void> | null = null;
    const xor = (b: Buffer) => {
      if (!keyed) return b;
      const out = Buffer.allocUnsafe(b.length);
      for (let i = 0; i < b.length; i++) out[i] = b[i]! ^ this.key[i % this.key.length]!;
      return out;
    };
    const write = (requestId: number, name: string, statusCode: number, contentBody: string) => {
      const body = xor(Buffer.from(JSON.stringify({ name, version: 2, statusCode, statusMessage: statusCode === 200 ? "OK" : "refused", contentBody }), "utf8"));
      const head = Buffer.allocUnsafe(12);
      head.writeUInt32LE(MAGIC, 0);
      head.writeUInt32LE(requestId, 4);
      head.writeUInt32LE(body.length, 8);
      sock.write(Buffer.concat([head, body]));
    };

    /** Answer one command. Everything it does to the fake's state happens here, after any hook. */
    const respond = (requestId: number, name: string, content: Record<string, unknown>, req: { name?: string; contentBody?: string }): void => {
      const reply = (id: number, n: string, statusCode: number, body: string) =>
        statusCode === 200 && this.lostReplies.has(n) ? write(id, n, 500, "no answer in time") : write(id, n, statusCode, body);
      if (this.failing.has(name) || (name === "GetServerInformation" && this.failingInfo.has(String(content.Name)))) {
        reply(requestId, name, 500, "refused by the test");
        return;
      }
      if (this.swallowing.has(name)) {
        reply(requestId, name, 200, "");
        return;
      }

      if (name === "ServerConnect") {
        // The key travels in the clear; the client starts XORing only after it lands.
        reply(requestId, name, 200, this.key.toString("base64"));
        keyed = true;
      } else if (name === "Login") {
        reply(requestId, name, req.contentBody === this.password ? 200 : 401, "tok");
      } else if (name === "TemporaryBanPlayer") {
        this.tempBans.set(String(content.PlayerId), { playerId: String(content.PlayerId), reason: String(content.Reason ?? ""), by: String(content.AdminName ?? ""), hours: Number(content.Duration ?? 0) });
        reply(requestId, name, 200, "");
      } else if (name === "PermanentBanPlayer") {
        this.permaBans.set(String(content.PlayerId), { playerId: String(content.PlayerId), reason: String(content.Reason ?? ""), by: String(content.AdminName ?? "") });
        reply(requestId, name, 200, "");
      } else if (name === "RemoveTemporaryBan") {
        // HLL keeps listing a temp ban after its time runs out, and will not remove it.
        const held = this.tempBans.get(String(content.PlayerId));
        if (held?.at && held.hours && Date.parse(held.at) + held.hours * 3_600_000 <= Date.now()) {
          reply(requestId, name, 400, "Unable to perform request. Request was invalid");
          return;
        }
        if (!this.unbanSilentlyFails) this.tempBans.delete(String(content.PlayerId));
        reply(requestId, name, 200, "");
      } else if (name === "RemovePermanentBan") {
        if (!this.unbanSilentlyFails) this.permaBans.delete(String(content.PlayerId));
        reply(requestId, name, 200, "");
      } else if (name === "GetAdminLog") {
        reply(requestId, name, 200, JSON.stringify({ entries: this.adminLog.map((message) => ({ message })) }));
      } else if (name === "GetClientReferenceData") {
        // The body is the bare command name, and the answer is THAT command's options. The
        // rotation command offers every installed map; ChangeMap offers the rotation; the
        // sector command answers five Sector_N rows.
        const about = String(req.contentBody ?? "");
        if (about === "SetSectorLayout") {
          const grid = this.objectiveRowsByMap.get(String(this.session.mapId ?? "")) ?? this.objectiveRows;
          reply(requestId, name, 200, JSON.stringify({
            dialogueParameters: grid.map((opts, i) => ({ iD: `Sector_${i + 1}`, valueMember: opts.join(",") })),
          }));
        } else {
          const options = about === "ChangeMap" ? this.rotation : about === "AddMapToRotation" ? this.catalogue : [];
          reply(requestId, name, 200, JSON.stringify({ dialogueParameters: [{ iD: "MapName", valueMember: options.join(",") }] }));
        }
      } else if (name === "SetSectorLayout") {
        this.sectorLayout = content;
        if (String(content.MapId ?? "").trim()) {
          this.storedLayouts.set(String(content.MapId),
            [content.Sector_1, content.Sector_2, content.Sector_3, content.Sector_4, content.Sector_5].map(Number));
        }
        reply(requestId, name, 200, "");
      } else if (name === "RemoveSectorLayout") {
        this.storedLayouts.delete(String(content.MapId ?? ""));
        reply(requestId, name, 200, "");
      } else if (name === "GetSectorLayout") {
        reply(requestId, name, 200, JSON.stringify({
          entries: [...this.storedLayouts.entries()].map(([mapId, sectors]) => ({ mapId, sectors })),
        }));
      } else if (name === "SetWelcomeMessage" || name === "SetNoticeMessage") {
        this.welcomeSet = { command: name, message: String(content.Message ?? "") };
        reply(requestId, name, 200, "");
      } else if (name === "GetServerInformation" && content.Name === "maprotation") {
        reply(requestId, name, 200, JSON.stringify({ mAPS: this.rotation.map((id) => ({ iD: id, name: id.toUpperCase(), ...this.mapDetails.get(id) })), currentIndex: this.rotationIndex }));
      } else if (name === "GetServerInformation" && content.Name === "mapsequence" && this.sequence) {
        reply(requestId, name, 200, JSON.stringify({ mAPS: this.sequence.map((e) => (typeof e === "string" ? { iD: e } : e)), currentIndex: this.sequenceIndex }));
      } else if (name === "GetMapShuffleEnabled" && this.shuffle !== null) {
        reply(requestId, name, 200, JSON.stringify({ enable: this.shuffle }));
      } else if (name === "SetMapShuffleEnabled") {
        this.shuffle = content.Enable === true;
        reply(requestId, name, 200, "");
      } else if (name === "AddMapToRotation") {
        const at = Number(content.Index);
        this.rotation.splice(Number.isFinite(at) ? at : this.rotation.length, 0, String(content.MapName));
        reply(requestId, name, 200, "");
      } else if (name === "RemoveMapFromRotation") {
        // Removal is BY INDEX — the map name rides along as a cross-check the game does not
        // enforce, which is why the route resolves the index itself rather than trusting a
        // caller's stale one. Modelled here because without it a removal answered 200 and
        // changed nothing, so any test of removing a map was passing on a no-op.
        const at = Number(content.Index);
        if (Number.isInteger(at) && at >= 0 && at < this.rotation.length) this.rotation.splice(at, 1);
        reply(requestId, name, 200, "");
      } else if (name === "ChangeMap") {
        // 200 either way — an unlisted map is accepted and ignored, which is indistinguishable
        // from success on the wire and is exactly what a caller must not be told worked.
        const wanted = String(content.MapName);
        if (this.rotation.includes(wanted)) {
          this.changedTo = wanted;
          if (this.followChangeMap) this.session = { ...this.session, mapId: wanted };
        }
        reply(requestId, name, 200, "");
      } else if (name === "GetServerInformation" && content.Name === "players") {
        // The WHOLE row, extra fields included — the real game sends far more than tests set
        // (worldPosition among them), and a fake that trims to the polite subset lets a
        // projection leak fields the tests never saw. Spread first so iD/name/platform win.
        reply(requestId, name, 200, JSON.stringify({ players: this.players.map((p) => ({ ...p, iD: p.iD, name: p.name, platform: p.platform ?? "steam" })) }));
      } else if (name === "GetServerInformation" && content.Name === "serverconfig") {
        reply(requestId, name, 200, JSON.stringify(this.serverConfig));
      } else if (name === "GetServerInformation" && content.Name === "session") {
        reply(requestId, name, 200, JSON.stringify(this.session));
      } else if (name === "GetServerInformation" && content.Name === "vipplayers") {
        // Same key + entry casing as the live capture (`vipPlayers`, entries keyed like players).
        reply(requestId, name, 200, JSON.stringify({ vipPlayers: [...this.vips.values()].map((v) => ({ iD: v.playerId, comment: v.comment })) }));
      } else if (name === "AddVip") {
        this.vips.set(String(content.PlayerId), { playerId: String(content.PlayerId), comment: String(content.Comment ?? "") });
        reply(requestId, name, 200, "");
      } else if (name === "RemoveVip") {
        this.vips.delete(String(content.PlayerId));
        reply(requestId, name, 200, "");
      } else if (name === "MessagePlayer") {
        // A busy server dropping a send: the first message to a listed player fails once.
        if (this.dropFirstMessageTo.delete(String(content.PlayerId))) {
          reply(requestId, name, 500, "server busy");
          return;
        }
        this.messages.push({ playerId: String(content.PlayerId), message: String(content.Message ?? "") });
        reply(requestId, name, 200, "");
      } else if (name === "PunishPlayer") {
        // The real server refuses a punish for a player it does not have — modelled because
        // without it "punish someone who already left" answered 200, and the refusal path
        // (409 with a reason, not a bare upstream 502) was untestable.
        const pid = String(content.PlayerId);
        if (!this.players.some((p) => p.iD === pid)) {
          reply(requestId, name, 400, "Player not found");
        } else if (this.punishRefusal) {
          reply(requestId, name, 400, this.punishRefusal);
        } else {
          this.punished.push({ playerId: pid, reason: String(content.Reason ?? "") });
          reply(requestId, name, 200, "");
        }
      } else if (name === "GetTemporaryBans" || name === "GetPermanentBans") {
        const list = name === "GetTemporaryBans" ? this.tempBans : this.permaBans;
        reply(requestId, name, 200, JSON.stringify({
          banList: [...list.values()].map((b) => ({
            userId: b.playerId, userName: b.playerName ?? null, timeOfBanning: b.at ?? new Date().toISOString(),
            durationHours: b.hours ?? 0, banReason: b.reason, adminName: b.by,
          })),
        }));
      } else {
        // Everything else answers OK-and-empty, so an incidental read (server-name resolution,
        // a session probe) never fails a test that is not about it.
        reply(requestId, name, 200, "{}");
      }
    };

    sock.on("data", (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      while (recv.length >= 12) {
        if (recv.readUInt32LE(0) !== MAGIC) { sock.destroy(); return; }
        const requestId = recv.readUInt32LE(4);
        const bodyLen = recv.readUInt32LE(8);
        if (recv.length < 12 + bodyLen) break;
        const bodyBuf = xor(recv.subarray(12, 12 + bodyLen));
        recv = recv.subarray(12 + bodyLen);
        let req: { name?: string; contentBody?: string };
        try { req = JSON.parse(bodyBuf.toString("utf8")); } catch { sock.destroy(); return; }
        const name = String(req.name ?? "");
        this.received.push(name);
        const content = (() => { try { return JSON.parse(req.contentBody || "{}"); } catch { return {}; } })() as Record<string, unknown>;
        this.sent.push({ name, content: content && typeof content === "object" ? content : {} });
        if (this.dropOn.has(name)) { sock.destroy(); return; }
        const hook = this.onCommand;
        if (!hook && !behind) {
          respond(requestId, name, content, req);
          continue;
        }
        const mine = (behind ?? Promise.resolve())
          .then(() => hook?.(name, content))
          .catch(() => {})
          .then(() => respond(requestId, name, content, req));
        behind = mine;
        void mine.finally(() => { if (behind === mine) behind = null; });
      }
    });
    sock.on("error", () => {});
  }
}

/** A game server the app can actually talk to: fake HLL + the API rows pointing at it, armed. */
export async function fakeGameServer(base: string, token: string, name = "fake", game?: string): Promise<{ fake: FakeHllServer; serverId: string }> {
  const fake = new FakeHllServer("pw");
  const port = await fake.listen();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const created = await fetch(`${base}/api/servers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name, host: "127.0.0.1", port, password: "pw", ...(game ? { game } : {}) }),
  }).then((r) => r.json()) as { server: { id: string } };
  const serverId = created.server.id;
  // Servers are born in observe mode (safe default); a fake that exists to receive writes arms it.
  await fetch(`${base}/api/servers/${serverId}/engagement`, { method: "POST", headers: auth, body: JSON.stringify({ mode: "active" }) });
  return { fake, serverId };
}
