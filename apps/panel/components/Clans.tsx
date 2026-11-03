"use client";
/**
 * Players → Clans: every clan tag the roster has shown, one row per clan however its members spell
 * it, and the players behind any of them — tick several to see them together.
 *
 * Spellings are grouped automatically (`[ABC]`, `ᴀʙᴄ` and `A.B.C` are one clan); what the fold
 * cannot know, staff fix here: combine ticked clans into one, split a spelling back out, name a
 * clan, or reset one to its automatic grouping. The same grouping is what the "player is wearing
 * a clan tag" rule acts on.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, wasFiled } from "../lib/api";
import { useAlert, useConfirm, usePrompt, useToast } from "../lib/feedback";
import { PanelGroup, Panel } from "./Panel";
import { ActionResult, AskNotice, EmptyState, Pager, SearchInput, SkeletonRows, Explanation } from "./ui";
import { usePagedList } from "../lib/paged";
import { isText, isTextOrNull, oneOf, useRemembered } from "../lib/remembered";
import { useAppNav } from "../lib/nav";
import { recordRecent } from "../lib/recent";
import { Time } from "./Time";
import { platformLabel } from "../lib/platform";
import { clearClanFocus, peekClanFocus } from "../lib/clanFocus";

interface Spelling { tag: string; ever: number; now: number; lastSeen: string }
interface ClanGroup { key: string; label: string; customised: boolean; now: number; ever: number; lastSeen: string | null; spellings: Spelling[] }
interface ClanPage { clans: ClanGroup[]; total: number; focus: string | null; canEdit: boolean }
interface Member {
  playerId: string; name: string; game: string; platform: string; platformId: string; lastSeen: string;
  tag: string; firstSeen: string; tagLastSeen: string; wearingNow: boolean; currentTag: string | null;
}
type Status = "any" | "now" | "former";
const isSelection = (v: unknown): v is { key: string; label: string }[] =>
  Array.isArray(v) && v.every((s) => s && typeof s.key === "string" && typeof s.label === "string");

export default function Clans() {
  const toast = useToast();
  const prompt = usePrompt();
  const confirm = useConfirm();
  // A change that fails says why in a dialog: the list's error line sits above every row, and the
  // Rename or Reset pressed can be a screen below it.
  const alert = useAlert();
  const nav = useAppNav();
  // The tab as it was left, for the sitting: the search, the game, the clans ticked, the member
  // filters and both pages. Opening a member's profile leaves the tab (the profile lives on the
  // Directory's), and Back must find all of it as it was rather than an empty selection to rebuild.
  const [q, setQ] = useRemembered("clans.search", "", isText, "session");
  const [game, setGame] = useRemembered("clans.game", "", isText, "session");
  const [games, setGames] = useState<{ id: string; label: string }[]>([]);
  // A profile's tag chip sent us here for one clan: it leads the first page (for as long as the
  // tab stays open, so the list does not jump) and starts ticked.
  const [focus] = useState<string | null>(() => peekClanFocus());
  const [selected, setSelected] = useRemembered<{ key: string; label: string }[]>("clans.selected", [], isSelection, "session");
  const [expanded, setExpanded] = useRemembered<string | null>("clans.expanded", null, isTextOrNull, "session");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useRemembered<Status>("clans.status", "any", oneOf(["any", "now", "former"] as const), "session");
  const [seenDays, setSeenDays] = useRemembered<"" | "1" | "7" | "30">("clans.seenDays", "", oneOf(["", "1", "7", "30"] as const), "session");

  useEffect(() => {
    let live = true;
    api<{ games?: { id: string; label: string }[] }>("/games").then((r) => { if (live) setGames(r.games ?? []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const gameLabel = (id: string) => games.find((g) => g.id === id)?.label ?? id;

  const query = useCallback((offset: number, limit: number) => {
    const p = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (q.trim()) p.set("q", q.trim());
    if (game) p.set("game", game);
    if (focus) p.set("focus", focus);
    return `/clans?${p.toString()}`;
  }, [q, game, focus]);
  // Typing should not fire a request per keystroke (same arrow-wrapping as the directory's).
  const [debounced, setDebounced] = useState<(offset: number, limit: number) => string>(() => query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(() => query), 200);
    return () => clearTimeout(t);
  }, [query]);
  const fetchClans = useCallback(
    (offset: number, limit: number) => api<ClanPage>(debounced(offset, limit)).then((r) => {
      // Tick the focused clan on the first answer only — later reloads must not undo the user's
      // own selection — and let go of the hand-off so the next visit starts plain.
      if (r.focus && peekClanFocus() !== null) {
        const hit = r.clans.find((c) => c.key === r.focus);
        if (hit) setSelected([{ key: hit.key, label: hit.label }]);
      }
      clearClanFocus();
      return { items: r.clans ?? [], total: r.total ?? null };
    }),
    [debounced, setSelected],
  );
  const list = usePagedList<ClanGroup>(fetchClans, "clans.list");

  const keys = selected.map((s) => s.key);
  // The selection as one value, so a re-render with the same clans ticked keeps the same fetcher.
  const keyList = keys.join("\u0000");
  const fetchMembers = useMemo(() => (keyList ? (offset: number, limit: number) => {
    const p = new URLSearchParams({ limit: String(limit), offset: String(offset), status });
    for (const k of keyList.split("\u0000")) p.append("key", k);
    if (game) p.set("game", game);
    if (seenDays) p.set("seenDays", seenDays);
    return api<{ members: Member[]; total: number }>(`/clans/members?${p.toString()}`).then((r) => ({ items: r.members ?? [], total: r.total ?? null }));
  } : null), [keyList, status, game, seenDays]);
  const members = usePagedList<Member>(fetchMembers, "clans.members");

  const isSelected = (key: string) => selected.some((s) => s.key === key);
  const toggle = (g: ClanGroup) => setSelected((cur) => (cur.some((s) => s.key === g.key) ? cur.filter((s) => s.key !== g.key) : [...cur, { key: g.key, label: g.label }]));

  const openPlayer = (m: Member) => {
    recordRecent({ kind: "player", label: m.name || m.platformId, sub: "profile", view: "players", target: { playerId: m.playerId } });
    nav.go("players", { playerId: m.playerId });
  };

  /** One write, then a fresh list; `pick` is what stays ticked afterwards. */
  async function write(path: string, body: Record<string, unknown>, done: string, failed: string, pick?: (key: string) => { key: string; label: string }[]) {
    setBusy(true); setError("");
    try {
      const r = await api<{ key: string }>(path, { method: "POST", body });
      toast.success(done);
      if (pick) setSelected(pick(r.key));
      list.reload();
    } catch (e) {
      if (wasFiled(e)) setError(e.message);
      else void alert({ title: failed, body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function combine() {
    if (selected.length < 2) return;
    const name = await prompt({
      title: `Combine ${selected.length} clan tags`,
      label: "Name for the combined clan",
      initial: selected[0]!.label,
      hint: "Every spelling of the ticked tags becomes one clan. You can split a spelling back out, or reset the clan, at any time.",
      confirmLabel: "Combine",
    });
    if (name === null) return;
    await write("/clans/combine", { keys, label: name }, `Combined into ${name || selected[0]!.label}.`, "Couldn't combine the clans", (key) => [{ key, label: name || selected[0]!.label }]);
  }
  async function rename(g: ClanGroup) {
    const name = await prompt({
      title: "Name this clan", label: "Clan name", initial: g.customised ? g.label : "",
      placeholder: g.label, hint: "Leave it empty to show its most-worn spelling.", confirmLabel: "Save", required: false,
    });
    if (name === null) return;
    await write("/clans/rename", { key: g.key, label: name }, name ? `Named ${name}.` : "Name cleared.", `Couldn't rename ${g.label}`,
      (key) => selected.map((s) => (s.key === g.key ? { key, label: name || g.label } : s)));
  }
  async function reset(g: ClanGroup) {
    if (!(await confirm({
      title: `Reset ${g.label}?`,
      body: "Anything combined into it goes back to its own clan, a spelling split out of it rejoins its automatic group, and its name is cleared.",
      confirmLabel: "Reset",
    }))) return;
    await write("/clans/reset", { key: g.key }, `${g.label} is grouped automatically again.`, `Couldn't reset ${g.label}`, () => selected.filter((s) => s.key !== g.key));
  }
  async function split(g: ClanGroup, tag: string) {
    await write("/clans/split", { tag }, `${tag} is a clan of its own now.`, `Couldn't split ${tag} out of ${g.label}`, () => selected.filter((s) => s.key !== g.key));
  }

  const clans = list.items;
  const filtered = Boolean(q.trim() || game);
  return (
    <PanelGroup viewId="clans">
      <Panel
        id="clans"
        caps="open"
        title="Clans"
        subtitle={list.total !== null ? String(list.total) : undefined}
        actions={
          <>
            {games.length > 1 && (
              <select value={game} onChange={(e) => setGame(e.target.value)} title="Game">
                <option value="">All games</option>
                {games.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            )}
            <SearchInput value={q} onChange={setQ} placeholder="Search clan tags…" />
          </>
        }
      >
        <Explanation>
          Every clan tag players have worn, with the ways they spell it combined into one. Tick one or more to see their players below.
        </Explanation>
        {/* Combining, naming and splitting are offered to everyone who sees the list — without the
            tags permission each one is sent for approval, as this says. */}
        <AskNotice capability="player.tags" />
        <ActionResult error={error || list.error} />
        {selected.length > 0 && (
          <div className="control-row" style={{ marginBottom: 8 }}>
            <span className="fs-sm"><strong>{selected.length}</strong> selected</span>
            <button className="mini ghost" onClick={() => setSelected([])} disabled={busy}>Clear</button>
            {selected.length > 1 && (
              <button className="mini" onClick={() => void combine()} disabled={busy} title="Make the ticked clans one — every spelling of each">Combine…</button>
            )}
          </div>
        )}
        {!clans && !list.error && <SkeletonRows rows={6} cols={5} />}
        {clans && !clans.length && (
          <EmptyState icon="🏷️" title={filtered ? "No clan tags match" : "No clan tags recorded yet"} filtered={filtered} onClear={() => { setQ(""); setGame(""); }}>
            {filtered
              ? "Try fewer letters — the search finds a tag however it is spelled."
              : "Tags are recorded from the live roster while players are on a connected server."}
          </EmptyState>
        )}
        {clans && clans.length > 0 && (
          <>
            <div className="scroll-x roster">
              <table className="scoreboard">
                <thead><tr>
                  <th></th>
                  <th>Clan tag</th>
                  <th className="num">Wearing now</th>
                  <th className="num">Ever</th>
                  <th>Last seen</th>
                  <th></th>
                </tr></thead>
                <tbody>
                  {clans.map((g) => (
                    <React.Fragment key={g.key}>
                      <tr className={isSelected(g.key) ? "selected" : undefined}>
                        <td><input type="checkbox" checked={isSelected(g.key)} onChange={() => toggle(g)} aria-label={`Select ${g.label}`} /></td>
                        <td>
                          <span style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => toggle(g)}>{g.label}</span>
                          {g.spellings.length > 1 && (
                            <button className="mini ghost" style={{ marginLeft: 6 }} aria-expanded={expanded === g.key}
                              onClick={() => setExpanded((k) => (k === g.key ? null : g.key))}>
                              {g.spellings.length} spellings {expanded === g.key ? "▴" : "▾"}
                            </button>
                          )}
                          {g.customised && <span className="muted fs-sm" title="Combined, split or named by staff"> · edited</span>}
                        </td>
                        <td className="num">{g.now || ""}</td>
                        <td className="num">{g.ever}</td>
                        <td>{g.lastSeen ? <Time iso={g.lastSeen} /> : ""}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button className="mini ghost" onClick={() => void rename(g)} disabled={busy}>Rename</button>
                          {g.customised && <button className="mini ghost" onClick={() => void reset(g)} disabled={busy}>Reset</button>}
                        </td>
                      </tr>
                      {expanded === g.key && (
                        <tr>
                          <td></td>
                          <td colSpan={5}>
                            <div className="alias-chips">
                              {g.spellings.map((s) => (
                                <span key={s.tag} className="alias-chip">
                                  <span className="alias-value">{s.tag}</span>
                                  <span className="alias-when">{s.now ? `${s.now} now · ` : ""}{s.ever} ever</span>
                                  <button className="mini ghost" onClick={() => void split(g, s.tag)} disabled={busy}
                                    title="Make this spelling a clan of its own">Split out</button>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager list={list} noun="clan" />
          </>
        )}
      </Panel>

      {selected.length > 0 && (
        <Panel
          id="clan-members"
          caps="open"
          title={`Players · ${selected.map((s) => s.label).join(" + ")}`}
          subtitle={members.total !== null ? String(members.total) : undefined}
          actions={
            <div className="seg">
              {([["any", "Both"], ["now", "Wearing now"], ["former", "Used to"]] as const).map(([v, label]) => (
                <button key={v} className={`seg-btn ${status === v ? "active" : ""}`} onClick={() => setStatus(v)}>{label}</button>
              ))}
            </div>
          }
        >
          <div className="control-row" style={{ marginBottom: 8 }}>
            <span className="muted fs-sm">Seen within</span>
            <div className="seg">
              {([["", "Any time"], ["1", "24 h"], ["7", "7 days"], ["30", "30 days"]] as const).map(([v, label]) => (
                <button key={v || "any"} className={`seg-btn ${seenDays === v ? "active" : ""}`} onClick={() => setSeenDays(v)}>{label}</button>
              ))}
            </div>
          </div>
          <ActionResult error={members.error} />
          {!members.items && !members.error && <SkeletonRows rows={6} cols={5} />}
          {members.items && !members.items.length && (
            <p className="muted">
              {status === "now" ? "Nobody is wearing these tags right now." : status === "former" ? "Nobody has stopped wearing these tags." : "No players match."}
            </p>
          )}
          {members.items && members.items.length > 0 && (
            <>
              <p className="muted fs-sm mt-0" style={{ marginBottom: 6 }}>Click a row for the full profile.</p>
              <div className="scroll-x roster">
                <table className="scoreboard">
                  <thead><tr>
                    <th>Name</th>
                    {!game && games.length > 1 && <th>Game</th>}
                    <th>Platform</th>
                    <th>Clan tag</th>
                    <th>Now</th>
                    <th>Wore it</th>
                    <th>Last seen</th>
                  </tr></thead>
                  <tbody>
                    {members.items.map((m) => (
                      <tr key={m.playerId} style={{ cursor: "pointer" }} onClick={() => openPlayer(m)}>
                        <td>{m.name || "[No Name]"}</td>
                        {!game && games.length > 1 && <td>{gameLabel(m.game)}</td>}
                        <td title={m.platform}>{platformLabel(m.platform)}</td>
                        <td>{m.tag}</td>
                        <td>
                          {m.wearingNow ? <strong>Wearing it</strong>
                            : m.currentTag ? <>Now wears {m.currentTag}</>
                              : <span className="muted">No tag now</span>}
                        </td>
                        <td className="fs-sm"><Time iso={m.firstSeen} /> – <Time iso={m.tagLastSeen} /></td>
                        <td><Time iso={m.lastSeen} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager list={members} noun="player" />
            </>
          )}
        </Panel>
      )}
    </PanelGroup>
  );
}
