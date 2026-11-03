"use client";
import { useMemo, useRef, useState } from "react";
import { api, fmt } from "../lib/api";
import { useResetOnServerChange, useServers } from "../lib/servers";
import { ActionResult, AskNotice, NoServersNote, Nothing, ObserveBanner, PageHeader, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";

interface RawResult { statusCode?: number; statusMessage?: string; content: string }
interface Entry { id: number; ts: string; command: string; version?: number; ok: boolean; result?: RawResult; error?: string }

// The v2 command set (from a live GetDisplayableCommands capture). Used to populate the command
// picker and the "which command?" dropdown for GetClientReferenceData.
const V2_COMMANDS = [
  "GetDisplayableCommands", "GetServerInformation", "GetClientReferenceData", "GetServerChangelist",
  "GetAdminLog", "GetAdminGroups", "GetAdminUsers",
  "GetTemporaryBans", "GetPermanentBans",
  "GetAutoBalanceEnabled", "GetAutoBalanceThreshold", "GetHighPingThreshold", "GetKickIdleDuration",
  "GetMapShuffleEnabled", "GetTeamSwitchCooldown", "GetVoteKickEnabled", "GetVoteKickThreshold",
  "AddAdmin", "RemoveAdmin", "AddVip", "RemoveVip", "SetVipSlotCount",
  "AddBannedWords", "RemoveBannedWords",
  "ChangeMap", "AddMapToRotation", "RemoveMapFromRotation",
  "AddMapToSequence", "RemoveMapFromSequence", "MoveMapInSequence",
  "SetMapShuffleEnabled", "DisbandPlatoon", "RemovePlayerFromPlatoon", "ForceTeamSwitch",
  "KickPlayer", "PunishPlayer", "MessagePlayer", "MessageAllPlayers", "ServerBroadcast",
  "TemporaryBanPlayer", "PermanentBanPlayer", "RemoveTemporaryBan", "RemovePermanentBan",
  "SetAutoBalanceEnabled", "SetAutoBalanceThreshold", "SetHighPingThreshold", "SetIdleKickDuration",
  "SetTeamSwitchCooldown", "SetVoteKickEnabled", "SetVoteKickThreshold", "ResetVoteKickThreshold",
  "SetMaxQueuedPlayers", "SetWelcomeMessage", "SetDynamicWeatherEnabled",
  "SetMatchTimer", "RemoveMatchTimer", "SetWarmupTimer", "RemoveWarmupTimer", "SetSectorLayout",
];

// A parameter field for a command's request body. `kind:"select"` renders a dropdown of known
// values (the "prefill via selector" case); text/number render inputs. `optional` fields that are
// left blank are still sent (the v2 envelope expects e.g. Value:"").
type FieldKind = "text" | "number" | "select";
interface Field { key: string; label: string; kind: FieldKind; options?: string[]; default?: string; optional?: boolean; hint?: string }
// A command's request body: a set of form fields. `stringBody` means the wire body is the plain
// string value of the (single) field rather than a JSON object — the v2 transport sends the body
// verbatim when it's a string (GetClientReferenceData wants the bare command name, not {Name:…}).
interface CommandSpec { fields: Field[]; stringBody?: boolean }

// Curated request-body schemas for the commands we've confirmed. Anything not listed here has no
// known param shape yet (its write body comes from GetClientReferenceData) — for those the console
// falls back to an advanced raw-JSON editor.
const NO_PARAMS: CommandSpec = { fields: [] };
const SPECS: Record<string, CommandSpec> = {
  GetDisplayableCommands: NO_PARAMS,
  GetTemporaryBans: NO_PARAMS,
  GetPermanentBans: NO_PARAMS,
  GetMapShuffleEnabled: NO_PARAMS,
  GetAdminGroups: NO_PARAMS,
  GetAdminUsers: NO_PARAMS,
  GetAutoBalanceEnabled: NO_PARAMS,
  GetAutoBalanceThreshold: NO_PARAMS,
  GetHighPingThreshold: NO_PARAMS,
  GetKickIdleDuration: NO_PARAMS,
  GetTeamSwitchCooldown: NO_PARAMS,
  GetVoteKickEnabled: NO_PARAMS,
  GetVoteKickThreshold: NO_PARAMS,
  GetServerChangelist: NO_PARAMS,
  GetServerInformation: { fields: [
    { key: "Name", label: "Info type", kind: "select", options: ["session", "players", "player", "maprotation", "mapsequence", "vipplayers", "bannedwords", "serverconfig"], default: "session" },
    { key: "Value", label: "Value", kind: "text", default: "", optional: true, hint: "blank, or a player id for “player”" },
  ] },
  // Body is the bare command name string (the {Name,Value} envelope 400s); confirmed against the v2 client.
  GetClientReferenceData: { stringBody: true, fields: [
    { key: "Name", label: "Command", kind: "select", options: V2_COMMANDS, default: "KickPlayer" },
  ] },
  GetAdminLog: { fields: [
    { key: "LogBackTrackTime", label: "Seconds back", kind: "number", default: "120" },
    { key: "Filters", label: "Filter", kind: "text", default: "", optional: true },
  ] },
};

const LEGACY_PRESETS = ["get name", "get slots", "get vipids", "get adminids", "get mapsinrotation", "get tempbans"];
const CUSTOM = "__custom__";

let SEQ = 0;

export default function Console() {
  const { serverId, server, servers } = useServers();
  const [command, setCommand] = useState(""); // the actual command string sent
  const [pick, setPick] = useState(""); // command-picker selection ("" = none, CUSTOM, or a name)
  const [params, setParams] = useState<Record<string, string>>({});
  const [version, setVersion] = useState("2");
  const [rawBody, setRawBody] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [log, setLog] = useState<Entry[]>([]);
  const [copied, setCopied] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const isLegacy = server?.protocol === "legacy-text";
  const isBridge = server?.protocol === "crcon-bridge";
  const textProtocol = isLegacy || isBridge; // no JSON body; command is a line of text

  const spec = useMemo(() => (pick && pick !== CUSTOM ? SPECS[pick] : undefined), [pick]);
  const hasSpec = spec !== undefined;

  // Pick a command from the dropdown: set the command string and seed param defaults.
  function choose(name: string) {
    setPick(name);
    if (name === CUSTOM || name === "") { setCommand(name === CUSTOM ? "" : command); return; }
    setCommand(name);
    const s = SPECS[name];
    const next: Record<string, string> = {};
    if (s) for (const f of s.fields) next[f.key] = f.default ?? "";
    setParams(next);
    setShowRaw(false);
  }

  // Build the request body from the param form (or return undefined to use the raw editor / none).
  function bodyFromForm(): unknown {
    if (!spec) return undefined;
    if (spec.stringBody) {
      const f = spec.fields[0];
      return params[f.key] ?? f.default ?? ""; // plain-string body (sent verbatim on the wire)
    }
    if (spec.fields.length === 0) return {}; // no params → empty body
    const body: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const v = params[f.key] ?? f.default ?? "";
      body[f.key] = f.kind === "number" ? Number(v || 0) : v;
    }
    return body;
  }

  async function send(override?: { command?: string; body?: unknown; version?: number }) {
    const c = (override?.command ?? command).trim();
    if (!c || !serverId) return;
    setBusy(true); setError("");
    const payload: Record<string, unknown> = { command: c };
    const v = override?.version ?? (version.trim() ? Number(version.trim()) : undefined);
    if (!textProtocol && v != null && !Number.isNaN(v)) payload.version = v;

    let bodyVal: unknown;
    if (override && "body" in override) bodyVal = override.body;
    else if (textProtocol) bodyVal = undefined; // legacy: the command line carries everything
    else if (showRaw && rawBody.trim()) { try { bodyVal = JSON.parse(rawBody); } catch { bodyVal = rawBody; } }
    else bodyVal = bodyFromForm();
    if (bodyVal !== undefined) payload.body = bodyVal;

    const entry: Entry = { id: ++SEQ, ts: new Date().toISOString(), command: c, version: payload.version as number | undefined, ok: false };
    try {
      const r = await api<{ result: RawResult }>(`/servers/${serverId}/raw`, { method: "POST", body: payload });
      entry.ok = true; entry.result = r.result;
    } catch (e) {
      entry.error = (e as Error).message;
    } finally {
      setBusy(false);
      setLog((l) => [entry, ...l]);
      queueMicrotask(() => scrollRef.current?.scrollTo({ top: 0 }));
    }
  }

  function copy(text: string, key: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? "" : c)), 1200);
    }).catch(() => {});
  }

  function entryText(e: Entry): string {
    const head = `> ${server?.protocol ?? ""} ${e.command}${e.version != null ? ` (v${e.version})` : ""}`.trim();
    const status = e.ok
      ? (e.result?.statusCode != null ? `[${e.result.statusCode} ${e.result.statusMessage ?? ""}]`.trim() : "[ok]")
      : "[error]";
    const out = e.ok ? (e.result?.content || "(empty response)") : (e.error ?? "");
    return `${head} ${status}\n${out}`;
  }
  function transcriptText(): string {
    return [...log].reverse().map(entryText).join("\n\n");
  }

  /**
   * A transcript belongs to the server it was typed at.
   *
   * `Entry` records the command and the response but not which server answered, so a switch left
   * the previous server's output on screen under the new server's name — and the whole point of
   * this screen is reading a raw response and believing it. Clearing is the honest option: the
   * alternative is labelling every row, which is more chrome on a screen whose scrollback is only
   * ever about the session you are in.
   */
  useResetOnServerChange(() => { setLog([]); setError(""); });

  const canSend = !busy && !!serverId && !!command.trim();

  return (
    <div>
      <div className="card page-head">
        <PageHeader
          routeId="console"
          subtitle={server ? <>On <strong>{server.name}</strong> · {server.protocol}</> : undefined}
        />
      </div>
      <PanelGroup viewId="console">
      {/* No subtitle: the page header directly above already names the server and its protocol. */}
      <Panel id="console" caps="open" title="Send a command">
      <Explanation>
        Sends an un-abstracted command straight to the server and shows the raw response. Pick a
        command and fill its parameters — no JSON needed.
      </Explanation>
      {!servers.length && <NoServersNote>There is nothing to send a command to.</NoServersNote>}
      <ObserveBanner server={server}>Raw commands can&apos;t be classed read/write, so the guard refuses them all here.</ObserveBanner>
      <AskNotice capability="admin.console" serverId={serverId} />
      <ActionResult error={error} />

      {textProtocol ? (
        // Legacy / bridge: a command is a single text line — no param form.
        <>
          <div className="console-input">
            <input
              placeholder="e.g. get vipids"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              style={{ flex: 1, fontFamily: "var(--mono, monospace)" }}
            />
            <button className="primary" onClick={() => send()} disabled={!canSend}>{busy ? "…" : "Send"}</button>
          </div>
          <div className="chips" style={{ marginTop: 10 }}>
            <span className="muted" style={{ marginRight: 6 }}>Quick:</span>
            {LEGACY_PRESETS.map((c) => (
              <button key={c} className="mini ghost" onClick={() => { setCommand(c); send({ command: c }); }} disabled={!serverId || busy}>{c}</button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="param-grid">
            <label className="m-0">
              Command
              <select value={pick} onChange={(e) => choose(e.target.value)}>
                <option value="">— pick a command —</option>
                <optgroup label="Reads">
                  {V2_COMMANDS.filter((c) => c.startsWith("Get")).map((c) => <option key={c} value={c}>{c}{SPECS[c] ? "" : " (no form)"}</option>)}
                </optgroup>
                <optgroup label="Writes / setters">
                  {V2_COMMANDS.filter((c) => !c.startsWith("Get")).map((c) => <option key={c} value={c}>{c}{SPECS[c] ? "" : " (raw)"}</option>)}
                </optgroup>
                <option value={CUSTOM}>Custom…</option>
              </select>
            </label>
            <label style={{ margin: 0, maxWidth: 90 }}>
              Version
              <input value={version} onChange={(e) => setVersion(e.target.value)} />
            </label>
          </div>

          {pick === CUSTOM && (
            <label>
              Command name
              <input placeholder="e.g. GetServerInformation" value={command} onChange={(e) => setCommand(e.target.value)} style={{ fontFamily: "var(--mono, monospace)" }} />
            </label>
          )}

          {/* Parameter form driven by the selected command's spec. */}
          {hasSpec && spec!.fields.length > 0 && (
            <div className="param-grid">
              {spec!.fields.map((f) => (
                <label key={f.key} className="m-0">
                  {f.label}{f.optional && <span className="muted"> (optional)</span>}
                  {f.kind === "select" ? (
                    <select value={params[f.key] ?? f.default ?? ""} onChange={(e) => setParams((p) => ({ ...p, [f.key]: e.target.value }))}>
                      {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      type={f.kind === "number" ? "number" : "text"}
                      value={params[f.key] ?? f.default ?? ""}
                      onChange={(e) => setParams((p) => ({ ...p, [f.key]: e.target.value }))}
                    />
                  )}
                  {f.hint && <span className="muted" style={{ fontWeight: 400, fontSize: "0.72rem" }}>{f.hint}</span>}
                </label>
              ))}
            </div>
          )}

          {hasSpec && spec!.fields.length === 0 && pick && pick !== CUSTOM && (
            <Nothing>No parameters — just hit Send.</Nothing>
          )}

          {/* Advanced raw-JSON escape hatch: for custom commands, or commands whose param schema we
              don't know yet, or to override the form. */}
          {(pick === CUSTOM || (pick && !hasSpec)) && (
            <p className="muted" style={{ marginTop: 8 }}>
              No known parameter form for this command yet — supply the request body as JSON below.
            </p>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="mini ghost" onClick={() => setShowRaw((v) => !v)}>{showRaw ? "− Advanced (raw JSON)" : "+ Advanced (raw JSON)"}</button>
            {showRaw && (
              <textarea
                placeholder='raw request body, e.g. {"Name":"session","Value":""} — overrides the form above'
                value={rawBody}
                onChange={(e) => setRawBody(e.target.value)}
                rows={3}
                style={{ width: "100%", fontFamily: "var(--mono, monospace)", marginTop: 8 }}
              />
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            <button className="primary" onClick={() => send()} disabled={!canSend}>{busy ? "Sending…" : "Send"}</button>
            {command && <code className="muted" style={{ marginLeft: 12, fontSize: "0.8em" }}>{command}{version.trim() ? ` (v${version.trim()})` : ""}</code>}
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 14, alignItems: "center", gap: 8 }}>
        <span className="muted" style={{ fontSize: "0.85em" }}>{log.length ? `${log.length} response${log.length === 1 ? "" : "s"}` : "History"}</span>
        <span className="grow" />
        <button className="mini ghost" disabled={!log.length} onClick={() => copy(transcriptText(), "all")}>{copied === "all" ? "Copied ✓" : "Copy all"}</button>
        <button className="mini ghost" disabled={!log.length} onClick={() => setLog([])}>Clear</button>
      </div>

      <div ref={scrollRef} className="console-log" style={{ marginTop: 8, maxHeight: "56vh", overflow: "auto" }}>
        {!log.length && <Nothing>No commands yet. Pick a command above.</Nothing>}
        {log.map((e) => (
          <div key={e.id} className="console-entry" style={{ borderTop: "1px solid var(--border, #2a2a2a)", paddingTop: 10, marginTop: 10 }}>
            <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
              <code style={{ fontWeight: 600 }}>{e.command}{e.version != null ? ` (v${e.version})` : ""}</code>
              {e.ok
                ? <span className={`badge ${e.result?.statusCode && e.result.statusCode !== 200 ? "observe" : "active"}`}>
                    {e.result?.statusCode != null ? `${e.result.statusCode} ${e.result.statusMessage ?? ""}`.trim() : "ok"}
                  </span>
                : <span className="badge observe">error</span>}
              <span className="muted" style={{ fontSize: "0.8em" }}>{fmt(e.ts)}</span>
              <span className="grow" />
              <button className="mini ghost" title="Copy the raw response only" onClick={() => copy(e.ok ? (e.result?.content ?? "") : (e.error ?? ""), `body-${e.id}`)}>{copied === `body-${e.id}` ? "Copied ✓" : "Copy"}</button>
              <button className="mini ghost" title="Copy the command and response together" onClick={() => copy(entryText(e), `full-${e.id}`)}>{copied === `full-${e.id}` ? "Copied ✓" : "+cmd"}</button>
            </div>
            <pre className="console-out" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", margin: "6px 0 0", fontSize: "0.85em" }}>
              {e.ok ? (e.result?.content || "(empty response)") : e.error}
            </pre>
          </div>
        ))}
      </div>
      </Panel>
      </PanelGroup>
    </div>
  );
}
