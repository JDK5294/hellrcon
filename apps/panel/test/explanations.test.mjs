// The owner's standard: explanatory text folds under an "Explanation" dropdown (components/ui.tsx
// Explanation), so a screen shows its controls, warnings and live status rather than a wall of
// text to scroll past. This fails when a long, static explanation is written as a visible hint
// again — write it inside <Explanation> instead. A notice that must stay in view (a warning, what
// an action that costs something will do, something to fix before saving) is marked as one:
// className="hint notice" (or "muted … notice") — the scan below skips those.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PANEL = join(dirname(fileURLToPath(import.meta.url)), "..");
// The players' public site has its own design.
const SKIP = ["components/public/"];
const EXPR_OK = /\{" "\}|\{"\{[a-z_]+\}"\}|\{`[^`$]*`\}/g;

function* tsx(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsx(p);
    else if (p.endsWith(".tsx")) yield p;
  }
}
const plain = (body) => body.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "'").replace(EXPR_OK, " ").replace(/\s+/g, " ").trim();

test("long explanations fold under an Explanation dropdown instead of filling the screen", () => {
  const offenders = [];
  for (const file of [...tsx(join(PANEL, "components")), ...tsx(join(PANEL, "app"))]) {
    const rel = relative(PANEL, file);
    if (SKIP.some((s) => rel.startsWith(s))) continue;
    const src = readFileSync(file, "utf8");
    // Both styles explanations were written in: the hint, and muted body text.
    for (const m of src.matchAll(/<(p|div) className="((?:hint|muted)(?: [a-z0-9-]+)*)"(?: style=\{\{[^}]*\}\})?>([\s\S]*?)<\/\1>/g)) {
      if (m[2].split(" ").includes("notice")) continue;
      const body = m[3];
      // A paragraph carrying live values or controls is status, and stays in view.
      const isStatic = !body.replace(EXPR_OK, "").includes("{") && !/<button|<input|<select|onClick/.test(body);
      const text = plain(body);
      if (!isStatic || text.length < 120) continue;
      offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length} ${text.slice(0, 70)}…`);
    }
  }
  assert.deepEqual(offenders, [], "write these inside <Explanation> (components/ui.tsx)");
});

// Three "Explanation" toggles in a row read as clutter and hide which one holds what: side-by-side
// explanations are ONE dropdown, each part a paragraph inside it.
test("one Explanation per spot: side-by-side explanations are a single dropdown", () => {
  const offenders = [];
  for (const file of [...tsx(join(PANEL, "components")), ...tsx(join(PANEL, "app"))]) {
    const rel = relative(PANEL, file);
    if (SKIP.some((s) => rel.startsWith(s))) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/<\/Explanation>\s*<Explanation>/g)) offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
  }
  assert.deepEqual(offenders, [], "merge these into one <Explanation>, a <p> per part");
});

test("a setting's description is an Explanation, labelled as one", () => {
  const ui = readFileSync(join(PANEL, "components", "ui.tsx"), "utf8");
  assert.match(ui, /\{description && <Explanation>\{description\}<\/Explanation>\}/);
  assert.match(ui, /<summary>Explanation<\/summary>/);
});

// A confirmation's body is what pressing its button will do — the one thing the dialog is for. It
// is never an Explanation.
test("a dialog's own words are never folded", () => {
  const offenders = [];
  for (const file of [...tsx(join(PANEL, "components")), ...tsx(join(PANEL, "app"))]) {
    const rel = relative(PANEL, file);
    if (SKIP.some((s) => rel.startsWith(s))) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bbody:\s*\(?\s*<Explanation>/g)) offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
  }
  assert.deepEqual(offenders, [], "write a confirm's body as plain text or a notice");
});

/*
 * The other half of the standard: a notice must never be folded away. These are the ones a
 * person has to see — a warning, what an action that costs something (paid VIP, a restore) will
 * do, and something to fix before a save goes through — each kept in a visible notice paragraph.
 */
test("notices stay in view: warnings, what an action will do, and what to fix before saving", () => {
  const NOTICES = [
    ["components/Enforcer.tsx", "This rule moved the player to the other team"],
    ["components/Maps.tsx", "Map voting is paused, so it leaves this rotation"],
    ["components/Maps.tsx", "Map voting is on, and it manages this rotation"],
    ["components/Maps.tsx", "Map shuffle is on"],
    ["components/Seeding.tsx", "Deselect them to save"],
    ["components/PlayerGroups.tsx", "Members hold permanent VIP while they"],
    ["components/PlayerGroups.tsx", "Removes each member&apos;s VIP from the game"],
    ["components/EditVip.tsx", "Their VIP comes off the game now"],
    ["components/EditVip.tsx", "Counts down from their current expiry"],
    ["components/EditVip.tsx", "You don't hold the VIP permission here"],
    ["components/DataPort.tsx", "Restore replaces everything on this install"],
    ["app/page.tsx", "You are still signed in"],
    ["components/MapVoteHistory.tsx", "No votes recorded yet"],
    ["components/MatchDetail.tsx", "No kill log was captured for this round"],
    ["components/analytics/MapVoteAnalytics.tsx", "A quarter or more of results were overruled"],
    ["components/GroundRules.tsx", "Seeding is switched off for this server"],
    ["components/Enforcer.tsx", "This section is switched off, so none of its rules fire"],
    ["components/MapVoteHistory.tsx", "A third or more of your votes get no votes at all"],
    ["components/Bans.tsx", "Reads every connected server&apos;s own ban list"],
    ["components/DataPort.tsx", "A backup carries server RCON credentials"],
    ["components/DataPort.tsx", "The archive includes server RCON credentials"],
    ["components/GroundRules.tsx", "Seeding is in dry-run on this server"],
    ["components/PlayerActions.tsx", "confirming sends the action for approval"],
  ];
  for (const [file, text] of NOTICES) {
    const src = readFileSync(join(PANEL, file), "utf8");
    const at = src.indexOf(text);
    assert.ok(at > 0, `${file}: "${text}" is still there`);
    const before = src.slice(0, at);
    assert.ok(before.lastIndexOf("<Explanation>") <= before.lastIndexOf("</Explanation>"), `${file}: "${text}" is folded under an Explanation`);
    const lastNotice = Math.max(-1, ...[...before.matchAll(/className="[^"]*\bnotice"/g)].map((m) => m.index));
    assert.ok(lastNotice > Math.max(before.lastIndexOf("</p>"), before.lastIndexOf("</div>")), `${file}: "${text}" is a visible notice`);
  }
});
