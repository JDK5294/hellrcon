"use client";
import { useEffect, useState } from "react";
import { ACCENT_PRESETS, applyTheme, readTheme, watchSystem, type ThemeMode, type ThemePref } from "../lib/theme";
import { saveTheme } from "../lib/accountPrefs";
import { Explanation } from "./ui";

/** Full theme controls (mode + accent) for the Settings view. */
export default function ThemeControls() {
  const [pref, setPref] = useState<ThemePref>({ mode: "system", accent: null });

  useEffect(() => {
    const p = readTheme();
    setPref(p);
    applyTheme(p);
    return watchSystem(() => readTheme());
  }, []);

  function update(next: ThemePref) { setPref(next); saveTheme(next); }

  return (
    <fieldset>
      <legend>Appearance</legend>
      <Explanation>Choose light, dark, or follow your system — and an accent colour. Saved to your account, so every device you sign in on matches.</Explanation>

      <label className="m-0">Theme</label>
      <div className="seg" role="group" aria-label="Theme" style={{ marginTop: 6 }}>
        {(["light", "dark", "system"] as ThemeMode[]).map((m) => (
          <button key={m} className={`seg-btn ${pref.mode === m ? "active" : ""}`} onClick={() => update({ ...pref, mode: m })}>
            {m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      <label style={{ marginTop: 14 }}>Accent</label>
      <div className="swatches" role="group" aria-label="Accent">
        {ACCENT_PRESETS.map((a) => (
          <button
            key={a.value}
            title={a.name}
            className={`swatch ${pref.accent === a.value ? "on" : ""}`}
            style={{ background: a.value }}
            onClick={() => update({ ...pref, accent: a.value })}
          />
        ))}
        <label className="swatch custom" title="Custom colour" style={{ background: pref.accent && !ACCENT_PRESETS.some((a) => a.value === pref.accent) ? pref.accent : undefined }}>
          <input type="color" value={pref.accent ?? "#64748b"} onChange={(e) => update({ ...pref, accent: e.target.value })} />
          <span aria-hidden>🎨</span>
        </label>
        {pref.accent && (
          <button className="mini ghost" style={{ marginLeft: 6 }} onClick={() => update({ ...pref, accent: null })}>Reset</button>
        )}
      </div>
    </fieldset>
  );
}

