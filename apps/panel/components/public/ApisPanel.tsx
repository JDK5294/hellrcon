"use client";
/**
 * The APIs behind a public stats screen, for streamers and overlay builders: each public endpoint
 * the screen is built from, its full link, and what it answers right now. The list comes from the
 * page (apisFor in PublicStatsApp), which knows what each screen reads.
 *
 * A reply is shown as it came, only re-indented: parsing and re-printing it would rewrite its
 * numbers (CRCON's 1.0 reads back as 1), and a tool matching the wire needs the wire.
 */
import { useEffect, useRef, useState } from "react";

export interface PublicApi {
  /** The CRCON command, or a short name for one of this site's own endpoints. */
  name: string;
  /** Which server it answers for, on a screen that reads more than one. */
  server?: string;
  /** What it answers, in a line. */
  about: string;
  /** Root-relative, query included. */
  path: string;
  /** One of CRCON's public endpoints: a tool that reads CRCON reads it unchanged. */
  crcon?: boolean;
}

type Reply = { status: number; text: string } | { error: string };

/** How much of a reply the panel draws; the link has the rest. */
const SHOWN_MAX = 200_000;

/** `raw` re-indented two spaces a level, its strings and numbers exactly as they came. */
export function indentJson(raw: string): string {
  let out = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") { inString = true; out += c; continue; }
    if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
    if (c === "{" || c === "[") {
      // An empty one stays on its line.
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j]!)) j++;
      if (raw[j] === (c === "{" ? "}" : "]")) { out += c + raw[j]; i = j; continue; }
      depth += 1;
      out += c + newline();
      continue;
    }
    if (c === "}" || c === "]") { depth = Math.max(0, depth - 1); out += newline() + c; continue; }
    if (c === ",") { out += `,${newline()}`; continue; }
    if (c === ":") { out += ": "; continue; }
    out += c;
  }
  return out;
}

function shown(reply: Reply): string {
  if ("error" in reply) return `Could not reach it: ${reply.error}`;
  const looksJson = /^\s*[[{]/.test(reply.text);
  const body = looksJson ? indentJson(reply.text) : reply.text;
  const cut = body.length > SHOWN_MAX ? `${body.slice(0, SHOWN_MAX)}\n… (cut short here: open the link for the whole reply)` : body;
  return reply.status === 200 ? cut : `HTTP ${reply.status}\n${cut}`;
}

/**
 * `origin` is the address the links carry: the site's public one when it has one, so a link copied
 * from the page opened on the panel's own host never hands out the admin hostname. The replies are
 * read from this page's own address either way (no cross-origin read).
 */
export function ApisPanel({ apis, origin, onClose }: { apis: PublicApi[]; origin?: string | null; onClose: () => void }) {
  // Each reply as drawn, laid out once as it arrives: a live screen's replies run to hundreds of
  // kilobytes, and laying them all out again on every render (each arrival, each Copy) stalled a phone.
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [reads, setReads] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const base = origin || (typeof window === "undefined" ? "" : window.location.origin);

  // What each endpoint answers now: read when the panel opens, and again on Refresh.
  useEffect(() => {
    let stop = false;
    setReplies({});
    for (const a of apis) {
      fetch(a.path, { cache: "no-store" })
        .then(async (r): Promise<Reply> => ({ status: r.status, text: await r.text() }))
        .catch((e): Reply => ({ error: (e as Error).message }))
        .then((reply) => { if (!stop) { const drawn = shown(reply); setReplies((cur) => ({ ...cur, [a.path]: drawn })); } });
    }
    return () => { stop = true; };
  }, [apis, reads]);

  // A dialog: Escape closes it, and the page behind stays where it was.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = before; window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  useEffect(() => { box.current?.focus(); }, []);

  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(url);
      setTimeout(() => setCopied((cur) => (cur === url ? null : cur)), 1500);
    }).catch(() => { /* the link is on screen to copy by hand */ });
  };

  return (
    <div className="pub-apis-backdrop" onClick={onClose}>
      <div className="pub-apis" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="APIs for this screen" onClick={(e) => e.stopPropagation()}>
        <div className="pub-apis-head">
          <strong>APIs for this screen</strong>
          <button type="button" onClick={() => setReads((n) => n + 1)}>Refresh</button>
          <button type="button" className="pub-apis-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <p className="hint">
          What this screen is built from: public, with no login or key. Live data changes every few seconds, so poll every
          10 seconds or slower.
        </p>
        {apis.map((a) => {
          const url = base + a.path;
          return (
            <section key={a.path} className="pub-api">
              <div className="pub-api-head">
                <strong className={a.crcon ? "pub-api-command" : undefined}>{a.name}</strong>
                {a.server && <span className="muted fs-sm">{a.server}</span>}
                {a.crcon && <span className="pub-api-tag" title="One of CRCON's public endpoints: a tool that reads CRCON reads it unchanged">CRCON</span>}
              </div>
              <p className="muted fs-sm pub-api-about">{a.about}</p>
              <div className="pub-api-url">
                <code>{url}</code>
                <button type="button" onClick={() => copy(url)}>{copied === url ? "Copied" : "Copy"}</button>
                <a className="pub-api-open" href={url} target="_blank" rel="noreferrer">Open</a>
              </div>
              <pre className="pub-api-out" aria-label={`What ${a.name} answers now`}>{replies[a.path] ?? "Loading…"}</pre>
            </section>
          );
        })}
      </div>
    </div>
  );
}
