"use client";
/**
 * Searchable player picker — staff find a player by NAME (or paste an id) instead of hunting for a
 * raw platform id. Backed by GET /players?q= (the records-grade directory), and each result renders
 * as a mini player CARD — platform, VIP/watch state, last seen, playtime, kills — because two
 * players can share a name and a raw id alone doesn't tell staff which one they're about to act on.
 * Because a brand-new player who's never been seen won't be indexed yet, the dropdown always offers
 * a "use as a raw id" escape hatch, so nothing that used a raw-id text box loses capability. Stores
 * the raw platform id; shows the friendly name. Styling reuses the shared `.picker*` classes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { platformLabel } from "../lib/platform";
import { fmtRelative } from "../lib/time";
import { GameId } from "./GameId";

export interface PickedPlayer { playerId: string; name: string }
interface Hit {
  id: string; platformId: string; name: string;
  platform?: string | null;
  lastSeen?: string | null;
  kills?: number;
  playtimeSec?: number;
  watchlist?: boolean;
  /** a live VIP grant vs. the cosmetic profile marker — either lights the star. */
  vip?: boolean;
}

export function PlayerPicker({ value, onChange, placeholder = "Search a player by name…", allowRawId = true, disabled, game }: {
  value: PickedPlayer | null;
  onChange: (p: PickedPlayer | null) => void;
  placeholder?: string;
  /** show the "use as a raw id" fallback option (for players not yet in our index). */
  allowRawId?: boolean;
  disabled?: boolean;
  /** Set by flows that target a server: only that game's accounts are offered, because the games
   *  issue different player ids and the other game's id is a command the server applies to nobody. */
  game?: string;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const needle = q.trim();
    if (!needle || value) { setHits([]); return; }
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api<{ players: Hit[] }>(`/players?q=${encodeURIComponent(needle)}&limit=20${game ? `&game=${encodeURIComponent(game)}` : ""}`)
        .then((r) => { if (mine === seq.current) setHits(r.players ?? []); })
        .catch(() => { if (mine === seq.current) setHits([]); })
        .finally(() => { if (mine === seq.current) setLoading(false); });
    }, 200); // debounce keystrokes
    return () => clearTimeout(t);
  }, [q, value, game]);

  // A pasted id looks like a long token with no spaces (steam64, UUID, T17 hex…).
  const rawIdCandidate = useMemo(() => {
    const t = q.trim();
    return allowRawId && t.length >= 5 && !/\s/.test(t) ? t : "";
  }, [q, allowRawId]);

  const pick = (p: PickedPlayer) => { onChange(p); setQ(""); setHits([]); };

  return (
    <div className="picker">
      <div className="picker-chips">
        {value && (
          <span className="picker-chip">
            {value.name || value.playerId}
            {!disabled && <button type="button" onClick={() => onChange(null)} aria-label="clear">✕</button>}
          </span>
        )}
      </div>
      {!disabled && !value && (
        <div className="picker-input-wrap">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} />
          {(hits.length > 0 || rawIdCandidate || (q.trim() && !loading)) && (
            <div className="picker-menu">
              {hits.map((h) => {
                const hours = Math.round((h.playtimeSec ?? 0) / 3600);
                return (
                  <button key={h.id} type="button" className="picker-opt picker-card" title={h.platformId}
                    onClick={() => pick({ playerId: h.platformId, name: h.name })}>
                    <span className="picker-card-top">
                      <strong>{h.name || h.platformId}</strong>
                      {h.platform && <span className="badge" title={h.platform}>{platformLabel(h.platform)}</span>}
                      {h.vip && <span className="badge active">★ VIP</span>}
                      {h.watchlist && <span className="badge observe">👁 watched</span>}
                    </span>
                    <span className="picker-card-sub">
                      <GameId id={h.platformId} truncate={18} />
                      {h.lastSeen && <> · seen {fmtRelative(h.lastSeen)}</>}
                      {hours > 0 && <> · {hours.toLocaleString()} h played</>}
                      {(h.kills ?? 0) > 0 && <> · {(h.kills ?? 0).toLocaleString()} kills</>}
                    </span>
                  </button>
                );
              })}
              {hits.length === 0 && !loading && q.trim() && !rawIdCandidate && (
                <div className="picker-opt" style={{ cursor: "default" }}><span className="muted">No players match “{q.trim()}”.</span></div>
              )}
              {rawIdCandidate && (
                <button type="button" className="picker-opt" onClick={() => pick({ playerId: rawIdCandidate, name: "" })}>
                  Use “<strong>{rawIdCandidate}</strong>” as a raw id
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
