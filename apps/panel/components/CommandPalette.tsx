"use client";
/**
 * Command palette (⌘K / Ctrl-K): fuzzy jump-to across nav destinations, server switching, a few
 * actions, players by name or game id, and the walkthroughs this person may follow. Opened
 * globally by the parent; keyboard-driven (↑/↓/Enter/Esc).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { hasCap } from "../lib/access";
import { useGrants } from "../lib/grants";
import { useAppNav } from "../lib/nav";
import { platformLabel } from "../lib/platform";
import { getRecent, recordRecent, type RecentItem, type RecentTarget } from "../lib/recent";
import { useServers } from "../lib/servers";
import { fmtRelative } from "../lib/time";
import { Icon } from "./icons";

type WalkLib = typeof import("../lib/walkthroughs");

export interface Command {
  id: string; title: string; group: string; icon?: ReactNode;
  /** one-line description, shown under the title and searched — this is what makes the palette
   *  answer "where do I do X?" rather than only "what is X called?". */
  hint?: string;
  /** extra search terms: the words someone types when they don't know our label. */
  keywords?: string[];
  run: () => void;
}

interface FoundPlayer { id: string; name: string | null; platform?: string | null; platformId?: string | null; lastSeen?: string | null }

/** Recent activity (lib/recent, the dashboard's card) as palette rows — what Search lists before
 *  anything is typed. Not the screen or profile already open: that is not somewhere to go back to. */
function recentCommands(items: RecentItem[], here: { view: string; tab?: string; subject?: string }, go: (view: string, target?: RecentTarget, tab?: string) => void): Command[] {
  return items
    .filter((r) => (r.kind === "screen"
      ? here.subject || r.view !== here.view || (r.tab ?? "") !== (here.tab ?? "")
      : !here.subject || r.target?.playerId !== here.subject))
    .slice(0, 8)
    .map((r, i) => ({
      id: `recent:${i}`, title: r.label, group: "Recent",
      icon: <Icon name={r.kind === "screen" ? r.view : "players"} />,
      hint: r.kind === "screen" ? undefined : r.sub,
      run: () => go(r.view, r.target, r.tab),
    }));
}

/** Wraps the palette with server-switch commands from the active-server context, and players from
 *  the directory's own search for anyone who may see the directory. `base` carries the nav +
 *  action commands the parent builds. */
export function CommandK({ open, onClose, base }: { open: boolean; onClose: () => void; base: Command[] }) {
  const { servers, serverId, setServerId } = useServers();
  const { go, view, tab, subject } = useAppNav();
  const grants = useGrants();
  const canFindPlayers = hasCap(grants, "server.view");
  const serverCmds: Command[] = servers.map((s) => ({
    id: `srv:${s.id}`, title: s.name, group: "Switch server",
    hint: s.id === serverId ? "current" : undefined, icon: <Icon name="servers" />,
    run: () => setServerId(s.id),
  }));
  // Opened the way the directory opens one: the profile, and a place on the recent list.
  const findPlayers = useCallback(async (q: string): Promise<Command[]> => {
    const r = await api<{ players?: FoundPlayer[] }>(`/players?${new URLSearchParams({ q, limit: "8" })}`);
    return (r.players ?? []).map((p) => ({
      id: `player:${p.id}`, title: p.name || p.platformId || p.id, group: "Players", icon: <Icon name="players" />,
      hint: [platformLabel(p.platform), p.lastSeen ? `seen ${fmtRelative(p.lastSeen)}` : ""].filter(Boolean).join(" · ") || undefined,
      run: () => {
        recordRecent({ kind: "player", label: p.name || p.id, sub: "profile", view: "players", target: { playerId: p.id } });
        go("players", { playerId: p.id });
      },
    }));
  }, [go]);
  // Read as the palette opens: what was opened since it last closed is on the list.
  const recent = useMemo(() => (open ? recentCommands(getRecent(), { view, tab, subject }, go) : []), [open, view, tab, subject, go]);
  // The walkthroughs this person may follow (lib/walkthroughs), fetched the first time Search
  // opens: there are enough of them to keep out of the panel's first download. Found by Help's
  // own walkthrough search — matching every word, here among everything else — and opened over
  // whatever screen the person is on.
  const [walkLib, setWalkLib] = useState<WalkLib | null>(null);
  useEffect(() => {
    if (!open || walkLib) return;
    let alive = true;
    import("../lib/walkthroughs").then((m) => { if (alive) setWalkLib(m); }).catch(() => { /* Search works without them */ });
    return () => { alive = false; };
  }, [open, walkLib]);
  const mineWalks = useMemo(() => walkLib?.walkthroughsFor(grants) ?? [], [walkLib, grants]);
  const findWalks = useCallback((q: string): Command[] => (walkLib ? walkLib.searchWalkthroughs(mineWalks, q, { every: true }).slice(0, 5) : []).map((w) => ({
    id: `walk:${w.id}`, title: w.title, group: "Walkthroughs", hint: w.blurb, icon: <Icon name="help" />,
    run: () => walkLib?.openWalkthrough(w.id),
  })), [walkLib, mineWalks]);
  return <CommandPalette open={open} onClose={onClose} commands={[...base, ...serverCmds]} recent={recent} search={canFindPlayers ? findPlayers : undefined} found={findWalks} />;
}

/** Subsequence match (e.g. "cfg" matches "Config") with a light score for ranking. */
function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  if (t.includes(s)) return 100 - t.indexOf(s); // contiguous match ranks highest
  let ti = 0, hits = 0;
  for (const ch of s) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return 0;
    ti = idx + 1; hits++;
  }
  return hits; // loose subsequence
}

export default function CommandPalette({ open, onClose, commands, recent, search, found: own }: {
  open: boolean; onClose: () => void; commands: Command[];
  /** All that is listed before anything is typed: what was opened lately. */
  recent?: Command[];
  /** Asked as you type, from two characters, for what cannot be listed up front (players). */
  search?: (q: string) => Promise<Command[]>;
  /** Asked as you type, for what has a search of its own (walkthroughs): its matches, best first. */
  found?: (q: string) => Command[];
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ(""); setSel(0);
    // On a computer, Ctrl K is followed straight away by typing, so the box takes the focus before
    // the next key can land — later, the first letters went nowhere and the search sat empty. A
    // touch screen keeps the short wait it always had.
    if (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) inputRef.current?.focus();
    else setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // What `search` found, kept with the text it answers: an answer for an earlier text, still on
  // its way when the next letter was typed, is dropped rather than shown under the newer one.
  const asked = q.trim();
  const [found, setFound] = useState<{ q: string; items: Command[] }>({ q: "", items: [] });
  useEffect(() => {
    if (!search || asked.length < 2) return;
    let stale = false;
    const t = setTimeout(() => {
      search(asked).catch(() => []).then((items) => { if (!stale) setFound({ q: asked, items }); });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [asked, search]);
  const searching = Boolean(search) && asked.length >= 2 && found.q !== asked;

  const results = useMemo(() => {
    // Before anything is typed, only what was opened lately. Every screen listed under it, each
    // with a sentence beside its name, was a wall to scroll past, and typing finds any of them.
    if (!q.trim()) return recent ?? [];
    // Title matches outrank description/keyword matches, so typing an exact name still wins, but
    // describing what you want ("welcome message", "ban someone") still finds the screen.
    const named = (c: Command) => `${c.title} ${c.group}`;
    const described = (c: Command) => `${c.hint ?? ""} ${(c.keywords ?? []).join(" ")}`;
    const holds = (text: string) => text.toLowerCase().includes(q.toLowerCase());
    // Three tiers, each in its own order: what a name or a description holds outright, then the
    // walkthroughs, then what only has the letters in order ("cfg" for Config). A word met far
    // into a long description scores under those letter matches (Live's "roster"), so the tiers,
    // not the scores, keep it, and the walkthroughs, above them.
    const scored = commands
      .map((c) => ({ c, s: Math.max(score(q, named(c)) * 2, score(q, described(c))), tier: holds(named(c)) || holds(described(c)) ? 0 : 2 }))
      .filter((r) => r.s > 0);
    // The search's own matches, whatever the fuzzy score says — a game id finds its player, whose
    // name holds no digits — ranking with the titles when the name matches too.
    if (found.q === q.trim()) scored.push(...found.items.map((c) => ({ c, s: Math.max(score(q, c.title) * 2, 100), tier: 0 })));
    // A walkthrough's own search has already judged it a match: listed in the order that search
    // put them, below the screens and players matched outright — with those, when its title holds
    // what was typed.
    if (own) scored.push(...own(q).map((c, i) => (holds(c.title) ? { c, s: score(q, c.title) * 2, tier: 0 } : { c, s: -i, tier: 1 })));
    scored.sort((a, b) => a.tier - b.tier || b.s - a.s);
    return scored.map((r) => r.c).slice(0, 40);
  }, [q, commands, found, recent, own]);

  // Players arriving can land above the highlighted row: back to the top, so Enter never runs a
  // row that moved under it.
  useEffect(() => { setSel(0); }, [q, found]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const c = results[sel]; if (c) { c.run(); onClose(); } }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  // Group results in display order (groups appear as their first result is encountered).
  const groups: { label: string; items: { c: Command; i: number }[] }[] = [];
  results.forEach((c, i) => {
    let g = groups.find((x) => x.label === c.group);
    if (!g) { g = { label: c.group, items: [] }; groups.push(g); }
    g.items.push({ c, i });
  });

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="cmdk-input">
          <span className="cmdk-search" aria-hidden>⌕</span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={search ? "Search views, players, servers, actions…" : "Search views, servers, actions…"} />
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {!results.length && (
            <div className="cmdk-empty">
              {!asked ? (search ? "Type to find a screen, a player, a server or a walkthrough." : "Type to find a screen, a server or a walkthrough.") : searching ? "Searching…" : "No matches."}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label} className="cmdk-group">
              <div className="cmdk-group-label">{g.label}</div>
              {g.items.map(({ c, i }) => (
                <button key={c.id} data-i={i} className={`cmdk-item ${i === sel ? "active" : ""}`} onMouseMove={() => setSel(i)} onClick={() => { c.run(); onClose(); }}>
                  {c.icon && <span className="cmdk-ico">{c.icon}</span>}
                  <span className="cmdk-title">{c.title}</span>
                  {c.hint && <span className="cmdk-hint">{c.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
