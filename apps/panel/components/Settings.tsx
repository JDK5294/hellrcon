"use client";
import { Fragment, useEffect, useState } from "react";
import { api, fmt, setToken } from "../lib/api";
import { useConfirm, useToast } from "../lib/feedback";
import ThemeControls from "./ThemeControls";
import { ActionResult, Nothing, PageHeader, SettingCard, SettingSwitch, Toggle } from "./ui";
import { DEFAULT_USER_PREFS, FONT_SCALES, PHONE_BAR_MAX, SCREEN_SIZES, readUserPrefs, writeUserPrefsLocal, type PhoneAlerts, type UserPrefs } from "../lib/userPrefs";
import { saveAccountPrefs, writeUserPrefs } from "../lib/accountPrefs";
import { ROUTES, canOpenRoute, pluginRoutes, routeById } from "../lib/routes";
import { useGrants } from "../lib/grants";
import { hasCap } from "../lib/access";
import { pushState, testPush, turnOffPush, turnOnPush, type PushState } from "../lib/push";
import { applyDisplayZone, deviceZone, useCommunityZone, zoneOptions } from "../lib/zones";
import { PanelGroup, Panel } from "./Panel";
import { Time } from "./Time";

interface Token { id: string; name: string; createdAt: string; expiresAt: string | null }

/** Personal settings: each person's own, the same for everyone who opens them. What belongs to the
 *  whole community lives with the permission that changes it — its clock on Users & roles, loaded
 *  plugins and service health in the System view. */
export default function Settings() {
  return (
    <div>
      <div className="card page-head">
        <PageHeader routeId="settings" />
      </div>
      <PanelGroup viewId="settings">
        <Panel id="workspace" caps="open" title="Workspace" subtitle="how the panel opens and how tight it packs"><WorkspacePrefs /></Panel>
        <Panel id="notifications" caps="open" title="Phone notifications" subtitle="when something needs you"><PhoneNotifications /></Panel>
        <Panel id="appearance" caps="open" title="Appearance"><ThemeControls /></Panel>
        <PasswordChange />
        <ApiTokens />
      </PanelGroup>
    </div>
  );
}

/**
 * The quick bar's buttons: the screens this person uses most, up to PHONE_BAR_MAX, in their order —
 * any screen or hub tab their account can open, a plugin's included, and Search. More always
 * follows them on the bar, so the whole menu stays a tap away. Each change saves at once, like the
 * rest of Workspace.
 */
function QuickBarButtons({ items, onChange }: { items: string[]; onChange: (next: string[]) => void }) {
  const grants = useGrants();
  // Every screen and hub tab this account may open, in the menu's order, by the menu's names — then
  // the screens plugins add, which the menu lists too.
  const choices = [...[...ROUTES, ...pluginRoutes()].filter((r) => (!r.hidden || r.parent) && canOpenRoute(grants, r)).map((r) => r.id), "search"];
  const nameOf = (id: string): string => {
    if (id === "search") return "Search";
    const r = routeById(id);
    const parent = r?.parent ? routeById(r.parent) : undefined;
    return parent ? `${parent.title} › ${r!.title}` : r?.title ?? id;
  };
  // Not before the permissions have loaded: until then the account seems able to open nothing, and
  // a change made then would save a list without the screens it can.
  if (!grants.length) return null;
  // Every button saved, in order, but one for a screen this account may not open: that is not on
  // its bar either (the starting list's Bans, for an account without the ban list). One for a
  // screen the panel does not have right now, a plugin's that is not running, is listed and said
  // so, and stays off the bar until it is back: left out of this list, the next change saved the
  // list without it, and it was gone for good.
  const shown = items.filter((id) => choices.includes(id) || !routeById(id));
  const label = (id: string) => (choices.includes(id) ? nameOf(id) : "A screen (not available right now)");
  const move = (i: number, by: -1 | 1) => {
    const next = [...shown];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onChange(next);
  };
  return (
    <SettingCard
      title="Quick bar buttons"
      description={`The screens you use most, up to ${PHONE_BAR_MAX}, in the order the bar shows them. More always comes last and opens the whole menu.`}
    >
      {shown.length === 0 && <p className="muted fs-sm mt-0">No buttons yet: the bar shows More alone.</p>}
      {shown.map((id, i) => (
        <div key={id} className="control-row sentence-row quick-pick">
          <span className="field-label">{label(id)}</span>
          <button type="button" className="ghost mini" aria-label={`Move ${label(id)} earlier`} title="Earlier on the bar" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
          <button type="button" className="ghost mini" aria-label={`Move ${label(id)} later`} title="Later on the bar" disabled={i === shown.length - 1} onClick={() => move(i, 1)}>↓</button>
          <button type="button" className="ghost mini" aria-label={`Take ${label(id)} off the bar`} title="Take off the bar" onClick={() => onChange(shown.filter((x) => x !== id))}>✕</button>
        </div>
      ))}
      {shown.length >= PHONE_BAR_MAX && <p className="muted fs-sm mb-0">{PHONE_BAR_MAX} is the most. Take one off to add another.</p>}
      {shown.length < PHONE_BAR_MAX && (
        <select value="" aria-label="Add a button to the quick bar" onChange={(e) => { if (e.target.value) onChange([...shown, e.target.value]); }} style={{ maxWidth: 300 }}>
          <option value="">+ Add a screen…</option>
          {choices.filter((id) => !shown.includes(id)).map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
        </select>
      )}
    </SettingCard>
  );
}

/**
 * The two preferences that change how the whole app feels, kept together and explained in plain
 * words: where it opens, and how much it packs onto a screen. Both are personal and take effect
 * immediately — nothing to save.
 */
function WorkspacePrefs() {
  const [prefs, setPrefs] = useState<UserPrefs>(() => ({ ...DEFAULT_USER_PREFS }));
  useEffect(() => { setPrefs(readUserPrefs()); }, []);
  const communityTz = useCommunityZone();
  const update = (patch: Partial<UserPrefs>) => {
    const merged = writeUserPrefs(patch);
    setPrefs(merged);
    // The display zone follows the preference immediately — no reload, no waiting on the 30s clock.
    if (patch.timeZone !== undefined) applyDisplayZone(communityTz);
    return merged;
  };
  // Only offer landing pages that exist as real destinations, and that this account can open — a
  // destination the nav hides from them must not turn up here under its name instead. A plugin's
  // page is never a landing: picking one would write its id into the account's synced preferences,
  // which ride /api/me and the data export.
  const grants = useGrants();
  const landings = ROUTES.filter((r) => !r.parent && !r.hidden && canOpenRoute(grants, r));
  // A saved landing this list no longer offers (one they lost access to) shows as "choose one"
  // rather than as whatever option happens to come first — which also made that first option
  // impossible to pick, since choosing what is already shown fires no change. Before grants load
  // the list is short, so this waits for them rather than flashing the placeholder.
  const listed = landings.some((r) => r.id === prefs.landing);
  const landingBlurb = landings.find((r) => r.id === prefs.landing)?.blurb;
  // The window's size, for the Screen size card to say what Automatic is fitting right now.
  const [win, setWin] = useState<[number, number] | null>(null);
  useEffect(() => {
    const read = () => setWin([window.innerWidth, window.innerHeight]);
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  const screen = SCREEN_SIZES.find((s) => s.id === prefs.screenSize);

  return (
    <>
      <SettingCard
        title="Open the panel on"
        description="The screen you land on when you sign in or open a fresh tab."
        helper={landingBlurb}
      >
        <select value={listed || grants.length === 0 ? prefs.landing : ""} onChange={(e) => update({ landing: e.target.value })} style={{ maxWidth: 260 }}>
          {!listed && grants.length > 0 && <option value="" disabled>Choose a screen…</option>}
          {landings.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
      </SettingCard>
      <SettingCard
        title="What's new after an update"
        description="When the panel is updated, a note on what changed opens once, the next time you open the panel. Switch it off and it no longer opens: every update's notes stay in Help, under What's new."
        helper={prefs.whatsNew ? "On: it opens once after each update." : "Off: read it in Help, under What's new, whenever you like."}
      >
        <Toggle checked={prefs.whatsNew} onChange={(whatsNew) => update({ whatsNew })} label={prefs.whatsNew ? "On" : "Off"} />
      </SettingCard>
      <SettingCard
        title="Density"
        description="How much the panel packs onto a screen."
        helper={prefs.density === "compact"
          ? "Compact: the most rows per screen — best on a monitor, and what the live roster is tuned for."
          : "Cozy: roomier rows and bigger tap targets — easier on a tablet or phone."}
      >
        <div className="seg">
          <button className={`seg-btn ${prefs.density === "compact" ? "active" : ""}`} onClick={() => update({ density: "compact" })}>Compact</button>
          <button className={`seg-btn ${prefs.density === "cozy" ? "active" : ""}`} onClick={() => update({ density: "cozy" })}>Cozy</button>
        </div>
      </SettingCard>
      <SettingCard
        title="Screen size"
        description="On a computer the menu packs itself to fit, so every screen in it stays in view: roomy on a big monitor, tighter on a laptop. Automatic fits the window you are in, as it changes. Or pick your screen, and the menu packs for that size whatever the window. This device keeps its own choice, since a laptop and a monitor want different ones."
        helper={screen
          ? `Packed for a ${screen.label} screen. In a smaller window the menu scrolls; in a bigger one it has room to spare.`
          : `Automatic: the menu fits this window${win ? `, ${win[0]} × ${win[1]} right now` : ""}.`}
      >
        {/* This device's alone: written here and never to the account (lib/userPrefs, screenSize). */}
        <select aria-label="Screen size" value={prefs.screenSize} onChange={(e) => setPrefs(writeUserPrefsLocal({ screenSize: e.target.value }))} style={{ maxWidth: 360 }}>
          <option value="auto">Automatic — fits this window</option>
          {SCREEN_SIZES.map((s) => <option key={s.id} value={s.id}>{s.label} — {s.hint}</option>)}
        </select>
      </SettingCard>
      <SettingCard
        title="Quick bar on phones"
        description="On a phone, a bar of buttons keeps the screens you use most one tap away. You pick the buttons below."
        helper={prefs.phoneBar === "off"
          ? "Off: no bar. The menu and Search stay at the top of the screen."
          : prefs.phoneBar === "top"
            ? "Top: pinned under the header, so it stays in view as you scroll."
            : "Bottom: along the bottom edge of the screen, where your thumb is."}
      >
        <div className="seg">
          <button className={`seg-btn ${prefs.phoneBar === "bottom" ? "active" : ""}`} onClick={() => update({ phoneBar: "bottom" })}>Bottom</button>
          <button className={`seg-btn ${prefs.phoneBar === "top" ? "active" : ""}`} onClick={() => update({ phoneBar: "top" })}>Top</button>
          <button className={`seg-btn ${prefs.phoneBar === "off" ? "active" : ""}`} onClick={() => update({ phoneBar: "off" })}>Off</button>
        </div>
      </SettingCard>
      {prefs.phoneBar !== "off" && <QuickBarButtons items={prefs.phoneBarItems} onChange={(phoneBarItems) => update({ phoneBarItems })} />}
      <SettingCard
        title="Text size"
        description="Scales every word in the panel. Separate from density on purpose: density decides how many rows fit, this decides whether you can read them."
        helper={prefs.fontScale === 1
          ? "Default: the size the panel was designed at."
          : `${FONT_SCALES.find((f) => f.value === prefs.fontScale)?.label ?? `${Math.round(prefs.fontScale * 100)}%`}: text scales, spacing does not — so a roster keeps its shape as the words grow.`}
      >
        <div className="seg">
          {FONT_SCALES.map((f) => (
            <button key={f.value} className={`seg-btn ${prefs.fontScale === f.value ? "active" : ""}`} onClick={() => update({ fontScale: f.value })}>{f.label}</button>
          ))}
        </div>
      </SettingCard>
      <SettingCard
        title="Times shown in"
        description="The time zone every date and time in the panel is written in — and the zone typed dates (event times, ban expiries) are read in."
        helper={prefs.timeZone
          ? `Everything shows in ${prefs.timeZone}.`
          : `Following the community time zone${communityTz ? ` (${communityTz})` : ""} — the whole staff reads one clock.`}
      >
        <select value={prefs.timeZone} onChange={(e) => update({ timeZone: e.target.value })} style={{ maxWidth: 300 }}>
          <option value="">Community default{communityTz ? ` (${communityTz})` : ""}</option>
          {zoneOptions(communityTz).map((z) => <option key={z} value={z}>{z}{z === deviceZone() ? " (your device)" : ""}</option>)}
        </select>
      </SettingCard>
      <SettingCard
        title="Schedule times on your clock"
        description="Schedules are saved in the community time zone. This shows each one converted to your own device's zone alongside it — useful when you are travelling or the community runs somewhere else."
        helper={prefs.localTimes
          ? `On: a window also reads as its time in ${Intl.DateTimeFormat().resolvedOptions().timeZone || "your zone"}.`
          : "Off: schedule times show only in the zone they are saved in."}
      >
        <div className="seg">
          <button className={`seg-btn ${prefs.localTimes ? "active" : ""}`} onClick={() => update({ localTimes: true })}>Show my local time</button>
          <button className={`seg-btn ${prefs.localTimes ? "" : "active"}`} onClick={() => update({ localTimes: false })}>Configured zone only</button>
        </div>
      </SettingCard>
    </>
  );
}

/**
 * Phone notifications — off until the person turns them on, on each phone or computer they want
 * them on (lib/push). Which ones come is theirs to choose, kept with their other settings so all
 * their devices agree; each is offered only when they could see what it is about. The panel's
 * server sends them (apps/api phone-alerts.ts) and checks the same things again when it does. Getting
 * started offers the same card.
 */
export function PhoneNotifications() {
  const toast = useToast();
  const grants = useGrants();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [alerts, setAlerts] = useState<PhoneAlerts>(() => ({ ...DEFAULT_USER_PREFS.phoneAlerts }));
  // The roles staff bans can be narrowed to — for whoever may see the list of roles. Null until the
  // list has come: a pick reads as removed only when the list says so, never because it failed.
  const [roles, setRoles] = useState<{ id: string; name: string }[] | null>(null);
  const [rolesFailed, setRolesFailed] = useState(false);
  const seesRoles = hasCap(grants, "admin.users");
  useEffect(() => {
    setAlerts(readUserPrefs().phoneAlerts);
    void pushState().then(setState).catch(() => setState("unsupported"));
  }, []);
  useEffect(() => {
    if (!seesRoles) return;
    void api<{ roles?: { id: string; name: string }[] }>("/roles")
      .then((r) => { if (Array.isArray(r.roles)) setRoles(r.roles); else setRolesFailed(true); })
      .catch(() => setRolesFailed(true));
  }, [seesRoles]);

  const flip = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        await turnOnPush();
        toast.success("Notifications are on for this device.");
      } else {
        await turnOffPush();
        toast.info("Notifications are off for this device.");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setState(await pushState().catch(() => "unsupported" as const));
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      await testPush();
      toast.success("Sent. It should arrive in a few seconds.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Which notifications come is decided on the server, from the account's copy, so a choice is made
  // only once it lands there: said and put back when it doesn't. (The display preferences are this
  // device's to apply, and can sync later; these can't.)
  const choose = async (patch: Partial<PhoneAlerts>) => {
    const before = alerts;
    const next = { ...alerts, ...patch };
    setAlerts(next);
    try {
      await saveAccountPrefs({ phoneAlerts: next });
      writeUserPrefsLocal({ phoneAlerts: next });
    } catch (e) {
      setAlerts(before);
      toast.error(`Couldn't save your notification choices: ${(e as Error).message}`);
    }
  };

  const offers: { key: Exclude<keyof PhoneAlerts, "banRoles">; label: string }[] = [
    ...(hasCap(grants, "player.watchlist") ? [{ key: "watch" as const, label: "A player on the watchlist joins a server" }] : []),
    // Signing a request takes the permission it asks for, so someone who can change nothing has none to sign.
    ...(grants.some((g) => g.level === "write") ? [{ key: "requests" as const, label: "A request needs your approval" }] : []),
    { key: "servers", label: "A server stops answering, and when it's back" },
    // Off until switched on, each: offered to whoever could see what it is about, as the server
    // checks again when it sends one.
    ...(hasCap(grants, "server.view") ? [{ key: "admin" as const, label: "A player asks for an admin in chat" }] : []),
    ...(["admin.moderation", "autosettings.profiles", "seeding.config"].some((c) => hasCap(grants, c))
      ? [{ key: "automod" as const, label: "The automatic rules kick or ban a player" }] : []),
    ...(hasCap(grants, "server.view") ? [{ key: "seeding" as const, label: "A server starts seeding, and when it goes live" }] : []),
    { key: "decided", label: "A request you sent is approved or denied" },
    ...(hasCap(grants, "moderation.bans") ? [
      { key: "bans" as const, label: "A staff member bans a player" },
      { key: "permabans" as const, label: "A player is banned for good" },
    ] : []),
    ...(hasCap(grants, "audit.trail") ? [{ key: "settings" as const, label: "A staff member changes a setting" }] : []),
    { key: "notices", label: "A notice is posted for staff" },
    ...(hasCap(grants, "server.admins") ? [{ key: "camera" as const, label: "An admin goes into the admin camera" }] : []),
    ...(hasCap(grants, "economy.balances") ? [{ key: "shop" as const, label: "A member buys something in the shop" }] : []),
  ];
  // A role picked before it was removed stays listed, said so, until it is unticked: left out, a
  // filter of nothing but removed roles would quietly match nobody.
  const roleChoices = roles ? [
    ...roles,
    ...alerts.banRoles.filter((id) => !roles.some((r) => r.id === id)).map((id) => ({ id, name: "A role that was removed" })),
  ] : [];
  const pickRole = (id: string, on: boolean) => void choose({ banRoles: on ? [...alerts.banRoles, id] : alerts.banRoles.filter((x) => x !== id) });
  const why = state === "home-screen" ? "On an iPhone or iPad, only the panel on your Home Screen can get notifications. In Safari, tap Share, then Add to Home Screen. Open the panel from the new icon and turn this on there."
    : state === "insecure" ? "Notifications need the panel's secure address, the one that starts with https://."
      : state === "unsupported" ? "This browser can't show notifications from the panel."
        : state === "blocked" ? "Notifications are blocked for the panel. Allow them in this browser's or phone's settings, then come back here."
          : "";

  return (
    <SettingCard
      title="Notifications on this device"
      description="Get a notification on this phone or computer when something needs you, even when the panel is closed. Turn them on separately on each device you want them on; which ones you get is the same on all of them. Signing out turns this device off."
    >
      {why ? <p className="hint notice">{why}</p> : (
        <SettingSwitch label="On this device" checked={state === "on"} onChange={(v) => void flip(v)} disabled={busy || state === null}>
          <div className="phone-alerts">
            <div className="muted fs-sm">Notify me when:</div>
            {offers.map((o) => (
              <Fragment key={o.key}>
                <Toggle label={o.label} checked={alerts[o.key]} onChange={(v) => void choose({ [o.key]: v })} />
                {o.key === "bans" && alerts.bans && seesRoles && rolesFailed && (
                  <div className="muted fs-sm">The list of roles couldn&apos;t be loaded, so the roles can&apos;t be picked right now.</div>
                )}
                {o.key === "bans" && alerts.bans && seesRoles && roleChoices.length > 0 && (
                  <div className="phone-alert-roles" role="group" aria-label="Only bans by these roles">
                    <div className="muted fs-sm">Only bans by these roles. None picked: every staff member.</div>
                    {roleChoices.map((r) => <Toggle key={r.id} label={r.name} checked={alerts.banRoles.includes(r.id)} onChange={(v) => pickRole(r.id, v)} />)}
                  </div>
                )}
              </Fragment>
            ))}
            <div><button type="button" className="mini ghost" onClick={() => void test()} disabled={busy}>Send a test</button></div>
          </div>
        </SettingSwitch>
      )}
    </SettingCard>
  );
}

/**
 * Change your own password. Proving the CURRENT one is the point — it is what separates this from
 * an admin reset — and on success every other session is signed out while this one continues on
 * the fresh token the API hands back. Discord-only accounts have no password to change, so the
 * panel explains that instead of offering fields that can only fail.
 */
function PasswordChange() {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  useEffect(() => {
    api<{ user?: { hasPassword?: boolean } }>("/me").then((r) => setHasPassword(Boolean(r.user?.hasPassword))).catch(() => setHasPassword(null));
  }, []);

  async function change() {
    if (next !== again) { setError("the new passwords do not match"); setOk(""); return; }
    setBusy(true); setError(""); setOk("");
    try {
      const r = await api<{ token: string }>("/me/password", { method: "PUT", body: { currentPassword: current, newPassword: next } });
      // The old token died with the epoch bump; store the replacement before anything else asks.
      setToken(r.token);
      setCurrent(""); setNext(""); setAgain("");
      setOk("Password changed. Every other session was signed out; this one stays signed in.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel defaultCollapsed id="password" caps="open" title="Password">
      {hasPassword === false ? (
        <p className="muted mt-0">This account signs in with Discord and has no password. An admin can set one under Administration → Users.</p>
      ) : (<>
        <p className="muted mt-0">Changing it signs your account out everywhere else — this session stays.</p>
        <div className="form-row">
          <label>Current password
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label>New password
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label>New password again
            <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") change(); }} />
          </label>
          <button className="primary" onClick={change} disabled={busy || !current || !next || !again}>
            {busy ? "…" : "Change password"}
          </button>
        </div>
        <ActionResult ok={ok} error={error} />
      </>)}
    </Panel>
  );
}

/**
 * Making a token takes the API tokens permission, and a token works only while its maker holds it.
 * Without it there is nothing to make here, so the card shows only to list and revoke tokens made
 * while the person still had it — and says why they no longer work.
 */
function ApiTokens() {
  const confirm = useConfirm();
  const canMake = hasCap(useGrants(), "api.tokens", "write");
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = () => api<{ tokens: Token[] }>("/tokens").then((r) => setTokens(r.tokens)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function create() {
    setBusy(true); setError(""); setFresh(null);
    try {
      const r = await api<{ token: string; name: string }>("/tokens", { method: "POST", body: { name: name.trim() || "token" } });
      setFresh({ name: r.name, token: r.token });
      setName("");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: Token) {
    if (!(await confirm({ title: `Revoke token "${t.name}"? Any integration using it will stop working.`, confirmLabel: "Remove", danger: true }))) return;
    try { await api(`/tokens/${t.id}`, { method: "DELETE" }); load(); }
    catch (e) { setError((e as Error).message); }
  }

  if (!canMake && !tokens?.length) return null;
  return (
    <Panel defaultCollapsed id="tokens" caps="open" title="API tokens" subtitle={tokens ? String(tokens.length) : undefined}>
      <p className="muted mt-0">Personal tokens for scripts and integrations. A token carries your permissions; the secret is shown once at creation.</p>
      <ActionResult error={error} />
      {canMake ? (
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <input placeholder="Token name (e.g. discord-bot)" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
          <button className="primary" onClick={create} disabled={busy}>{busy ? "…" : "Create token"}</button>
        </div>
      ) : (
        <p className="hint notice">You no longer have the API tokens permission, so these tokens don&apos;t work. You can still revoke them.</p>
      )}
      {fresh && (
        <div className="subcard" style={{ marginTop: 10 }}>
          <p className="m-0"><strong>{fresh.name}</strong> — copy this now, it won&apos;t be shown again:</p>
          <div className="row" style={{ gap: 8, marginTop: 6, alignItems: "center" }}>
            <code style={{ wordBreak: "break-all", flex: 1 }}>{fresh.token}</code>
            <button className="mini ghost" onClick={() => navigator.clipboard?.writeText(fresh.token).catch(() => {})}>Copy</button>
          </div>
        </div>
      )}
      {tokens && !tokens.length && <Nothing>No tokens yet — create one above to use the API from a script.</Nothing>}
      {tokens && tokens.length > 0 && (
        <div className="scroll-x" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>Name</th><th>Created</th><th>Expires</th><th></th></tr></thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td><Time iso={t.createdAt} /></td>
                  <td>{t.expiresAt ? fmt(t.expiresAt) : "never"}</td>
                  <td><button className="mini ghost" onClick={() => revoke(t)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

