"use client";
/**
 * The public demo's page (app/demo): the panel's own shell, with the demo's world put in place
 * first — lib/demo/install is imported before anything of the panel's, so it is there before any of
 * the panel's code runs. Its bar keeps Help's walkthroughs a press away (components/DemoBar).
 */
import "../lib/demo/install";
import Shell from "../app/page";

export default function DemoApp() {
  return <Shell />;
}
