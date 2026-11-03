"use client";
/**
 * One line of the event stream, rendered the same way everywhere it appears.
 *
 * The Game log grew a full vocabulary for this — a short tag per kind, a sentence that reads like
 * the thing that happened, and the shared tone colours (kills wear the killer's side, team kills
 * are always yellow). The player profile's "Recent activity" had none of it: it printed the raw
 * `evt.kill` key in a `<code>` and laid the fields out as bare table columns, so the one place a
 * moderator looks up a specific player was the one place the event stream was unreadable.
 *
 * Extracted here rather than copied so the two cannot drift: a kind added to the map is understood
 * by every surface at once, and a kind that is missing falls back identically in both.
 */
import { PlayerLink } from "./PlayerLink";
import { eventTone } from "../lib/colors";
import { EVENT_TAG, teamSwitchText } from "../lib/eventKinds";

export interface EventLineRow {
  ts: string;
  kind: string;
  actorName?: string | null;
  actorPlayerId?: string | null;
  victimName?: string | null;
  victimPlayerId?: string | null;
  weapon?: string | null;
  data?: Record<string, unknown> | null;
}

const str = (v: unknown) => (v == null ? "" : String(v));

/** The sentence: what happened, with the people in it clickable. */
export function EventBody({ e }: { e: EventLineRow }) {
  const actor = <PlayerLink playerId={e.actorPlayerId ?? undefined} name={e.actorName ?? "?"} />;
  const victim = <PlayerLink playerId={e.victimPlayerId ?? undefined} name={e.victimName ?? "?"} />;
  const d = e.data ?? {};
  switch (e.kind) {
    case "evt.chat.team":
    case "evt.chat.squad":
      return <>{actor}: <span className="log-msg">{str(d.message)}</span></>;
    case "evt.kill":
      return <>{actor} <span className="muted">✖</span> {victim}{e.weapon && <span className="log-weapon"> · {e.weapon}</span>}</>;
    case "evt.teamkill":
      return <>{actor} <span className="log-tk-mark">team-killed</span> {victim}{e.weapon && <span className="log-weapon"> · {e.weapon}</span>}</>;
    case "evt.player.connected": return <>{actor} <span className="muted">connected</span></>;
    case "evt.player.disconnected": return <>{actor} <span className="muted">disconnected</span></>;
    // A side swap reads at full strength: it is the one a moderator is looking for.
    case "evt.player.teamSwitched": return <>{actor} <span className={typeof d.swapFrom === "string" ? undefined : "muted"}>{teamSwitchText(d) ?? "switched team"}</span></>;
    case "evt.player.kicked": return <>{actor} <span className="muted">kicked</span>{d.reason ? <> — {str(d.reason)}</> : ""}</>;
    case "evt.player.banned": return <>{actor} <span className="muted">banned</span>{d.reason ? <> — {str(d.reason)}</> : ""}</>;
    case "evt.admin.message": return <><span className="muted">admin →</span> {actor}: <span className="log-msg">{str(d.message)}</span></>;
    case "evt.admin.camera": return <>{actor} <span className="muted">used admin camera</span>{d.message ? <> — <span className="log-msg">{str(d.message)}</span></> : null}</>;
    case "evt.vote.started": return <>{actor} <span className="muted">started a</span> {str(d.voteType) || "kick"} <span className="muted">vote{d.target ? <> vs {str(d.target)}</> : null}</span></>;
    case "evt.vote.completed": return <><span className="muted">vote completed:</span> {str(d.result)}</>;
    case "evt.vote.cast": return <>{actor} <span className="muted">voted</span>{d.content ? <> — <span className="log-msg">{str(d.content)}</span></> : null}</>;
    case "evt.match.started": return <span className="log-match">▶ Match started</span>;
    case "evt.match.ended": return <span className="log-match">■ Match ended</span>;
    default: return <span className="muted">{e.kind.replace(/^evt\./, "").replace(/\./g, " ")}</span>;
  }
}

/** The tag chip alone — kills take the killer's side colour when the row carries one. */
export function EventTag({ e }: { e: EventLineRow }) {
  const tag = EVENT_TAG[e.kind] ?? { label: "•", cls: "" };
  const tone = eventTone(e.kind, e.data);
  // Kills wear the killer's side: the tag flips to the blue/red variant when the event carries a
  // resolved actorSide (old imported rows without one stay neutral rather than guessing).
  const cls = e.kind === "evt.kill" && (tone === "blue" || tone === "red") ? `kill-${tone}` : tag.cls;
  return <span className={`log-tag ${cls}`}>{tag.label}</span>;
}

/**
 * A whole row: time, tag, sentence. `time` is passed in because the surfaces disagree about how to
 * show it on purpose — the log wants an absolute clock time to correlate against the game, a
 * profile wants "6 min ago".
 */
export function EventLine({ e, time, trailing }: { e: EventLineRow; time: React.ReactNode; trailing?: React.ReactNode }) {
  const tone = eventTone(e.kind, e.data);
  return (
    <div className={`log-row ${tone ? `tone-${tone}` : ""}`}>
      <span className="log-time">{time}</span>
      <EventTag e={e} />
      <span className="log-body"><EventBody e={e} /></span>
      {trailing}
    </div>
  );
}
