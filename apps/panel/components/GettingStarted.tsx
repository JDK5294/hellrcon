"use client";
/**
 * Getting started: the panel set up for the person using it, a step at a time — how it looks, how
 * big the text is, which clock it reads, where it opens (and whether What's new opens after an
 * update), what reaches their phone — then the walkthroughs made for what they can do, and how to
 * get around.
 *
 * Each choice applies the moment it is made and is saved exactly as Settings saves it: these are
 * the same settings, in an order that makes sense the first time. What is offered follows the
 * person's permissions like everything else — the screens they can land on, the notifications about
 * things they can see, the walkthroughs for what they hold.
 *
 * Shown once (lib/gettingStarted), skippable at every step, and opened again from Help → Start here.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import ThemeControls from "./ThemeControls";
import { PhoneNotifications } from "./Settings";
import { Modal, Toggle } from "./ui";
import { WalkthroughPlayer } from "./Walkthroughs";
import { useGrants } from "../lib/grants";
import { writeUserPrefs } from "../lib/accountPrefs";
import { DEFAULT_USER_PREFS, FONT_SCALES, SCREEN_SIZES, readUserPrefs, writeUserPrefsLocal, type UserPrefs } from "../lib/userPrefs";
import { applyDisplayZone, deviceZone, useCommunityZone, zoneOptions } from "../lib/zones";
import { ROUTES, canOpenRoute } from "../lib/routes";
import { WALK_GROUPS, showOnScreen, walkthroughsFor, type Walkthrough } from "../lib/walkthroughs";

const STEPS = ["welcome", "look", "reading", "time", "opening", "phone", "walkthroughs", "around"] as const;

/** One setting: what it is, a line on what it does, and the control. */
function Choice({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setup-choice">
      <div className="setup-choice-title">{title}</div>
      {hint && <p className="setup-choice-hint">{hint}</p>}
      {children}
    </div>
  );
}

/** A row of buttons, the one chosen lit — the control Settings uses for the same choices. Named for
 *  its choice, so the row is read out as the one setting it is. */
function Seg<T extends string | number | boolean>({ name, value, options, onPick }: { name: string; value: T; options: { value: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <div className="seg" role="group" aria-label={name}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={`seg-btn ${value === o.value ? "active" : ""}`} onClick={() => onPick(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export default function GettingStarted({ name, onDone }: { name: string; onDone: () => void }) {
  const grants = useGrants();
  const [at, setAt] = useState(0);
  const [prefs, setPrefs] = useState<UserPrefs>(() => ({ ...DEFAULT_USER_PREFS }));
  useEffect(() => { setPrefs(readUserPrefs()); }, []);
  const communityTz = useCommunityZone();
  // A walkthrough opened from the list: played in place of the setup, which comes back after it.
  const [playing, setPlaying] = useState<Walkthrough | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => { setNarrow(window.matchMedia("(max-width: 860px)").matches); }, []);

  const update = (patch: Partial<UserPrefs>) => {
    setPrefs(writeUserPrefs(patch));
    // The whole panel reads the new clock at once, as it does from Settings.
    if (patch.timeZone !== undefined) applyDisplayZone(communityTz);
  };
  const groups = useMemo(() => {
    const mine = walkthroughsFor(grants);
    return WALK_GROUPS.map((label) => ({ label, items: mine.filter((w) => w.group === label) })).filter((g) => g.items.length);
  }, [grants]);
  // Only screens this account can open, as the menu shows them — never a plugin's (see Settings).
  const landings = ROUTES.filter((r) => !r.parent && !r.hidden && canOpenRoute(grants, r));
  const landingListed = landings.some((r) => r.id === prefs.landing);
  const keys = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";
  const last = STEPS.length - 1;
  const step = STEPS[at];

  if (playing) {
    return <WalkthroughPlayer walk={playing} onClose={() => setPlaying(null)} onLive={(i) => { onDone(); showOnScreen(playing.id, i); }} />;
  }

  return (
    <Modal title="Getting started" onClose={onDone} className="setup-modal">
      <div className="setup-pips" role="img" aria-label={`Step ${at + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => <span key={s} className={`setup-pip${i <= at ? " on" : ""}`} />)}
      </div>

      {step === "welcome" && (
        <section className="setup-step">
          <h4>Welcome{name ? `, ${name}` : ""}</h4>
          <p>A minute to set the panel up the way you like it. Then a quick look at what you can do here, and how to get around.</p>
          <p>Each choice applies straight away. You can change any of them later in Settings.</p>
        </section>
      )}

      {step === "look" && (
        <section className="setup-step">
          <h4>How it looks</h4>
          <ThemeControls />
        </section>
      )}

      {step === "reading" && (
        <section className="setup-step">
          <h4>Reading</h4>
          <Choice title="Text size" hint="Bigger or smaller words, everywhere in the panel.">
            <Seg name="Text size" value={prefs.fontScale} options={FONT_SCALES.map((f) => ({ value: f.value as number, label: f.label }))} onPick={(fontScale) => update({ fontScale })} />
          </Choice>
          <Choice title="Density" hint={prefs.density === "compact" ? "Compact: the most rows on a screen. Best on a computer." : "Cozy: roomier rows and bigger buttons. Easier on a phone."}>
            <Seg name="Density" value={prefs.density} options={[{ value: "compact", label: "Compact" }, { value: "cozy", label: "Cozy" }]} onPick={(density) => update({ density })} />
          </Choice>
        </section>
      )}

      {step === "time" && (
        <section className="setup-step">
          <h4>Your clock</h4>
          <Choice title="Times shown in" hint={prefs.timeZone ? `Every date and time shows in ${prefs.timeZone}.` : `Following the community's clock${communityTz ? `, ${communityTz}` : ""}.`}>
            <select aria-label="Times shown in" value={prefs.timeZone} onChange={(e) => update({ timeZone: e.target.value })}>
              <option value="">Community default{communityTz ? ` (${communityTz})` : ""}</option>
              {zoneOptions(communityTz).map((z) => <option key={z} value={z}>{z}{z === deviceZone() ? " (your device)" : ""}</option>)}
            </select>
          </Choice>
          <Choice title="Schedule times on your clock" hint="Show each schedule's time on your own clock too, beside the community's.">
            <Seg name="Schedule times on your clock" value={prefs.localTimes} options={[{ value: true, label: "Show my local time" }, { value: false, label: "Community clock only" }]} onPick={(localTimes) => update({ localTimes })} />
          </Choice>
        </section>
      )}

      {step === "opening" && (
        <section className="setup-step">
          <h4>Where it opens</h4>
          <Choice title="Open the panel on" hint={landings.find((r) => r.id === prefs.landing)?.blurb ?? "The screen you land on when you sign in."}>
            <select aria-label="Open the panel on" value={landingListed ? prefs.landing : ""} onChange={(e) => update({ landing: e.target.value })}>
              {!landingListed && <option value="" disabled>Choose a screen…</option>}
              {landings.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          </Choice>
          <Choice title="What's new after an update" hint={prefs.whatsNew ? "A note on what changed opens once after each update." : "Off: each update's notes wait in Help, under What's new."}>
            <Toggle checked={prefs.whatsNew} onChange={(whatsNew) => update({ whatsNew })} label={prefs.whatsNew ? "On" : "Off"} />
          </Choice>
          {/* A computer's choice: the menu packs to the screen. This device's alone, as in Settings. */}
          {!narrow && (
            <Choice title="Screen size" hint="The menu packs itself to fit. Automatic fits this window; or pick your screen.">
              <select aria-label="Screen size" value={prefs.screenSize} onChange={(e) => setPrefs(writeUserPrefsLocal({ screenSize: e.target.value }))}>
                <option value="auto">Automatic — fits this window</option>
                {SCREEN_SIZES.map((s) => <option key={s.id} value={s.id}>{s.label} — {s.hint}</option>)}
              </select>
            </Choice>
          )}
        </section>
      )}

      {step === "phone" && (
        <section className="setup-step">
          <h4>Notifications and phones</h4>
          <PhoneNotifications />
          <Choice title="Quick bar on phones" hint="On a phone, a bar of buttons keeps your most used screens one tap away.">
            <Seg name="Quick bar on phones" value={prefs.phoneBar} options={[{ value: "bottom", label: "Bottom" }, { value: "top", label: "Top" }, { value: "off", label: "Off" }]} onPick={(phoneBar) => update({ phoneBar })} />
          </Choice>
        </section>
      )}

      {step === "walkthroughs" && (
        <section className="setup-step">
          <h4>What you can do</h4>
          <p>A walkthrough for each thing your permissions let you do, a step at a time. Open one now, or find them in Help, under Start here.</p>
          {groups.map((g) => (
            <div key={g.label} className="help-group">
              <h5 className="help-group-label">{g.label}</h5>
              <ul className="walk-list">
                {g.items.map((w) => (
                  <li key={w.id}>
                    <button type="button" className="walk-card" onClick={() => setPlaying(w)}>
                      <span className="walk-card-title">{w.title}</span>
                      <span className="muted walk-card-blurb">{w.blurb}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {step === "around" && (
        <section className="setup-step">
          <h4>Finding your way around</h4>
          <ul className="setup-tips">
            <li>{narrow ? <><strong>☰</strong> opens the menu: every screen you can open.</> : <><strong>The menu</strong> on the left lists every screen you can open.</>}</li>
            <li><strong>Search</strong> finds any screen, player or setting{narrow ? "." : <>. Press <kbd>{keys}</kbd>.</>}</li>
            <li><strong>Back and forward</strong>, beside Search, step through the screens you opened.</li>
            <li>{narrow ? <><strong>Your initial</strong>, at the top right, opens Settings.</> : <><strong>Your name</strong>, at the foot of the menu, opens Settings.</>}</li>
            <li><strong>Help</strong> keeps your walkthroughs, and this setup.</li>
          </ul>
          <p>Show me around points out each one on your screen.</p>
        </section>
      )}

      <div className="pa-actions setup-actions">
        {at < last && <button type="button" className="ghost setup-skip" onClick={onDone}>Skip setup</button>}
        {at > 0 && <button type="button" className="ghost" onClick={() => setAt(at - 1)}>Back</button>}
        {at < last
          ? <button type="button" className="primary" onClick={() => setAt(at + 1)}>{at === 0 ? "Let's start" : "Next"}</button>
          : (<>
            <button type="button" onClick={() => { onDone(); showOnScreen("getting-around"); }}>Show me around</button>
            <button type="button" className="primary" onClick={onDone}>Finish</button>
          </>)}
      </div>
    </Modal>
  );
}
