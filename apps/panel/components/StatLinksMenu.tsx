"use client";
/** "View on…" dropdown of external stat-site links for a player (opens each in a new tab). */
import { useEffect, useRef, useState } from "react";
import { buildStatLinks } from "../lib/statLinks";

export function StatLinksMenu({ platform, platformId }: { platform: string; platformId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const links = buildStatLinks(platform, platformId);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  if (!links.length) return null;
  return (
    <div className="settings-menu" ref={ref} style={{ display: "inline-block" }}>
      <button className="ghost" onClick={() => setOpen((o) => !o)}>View on… ▾</button>
      {open && (
        <div className="settings-pop" role="menu" style={{ right: 0, minWidth: 200 }}>
          <div className="sm-label">External stats</div>
          {links.map((l) => (
            <a key={l.label} className="sm-item" href={l.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
              <span className="grow">{l.label}</span>
              {l.note && <span className="muted fs-xs">{l.note}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
