"use client";
/**
 * The panel the staff command opens in Discord, drawn as Discord shows it to this person (GET
 * /api/discord/staff-panel: the bot's own screens, for their permissions). The Discord walkthrough's
 * steps happen there, where the panel has no screen to show or ring (lib/walkthroughs
 * WalkStep.discord), so they draw it: in the slideshow in a picture's place, and in a window over
 * the person's own screen for Show me on my screen (components/WalkSpotlight).
 *
 * It opens where the step is — at a part (at the list of parts without one), with the first of the
 * person's servers picked where the part starts by picking one — and moves as the real one does
 * wherever moving changes nothing: a part's button opens that part, a door opens the part behind
 * it, Back goes back, and picking a server draws that server's screen. Every other button does
 * something, so here it only says so.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { DISCORD_PANEL } from "../lib/walkthroughs";
import { findWalkTarget, type WalkTarget } from "../lib/walkTarget";
import { ActionResult, Callout, SkeletonLines } from "./ui";

/** Discord's own message shape: rows of buttons (2), string selects (3) and member pickers (5). */
interface Component {
  type: number; style?: number; label?: string; custom_id?: string; disabled?: boolean;
  placeholder?: string; options?: { label: string; value: string; description?: string }[];
}
interface Message { content: string; components: { type: number; components: Component[] }[] }
interface Preview {
  command: { name: string; enabled: boolean };
  linked: boolean;
  home: Message;
  parts: Record<string, { label: string; message: Message; servers: boolean }>;
}

/** What a button carries in Discord, `sp:<part>:<action>:<state>`: which part, and what it does
 *  there ("" opens it). */
function addressOf(id = ""): { part: string; action: string } | null {
  const m = /^sp:([^:]+):([^:]*):/.exec(id);
  return m ? { part: m[1]!, action: m[2]! } : null;
}

const WORD = /[\p{L}\p{N}]/u;

/** Discord's text, as Discord shows it: **bold**, _italic_, `code`, mentions, a \ before a mark. */
function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  // The next unescaped `mark` at or after `from`, or -1.
  const close = (mark: string, from: number) => {
    for (let j = from; j <= s.length - mark.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (s.startsWith(mark, j)) return j;
    }
    return -1;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length && /[\\*_`~|>#-]/.test(s[i + 1]!)) { buf += s[++i]; continue; }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) { flush(); out.push(<code key={`${key}-${i}`}>{s.slice(i + 1, end)}</code>); i = end; continue; }
    }
    if (c === "*" && s[i + 1] === "*") {
      const end = close("**", i + 2);
      if (end > i + 2) { flush(); out.push(<strong key={`${key}-${i}`}>{inline(s.slice(i + 2, end), `${key}-${i}`)}</strong>); i = end + 1; continue; }
    }
    if (c === "_" && !WORD.test(s[i - 1] ?? "")) {
      const end = close("_", i + 1);
      if (end > i + 1 && !WORD.test(s[end + 1] ?? "")) { flush(); out.push(<em key={`${key}-${i}`}>{inline(s.slice(i + 1, end), `${key}-${i}`)}</em>); i = end; continue; }
    }
    if (c === "<") {
      const m = /^<(@!?|#)\d+>/.exec(s.slice(i));
      if (m) { flush(); out.push(<span key={`${key}-${i}`} className="dpv-mention">{m[1] === "#" ? "#channel" : "@member"}</span>); i += m[0].length - 1; continue; }
    }
    buf += c;
  }
  flush();
  return out;
}

function DiscordText({ text }: { text: string }) {
  return <div className="dpv-text">{text.split("\n").map((line, i) => <div key={i} className="dpv-line">{line ? inline(line, `l${i}`) : " "}</div>)}</div>;
}

/** The first server a part that starts by picking one offers this person: its picker's first. */
function firstServer(message: Message, part: string): string | undefined {
  for (const row of message.components) {
    for (const c of row.components) {
      const a = addressOf(c.custom_id);
      if (c.type === 3 && a?.part === part && a.action === "srv") return c.options?.[0]?.value;
    }
  }
  return undefined;
}

/**
 * The drawing for `step`, opened at its `part` (and, with `server`, at that part's screen for the
 * first of this person's servers) — afresh for each new step, wherever the last was left: a door
 * pressed in one step does not leave the next in the part behind it. `ring` is what the step points
 * at, ringed in it — the slideshow's; Show me on my screen rings it itself, so passes none.
 */
export default function StaffPanelDrawing({ step, part, server = false, ring }: { step: object; part?: string; server?: boolean; ring?: WalkTarget }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState("");
  // What is on screen: the list of parts, a part's opening screen, or one server's screen in a part.
  const [at, setAt] = useState<{ part: string | null; message?: Message }>({ part: null });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  /** One server's screen per part and server, read once: stepping back and forth draws it at once. */
  const screens = useRef(new Map<string, Message>());
  /** Counts what the drawing has been asked to show — a step, a part, Back, a server picked. A
   *  server's screen that comes back after something newer was asked for is not drawn over it. */
  const asked = useRef(0);
  const region = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api<Preview>("/discord/staff-panel").then(setPreview).catch((e) => setErr((e as Error).message));
  }, []);

  const serverScreen = async (p: string, key: string): Promise<Message> => {
    const known = screens.current.get(`${p}/${key}`);
    if (known) return known;
    const r = await api<{ message: Message }>(`/discord/staff-panel/${encodeURIComponent(p)}/${encodeURIComponent(key)}`);
    screens.current.set(`${p}/${key}`, r.message);
    return r.message;
  };

  // Where the step is, each time it changes.
  useEffect(() => {
    if (!preview) return;
    const mine = ++asked.current;
    setNote("");
    const opened = part ? preview.parts[part] : undefined;
    const key = opened && server && opened.servers ? firstServer(opened.message, part!) : undefined;
    if (!opened || !key) { setAt({ part: opened ? part! : null }); setBusy(false); return; }
    setBusy(true);
    serverScreen(part!, key)
      .then((message) => { if (asked.current === mine) setAt({ part: part!, message }); })
      .catch((e) => { if (asked.current === mine) { setAt({ part: part! }); setNote((e as Error).message); } })
      .finally(() => { if (asked.current === mine) setBusy(false); });
  }, [preview, step, part, server]);

  const shown: Message | undefined = preview ? at.message ?? (at.part ? preview.parts[at.part]?.message : undefined) ?? preview.home : undefined;

  // The step's control, ringed where the drawing shows it — none when the step is about the whole
  // panel, or the control is not in this person's drawing (a vote that is not running).
  useEffect(() => {
    if (!ring || !shown || (!ring.button && !ring.css)) return;
    const el = findWalkTarget(ring);
    if (!el || !region.current?.contains(el)) return;
    el.classList.add("walk-ringed");
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    return () => el.classList.remove("walk-ringed");
  }, [ring, shown]);

  if (err && !preview) return <ActionResult error={err} />;
  if (!preview || !shown) return <SkeletonLines lines={4} />;

  const go = (p: string | null, message?: Message) => { asked.current++; setAt({ part: p, message }); setNote(""); setBusy(false); };

  const press = (c: Component) => {
    const a = addressOf(c.custom_id);
    if (a && a.action === "") {
      if (a.part === "home") return go(null);
      if (preview.parts[a.part]) return go(a.part);
      // A door whose part is not theirs: Discord answers the press with a refusal.
      return setNote("Your permissions don't open that part, so Discord answers that you don't have access to it.");
    }
    setNote(`“${c.label ?? ""}” does its work in Discord. Here it only shows where it is.`);
  };

  const pick = async (c: Component, value: string) => {
    const a = addressOf(c.custom_id);
    if (!value || !a || a.action !== "srv" || !preview.parts[a.part]?.servers) return setNote("Picking here works in Discord. Here it only shows where it is.");
    const mine = ++asked.current;
    setBusy(true); setNote("");
    try {
      const message = await serverScreen(a.part, value);
      if (asked.current === mine) setAt({ part: a.part, message });
    } catch (e) { if (asked.current === mine) setNote((e as Error).message); } finally { if (asked.current === mine) setBusy(false); }
  };

  return (
    <>
      {!preview.command.enabled && <Callout variant="warn">The staff command is switched off, so Discord does not offer it until it is switched on again.</Callout>}
      {!preview.linked && <Callout>Your account is not linked to Discord, so the command answers only that it needs a linked account. Link Discord in the menu under your name.</Callout>}
      <div className="dpv" role="region" aria-label={DISCORD_PANEL} aria-busy={busy} ref={region}>
        <div className="dpv-used"><span className="dpv-you">You</span> used <span className="dpv-cmd">/{preview.command.name}</span></div>
        <div className="dpv-msg">
          <span className="dpv-avatar" aria-hidden>⚙</span>
          <div className="dpv-body">
            <DiscordText text={shown.content} />
            {shown.components.map((row, r) => (
              <div key={r} className="dpv-row">
                {row.components.map((c, i) => c.type === 2 ? (
                  <button key={i} type="button" className={`dpv-btn dpv-s${c.style ?? 2}`} disabled={c.disabled} onClick={() => press(c)}>{c.label}</button>
                ) : c.type === 3 ? (
                  <select key={i} className="dpv-select" aria-label={c.placeholder ?? "Pick one"} value="" onChange={(e) => void pick(c, e.target.value)}>
                    <option value="">{c.placeholder ?? "Make a selection"}</option>
                    {(c.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <button key={i} type="button" className="dpv-select dpv-pickmember" onClick={() => setNote("Picking a member works in Discord. Here it only shows where it is.")}>
                    {c.placeholder ?? "Pick a member"}
                  </button>
                ))}
              </div>
            ))}
            <div className="dpv-ephemeral">Only you can see this</div>
          </div>
        </div>
      </div>
      {note && <p className="hint dpv-note" role="status">{note}</p>}
    </>
  );
}
