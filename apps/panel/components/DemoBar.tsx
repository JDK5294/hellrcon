"use client";
/**
 * The strip at the top of the public demo's screens (app/demo): that this is a made-up community,
 * kept in this page only, with a way to start again and to Help's walkthroughs. It says for a
 * moment why a link was not followed (lib/demo/install). Drawn nowhere else.
 */
import { useEffect, useState } from "react";
import { DEMO_NOTE, isDemo } from "../lib/demo/flag";

export function DemoBar() {
  const [demo, setDemo] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => setDemo(isDemo()), []);
  useEffect(() => {
    if (!demo) return;
    const said = (e: Event) => setNote(String((e as CustomEvent).detail ?? ""));
    window.addEventListener(DEMO_NOTE, said);
    return () => window.removeEventListener(DEMO_NOTE, said);
  }, [demo]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(""), 5_000);
    return () => clearTimeout(t);
  }, [note]);
  if (!demo) return null;
  return (
    <div className="demo-bar" role="note">
      <strong>Demo</strong>
      <span className="demo-bar-text" aria-live="polite">{note || "A made-up community. What you change lasts until you reload."}</span>
      <span className="grow" />
      <a className="mini ghost" href="#/help/start">Walkthroughs</a>
      {/* The page afresh, at its start: the dashboard. */}
      <button type="button" className="mini" onClick={() => window.location.replace(window.location.pathname)}>Start over</button>
    </div>
  );
}
