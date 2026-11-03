"use client";
/**
 * Messages — send one message to everybody playing on the active server.
 *
 * This is the message that appears in the TOP RIGHT and stays there until the player acknowledges
 * it. That is the whole reason this screen exists next to Broadcast rather than inside it: a
 * broadcast is the line that scrolls across the top left and is gone in seconds, so it is fine for
 * ambient reminders and useless for anything a player actually has to read. If it matters that they
 * saw it, it goes here.
 *
 * The game has no send-to-everyone form of it — the API fans the message out across the live roster
 * one player at a time — so the result reports how many people it actually reached. "Sent" with no
 * count is the failure mode this screen is built to avoid.
 *
 * Needs the "Message players" permission (`action.message` write), the same one behind the
 * per-player message on a profile. Saving and removing presets is `templates.manage` write, since
 * the preset library is shared wording every colleague sees.
 */
import { useState } from "react";
import { api } from "../lib/api";
import { useResetOnServerChange, useServers } from "../lib/servers";
import { ActionResult, AskNotice, ObserveBanner, Explanation } from "./ui";
import { PanelGroup, Panel } from "./Panel";
import { TemplatePicker } from "./TemplatePicker";
import { PlaceholderHint } from "./Placeholders";

interface SendResult { found: number; sent: number; failed: number }

export default function Messages({ canSend, canManagePresets }: { canSend: boolean; canManagePresets: boolean }) {
  const { serverId, server } = useServers();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Separate ok/err fields rather than one string whose meaning is inferred from its wording —
  // the same trap Broadcast documents next door.
  const [ok, setOk] = useState("");
  const [err, setErr] = useState("");

  async function send() {
    const message = text.trim();
    if (!message) return;
    setSending(true); setOk(""); setErr("");
    try {
      const r = await api<SendResult>(`/servers/${serverId}/message/send`, { method: "POST", body: { message } });
      // Say what actually happened. Nobody on the server is a perfectly ordinary outcome between
      // rounds, and it is NOT the same as a message that went out — so it does not read as one.
      setOk(r.found === 0
        ? "Nobody is on the server right now — nothing was sent."
        : r.failed > 0
          ? `Sent to ${r.sent} of ${r.found} player${r.found === 1 ? "" : "s"} — ${r.failed} didn't get it, usually because they left mid-send.`
          : `Sent to all ${r.sent} player${r.sent === 1 ? "" : "s"}.`);
      if (r.sent > 0) setText("");
    } catch (e) { setErr((e as Error).message); } finally { setSending(false); }
  }

  // The outcome names a server and a headcount; carried onto the next server it would read as a
  // claim about that one.
  useResetOnServerChange(() => { setOk(""); setErr(""); });

  if (!serverId) return <div className="card"><p className="muted">Select a server to message.</p></div>;
  const active = server?.engagementMode === "active";

  // The Hub above draws the page header from the route; this tab draws only its own content.
  return (
    <div>
      <ObserveBanner server={server}>Nothing is sent while this server is in observe mode.</ObserveBanner>

      <PanelGroup viewId="messages">
        <Panel id="message-all" caps="action.message" title="Message everyone"
          subtitle="Appears in the top right of every player's screen and stays until dismissed.">
          {canSend ? (
            <>
              <AskNotice capability="action.message" serverId={serverId} />
              <label className="field">Message
                <textarea rows={3} value={text} maxLength={1000}
                  placeholder="Type a message, or pick a preset below…"
                  onChange={(e) => { setText(e.target.value); setOk(""); setErr(""); }} />
              </label>
              <TemplatePicker kind="message" canManage={canManagePresets} addFrom={text}
                onPick={(p) => { setText(p); setOk(""); setErr(""); }} />
              <PlaceholderHint>— filled for each player it reaches.</PlaceholderHint>
              <div className="actions">
                <button className="primary" disabled={!active || sending || !text.trim()} onClick={send}>
                  {sending ? "Sending…" : "Send to everyone"}
                </button>
                <ActionResult ok={ok} error={err} />
              </div>
              <Explanation>
                One message is sent per player, paced so a full server doesn&apos;t flood the game.
                For an ambient reminder that scrolls past instead, use the rotating broadcast under Administration.
              </Explanation>
            </>
          ) : (
            <p className="muted">You don&apos;t have permission to message players.</p>
          )}
        </Panel>
      </PanelGroup>
    </div>
  );
}
