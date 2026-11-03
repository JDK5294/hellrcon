"use client";
import { useEffect, useState } from "react";
import { api, setToken } from "../lib/api";
import { holdReturnRoute } from "../lib/signin-return";
import { APP_NAME, BRAND_MARK } from "../lib/brand";
import { Callout } from "./ui";
import { SetupStart } from "./Setup";

/** Sign-in, or first-run setup (Setup.tsx) on an install with no accounts yet. Calls onAuthed once a session token is stored. */
export default function Auth({ onAuthed, initialError = "" }: { onAuthed: () => void; initialError?: string }) {
  const [mode, setMode] = useState<"login" | "register" | "loading">("loading");
  const [codeRequired, setCodeRequired] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [discord, setDiscord] = useState(false);

  useEffect(() => {
    // First-run detection: an install with no accounts yet opens on setup (the setup code, then
    // the owner account) instead of a sign-in form nobody can use.
    api<{ needed?: boolean; codeRequired?: boolean }>("/setup/status")
      .then((s) => { setCodeRequired(Boolean(s.codeRequired)); setMode(s.needed ? "register" : "login"); })
      .catch(() => setMode("login"));
    // Offer "Sign in with Discord" only when the OAuth flow is configured.
    api<{ configured: boolean }>("/auth/discord/status")
      .then((s) => setDiscord(s.configured))
      .catch(() => setDiscord(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const login = await api<{ token: string }>("/auth/login", { method: "POST", body: { username, password } });
      setToken(login.token);
      onAuthed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (mode === "register") return <SetupStart onAuthed={onAuthed} codeRequired={codeRequired} />;
  return (
    <main className="auth-wrap">
      <div className="card auth-card">
        <div className="brand" style={{ padding: "0 0 14px" }}><span className="brand-mark">{BRAND_MARK}</span> {APP_NAME}</div>
        <h1>Sign in</h1>
        <p className="muted">Enter your credentials to manage your servers.</p>
        {/* A refused Discord sign-in bounces back here; show WHY prominently at the top rather than
            as small text buried under the form, where it reads as "it just sent me back". */}
        {error && <Callout variant="warn">{error}</Callout>}
        <form onSubmit={submit}>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          <div className="actions">
            <button type="submit" disabled={busy || mode === "loading"}>
              Sign in
            </button>
          </div>
        </form>
        {discord && (
          <>
            <div className="auth-or"><span>or</span></div>
            <button type="button" className="discord-btn" onClick={() => { holdReturnRoute(); window.location.href = "/api/auth/discord/start"; }}>
              <span className="discord-mark" aria-hidden>◆</span> Sign in with Discord
            </button>
          </>
        )}
      </div>
    </main>
  );
}
