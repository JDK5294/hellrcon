"use client";
/**
 * The single bottom-left "account & settings" source. One trigger (the user chip) opens a popover
 * that gathers everything that used to be scattered across the footer, the nav, and the command
 * palette: theme, appearance/accent + API tokens/plugins (the Settings view), the layout editor, and
 * log out. Consolidating removes the duplicate entry points.
 */
import { useEffect, useRef, useState } from "react";
import { readTheme, type ThemeMode } from "../lib/theme";
import { saveTheme } from "../lib/accountPrefs";
import { useGrants } from "../lib/grants";
import { hasCap } from "../lib/access";

export function SettingsMenu({ username, editing, collapsed, discordLinked, onOpenSettings, onEditLayout, onLinkDiscord, onLogout }: {
  username: string;
  editing: boolean;
  collapsed: boolean;
  /** undefined = unknown yet; true = this account already has a Discord identity. */
  discordLinked?: boolean;
  onOpenSettings: () => void;
  onEditLayout: () => void;
  /** Starts the OAuth link flow for THIS account (absorbs an auto-created duplicate if one exists). */
  onLinkDiscord: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ThemeMode>("system");
  // Settings has nothing to make for someone without the permission, so the shortcut isn't offered.
  const makesTokens = hasCap(useGrants(), "api.tokens", "write");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setMode(readTheme().mode); }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onEsc); };
  }, [open]);

  const setThemeMode = (m: ThemeMode) => { setMode(m); saveTheme({ ...readTheme(), mode: m }); };
  const go = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <div className="settings-menu" ref={ref}>
      <button className={`settings-trigger ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)} title="Account & settings" aria-haspopup="menu" aria-expanded={open}>
        <span className="avatar">{(username || "?").charAt(0).toUpperCase()}</span>
        {!collapsed && (
          <span className="user-meta">
            <span className="name">{username}</span>
            <span className="sub">Account & settings</span>
          </span>
        )}
        {!collapsed && <span className="sm-chev" aria-hidden>▾</span>}
      </button>

      {open && (
        <div className="settings-pop" role="menu">
          <div className="sm-label">Theme</div>
          <div className="seg sm-seg">
            {(["system", "light", "dark"] as ThemeMode[]).map((m) => (
              <button key={m} className={`seg-btn ${mode === m ? "active" : ""}`} onClick={() => setThemeMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>
            ))}
          </div>
          <div className="sm-sep" />
          <button className="sm-item" role="menuitem" onClick={() => go(onOpenSettings)}><span className="sm-ico">🎨</span> Appearance &amp; accent…</button>
          <button className="sm-item" role="menuitem" onClick={() => go(onEditLayout)}><span className="sm-ico">▦</span> {editing ? "Close layout editor" : "Edit layout"}</button>
          {makesTokens && <button className="sm-item" role="menuitem" onClick={() => go(onOpenSettings)}><span className="sm-ico">🔑</span> API tokens &amp; plugins…</button>}
          {discordLinked === false && (
            <button className="sm-item" role="menuitem" title="Connect your Discord so Discord sign-in lands on THIS account (and absorbs any duplicate it already created)" onClick={() => go(onLinkDiscord)}>
              <span className="sm-ico">🔗</span> Link Discord…
            </button>
          )}
          <div className="sm-sep" />
          <button className="sm-item danger" role="menuitem" onClick={() => go(onLogout)}><span className="sm-ico">⏻</span> Log out</button>
        </div>
      )}
    </div>
  );
}
