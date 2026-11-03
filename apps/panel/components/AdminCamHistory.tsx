"use client";
/**
 * Admin camera history — who went into spectator, on which server, when, and for how long.
 *
 * Spectator is the one staff power that leaves no audit row: nobody is kicked, nothing is granted,
 * and the only trace is a line in the game log that scrolls past and eventually gets trimmed. So
 * the enter/leave pair is stored on its own and read back here, which turns "was anyone watching
 * last night" from an archaeology exercise into a sort.
 *
 * Community-wide by default rather than one server at a time, because that is the shape of the
 * question — and every column sorts SERVER-SIDE. The list is paged, and sorting the twenty rows on
 * screen by duration answers "the longest visit on this page", which nobody has ever wanted to
 * know. Both filters are populated from the record itself: you only appear in the admin dropdown
 * if you have actually been in cam.
 */
import { useCallback, useMemo, useState } from "react";
import { api } from "../lib/api";
import { usePagedList } from "../lib/paged";
import { PanelGroup, Panel } from "./Panel";
import { PlayerLink } from "./PlayerLink";
import { Time } from "./Time";
import { ActionResult, GoTo, Nothing, Pager, SettingCard, SkeletonRows, Toggle, Explanation } from "./ui";
import { useEffect } from "react";
import { useResource } from "../lib/resource";
import { useToast } from "../lib/feedback";
import { useServers } from "../lib/servers";
import { isText, oneOf, useRemembered } from "../lib/remembered";
import { useGrants } from "../lib/grants";
import { canOnServer } from "../lib/access";
import { PlaceholderHint } from "./Placeholders";

interface CamSession {
  id: string;
  serverId: string;
  serverName: string;
  playerId: string | null;
  playerName: string;
  enteredAt: string;
  exitedAt: string | null;
  durationSec: number | null;
}
interface Page {
  sessions: CamSession[];
  total: number;
  admins: { playerId: string | null; playerName: string }[];
  servers: { id: string; name: string }[];
}

const SORTS = ["entered", "exited", "duration", "who", "server"] as const;
type Sort = (typeof SORTS)[number];

interface SelfCheck {
  serverName: string;
  seconds: number;
  engagementMode: string;
  notify: { enabled: boolean; enterMessage: string; exitMessage: string };
  read: { ok: true; lines: number; camera: { raw: string; parsed: { name: string | null; playerId: string | null; entered: boolean | null } | null }[] }
    | { ok: false; error: string };
  stored: { events: number; visits: number; sample: { ts: string; actorName: string | null; entered: boolean | null }[] };
}

/**
 * Ask the server where the chain breaks.
 *
 * This page's failure mode is an empty table that explains nothing: a camera visit is one line in
 * the admin log, and if the game does not print it, or the poll misses it, or the parser does not
 * recognise it, or the pairing drops it, the result is identical — nothing. We have twice gone
 * hunting for the cause by reading our own source and reasoning about what the game probably
 * prints. This asks it instead, and shows the raw lines it sent back.
 */
function SelfCheck({ servers }: { servers: { id: string; name: string }[] }) {
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [out, setOut] = useState<SelfCheck | null>(null);
  const target = pick || servers[0]?.id || "";

  async function run() {
    if (!target) return;
    setBusy(true); setErr(""); setOut(null);
    try { setOut(await api<SelfCheck>(`/servers/${target}/admincam/selfcheck?seconds=3600`)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  // The verdict, in the order the chain runs — the first link that comes back empty is the answer,
  // so this stops at the first one rather than listing every downstream symptom of it.
  const verdict = (() => {
    if (!out) return null;
    if (!out.read.ok) return { bad: true, text: `Could not read the admin log: ${out.read.error}. Nothing downstream can work until that does.` };
    if (out.read.lines === 0) return { bad: true, text: `The server returned no admin log at all for the last hour. That is upstream of anything this app does — check RCON access and that the game is writing an admin log.` };
    if (out.read.camera.length === 0) return { bad: true, text: `${out.read.lines} log line${out.read.lines === 1 ? "" : "s"} came back and not one of them mentions the camera. Either nobody was in cam in the last hour, or this server is not printing camera lines to the admin log — try again while somebody is in spectator.` };
    const unparsed = out.read.camera.filter((c) => !c.parsed).length;
    if (unparsed) return { bad: true, text: `${unparsed} of ${out.read.camera.length} camera line${out.read.camera.length === 1 ? "" : "s"} came back in a shape our parser does not recognise. The raw text is below — that is the fix.` };
    const noDirection = out.read.camera.filter((c) => c.parsed?.entered == null).length;
    if (noDirection) return { bad: true, text: `${noDirection} camera line${noDirection === 1 ? "" : "s"} parsed, but the wording does not say whether the admin went in or came out, so the visit cannot be paired. The raw text is below.` };
    if (out.stored.events === 0) return { bad: true, text: `Camera lines are on the wire and parse cleanly, but none were stored. The worker is not ingesting this server — check that it is running and connected.` };
    return { bad: false, text: `The chain is intact: ${out.read.camera.length} camera line${out.read.camera.length === 1 ? "" : "s"} read, ${out.stored.events} stored in the last hour, ${out.stored.visits} visit${out.stored.visits === 1 ? "" : "s"} recorded in total.` };
  })();

  return (
    <>
      <Explanation>
        Nothing here, and it should not be empty? This asks the server directly and shows what it
        sent back, rather than leaving you to guess which link in the chain is broken.
      </Explanation>
      <div className="control-row">
        <label style={{ margin: 0, flex: "1 1 200px" }}>Server
          <select value={target} onChange={(e) => setPick(e.target.value)}>
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button className="primary" disabled={!target || busy} onClick={() => void run()}>
          {busy ? "Checking…" : "Check the last hour"}
        </button>
      </div>
      <ActionResult error={err} />

      {out && (
        <>
          {verdict && <p className={verdict.bad ? "error" : "hint"}>{verdict.text}</p>}
          <table className="table">
            <tbody>
              <tr>
                <th>In-game announcement</th>
                <td>
                  {out.notify.enabled
                    ? <>on — “{out.notify.enterMessage || "(nothing on entry)"}”</>
                    : <><span className="badge">off</span> players are not told when an admin is watching. This is the switch, and it is separate from the record below.</>}
                  {out.engagementMode !== "active" && <> · this server is in <strong>observe</strong> mode, which never writes to the game, so nothing would be announced either way.</>}
                </td>
              </tr>
              <tr>
                <th>Admin log read</th>
                <td>{out.read.ok ? `${out.read.lines} line${out.read.lines === 1 ? "" : "s"} in the last hour, ${out.read.camera.length} mentioning the camera` : `failed — ${out.read.error}`}</td>
              </tr>
              <tr>
                <th>Stored</th>
                <td>{out.stored.events} camera events in the last hour · {out.stored.visits} paired visits, all time</td>
              </tr>
            </tbody>
          </table>

          {out.read.ok && out.read.camera.length > 0 && (
            <>
              <h4>What the server actually sent</h4>
              <div className="scroll-x">
                <table className="table">
                  <thead><tr><th>Raw line</th><th>Read as</th></tr></thead>
                  <tbody>
                    {out.read.camera.map((c, i) => (
                      <tr key={i}>
                        <td><code>{c.raw}</code></td>
                        <td>
                          {!c.parsed ? <span className="badge err">not recognised</span>
                            : c.parsed.entered == null ? <span className="badge warn-badge">{c.parsed.name} — direction unclear</span>
                            : <>{c.parsed.name} {c.parsed.entered ? "entered" : "left"}</>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

/** "1h 04m", "3m 20s", "12s" — a length, read at a glance, not a raw second count. */
function dur(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * A sortable header that drives the SERVER-side sort. Deliberately not the shared `SortTh`: that
 * one reorders an array already in hand, which is the wrong answer for a paged list.
 */
function Th({ k, sort, dir, onSort, children, numeric }: {
  k: Sort; sort: Sort; dir: "asc" | "desc"; onSort: (k: Sort) => void;
  children: React.ReactNode; numeric?: boolean;
}) {
  const active = sort === k;
  return (
    <th className={numeric ? "num" : undefined} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className="linklike" onClick={() => onSort(k)}>
        {children}{active ? (dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}

export default function AdminCamHistory() {
  // The server and admin filtered to and the page, for the sitting; the order, like every table's,
  // until it is changed.
  const [serverId, setServerId] = useRemembered("admincam.server", "", isText, "session");
  const [playerId, setPlayerId] = useRemembered("admincam.admin", "", isText, "session");
  const [sort, setSort] = useRemembered<Sort>("admincam.sort", "entered", oneOf(SORTS), "local");
  const [dir, setDir] = useRemembered<"asc" | "desc">("admincam.dir", "desc", oneOf(["asc", "desc"] as const), "local");
  // The filter dropdowns come from the response, so they survive a page change — a page of results
  // that happens to contain one admin must not shrink the dropdown to that one admin.
  const [meta, setMeta] = useState<{ admins: Page["admins"]; servers: Page["servers"] }>({ admins: [], servers: [] });

  const fetchPage = useCallback(async (offset: number, limit: number) => {
    const q = new URLSearchParams({ offset: String(offset), limit: String(limit), sort, dir });
    if (serverId) q.set("serverId", serverId);
    if (playerId) q.set("playerId", playerId);
    const r = await api<Page>(`/admincam/history?${q}`);
    setMeta({ admins: r.admins ?? [], servers: r.servers ?? [] });
    return { items: r.sessions ?? [], total: r.total ?? 0 };
  }, [serverId, playerId, sort, dir]);
  const list = usePagedList<CamSession>(fetchPage, "admincam");

  // Clicking the active column flips the direction; a new column starts at the sensible end —
  // newest first for times, longest first for duration, A-Z for names.
  const onSort = (k: Sort) => {
    if (k === sort) { setDir((d) => (d === "asc" ? "desc" : "asc")); return; }
    setSort(k);
    setDir(k === "who" || k === "server" ? "asc" : "desc");
  };

  const anyFilter = Boolean(serverId || playerId);
  const rows = list.items;
  const open = useMemo(() => (rows ?? []).filter((r) => r.exitedAt === null).length, [rows]);

  return (
    <PanelGroup viewId="admincam-history">
      {/* The announcement setting sits with the record it announces. It is per server, so it
          follows the server picker rather than this page's (multi-server) history filter. */}
      <CamNoticeForActiveServer />
      <Panel id="cam" caps="open" title="Admin camera"
        subtitle={open > 0 ? `${open} in cam right now` : "who has been in spectator"}>
        <Explanation>
          Every visit to the admin camera, on every server you can see. A row with no exit time is
          somebody who is in the camera <strong>right now</strong>.
        </Explanation>
        <ActionResult error={list.error} />

        <div className="control-row">
          <label style={{ margin: 0, flex: "1 1 180px" }}>Server
            <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
              <option value="">Every server</option>
              {meta.servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label style={{ margin: 0, flex: "1 1 180px" }}>Admin
            <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
              <option value="">Everyone</option>
              {meta.admins.filter((a) => a.playerId).map((a) => (
                <option key={a.playerId!} value={a.playerId!}>{a.playerName}</option>
              ))}
            </select>
          </label>
          {anyFilter && (
            <button className="ghost mini" onClick={() => { setServerId(""); setPlayerId(""); }}>Clear</button>
          )}
        </div>

        {!rows && !list.error ? <SkeletonRows rows={6} cols={5} /> : (
          rows && rows.length === 0
            ? <Nothing>{anyFilter ? "No camera sessions match those filters." : "Nobody has been in the admin camera yet."}</Nothing>
            : (
              <>
                <div className="scroll-x">
                  <table className="table">
                    <thead><tr>
                      <Th k="who" sort={sort} dir={dir} onSort={onSort}>Admin</Th>
                      <Th k="server" sort={sort} dir={dir} onSort={onSort}>Server</Th>
                      <Th k="entered" sort={sort} dir={dir} onSort={onSort}>Entered</Th>
                      <Th k="exited" sort={sort} dir={dir} onSort={onSort}>Exited</Th>
                      <Th k="duration" sort={sort} dir={dir} onSort={onSort} numeric>In cam for</Th>
                    </tr></thead>
                    <tbody>
                      {(rows ?? []).map((r) => (
                        <tr key={r.id}>
                          <td><PlayerLink playerId={r.playerId} name={r.playerName} /></td>
                          <td>{r.serverName}</td>
                          <td><Time iso={r.enteredAt} /></td>
                          <td>{r.exitedAt ? <Time iso={r.exitedAt} /> : <span className="badge ok">still in</span>}</td>
                          <td className="num">{dur(r.durationSec)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager list={list} noun="camera session" />
              </>
            )
        )}
      </Panel>
      {meta.servers.length > 0 && (
        <Panel id="cam-check" caps="open" title="Is it working?" subtitle="check the chain, server by server">
          <SelfCheck servers={meta.servers} />
        </Panel>
      )}
    </PanelGroup>
  );
}

/** The moved announcement panel, bound to the server picker's current server. Rendered nowhere
 *  else: on a page that lists every server's visits, the SETTING still belongs to one server. */
function CamNoticeForActiveServer() {
  const { serverId, server } = useServers();
  const grants = useGrants();
  if (!serverId) return null;
  return <AdminCamNotice serverId={serverId} serverName={server?.name} canManage={canOnServer(grants, "server.admins", serverId)} />;
}

interface AdminCamConfig { notifyEnabled: boolean; enterMessage: string; exitMessage: string }

/**
 * Tell players in game when an admin goes into the camera.
 *
 * It lives on the Admin camera page, with the record of every visit it is the announcement for.
 * It spent a long time on Console admins — a page about WHO may use the camera, not about what
 * happens when they do — where nobody looking for camera settings thought to check. The three
 * cam notification surfaces are now findable from the thing they are about: this announces to
 * PLAYERS, an Auto settings rule pings STAFF, and the Discord relay's Admin category carries it
 * with the rest of the moderation feed.
 *
 * Off by default, and it stays a choice: some communities want players to know they are being
 * watched (it settles a server down on its own), others consider being seen the opposite of what a
 * camera is for. Either message can be left blank to announce only the other half.
 */
export function AdminCamNotice({ serverId, serverName, canManage }: { serverId: string; serverName?: string; canManage: boolean }) {
  const toast = useToast();
  const load = useCallback(() => api<AdminCamConfig>(`/servers/${serverId}/admincam/config`), [serverId]);
  const { data, error, reload } = useResource(load);
  const [draft, setDraft] = useState<AdminCamConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The loaded config is the starting point; edits live in the draft until Save.
  useEffect(() => { setDraft(data ? { ...data } : null); }, [data]);
  const cfg = draft ?? data;
  const dirty = Boolean(draft && data && JSON.stringify(draft) !== JSON.stringify(data));

  async function save() {
    if (!draft) return;
    setBusy(true); setErr("");
    try {
      await api(`/servers/${serverId}/admincam/config`, { method: "PUT", body: draft });
      toast.success("Admin camera notification saved");
      reload();
    } catch (e) { setErr((e as Error).message); toast.error((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Panel id="admincam" caps="open" title="Admin camera" subtitle={cfg?.notifyEnabled ? "players are told" : "silent"}
      actions={dirty ? <button className="primary" onClick={save} disabled={busy || !canManage}>{busy ? "Saving…" : "Save"}</button> : undefined}>
      <ActionResult error={err || (error ? String(error) : "")} />
      <SettingCard
        title={`Announce in game when an admin enters the camera on ${serverName ?? "this server"}`}
        description="Off by default. Turning it on broadcasts to everyone on the server — it is a policy choice, not a log setting."
      >
        <Toggle checked={cfg?.notifyEnabled ?? false} disabled={!canManage || !cfg}
          onChange={(v) => setDraft((d) => (d ? { ...d, notifyEnabled: v } : d))}
          label={cfg?.notifyEnabled ? "On" : "Off"} />
      </SettingCard>
      {cfg?.notifyEnabled && (
        <div className="grid">
          <label>When they enter
            <input value={cfg.enterMessage} disabled={!canManage}
              onChange={(e) => setDraft((d) => (d ? { ...d, enterMessage: e.target.value } : d))}
              placeholder="An admin is now watching. {player}" />
          </label>
          <label>When they leave
            <input value={cfg.exitMessage} disabled={!canManage}
              onChange={(e) => setDraft((d) => (d ? { ...d, exitMessage: e.target.value } : d))}
              placeholder="Leave blank to say nothing" />
          </label>
          <Explanation>
            Write <code>{"{player}"}</code> to include the admin&rsquo;s <strong>in-game</strong> name —
            it is read off the game log, so their Discord name is not available here. (The
            <code>{"{staff}"}</code> token on <GoTo view="admin" tab="templates">signatures</GoTo> is the
            other way round: that one IS the Discord name.) Leave a box empty and that half is not
            announced — announcing only the entry is the usual choice.
          </Explanation>
          <div style={{ gridColumn: "1 / -1" }}><PlaceholderHint scope="server" extra={["player"]} /></div>
        </div>
      )}
      <p className="hint">
        Every visit to the camera is recorded either way, announced or not:{" "}
        <GoTo view="history" tab="admincam">History → Admin camera</GoTo>.
      </p>
    </Panel>
  );
}
