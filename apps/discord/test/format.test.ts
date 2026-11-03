import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEvent, categoryOf } from "../dist/format.js";

test("maps kinds to categories, unknown → null", () => {
  assert.equal(categoryOf("evt.kill"), "kills");
  assert.equal(categoryOf("evt.teamkill"), "kills");
  assert.equal(categoryOf("evt.chat.team"), "chat");
  assert.equal(categoryOf("evt.player.banned"), "admin");
  assert.equal(categoryOf("evt.player.connected"), "connections");
  assert.equal(categoryOf("evt.match.ended"), "match");
  assert.equal(categoryOf("evt.unknown.thing"), null);
});

test("formats a kill with weapon and a time prefix", () => {
  const f = formatEvent({ kind: "evt.kill", ts: "2026-02-11T22:56:00.000Z", actorName: "Peter", victimName: "Robo", weapon: "M1918A2 BAR" });
  assert.equal(f?.category, "kills");
  assert.match(f!.line, /`22:56:00`/);
  assert.match(f!.line, /Peter/);
  assert.match(f!.line, /Robo/);
  assert.match(f!.line, /BAR/);
});

test("teamkill is labelled distinctly", () => {
  const f = formatEvent({ kind: "evt.teamkill", actorName: "A", victimName: "B", weapon: "SATCHEL" });
  assert.equal(f?.category, "kills");
  assert.match(f!.line, /TEAMKILL/);
});

test("moderation + admin message pull detail from data", () => {
  const kick = formatEvent({ kind: "evt.player.kicked", actorName: "Tommy", data: { reason: "Idle" } });
  assert.match(kick!.line, /Tommy/);
  assert.match(kick!.line, /Idle/);
  const msg = formatEvent({ kind: "evt.admin.message", actorName: "Alpha", data: { message: "move up" } });
  assert.equal(msg?.category, "admin");
  assert.match(msg!.line, /move up/);
});

test("votes and match state format", () => {
  const vs = formatEvent({ kind: "evt.vote.started", actorName: "Noodle", data: { voteType: "Kick", target: "busco" } });
  assert.equal(vs?.category, "admin");
  assert.match(vs!.line, /Noodle/);
  assert.match(vs!.line, /busco/);
  assert.equal(formatEvent({ kind: "evt.match.started" })?.category, "match");
});

test("unknown kind is dropped", () => {
  assert.equal(formatEvent({ kind: "evt.something.else" }), null);
});

test("the time prefix reads on the community clock; junk zones fall back to UTC", () => {
  const evt = { kind: "evt.chat.team", ts: "2026-02-11T22:56:00.000Z", actorName: "Peter", data: { message: "push B" } };
  // February in New York is EST (UTC-5): a 22:56 UTC line reads 17:56 to the people watching it.
  assert.match(formatEvent(evt, "America/New_York")!.line, /`17:56:00`/);
  // No zone → the old UTC reading, so callers without a community clock keep their behavior.
  assert.match(formatEvent(evt)!.line, /`22:56:00`/);
  // A zone the runtime doesn't know never drops the line — it falls back to UTC.
  assert.match(formatEvent(evt, "Mars/Olympus_Mons")!.line, /`22:56:00`/);
});

test("missing timestamp → no prefix, still formats", () => {
  const f = formatEvent({ kind: "evt.player.connected", actorName: "Newbie" });
  assert.ok(f);
  assert.doesNotMatch(f!.line, /`/); // no backtick time prefix
  assert.match(f!.line, /Newbie/);
});

// The owner's case: a player swapping sides to find the other team's garrisons. Unassigned sits
// between the sides, so a swap is the join onto the other side; ingest marks it (swapFrom,
// swapCount). The panel words it the same — its copy is held to this one below.
test("a team switch reads as a person would say it, the swap with its count", async () => {
  const { teamSwitchText } = await import("../dist/format.js");
  const line = (data: Record<string, unknown> | null) => formatEvent({ kind: "evt.player.teamSwitched", actorName: "Bob", data })!.line;
  assert.match(line({ from: "None", to: "Allies", change: "joined Allies" }), /🔀 Bob joined Allies$/);
  assert.match(line({ from: "Allies", to: "None", change: "left Allies" }), /Bob left Allies \(unassigned\)$/);
  assert.match(line({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1 }), /Bob switched sides Allies → Axis$/);
  assert.match(line({ from: "None", to: "Axis", swapFrom: "Allies", swapCount: 3 }), /Bob switched sides Allies → Axis \(3rd this round\)$/);
  assert.match(line(null), /Bob switched team$/, "an older row with no teams");
  assert.equal(categoryOf("evt.player.teamSwitched"), "connections", "routed as before — the channel setup is the owner's");

  // Same strings as the panel, case for case.
  // (A path tsc does not follow: the panel is another app, read here only to compare.)
  const panelPath = new URL("../../panel/lib/eventKinds.ts", import.meta.url).href;
  const panel = (await import(panelPath)) as { teamSwitchText: (d: unknown) => string | null };
  const cases = [
    { from: "None", to: "Allies" }, { from: "Allies", to: "None" }, { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 1 },
    { from: "None", to: "Allies", swapFrom: "Axis", swapCount: 2 }, { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 11 },
    { from: "None", to: "Axis", swapFrom: "Allies", swapCount: 22 }, { from: "Allies", to: "Axis" }, { from: "None", to: "None" },
    { change: "joined Allies" }, {}, null,
  ];
  for (const c of cases) assert.equal(teamSwitchText(c), panel.teamSwitchText(c), JSON.stringify(c));
});

/*
 * Names and chat are the players' own words, and Discord reads them as formatting: a chat line
 * "[free VIP](https://…)" posted as a disguised link in the staff channel, and a name with an
 * asterisk or a backtick garbled its line. CRCON escapes the same text; the address stays whole.
 */
test("player-written text is shown as written, never as Discord formatting", () => {
  const chat = formatEvent({ kind: "evt.chat.team", actorName: "**Bob**_the_`tank`", data: { message: "free VIP: [claim](https://phish.example/x_y) ||now||" } });
  assert.ok(chat);
  assert.ok(chat!.line.includes("\\*\\*Bob\\*\\*\\_the\\_\\`tank\\`"), chat!.line);
  assert.ok(chat!.line.includes("\\[claim\\](https://phish.example/x_y)"), `no disguised link, and the address whole: ${chat!.line}`);
  assert.ok(chat!.line.includes("\\|\\|now\\|\\|"), chat!.line);
  const kill = formatEvent({ kind: "evt.kill", actorName: "x_y", victimName: "a*b", weapon: "MP40" });
  assert.ok(kill!.line.includes("**x\\_y** → a\\*b"), `the line's own bold stays, the names are literal: ${kill!.line}`);
  const ban = formatEvent({ kind: "evt.player.banned", actorName: "Eve", data: { reason: "see ~~this~~" } });
  assert.ok(ban!.line.includes("see \\~\\~this\\~\\~"), ban!.line);
});
