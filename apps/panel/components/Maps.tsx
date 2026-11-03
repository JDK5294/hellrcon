"use client";
/**
 * Maps — the map in play, the rotation, the vote, and the catalogue, as four tabs.
 *
 * It used to be one page you scrolled for ~2700px, with the map vote's nine-step configuration
 * wizard sitting in the middle of it. That put the thing you touch during a match (start the vote,
 * force a map, tell players) below the thing you touch once a year (which maps are eligible), and
 * buried both. Every other section of the panel is a hub; this was the last long page.
 *
 * The split is by WHEN you need it, not by what the data is:
 *   • Vote       — the live control surface. Lands first because it is the only tab with a clock.
 *   • Rotation   — what is playing and what follows it, plus this match's objectives.
 *   • Vote setup — which maps are eligible and where the poll posts. Rarely opened, and fine.
 *   • Catalogue  — every known map, its display name and family, and the tools to fix a stray.
 *
 * "Change now" loads a map immediately, ending the round in progress; the rotation is untouched.
 * Queueing a map instead (the collapse-and-verify placement) replaces the rotation with
 * the chosen map. Reading is open to anyone who can view the server; actions are gated separately —
 * maps.control for rotation and map changes, mapvote.config for anything about the vote. Those are two
 * different permissions and were previously conflated, which let the panel offer vote buttons the
 * API would then refuse.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, wasFiled } from "../lib/api";
import { useAlert, useConfirm } from "../lib/feedback";
import { useServers } from "../lib/servers";
import { isFlag, isText, useRemembered } from "../lib/remembered";
import { useLatestLoad } from "../lib/resource";
import { useGame } from "../lib/game";
import { onDemand } from "../lib/onDemand";
import { ActionResult, AskNotice, Callout, Hub, Nothing, ObserveBanner, SearchInput, SkeletonLines, Toggle, type HubTab, Explanation, ScreenLoading } from "./ui";
import { MapVoteControl } from "./MapVoteControl";
import { MapPicker } from "./MapPicker";
import { PanelGroup, Panel } from "./Panel";
import { liveMapUrl, mapImageUrl, mapIconUrl } from "../lib/gameAssets";
import { Time } from "./Time";
import { useAppNav } from "../lib/nav";

// The vote tab's screen is fetched the first time that tab opens.
const MapVote = onDemand(() => import("./MapVote"), "default", ScreenLoading);

interface MapItem {
  id: string; prettyName: string; defaultName?: string; custom?: boolean;
  mode: string; environment: string;
  /** effective family: the staff override where there is one, else the id-inferred default. */
  family: string; defaultFamily?: string; customFamily?: boolean;
}
interface MapsResponse {
  maps: MapItem[]; rotation: MapItem[]; current: MapItem | null; currentIndex: number;
  /** Raw ids ChangeMap will accept. null = this build didn't say, so don't restrict anything. */
  changeable?: string[] | null;
  /** the automated map vote is on for this server, so it manages the rotation. */
  voteManaged?: boolean;
  /** …but paused, so it is leaving the rotation alone until staff resume it. */
  votePaused?: boolean;
  /** The rotation entry the game plays next — the one after the game's own place in the list,
   *  not entry 1. -1 / absent when the server does not say where it is. */
  nextIndex?: number;
  next?: MapItem | null;
  /** The game's own play queue (shuffle reorders it) and the entry it names next; null when the
   *  server does not answer. */
  queue?: { maps: MapItem[]; nextIndex: number; next: MapItem | null } | null;
  /** Whether the game shuffles its play order; null when the server does not say. */
  shuffle?: boolean | null;
  /** When the game was asked for all of the above. */
  checkedAt?: string;
}

/*
 * "Checked …" is stamped with THIS browser's clock when the answer lands, not the server's. The age
 * is measured against the browser's clock, and a server's can be minutes out — a Docker host whose
 * clock lagged after a sleep — which made a check pressed a second ago read "5 min ago", exactly as
 * if it had failed.
 */
function stamp(r: MapsResponse): MapsResponse {
  // An answer missing its lists (a server not yet read) is empty lists: every tab counts them, and
  // the rotation and the catalogue crashed on one.
  return { ...r, maps: r.maps ?? [], rotation: r.rotation ?? [], checkedAt: new Date().toISOString() };
}

/**
 * Each control answers to the permission the server checks for it: changing the map and setting the
 * objectives to `canManage` (maps.next), the rotation editor to `canRotate` (maps.rotation — read
 * shows it and its saved sets, and a change made without write is sent for approval), renaming a
 * map, setting its family and teaching objective locations to `canName` (maps.names).
 */
export default function Maps({ canManage, canRotate, canName, canVote, showVote }: { canManage: boolean; canRotate: boolean; canName: boolean; canVote: boolean; showVote: boolean }) {
  const confirm = useConfirm();
  const alert = useAlert();
  const nav = useAppNav();
  const { serverId, server } = useServers();
  const game = useGame();
  const [data, setData] = useState<MapsResponse | null>(null);
  const [q, setQ] = useRemembered("maps.catalogue.search", "", isText, "session");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [famEditing, setFamEditing] = useState<string | null>(null);
  const [famDraft, setFamDraft] = useState("");
  const [byFamily, setByFamily] = useRemembered("maps.catalogue.byFamily", false, isFlag, "session");

  const claim = useLatestLoad();
  const load = useCallback(() => {
    if (!serverId) return;
    const fresh = claim();
    setErr(""); setData(null);
    api<MapsResponse>(`/servers/${serverId}/maps`)
      .then((r) => { if (fresh()) setData(stamp(r)); })
      .catch((e) => { if (fresh()) setErr(e.message); });
  }, [serverId, claim]);
  useEffect(() => { load(); }, [load]);
  /*
   * "Check from game": ask the game again WITHOUT blanking the page. The answer replaces what is
   * shown; a failure leaves the last answer up with its time beside it, so it is plain how old it is.
   *
   * "Checking…" is its own flag with its own turn counter, not the shared `busy` and not the load
   * guard. Tied to the load guard, a check overtaken by another load (a server switch, or an edit's
   * reload) never cleared it, and the button sat on "Checking…" for good. Now a check's end clears
   * the flag unless a NEWER check owns it, and changing server lets go of it at once.
   */
  const [checking, setChecking] = useState(false);
  const checkTurn = useRef(0);
  useEffect(() => { checkTurn.current++; setChecking(false); }, [serverId]);
  const check = useCallback(() => {
    if (!serverId) return;
    const fresh = claim();
    const turn = ++checkTurn.current;
    setErr(""); setChecking(true);
    api<MapsResponse>(`/servers/${serverId}/maps`)
      .then((r) => { if (fresh()) setData(stamp(r)); })
      .catch((e) => { if (fresh()) setErr(e.message); })
      .finally(() => { if (checkTurn.current === turn) setChecking(false); });
  }, [serverId, claim]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = data?.maps ?? [];
    if (!needle) return list;
    return list.filter((m) => m.prettyName.toLowerCase().includes(needle) || m.id.toLowerCase().includes(needle));
  }, [data, q]);

  /**
   * The maps this server's ChangeMap command lists. It is NOT the set of maps the server will load —
   * it follows the rotation — so it decides how the switch is performed, never whether it is
   * offered. It used to grey out every map outside it, which on a server whose rotation the vote had
   * collapsed to one map meant the whole catalogue was unclickable.
   */
  const changeable = useMemo(
    () => (data?.changeable ? new Set(data.changeable.map((x) => x.toLowerCase())) : null),
    [data],
  );
  const needsStaging = (m: MapItem) => changeable !== null && !changeable.has(m.id.toLowerCase());

  /**
   * Load a map immediately. This ENDS the round people are playing, so it asks plainly rather than
   * with the softer wording the queue-it-up action used — the cost lands on everyone connected.
   *
   * A map outside ChangeMap's list is added to the rotation first (`stage`), because that is what
   * this build needs to switch to it and it is exactly what an admin would do by hand. That is a
   * lasting edit to the rotation, so the confirmation says so before it happens.
   */
  async function changeMapNow(m: MapItem) {
    if (!canManage) return;
    // Whether the rotation append will be needed is the SERVER's decision at the moment the
    // command lands, not this page's — the snapshot behind needsStaging() goes stale the moment
    // the vote collapses the rotation, and deciding from it sent stage:false into a refusal for
    // a map the person had already confirmed. So the dialog covers the conditional append, the
    // request always allows it, and what actually happened comes back in the response.
    const stage = needsStaging(m);
    const confirmed = await confirm({
      title: `Change the map to "${m.prettyName}" now?`,
      body: `This ends the round in progress on ${server?.name ?? "the server"} immediately and everybody reloads into ${m.prettyName}. `
        + (stage
          ? `This server only switches to maps that are in its rotation, so ${m.prettyName} is added to the end of the rotation first — it stays there afterwards and will come round again unless you remove it.`
          : `The rotation is normally left alone; if this build needs the map in it to switch, it is added to the end automatically (remove it on the Rotation tab if it shouldn't come round again).`)
        + ` If map voting is running, it stands down for 5 minutes so it can't fight your pick.`,
      confirmLabel: stage ? "Add to rotation and change" : "Change map now",
      danger: true,
    });
    if (!confirmed) return;
    setBusy(m.id); setErr(""); setOk("");
    try {
      // The round has to END before the new map is live, so the server almost never reports the
      // switch inside this request. Saying "changed" regardless is how a command the game quietly
      // swallowed passed for a success — report what came back instead of what we hoped for.
      const r = await api<{ verified?: boolean; staged?: boolean; listed?: boolean; voteHoldUntil?: string | null }>(
        `/servers/${serverId}/maps/change`, { method: "POST", body: { mapId: m.id, stage: true } });
      const added = r.staged ? ` It was added to the end of the rotation to make that possible.` : "";
      // The server kept a list and the map is still not on it: the switch may be ignored outright,
      // and saying "sent" without that caveat is the lie this route was built to stop telling.
      const unlisted = r.listed === false
        ? ` The server still does not list it for switching, so it may refuse — check back and use the rotation if it hasn't loaded.`
        : "";
      const held = r.voteHoldUntil
        ? ` Map voting is standing down until ${new Date(r.voteHoldUntil).toLocaleTimeString()} so it can't override this — pause or disable it on the Vote tab if the change should stick longer.`
        : "";
      setOk(r.verified
        ? `Map changed to ${m.prettyName}.${added}${held}`
        : `${m.prettyName} sent to the server — the round is ending now.${added}${unlisted}${held} Refresh in a minute to confirm it loaded.`);
      load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }

  // Rotation editing (raw ids everywhere; names are cosmetic). Each op reloads the live rotation.
  async function rotOp(key: string, run: () => Promise<unknown>, done: string) {
    if (!canRotate) return;
    setBusy(key); setErr(""); setOk("");
    try { await run(); setOk(done); load(); }
    catch (e) {
      // A rotation edit that fails says why in a dialog: the panel's line sits above the whole list,
      // and the map pressed — or the add box under the list — can be a screen away from it. Filed
      // for approval is news, not a failure, and keeps the line.
      if (wasFiled(e)) setErr(e.message);
      else void alert({ title: "Couldn't change the rotation", body: (e as Error).message });
    } finally { setBusy(""); }
  }
  const rotAdd = (mapId: string) => rotOp(`add-${mapId}`, () => api(`/servers/${serverId}/maprotation/add`, { method: "POST", body: { mapId } }), "Added to rotation.");
  const rotRemove = async (mapId: string, index: number, name: string) => {
    if (!(await confirm({ title: `Remove "${name}" from the rotation?`, confirmLabel: "Remove", danger: true }))) return;
    return rotOp(`rot-${index}`, () => api(`/servers/${serverId}/maprotation/remove`, { method: "POST", body: { mapId, index } }), "Removed from rotation.");
  };
  const rotMove = (mapId: string, from: number, to: number) =>
    rotOp(`rot-${from}`, () => api(`/servers/${serverId}/maprotation/move`, { method: "POST", body: { mapId, fromIndex: from, toIndex: to } }), "Rotation reordered.");

  // Saved rotations: this game's library sets — pick one to replace the whole rotation with, or
  // save the live rotation under a name. A set with no lineup (a vote recipe) is listed but
  // disabled, so the library reads the same here as in the vote editor.
  const [rotationSets, setRotationSets] = useState<{ id: string; name: string; lineup: number | null }[] | null>(null);
  const [applySetId, setApplySetId] = useState("");
  const [saveSetName, setSaveSetName] = useState("");
  // A failed read is said, not shown as an empty picker that reads as "no saved rotations".
  const [rotationSetsErr, setRotationSetsErr] = useState("");
  useEffect(() => {
    if (!serverId || !canRotate) { setRotationSets(null); setRotationSetsErr(""); return; }
    let live = true;
    api<{ sets: { id: string; name: string; lineup: number | null }[] }>(`/servers/${serverId}/maprotation/sets`)
      .then((r) => { if (live) { setRotationSets(r.sets); setRotationSetsErr(""); } })
      .catch((e) => { if (live) { setRotationSets(null); setRotationSetsErr((e as Error).message); } });
    return () => { live = false; };
  }, [serverId, canRotate, ok]);

  const applySet = async () => {
    const set = rotationSets?.find((x) => x.id === applySetId);
    if (!set) return;
    if (!(await confirm({
      title: `Replace the rotation with "${set.name}"?`,
      body: `The live rotation on ${server?.name ?? "this server"} becomes exactly the ${set.lineup} map(s) this set lists, in its order. Maps not in the set are removed.`,
      confirmLabel: "Replace rotation", danger: true,
    }))) return;
    await rotOp("apply-set", () => api(`/servers/${serverId}/maprotation/apply-set`, { method: "POST", body: { setId: set.id } }), `Rotation replaced with "${set.name}".`);
  };

  const saveRotationAsSet = async () => {
    const name = saveSetName.trim();
    if (!name || !data || !server) return;
    setBusy("save-set"); setErr(""); setOk("");
    try {
      // An explicit ordered lineup — the one shape the apply above accepts verbatim.
      await api("/mapvote/sets", { method: "POST", body: { name, game: server.game, pool: { sequence: data.rotation.map((m) => m.id) } } });
      setSaveSetName("");
      setOk(`Saved the rotation as the set "${name}" — it can now be applied here, on any ${server.game} server, or attached to a scheduled event.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  };


  function startEdit(m: MapItem) { setEditing(m.id); setDraft(m.custom ? m.prettyName : ""); setOk(""); setErr(""); }

  async function saveName(m: MapItem, value: string) {
    setBusy(m.id); setErr(""); setOk("");
    try {
      // Blank clears the override (falls back to the auto name). Display only — the raw id is unchanged.
      await api(`/servers/${serverId}/maps/${encodeURIComponent(m.id)}/name`, { method: "PUT", body: { displayName: value } });
      setEditing(null); setDraft("");
      setOk(value.trim() ? `Renamed to "${value.trim()}".` : "Display name reset.");
      load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }

  function startFamilyEdit(m: MapItem) { setFamEditing(m.id); setFamDraft(m.family ?? ""); setOk(""); setErr(""); }

  async function saveFamily(m: MapItem, value: string) {
    setBusy(m.id); setErr(""); setOk("");
    try {
      // Blank resets to the family inferred from the id. This is NOT cosmetic — the vote engine
      // groups variants by family, so it changes what "one option per map" and the family rest do.
      await api(`/servers/${serverId}/maps/${encodeURIComponent(m.id)}/family`, { method: "PUT", body: { family: value } });
      setFamEditing(null); setFamDraft("");
      setOk(value.trim() ? `Grouped under "${value.trim().toLowerCase()}".` : "Family reset to the inferred one.");
      load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }

  if (!serverId) return <div className="card"><p className="muted">Select a server to manage maps.</p></div>;

  // The full items, not just id+name: the set editor groups by family and filters by mode and
  // time of day, and the map grid needs the family to find the artwork.
  const catalogue = data?.maps ?? [];
  // Resolved once per render rather than twice (the condition and the src used to each call it).
  const currentArt = mapImageUrl(data?.current?.id, game.descriptor?.id);

  const tabs: HubTab[] = [
    {
      id: "vote", label: "Vote", show: showVote,
      render: () => (
        <PanelGroup viewId="maps-vote">
          <MapVoteControl canManage={canVote} catalogue={catalogue} />
        </PanelGroup>
      ),
    },
    { id: "rotation", label: "Rotation", render: () => renderRotation() },
    {
      id: "votesetup", label: "Vote setup", show: showVote,
      render: () => (
        <PanelGroup viewId="maps-votesetup">
          <MapVote canManage={canVote} catalogue={catalogue} />
        </PanelGroup>
      ),
    },
    { id: "catalogue", label: "Catalogue", render: () => renderCatalogue() },
  ];

  function renderRotation() {
    return (
    <PanelGroup viewId="maps-rotation">
      <Panel id="current" caps="open" title="In play" subtitle={server?.name}>
        <ObserveBanner server={server}>Rotation edits and set-next are the writes that get refused.</ObserveBanner>
        <ActionResult ok={ok} error={err} />
        {!data && !err && <SkeletonLines lines={3} />}
        {!data && err && <button className="ghost" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check from game"}</button>}
        {data && (
          <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
            <div>
              <div className="hint">Current map</div>
              {currentArt && <img className="map-banner" src={currentArt} alt="" />}
              <strong style={{ fontSize: "1.1rem", display: "block" }}>{data.current?.prettyName ?? "—"}</strong>
              {/* The game's own pick, which is not entry 1 of the list below: it plays the entry
                  after its place in the rotation, and edits move that place in ways nobody can see
                  from a numbered list. */}
              {data.next && (
                <div style={{ marginTop: 6 }}>
                  <span className="hint">Next up: </span>
                  <strong>{data.next.prettyName}</strong>
                  {data.rotation.length > 1 && <span className="hint"> (entry {(data.nextIndex ?? 0) + 1} of {data.rotation.length})</span>}
                </div>
              )}
              <div className="control-row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
                <button className="ghost mini" disabled={checking} onClick={check}>
                  {checking ? "Checking…" : "Check from game"}
                </button>
                {data.checkedAt && (
                  <span className="hint">
                    checked <Time iso={data.checkedAt} />
                    {data.shuffle === false && " · shuffle off"}
                    {/* On with one map in the rotation (the vote's way of queuing) there is nothing
                        to reorder, so it is a note here rather than the warning below. */}
                    {data.shuffle === true && data.rotation.length <= 1 && " · shuffle on"}
                    {/* The two answers the game gives agreeing is what a passed check looks like. */}
                    {data.queue?.next && data.next && data.queue.next.id === data.next.id && " · the game's queue agrees"}
                  </span>
                )}
              </div>
              {/* Two things only the game can say, and both decide what plays next more than the
                  list order does. Shown when they matter, not as a status table. */}
              {data.shuffle === true && data.rotation.length > 1 && (
                <p className="hint notice" style={{ marginTop: 6 }}>
                  ⚠️ Map shuffle is on: the game picks its own order, so the order of this list is not what plays.
                  {" "}Switch it off under{" "}
                  <button type="button" className="linklike" onClick={() => nav.go("admin", undefined, "live")}>Administration → Live settings</button>.
                </p>
              )}
              {data.queue?.next && data.next && data.queue.next.id !== data.next.id && (
                <p className="hint notice" style={{ marginTop: 6 }}>
                  ⚠️ The game's own play queue names <strong>{data.queue.next.prettyName}</strong> next, not {data.next.prettyName}.
                </p>
              )}
              {data.queue?.next && !data.next && (
                <div style={{ marginTop: 6 }}>
                  <span className="hint">Next up (the game's play queue): </span>
                  <strong>{data.queue.next.prettyName}</strong>
                </div>
              )}
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="hint">Rotation ({data.rotation.length})</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                {data.rotation.length === 0 && <span className="muted">empty</span>}
                {data.rotation.map((m, i) => (
                  <span key={`${m.id}-${i}`} className={i === data.currentIndex || i === data.nextIndex ? "badge active map-badge" : "badge map-badge"}>
                    {mapIconUrl(m.id, game.descriptor?.id) && <img className="map-thumb" src={mapIconUrl(m.id, game.descriptor?.id)!} alt="" />}
                    {m.prettyName}
                    {/* Two chips can be lit — the map in play and the game's next — so the next one
                        says which it is. */}
                    {i === data.nextIndex && " · next"}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </Panel>

      {data && canRotate && server?.engagementMode === "active" && (
        <Panel id="rotation" caps="maps.rotation" title={`Edit rotation (${data.rotation.length})`}>
          <AskNotice capability="maps.rotation" serverId={serverId} />
          <Explanation>
            <p>
              Add, remove, and reorder maps in the live rotation — changes apply immediately on {server?.name ?? "the server"}. The map in play and the map the game plays next are marked. Acts on raw map ids; display names are cosmetic.
            </p>
            <p>
              The game does not play the list from the top: it plays the entry after its own place in the rotation, so
              adding or removing maps can change what is next. Check <strong>next</strong> after every edit.
            </p>
          </Explanation>
          {data.voteManaged && data.votePaused && (
            <p className="hint notice">
              Map voting is paused, so it leaves this rotation as you set it. When it is resumed, it takes the rotation
              over again and keeps its leading map queued next.
            </p>
          )}
          {data.voteManaged && !data.votePaused && (
            <p className="hint notice">
              ⚠️ Map voting is on, and it manages this rotation: the vote keeps its leading map queued next, which is
              why the list can look collapsed to a map or two, and hand edits here may be rewritten when it re-queues.
              Pause or disable voting on the Vote tab first if you want the rotation to stay exactly as you set it.
            </p>
          )}
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {data.rotation.length === 0 && <span className="muted">Rotation is empty — add a map below.</span>}
            {data.rotation.map((m, i) => (
              <div key={`${m.id}-${i}`} className="control-row" style={{ flexWrap: "nowrap" }}>
                <span className="muted" style={{ width: 24, textAlign: "right" }}>{i + 1}.</span>
                <span className="grow-min">
                  {i === data.currentIndex && <span className="badge active" style={{ marginRight: 6 }}>current</span>}
                  {i === data.nextIndex && <span className="badge active" style={{ marginRight: 6 }}>next</span>}
                  <strong>{m.prettyName}</strong> <span className="hint">{m.id}</span>
                </span>
                <button className="ghost mini" disabled={i === 0 || busy === `rot-${i}`} title="Move up" onClick={() => rotMove(m.id, i, i - 1)}>↑</button>
                <button className="ghost mini" disabled={i === data.rotation.length - 1 || busy === `rot-${i}`} title="Move down" onClick={() => rotMove(m.id, i, i + 1)}>↓</button>
                {/* The last map cannot be removed: an empty rotation makes the game refill it with
                    the whole catalogue, which is then cleared by hand. The API refuses it too —
                    this is so the answer arrives before the click, not after it. */}
                <button className="ghost mini" disabled={data.rotation.length <= 1 || busy === `rot-${i}`}
                  title={data.rotation.length <= 1
                    ? "The rotation must keep at least one map — add the next one first, then remove this."
                    : "Remove from rotation"}
                  onClick={() => rotRemove(m.id, i, m.prettyName)}>✕</button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, maxWidth: 440 }}>
            <span className="hint">Add a map to the end of the rotation:</span>
            <MapPicker catalogue={data.maps.map((m) => ({ id: m.id, prettyName: m.prettyName }))} multiple={false} value={[]} onChange={(v) => { if (v[0]) rotAdd(v[0]); }} placeholder="Search a map to add…" />
          </div>
          <div style={{ marginTop: 14, display: "grid", gap: 8, maxWidth: 560 }}>
            <span className="hint">Saved rotations — replace the whole lineup in one step instead of map by map, or save this one to reuse (and to attach to a scheduled event):</span>
            {rotationSetsErr && <span className="hint">Couldn&apos;t read the saved rotations: {rotationSetsErr}</span>}
            <div className="control-row">
              <select aria-label="Saved rotation" value={applySetId} onChange={(e) => setApplySetId(e.target.value)} className="grow-min">
                <option value="">— pick a saved set —</option>
                {(rotationSets ?? []).map((st) => (
                  <option key={st.id} value={st.id} disabled={st.lineup === null}>
                    {st.name}{st.lineup === null ? " (vote recipe — no lineup)" : ` (${st.lineup} maps)`}
                  </option>
                ))}
              </select>
              <button disabled={!applySetId || busy === "apply-set"} onClick={applySet}>Apply set</button>
            </div>
            <div className="control-row">
              <input value={saveSetName} onChange={(e) => setSaveSetName(e.target.value)} placeholder="Name this rotation…" className="grow-min" />
              <button className="ghost" disabled={!saveSetName.trim() || data.rotation.length === 0 || busy === "save-set"} onClick={saveRotationAsSet}>Save rotation as a set</button>
            </div>
          </div>
        </Panel>
      )}

      {serverId && (
        <ObjectivesPanel serverId={serverId} canManage={canManage} canName={canName} isActive={server?.engagementMode === "active"} currentMapId={data?.current?.id ?? null} />
      )}
    </PanelGroup>
    );
  }

  function renderCatalogue() {
    // Families, newest concern first: a family with ONE map is the stray to look at, because every
    // real place in this game ships several variants. That is the whole point of the grouped view —
    // it is a scan for maps whose id the inference rules read wrong, not a prettier list.
    const families = new Map<string, MapItem[]>();
    for (const m of filtered) {
      const fam = m.family || m.id;
      families.set(fam, [...(families.get(fam) ?? []), m]);
    }
    const groups = [...families.entries()].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));
    const strays = groups.filter(([, list]) => list.length === 1).length;

    const row = (m: MapItem) => (
      <div key={m.id} style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <strong>{m.prettyName}</strong>
            {m.custom && <span className="badge" style={{ marginLeft: 6, fontSize: "0.68rem" }}>custom name</span>}
            {m.customFamily && <span className="badge" style={{ marginLeft: 6, fontSize: "0.68rem" }}>custom family</span>}
            <span className="muted" style={{ marginLeft: 8, fontSize: "0.78rem" }}>{m.id} · {m.mode} · {m.environment} · family {m.family}</span>
          </div>
          <div className="actions" style={{ marginTop: 0, gap: 6 }}>
            {canName && <button className="ghost" disabled={busy === m.id} onClick={() => (editing === m.id ? setEditing(null) : startEdit(m))}>{editing === m.id ? "Close" : "Rename"}</button>}
            {canName && <button className="ghost" disabled={busy === m.id} onClick={() => (famEditing === m.id ? setFamEditing(null) : startFamilyEdit(m))}>{famEditing === m.id ? "Close" : "Set family"}</button>}
            {/* Every map is switchable. Where ChangeMap doesn't list the map, the switch takes one
                extra step — the map joins the rotation first — and the button says so rather than
                greying itself out, which is what made a whole catalogue unclickable. */}
            {canManage && server?.engagementMode === "active" && (
              <button className="danger" disabled={busy === m.id} onClick={() => changeMapNow(m)}
                title={needsStaging(m) ? `This server only switches to maps in its rotation, so ${m.id} is added to the rotation first.` : undefined}>
                {busy === m.id ? "Changing…" : needsStaging(m) ? "Add + change" : "Change now"}
              </button>
            )}
          </div>
        </div>
        {editing === m.id && (
          <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "center" }}>
            <input autoFocus aria-label="Name" value={draft} placeholder={m.defaultName ?? m.prettyName} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveName(m, draft); }} style={{ maxWidth: 320 }} />
            <button disabled={busy === m.id} onClick={() => saveName(m, draft)}>Save</button>
            {m.custom && <button className="ghost" disabled={busy === m.id} onClick={() => saveName(m, "")}>Reset to auto</button>}
          </div>
        )}
        {famEditing === m.id && (
          <div style={{ marginTop: 6 }}>
            <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <input autoFocus aria-label="Family" value={famDraft} placeholder={m.defaultFamily ?? m.family} onChange={(e) => setFamDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveFamily(m, famDraft); }} style={{ maxWidth: 240 }} list="mapset-families" />
              <button disabled={busy === m.id} onClick={() => saveFamily(m, famDraft)}>Save</button>
              {m.customFamily && <button className="ghost" disabled={busy === m.id} onClick={() => saveFamily(m, "")}>Reset to inferred</button>}
            </div>
            <Explanation>
              Type an existing family to merge this map into it, or a new name to start one. Inferred from the id:{" "}
              <code>{m.defaultFamily ?? m.family}</code>.
            </Explanation>
          </div>
        )}
      </div>
    );

    return (
    <PanelGroup viewId="maps-catalogue">
      <ActionResult ok={ok} error={err} />
      {/* Every family already on this server, so the family box can complete rather than guess. */}
      <datalist id="mapset-families">
        {[...new Set((data?.maps ?? []).map((m) => m.family))].sort().map((f) => <option key={f} value={f} />)}
      </datalist>

      {data && (
        <Panel id="catalogue" caps="open" title={`Every map (${data.maps.length})`} actions={<>
          <SearchInput value={q} onChange={setQ} placeholder="Search maps…" />
          <button className="ghost" aria-pressed={byFamily} onClick={() => setByFamily((v) => !v)}>{byFamily ? "Flat list" : "By family"}</button>
          <button className="ghost" onClick={load}>Refresh</button>
        </>}>
          {(canManage || canName) && <AskNotice capability={[...(canManage ? ["maps.next"] : []), ...(canName ? ["maps.names"] : [])]} serverId={serverId} />}
          {canName
            ? <Explanation>
                Display names are cosmetic and apply to all {server?.game ?? "game"} servers. The <strong>family</strong> is not
                cosmetic: the vote groups variants by it, so it decides what &ldquo;one option per map&rdquo; and
                &ldquo;rest whole map families&rdquo; treat as the same place. Both fall back to what the map id implies, and
                both are stored here rather than in code — so a map the game adds tomorrow can be fixed with these buttons.
              </Explanation>
            : !canManage && <p className="hint">You can look at every map. Changing to one needs Set next map; renaming one needs Map display names.</p>}

          {canManage && server?.engagementMode === "active" && data.changeable && data.changeable.length < data.maps.length && (
            <Callout variant="info">
              This server offers <strong>{data.changeable.length}</strong> of {data.maps.length} maps for an immediate switch — that
              list follows the rotation, not what the server can load. Everything else says <em>Add + change</em>: the map joins the
              end of the rotation first and is then loaded, and it stays in the rotation until you remove it.
            </Callout>
          )}

          {byFamily && strays > 0 && (
            <Callout variant="info">
              <strong>{strays}</strong> {strays === 1 ? "family has" : "families have"} only one map in{q ? " this search" : ""}.
              Most places ship several variants, so a lone one is usually a map whose id the naming rules read differently —
              worth a look. They are listed first below; use <em>Set family</em> to merge one into its siblings.
            </Callout>
          )}

          <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
            {filtered.length === 0 && <Nothing>No maps match “{q}”.</Nothing>}
            {!byFamily && filtered.slice(0, 200).map(row)}
            {byFamily && groups.slice(0, 80).map(([fam, list]) => (
              <div key={fam} className="setting-card" style={{ padding: "6px 10px" }}>
                <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
                  <strong>{fam}</strong>
                  <span className="hint">{list.length} map{list.length === 1 ? "" : "s"}{list.length === 1 ? " · possible stray" : ""}</span>
                </div>
                {list.map(row)}
              </div>
            ))}
            {!byFamily && filtered.length > 200 && <span className="hint">Showing first 200 — refine your search.</span>}
            {byFamily && groups.length > 80 && <span className="hint">Showing first 80 families — refine your search.</span>}
          </div>
        </Panel>
      )}
    </PanelGroup>
    );
  }

  return (
    <Hub
      routeId="maps"
      subtitle={<>What is playing on {server?.name ?? "this server"}, what follows it, and how that gets decided.</>}
      tabs={tabs}
    />
  );
}

/**
 * The current map's objective picker — five sectors, three choices each, applied to the match in
 * play (what CRCON calls the game layout). The grid is read live from the server so it always
 * matches the map that's actually running; "Surprise me" leaves a row to chance. On top of the
 * wire's grid sits the staff-TAUGHT layer: the name the community knows an option by (Vietnam's
 * wire offers only digits) and the tactical-map square it sits in — which is what lets a pick
 * light up on the art. Teaching is reading the map: the A1-J10 grid is printed on it.
 */
interface ObjPoint { row: number; idx: number; name: string | null; sector: string | null }
function ObjectivesPanel({ serverId, canManage, canName, isActive, currentMapId }: { serverId: string; canManage: boolean; canName: boolean; isActive: boolean; currentMapId?: string | null }) {
  const confirm = useConfirm();
  const game = useGame();
  const [data, setData] = useState<{ rows: string[][]; mapKey: string | null; points: ObjPoint[]; mapId?: string; saved?: number[] | null; savedPlays?: number | null } | null>(null);
  const [picks, setPicks] = useState<(string | "random")[]>(["random", "random", "random", "random", "random"]);
  // Vietnam only: how long the saved layout should stand — "" is the game's own forever-until-
  // cleared, a number is OUR countdown (the worker clears it after that many plays of the map).
  const [keep, setKeep] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  // The teaching layer: arm an option, tap its square, name it. Gated like Rename, by maps.names:
  // the permission its route enforces.
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState<{ row: number; idx: number } | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [teachBusy, setTeachBusy] = useState(false);

  const claim = useLatestLoad();
  const loadRows = useCallback((preservePicks = false) => {
    const fresh = claim();
    setErr(""); setOk("");
    if (!preservePicks) { setData(null); setPicks(["random", "random", "random", "random", "random"]); }
    api<{ rows: string[][]; mapKey: string | null; points: ObjPoint[]; mapId?: string; saved?: number[] | null; savedPlays?: number | null }>(`/servers/${serverId}/maps/objectives`)
      .then((r) => { if (fresh()) setData(r); })
      .catch((e) => { if (fresh()) setErr((e as Error).message); });
  }, [serverId, claim]);
  useEffect(() => { loadRows(); setEditing(false); setArmed(null); }, [loadRows]);

  const pointFor = (row: number, idx: number): ObjPoint | undefined =>
    data?.points.find((pt) => pt.row === row && pt.idx === idx);
  /** What an option is CALLED: the wire name where the game gives one (WW2), the taught name
   *  where it gives only a digit (Vietnam), and an honest placeholder until somebody teaches it. */
  const labelOf = (wire: string, row: number, idx: number): string =>
    /^\d+$/.test(wire) ? pointFor(row, idx)?.name ?? `Option ${idx + 1}` : wire;

  async function teach(row: number, idx: number, patch: { name?: string; sector?: string }) {
    if (!data?.mapKey) return;
    setTeachBusy(true); setErr("");
    try {
      await api(`/servers/${serverId}/maps/objective-points`, { method: "PUT", body: { mapKey: data.mapKey, row, idx, ...patch } });
      loadRows(true);
    } catch (e) { setErr((e as Error).message); } finally { setTeachBusy(false); }
  }

  function armOption(row: number, idx: number, wire: string) {
    // Tapping the armed option again DISARMS it — an exit that used to not exist.
    if (armed?.row === row && armed.idx === idx) { setArmed(null); return; }
    setArmed({ row, idx });
    setNameDraft(pointFor(row, idx)?.name ?? (/^\d+$/.test(wire) ? "" : wire));
  }

  /** Wipe everything taught about one option — name and square both. Blank halves clear on the
   *  PUT, and a row with neither is dropped, so this is the un-teach the screen was missing. */
  async function forget(row: number, idx: number) {
    const okGo = await confirm({
      title: "Forget this location?",
      body: "Clears the taught name and square for this option, on every server running this map. Anyone can teach it again.",
      confirmLabel: "Forget it",
    });
    if (!okGo) return;
    setNameDraft("");
    await teach(row, idx, { name: "", sector: "" });
  }

  async function apply() {
    const named = picks.filter((p) => p !== "random").length;
    // The two games do very different things with this press (docs/hll-vietnam.md p11): WW2
    // applies once and RESTARTS the round to do it; Vietnam SAVES a per-map layout that
    // re-applies every time the map plays, until cleared. The confirm must say which.
    const consequence = isVietnam
      ? keep
        ? `This saves the layout for the next ${keep} play${keep === "1" ? "" : "s"} of the current map — after that the server goes back to picking its own. (Conquest mode is unaffected.)`
        : "This saves the layout for the current map — the server will use it every time this map plays, until you clear it. (Conquest mode is unaffected.)"
      : "This applies to the match being played right now — the game restarts the round to take the new layout.";
    const okGo = await confirm({
      title: isVietnam ? "Save this map's objective layout?" : "Change this match's objectives?",
      body: named === 0
        ? `All five rows will be picked at random. ${consequence}`
        : `The ${named} objective${named === 1 ? "" : "s"} you picked will be set (the rest are chosen at random). ${consequence}`,
      confirmLabel: isVietnam ? "Save the layout" : "Set the objectives",
    });
    if (!okGo) return;
    setBusy(true); setErr(""); setOk("");
    try {
      const r = await api<{ objectives: string[] }>(`/servers/${serverId}/maps/objectives`, {
        method: "POST", body: { objectives: picks, ...(isVietnam && keep ? { keepPlays: Number(keep) } : {}) },
      });
      // Vietnam just STORED this layout, so the "Saved layout" line must refetch or it lies.
      // Refetch BEFORE setOk — loadRows starts by clearing the messages, and after it so the
      // success line survives the batch. WW2 stays put: its round is restarting, and a grid
      // read raced into the load screen answers with an error over a successful set.
      if (isVietnam) loadRows(true);
      setOk(`Objectives set: ${r.objectives.map((o, i) => labelOf(o, i, data?.rows[i]?.indexOf(o) ?? 0)).join(" → ")}`);
      setPicks(r.objectives); // show what actually applied
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  // The SAME resolver Map zones uses, because it is the one that knows both games' art:
  // WW2 answers with the clean gridded tactical map, Vietnam with its six bundled gridded maps.
  // This was tacMapUrl, which answers null for anything but WW2 — so on a Vietnam server the
  // map, the highlights, and the whole tap-to-teach grid silently never rendered: the exact
  // screen the highlight feature was asked for.
  const tacMap = liveMapUrl(currentMapId, currentMapId, game.descriptor?.id);
  const rows = data?.rows ?? null;
  const isVietnam = game.descriptor?.id === "hllv";
  const saved = isVietnam ? data?.saved ?? null : null;

  async function clearSaved() {
    const okGo = await confirm({
      title: "Clear this map's saved layout?",
      body: "The server forgets the stored objectives for this map and goes back to picking its own. The round in play is not touched.",
      confirmLabel: "Clear it",
    });
    if (!okGo) return;
    setBusy(true); setErr(""); setOk("");
    try {
      await api(`/servers/${serverId}/maps/objectives/clear`, { method: "POST", body: {} });
      // loadRows FIRST: it synchronously blanks the messages, so setOk after it survives the
      // React batch — the other order wiped this confirmation before anyone saw it.
      loadRows(true);
      setOk("Saved layout cleared \u2014 the server picks its own objectives for this map again.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  /** A taught cell ("E6") as overlay geometry on the 10x10 grid the art itself prints. */
  const cellBox = (cell: string) => {
    const col = cell.charCodeAt(0) - 65;
    const rowNo = Number(cell.slice(1)) - 1;
    return { left: `${col * 10}%`, top: `${rowNo * 10}%`, width: "10%", height: "10%" } as const;
  };

  return (
    <Panel id="objectives" caps={["maps.next", "maps.names"]} title="Objectives" subtitle="choose what this match is fought over">
      <AskNotice capability={[...(canManage ? ["maps.next"] : []), ...(canName ? ["maps.names"] : [])]} serverId={serverId} />
      <p className="hint mt-0">
        Every map has five rows of objectives, three choices per row. Pick one per row — or leave it
        on “Random”. {isVietnam
          ? "On Vietnam the layout SAVES for the map and re-applies every time it plays, until cleared."
          : "On WW2 it applies once to the match in play — the game restarts the round to take it."} The
        choices come from the map running right now; picked locations light up on the map once their
        square has been taught.
      </p>
      <ActionResult ok={ok} error={err} />
      {!rows && !err && <SkeletonLines lines={5} />}
      {rows && tacMap && (
        <div style={{ position: "relative", marginBottom: 8 }} role={editing ? "group" : undefined} aria-label={editing ? "Map grid" : undefined}>
          <img className="tac-map" src={tacMap} alt="Tactical map of the current battlefield" style={{ display: "block" }} />
          {!editing && rows.map((options, i) => {
            const pick = picks[i]!;
            if (pick === "random") return null;
            const j = options.indexOf(pick);
            const cell = j >= 0 ? pointFor(i, j)?.sector : null;
            if (!cell) return null;
            return (
              <div key={`hl-${i}`} style={{ position: "absolute", ...cellBox(cell), border: "2px solid var(--accent)", background: "color-mix(in srgb, var(--accent) 25%, transparent)", borderRadius: 4, pointerEvents: "none" }}>
                <span style={{ position: "absolute", top: 1, left: 1, fontSize: 10, fontWeight: 700, lineHeight: "12px", background: "var(--accent)", color: "#fff", borderRadius: 3, padding: "0 3px" }}>{i + 1}</span>
              </div>
            );
          })}
          {/* Teaching mode shows EVERY taught square, armed or not. Without this, the only trace
              of a square just set was the armed option's own highlight — move the pen to the next
              row and all of it vanished, which read as the teaching being lost (it never was). */}
          {editing && (data?.points ?? []).filter((pt) => !!pt.sector).map((pt) => {
            const isArmed = armed?.row === pt.row && armed.idx === pt.idx;
            return (
              <div key={`tm-${pt.row}-${pt.idx}`} data-taught-cell={pt.sector} style={{ position: "absolute", ...cellBox(pt.sector!), border: isArmed ? "2px solid var(--accent)" : "2px dashed var(--accent)", background: isArmed ? "color-mix(in srgb, var(--accent) 25%, transparent)" : "transparent", borderRadius: 4, pointerEvents: "none" }}>
                <span style={{ position: "absolute", top: 1, left: 1, fontSize: 10, fontWeight: 700, lineHeight: "12px", background: isArmed ? "var(--accent)" : "color-mix(in srgb, var(--accent) 65%, transparent)", color: "#fff", borderRadius: 3, padding: "0 3px" }}>{pt.row + 1}</span>
              </div>
            );
          })}
          {editing && Array.from({ length: 100 }, (_, k) => {
            const col = k % 10, rowNo = Math.floor(k / 10);
            const id = `${"ABCDEFGHIJ"[col]}${rowNo + 1}`;
            return (
              <button key={id} type="button" aria-label={`teach cell ${id}`} disabled={!armed || teachBusy}
                onClick={() => armed && void teach(armed.row, armed.idx, { sector: id })}
                style={{ position: "absolute", ...cellBox(id), background: "transparent", border: "1px dashed rgba(128,128,128,0.35)", padding: 0, cursor: armed ? "crosshair" : "default" }} />
            );
          })}
        </div>
      )}
      {rows && saved && saved.length === 5 && (
        <p className="hint" style={{ marginTop: 0 }}>
          <strong>{data?.savedPlays != null
            ? `Saved layout for this map (next ${data.savedPlays} play${data.savedPlays === 1 ? "" : "s"}, then back to random):`
            : "Saved layout for this map:"}</strong>{" "}
          {saved.map((sIdx, i) => labelOf(rows[i]?.[sIdx] ?? String(sIdx), i, sIdx)).join(" \u2192 ")}{" "}
          <button className="mini ghost" onClick={() => void clearSaved()} disabled={!canManage || busy}>Clear saved layout</button>
        </p>
      )}
      {rows && editing && (
        <p className="hint">
          Teaching mode: tap an option below to arm it, then tap its square on the map — a tap on a
          different square MOVES it, and tapping the armed option again puts the pen down.
          {!data?.mapKey && " (No map key — the server hasn\u2019t said which map is playing.)"}
          {armed && ` Teaching Row ${armed.row + 1} \u00b7 ${labelOf(rows[armed.row]?.[armed.idx] ?? "", armed.row, armed.idx)}${pointFor(armed.row, armed.idx)?.sector ? ` (${pointFor(armed.row, armed.idx)!.sector})` : ""}.`}
        </p>
      )}
      {rows && editing && armed && (
        <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <input value={nameDraft} placeholder="Location name (what players call it)" maxLength={60}
            onChange={(e) => setNameDraft(e.target.value)} style={{ maxWidth: 280 }} />
          <button className="mini" disabled={teachBusy} onClick={() => void teach(armed.row, armed.idx, { name: nameDraft })}>{teachBusy ? "\u2026" : "Save name"}</button>
          {(pointFor(armed.row, armed.idx)?.name || pointFor(armed.row, armed.idx)?.sector) && (
            <button className="mini ghost" disabled={teachBusy} onClick={() => void forget(armed.row, armed.idx)}>Forget location</button>
          )}
        </div>
      )}
      {rows && (
        <>
          {rows.map((options, i) => (
            <div key={i} className="row obj-opts" role="group" aria-label={`Row ${i + 1}`} style={{ alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "nowrap", overflowX: "auto" }}>
              <span className="hint" style={{ flex: "0 0 52px" }}>Row {i + 1}</span>
              {options.map((o, j) => (
                <button
                  key={o}
                  // "active" carries a VISIBLE selected look (accent-soft, scoped to .obj-opts). The
                  // old tell was className "" vs "ghost" \u2014 but ghost renders identically to a default
                  // button, so the chosen option looked no different from its neighbours and the only
                  // thing a tap changed on screen was which button held focus, reading as "the last
                  // pick vanished". The pick state was always right; it just could not be seen.
                  className={(editing ? armed?.row === i && armed.idx === j : picks[i] === o) ? "active" : "ghost"}
                  aria-pressed={editing ? armed?.row === i && armed.idx === j : picks[i] === o}
                  disabled={editing ? !canName : !canManage}
                  onClick={() => (editing ? armOption(i, j, o) : setPicks((p) => p.map((x, k) => (k === i ? o : x))))}
                >
                  {labelOf(o, i, j)}{editing && pointFor(i, j)?.sector ? ` \u00b7 ${pointFor(i, j)!.sector}` : ""}
                </button>
              ))}
              <button
                className={!editing && picks[i] === "random" ? "active" : "ghost"}
                aria-pressed={!editing && picks[i] === "random"}
                disabled={!canManage || editing}
                onClick={() => setPicks((p) => p.map((x, k) => (k === i ? "random" : x)))}
              >
                Random
              </button>
            </div>
          ))}
          <div className="actions" style={{ alignItems: "center", flexWrap: "wrap" }}>
            {isVietnam && (
              <select value={keep} onChange={(e) => setKeep(e.target.value)} disabled={!canManage || editing}
                title="How long the saved layout stands — the game itself keeps it forever, so the play limit is enforced by this app">
                <option value="">Keep until cleared</option>
                <option value="1">Next play only</option>
                <option value="3">Next 3 plays</option>
                <option value="5">Next 5 plays</option>
                <option value="10">Next 10 plays</option>
              </select>
            )}
            <button className="primary" onClick={apply} disabled={!canManage || !isActive || busy || editing}>{busy ? "Setting\u2026" : isVietnam ? "Save the layout" : "Set these objectives"}</button>
            <button className="ghost" onClick={() => loadRows()}>Re-read (map changed?)</button>
            {canName && <Toggle checked={editing} onChange={(v) => { setEditing(v); setArmed(null); }} label="Edit locations" />}
            {!isActive && <span className="hint">This server is in observe mode — the panel won&apos;t change anything until it&apos;s Active.</span>}
            {isActive && !canManage && <span className="hint">Setting them needs the &ldquo;Set next map&rdquo; permission.</span>}
          </div>
        </>
      )}
    </Panel>
  );
}
