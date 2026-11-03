"use client";
/**
 * The dedicated in-game chat filter — one word list, two jobs (CRCON's "profanities", grown up):
 *
 *  - ACT ON PLAYERS: the save maintains two managed rules (team chat + unit chat) in the rules
 *    engine, matching the list whole-word and case-insensitively. They are ordinary rules — the
 *    Rules tab shows them, and anything added to them there by hand (exemptions, a ladder, alert
 *    routing, active hours) survives every save here.
 *
 *  - THE GAME'S OWN CENSOR: optionally push the same list into each active server's native
 *    banned-words list, which stars the words out of everyone's chat client-side. The game never
 *    reports that a censored word was typed — which is exactly why the enforcement half exists.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { banHoursMode } from "../lib/ruleHours";
import { useAppNav } from "../lib/nav";
import { whyNotActing, type ManagedRuleState, type NotActing } from "../lib/managedRules";
import { ActionResult, AskNotice, Callout, GoTo, PageHeader, SkeletonLines, Toggle, Explanation } from "./ui";
import { Time } from "./Time";
import { PanelGroup, Panel } from "./Panel";

interface CensorResult { serverId: string; name: string; ok: boolean; added: number; removed: number; error?: string }
/** What the managed rule behind one chat scope is actually doing — null when it no longer exists. */
type RuleState = ManagedRuleState;
interface ManagedRules { team: RuleState | null; unit: RuleState | null }
interface Config {
  enabled: boolean; words: string[]; action: string; hours: number | null; reason: string;
  censor: boolean; censorApplied: Record<string, string[]>; teamRuleId: string | null; unitRuleId: string | null;
}

/** One scope's reason, and where it is undone. */
function notActingLine(scope: string, why: NotActing, rule: RuleState | null) {
  const rules = <GoTo view="autosettings" tab="rules">Rules</GoTo>;
  switch (why) {
    case "deleted": return <>the managed rule behind {scope} chat has been deleted under {rules}. Press Save here to put it back exactly as this page describes.</>;
    case "off": return <>the managed rule behind {scope} chat has been switched off under {rules}. Press Save here to switch it back on.</>;
    case "section": return <>the managed rule behind {scope} chat is filed in a section that is switched off under {rules} — switch that section back on there (a save here does not).</>;
    case "paused": return <>the managed rule behind {scope} chat is paused until <Time iso={rule?.pausedUntil ?? null} /> — it comes back on its own then, or Resume it under {rules}.</>;
  }
}

const ACTION_LABELS: [string, string][] = [
  ["message", "message them"],
  ["punish", "punish (kill in game)"],
  ["kick", "kick"],
  ["tempban", "temp ban"],
  ["blacklist", "ban (temp with hours, else permanent)"],
];

export default function ChatFilter({ canManage = false }: { canManage?: boolean }) {
  const nav = useAppNav();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [loadErr, setLoadErr] = useState("");
  // The working copy: words as the textarea's text, the rest as fields.
  const [text, setText] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [action, setAction] = useState("punish");
  const [hours, setHours] = useState<string>("");
  const [reason, setReason] = useState("");
  const [censor, setCensor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [censorResults, setCensorResults] = useState<CensorResult[]>([]);
  const [rules, setRules] = useState<ManagedRules | null>(null);
  // When the rule states were read: a pause is judged against that moment (the server only reports
  // one still running then), not against a clock read while rendering.
  const [rulesReadAt, setRulesReadAt] = useState(0);

  useEffect(() => {
    let alive = true;
    api<{ config: Config; rules?: ManagedRules }>("/chat-filter")
      .then((r) => {
        if (!alive) return;
        setCfg(r.config);
        setRules(r.rules ?? null);
        setRulesReadAt(Date.now());
        setText(r.config.words.join("\n"));
        setEnabled(r.config.enabled);
        setAction(r.config.action);
        setHours(r.config.hours ? String(r.config.hours) : "");
        setReason(r.config.reason);
        setCensor(r.config.censor);
      })
      .catch((e) => { if (alive) setLoadErr((e as Error).message); });
    return () => { alive = false; };
  }, []);

  const wordCount = text.split(/[\n,]/).map((w) => w.trim()).filter(Boolean).length;
  const hoursMode = banHoursMode(action, []);
  // Which chat scopes the SAVED filter claims to police but no working rule covers. Read off the
  // saved config, not the editor — an unsaved switch has not promised anything yet.
  const scopeState: [string, RuleState | null | undefined][] = [["team", rules?.team], ["unit", rules?.unit]];
  // Its own switch is not the only thing that stops a rule: its section's master switch and a pause
  // hold it too, and a save here lifts neither — so each scope says which it is.
  const notActing = rules ? scopeState.flatMap(([s, r]) => { const why = whyNotActing(r ?? null, rulesReadAt); return why ? [{ scope: s, why, rule: r ?? null }] : []; }) : [];
  const brokenScopes = notActing.map((x) => x.scope);

  async function save() {
    setBusy(true); setErr(""); setOk(""); setCensorResults([]);
    try {
      const r = await api<{ config: Config; censorResults: CensorResult[]; rules?: ManagedRules }>("/chat-filter", {
        method: "PUT",
        body: { enabled, words: text, action, hours: hours.trim() === "" ? null : Number(hours), reason, censor },
      });
      setCfg(r.config);
      setRules(r.rules ?? null);
      setRulesReadAt(Date.now());
      setText(r.config.words.join("\n"));
      setCensorResults(r.censorResults);
      const pushes = r.censorResults.filter((c) => c.ok).length;
      const failed = r.censorResults.filter((c) => !c.ok).length;
      setOk(`Saved — ${r.config.words.length} word(s)${r.censorResults.length ? `, censor pushed to ${pushes} server(s)${failed ? `, ${failed} unreachable (retried on next save)` : ""}` : ""}.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (loadErr) return <div className="card"><ActionResult error={loadErr} /></div>;
  if (!cfg) return <div className="card"><SkeletonLines lines={6} /></div>;

  return (
    <div>
      <div className="card">
        <PageHeader
          title="Chat filter"
          subtitle="One word list: it can act on players through two managed rules, and feed the game's own chat censor."
        />
        {canManage && <AskNotice capability="moderation.chatfilter" />}
      </div>
      <PanelGroup viewId="chatfilter">
        <Panel id="words" caps="moderation.chatfilter" title="Watched words">
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"one word or short phrase per line (commas work too)"}
            disabled={!canManage}
          />
          <p className="hint">
            {wordCount} word{wordCount === 1 ? "" : "s"}. Matching is whole-word and ignores case:
            &ldquo;slur&rdquo; catches &ldquo;SLUR!&rdquo; but never fires on a player named
            &ldquo;Slurpee&rdquo;. Words, not patterns — for regex, write a rule directly under Rules.
          </p>
        </Panel>

        <Panel id="act" caps="moderation.chatfilter" title="Act on players">
          {/* The switch is this page's intent; the two managed rules are what actually enforce it,
              and they live under Rules where they can be deleted or switched off. Saying "on" while
              one of them is gone is the filter claiming work it is not doing. */}
          {cfg.enabled && notActing.length > 0 && (
            <Callout variant="warn">
              <strong>Not acting on {brokenScopes.join(" or ")} chat right now.</strong>{" "}
              This filter is switched on, but{" "}
              {notActing.map(({ scope, why, rule }, i) => (
                <span key={scope}>{i > 0 ? " And " : ""}{notActingLine(scope, why, rule)}</span>
              ))}
            </Callout>
          )}
          <Toggle checked={enabled} onChange={(v) => canManage && setEnabled(v)}
            label="Act when a watched word is said in team or unit chat" />
          {enabled && (
            <div className="grid">
              <label>Action
                <select value={action} onChange={(e) => {
                  const next = e.target.value;
                  setAction(next);
                  // A tempban needs hours; seeding the editor default here keeps the box and the
                  // save honest (a box showing a fallback the save doesn't send failed with a
                  // "needs Ban hours" surprise).
                  if (next === "tempban" && hours.trim() === "") setHours("2");
                }} disabled={!canManage}>
                  {ACTION_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              {hoursMode === "required" && <label>Ban hours<input type="number" min="1" value={hours} onChange={(e) => setHours(e.target.value)} disabled={!canManage} /></label>}
              {hoursMode === "optional" && <label>Ban hours (blank = permanent ban)<input type="number" min="1" value={hours} onChange={(e) => setHours(e.target.value)} disabled={!canManage} /></label>}
              <label>Reason / message
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Watch your language — repeat offences are bans." disabled={!canManage} />
              </label>
            </div>
          )}
          <Explanation>
            Saving maintains two rules in the rules engine — &ldquo;Chat filter — team chat&rdquo;
            and &ldquo;Chat filter — unit chat&rdquo;. Escalation ladders, staff exemptions, Discord
            pings, active hours and trial run live on those rules under{" "}
            <button type="button" className="linklike" onClick={() => nav.go("autosettings", undefined, "rules")}>Rules</button>
            {" "}— whatever you set there survives every save here. Switching acting on, or changing
            the action or its hours, also needs that action&apos;s own permission (Message, Punish,
            Kick, Temp ban or Perma ban) — the filter never does what you could not do by hand.
          </Explanation>
        </Panel>

        <Panel id="censor" caps="moderation.chatfilter" title="Game censor">
          <Toggle checked={censor} onChange={(v) => canManage && setCensor(v)}
            label="Also add the list to each server's own banned-words censor" />
          <Explanation>
            The game stars censored words out of chat for everyone, client-side, on every active
            server — silently, with no log line and no punishment, which is why the rule half above
            exists. Switching this off removes the words again; a server moved from observe to
            active picks the list up on the next save here.
          </Explanation>
          {censorResults.length > 0 && (
            <ul className="m-0" style={{ paddingLeft: 18 }}>
              {censorResults.map((c) => (
                <li key={c.serverId} className={c.ok ? "" : "error"}>
                  {c.name}: {c.ok ? `censor updated (${c.added} added, ${c.removed} removed)` : `unreachable — ${c.error ?? "failed"}; retried on the next save`}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PanelGroup>
      {canManage && (
        <div className="card">
          <div className="actions">
            <button className="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save chat filter"}</button>
          </div>
          <ActionResult error={err} ok={ok} />
        </div>
      )}
    </div>
  );
}
