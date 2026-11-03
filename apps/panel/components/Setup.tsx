"use client";
/**
 * First-run setup, in the panel itself: only what it takes to have a working install.
 *
 * Before anyone can sign in: the setup code (filled in from the link the start script opened, so
 * most people never type it) and the owner account. Signed in, the owner is walked through the
 * community's time zone and the first game server, each skippable, and lands on a short list of
 * optional next steps. Everything else stays where it lives in the panel.
 */
import { useEffect, useState } from "react";
import { api, setToken } from "../lib/api";
import { APP_NAME, BRAND_MARK } from "../lib/brand";
import { applyDisplayZone, deviceZone, zoneOptions } from "../lib/zones";
import { Callout, Explanation } from "./ui";

/** The code the start script put in the link: `#/setup?code=ABCD-EFGH`, or `?code=` on the page. */
export function codeFromUrl(): string {
  const fromHash = /[?&]code=([^&]+)/.exec(window.location.hash)?.[1];
  const fromQuery = new URLSearchParams(window.location.search).get("code");
  return decodeURIComponent(fromHash ?? fromQuery ?? "").trim();
}

function Brand() {
  return <div className="brand" style={{ padding: "0 0 14px" }}><span className="brand-mark">{BRAND_MARK}</span> {APP_NAME}</div>;
}

/** Before sign-in: the setup code, then the owner account. Calls onAuthed once signed in. */
export function SetupStart({ onAuthed, codeRequired }: { onAuthed: () => void; codeRequired: boolean }) {
  const [code, setCode] = useState(() => codeFromUrl());
  const [step, setStep] = useState<"code" | "owner">(codeRequired ? "code" : "owner");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");

  async function verify(given: string) {
    setError("");
    setBusy(true);
    try {
      await api("/setup/verify", { method: "POST", body: { code: given } });
      // Out of the address bar once it has done its job.
      if (/code=/.test(window.location.hash) || /code=/.test(window.location.search)) {
        history.replaceState(null, "", `${window.location.pathname}#/`);
      }
      setStep("owner");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A code in the link the start script opened is checked straight away — and so is one arriving
  // later in this same tab (the link pasted into a setup page already open), which changes only
  // the part after # and so never reloads the page.
  useEffect(() => {
    if (codeRequired && code) void verify(code);
    const onHash = () => {
      const linked = codeFromUrl();
      if (codeRequired && linked) { setCode(linked); void verify(linked); }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (password !== again) return setError("The two passwords don't match.");
    setError("");
    setBusy(true);
    try {
      await api("/auth/register", { method: "POST", body: { username, password, ...(codeRequired ? { setupCode: code } : {}) } });
      const login = await api<{ token: string }>("/auth/login", { method: "POST", body: { username, password } });
      setToken(login.token);
      onAuthed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <div className="card auth-card setup-card">
        <Brand />
        {step === "code" ? (
          <>
            <h1>Set up your panel</h1>
            <p className="muted">Enter the setup code shown in the window that started the panel.</p>
            {error && <Callout variant="warn">{error}</Callout>}
            <form onSubmit={(e) => { e.preventDefault(); void verify(code); }}>
              <label>
                Setup code
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH" autoComplete="off" autoCapitalize="characters" spellCheck={false} required />
              </label>
              <div className="actions"><button type="submit" className="primary" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Continue"}</button></div>
            </form>
            <Explanation>
              <p className="mt-0">The code proves you are the person who installed the panel, so nobody else who finds the page can take it over. It stays the same until the owner account exists.</p>
              <p>Lost it? Run the start script again: start.bat on Windows, ./start.sh on a Mac or a Linux PC, sudo ./start.sh on a VM. It shows the code again and opens this page with it filled in; on a VM it prints that link instead.</p>
              <p>It is also in the panel&apos;s log, on the line starting &quot;Setup code&quot;: in Docker Desktop under Containers → app → api-1, or with <code>docker compose -f infra/docker-compose.yml logs api</code> in the panel&apos;s folder (with sudo in front on a VM). Five wrong codes within 15 minutes lock this page for up to 15 minutes.</p>
            </Explanation>
          </>
        ) : (
          <>
            <p className="muted fs-sm setup-step">Step 1 of 3</p>
            <h1>Create the owner account</h1>
            <p className="muted">This account can do everything. You can add the rest of your staff later.</p>
            {error && <Callout variant="warn">{error}</Callout>}
            <form onSubmit={create}>
              <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></label>
              <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required /></label>
              <label>Password again<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required /></label>
              <div className="actions"><button type="submit" className="primary" disabled={busy}>{busy ? "Creating…" : "Create account"}</button></div>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

interface GameOption { id: string; label: string }

/** Signed in: the community's time zone, the first game server, then the optional next steps. */
export function SetupWalkthrough({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"zone" | "server" | "done">("zone");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [zone, setZone] = useState(() => deviceZone());

  const [games, setGames] = useState<GameOption[]>([{ id: "hll", label: "Hell Let Loose" }]);
  const [game, setGame] = useState("hll");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [password, setPassword] = useState("");
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<{ games?: GameOption[] }>("/games").then((r) => { if (r.games?.length) setGames(r.games); }).catch(() => { /* the default stands */ });
  }, []);

  // A home PC keeps the panel on only while it is signed in with Docker Desktop running; a VM runs
  // Docker as a service from boot.
  const [route, setRoute] = useState<string | null>(null);
  useEffect(() => {
    api<{ route?: string }>("/setup/status").then((s) => setRoute(s.route ?? null)).catch(() => { /* the advice is left out */ });
  }, []);

  async function finish(then?: string) {
    try { await api("/setup/finish", { method: "POST", body: {} }); } catch { /* the panel opens either way */ }
    if (then) window.location.hash = then;
    onDone();
  }

  async function saveZone() {
    setError("");
    setBusy(true);
    try {
      const r = await api<{ config: { timezone: string } }>("/app-config", { method: "PUT", body: { timezone: zone } });
      applyDisplayZone(r.config.timezone);
      setStep("server");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const serverBody = () => ({ game, host: host.trim(), port: Number(port), password });

  async function test() {
    setError("");
    setTested(null);
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; name?: string | null; error?: string }>("/setup/test-server", { method: "POST", body: serverBody() });
      setTested(r.ok
        ? { ok: true, text: r.name ? `Connected to “${r.name}”.` : "Connected." }
        : { ok: false, text: `Could not connect: ${r.error || "no answer"}. Check the address, the RCON port and the password.` });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addServer(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/servers", { method: "POST", body: serverBody() });
      setStep("done");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const next: { title: string; why: string; href: string }[] = [
    { title: "Put it online", why: "Reach the panel from anywhere, over HTTPS.", href: "#/admin/online" },
    { title: "Turn on nightly backups", why: "A copy of everything, every night.", href: "#/admin/backup" },
    { title: "Connect Discord", why: "Staff sign-in with Discord, the live relay and alerts.", href: "#/discord/setup" },
    { title: "Add more servers", why: "Every server the panel looks after.", href: "#/admin/connections" },
  ];

  return (
    <main className="auth-wrap">
      <div className="card auth-card setup-card">
        <Brand />
        {step === "zone" && (
          <>
            <p className="muted fs-sm setup-step">Step 2 of 3</p>
            <h1>Your community&apos;s time zone</h1>
            <p className="muted">Schedules, the nightly backup and the daily claims all run on it.</p>
            {error && <Callout variant="warn">{error}</Callout>}
            <label>
              Time zone
              <select value={zone} onChange={(e) => setZone(e.target.value)}>
                {zoneOptions(zone).map((z) => <option key={z} value={z}>{z}{z === deviceZone() ? " (this device)" : ""}</option>)}
              </select>
            </label>
            <div className="actions">
              <button className="primary" onClick={saveZone} disabled={busy}>{busy ? "Saving…" : "Save and continue"}</button>
              <button className="ghost" onClick={() => void finish()} disabled={busy}>Skip setup</button>
            </div>
          </>
        )}
        {step === "server" && (
          <>
            <p className="muted fs-sm setup-step">Step 3 of 3</p>
            <h1>Connect your game server</h1>
            <p className="muted">Your server host&apos;s control panel lists its address, RCON port and RCON password.</p>
            {error && <Callout variant="warn">{error}</Callout>}
            <form onSubmit={addServer}>
              <label>
                Game
                <select value={game} onChange={(e) => setGame(e.target.value)}>
                  {games.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                </select>
              </label>
              <label>Server address<input value={host} onChange={(e) => { setHost(e.target.value); setTested(null); }} placeholder="1.2.3.4" autoComplete="off" required /></label>
              <label>RCON port<input value={port} onChange={(e) => { setPort(e.target.value); setTested(null); }} inputMode="numeric" placeholder="28316" required /></label>
              <label>RCON password<input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setTested(null); }} autoComplete="off" required /></label>
              {tested && <Callout variant={tested.ok ? "info" : "warn"}>{tested.text}</Callout>}
              <div className="actions">
                <button type="button" onClick={test} disabled={busy || !host.trim() || !port || !password}>Test connection</button>
                <button type="submit" className="primary" disabled={busy}>{busy ? "Adding…" : "Add server"}</button>
              </div>
            </form>
            <Explanation>
              <p className="mt-0">The server starts read-only (observe mode): the panel watches it and changes nothing until you switch it to active under Administration → Connections. That makes it safe to add next to another tool such as CRCON.</p>
              <p>The RCON port is not the port players join on. Most hosts show it on the server&apos;s settings or &quot;RCON&quot; page.</p>
            </Explanation>
            <div className="actions"><button className="ghost" onClick={() => setStep("done")} disabled={busy}>I&apos;ll add it later</button></div>
          </>
        )}
        {step === "done" && (
          <>
            <h1>You&apos;re ready</h1>
            <p className="muted">That is everything the panel needs. These are optional, whenever suits you:</p>
            <ul className="setup-next">
              {next.map((n) => (
                <li key={n.href}>
                  <button className="linklike" onClick={() => void finish(n.href)}>{n.title}</button>
                  <span className="muted"> — {n.why}</span>
                </li>
              ))}
            </ul>
            {route === "home" && (
              <>
                <p className="muted">Keep it on after a restart: let Docker Desktop start when you sign in, and the PC sign in by itself.</p>
                <Explanation>
                  <p className="mt-0">After the PC restarts, for Windows updates or after a power cut, the panel comes back by itself as soon as Docker Desktop is running. Two settings make that happen with nobody at the PC:</p>
                  <ul>
                    <li>Docker Desktop: Settings → General → &quot;Start Docker Desktop when you sign in to your computer&quot;. It is off when Docker Desktop is installed.</li>
                    <li>Windows signing in by itself: Microsoft&apos;s free <a href="https://learn.microsoft.com/sysinternals/downloads/autologon" target="_blank" rel="noreferrer">Autologon</a> tool sets it up. Only on a PC kept somewhere safe: whoever switches it on is signed in.</li>
                  </ul>
                  <p>start.bat reminds you of either one it finds off. To have the PC switch itself back on after a power cut, look in its BIOS for a setting such as &quot;Restore on AC power loss&quot;. On a Mac, Docker Desktop has the same setting, and automatic login is under System Settings → Users &amp; Groups.</p>
                </Explanation>
              </>
            )}
            <div className="actions"><button className="primary" onClick={() => void finish()}>Open the panel</button></div>
          </>
        )}
      </div>
    </main>
  );
}
