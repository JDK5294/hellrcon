import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVoteAnnouncement, parseVoteBallot, shouldApplyLiveLeader, MAX_ANNOUNCEMENT_CHARS } from "../dist/index.js";

const OPTS = [{ id: "carentan", name: "Carentan" }, { id: "foy", name: "Foy" }, { id: "omaha", name: "Omaha Beach" }];

test("announcement: the map-list layout puts one map per line under the header", () => {
  const text = buildVoteAnnouncement({ header: "Vote for the next map in Discord!", layout: "map_list", options: OPTS });
  assert.equal(text, "Vote for the next map in Discord!\n\nCarentan\nFoy\nOmaha Beach");
});

test("announcement: the vote-counts layout orders by votes and pluralises", () => {
  const text = buildVoteAnnouncement({ header: "Vote now!", layout: "vote_counts", options: OPTS, tallies: [3, 7, 1] });
  assert.equal(text, "Vote now!\n\nFoy - 7 votes\nCarentan - 3 votes\nOmaha Beach - 1 vote");
});

test("announcement: ties in the vote-counts layout break by name, so the order is stable", () => {
  const text = buildVoteAnnouncement({ header: "Vote", layout: "vote_counts", options: OPTS, tallies: [2, 2, 2] });
  assert.deepEqual(text.split("\n").slice(2), ["Carentan - 2 votes", "Foy - 2 votes", "Omaha Beach - 2 votes"]);
});

test("announcement: with no counts read yet, vote_counts shows the plain list rather than fake zeroes", () => {
  const text = buildVoteAnnouncement({ header: "Vote", layout: "vote_counts", options: OPTS });
  assert.equal(text, "Vote\n\nCarentan\nFoy\nOmaha Beach");
  // A short tally (Discord returned fewer answers than we offered) is equally untrustworthy.
  const partial = buildVoteAnnouncement({ header: "Vote", layout: "vote_counts", options: OPTS, tallies: [1, 2] });
  assert.equal(partial, "Vote\n\nCarentan\nFoy\nOmaha Beach");
});

test("announcement: {options} in the header is expanded and suppresses the appended list", () => {
  // This is what every message written before layouts existed looks like — it must not double up.
  const text = buildVoteAnnouncement({ header: "Vote on Discord: {options}", layout: "map_list", options: OPTS });
  assert.equal(text, "Vote on Discord: Carentan, Foy, Omaha Beach");
});

test("announcement: the 'none' layout is the header alone", () => {
  assert.equal(buildVoteAnnouncement({ header: "Vote on Discord!", layout: "none", options: OPTS }), "Vote on Discord!");
});

test("announcement: with no vote running the header stands alone, with no empty list under it", () => {
  assert.equal(buildVoteAnnouncement({ header: "Vote soon", layout: "map_list", options: [] }), "Vote soon");
  assert.equal(buildVoteAnnouncement({ header: "Vote for {options}", layout: "none", options: [] }), "Vote for the map poll");
});

const LIVE = {
  enabled: true, leaderId: "foy", alreadyAppliedId: null, totalVotes: 4,
  lastMatchEndAt: 0, now: 1_000_000, postMatchApplyDelayMs: 300_000,
};

test("live leader: a new leader with votes behind it gets queued", () => {
  assert.deepEqual(shouldApplyLiveLeader(LIVE), { apply: true, reason: "leader changed" });
});

test("live leader: an unchanged leader costs no RCON calls", () => {
  assert.equal(shouldApplyLiveLeader({ ...LIVE, alreadyAppliedId: "foy" }).apply, false);
});

test("live leader: a vote nobody has entered leaves the rotation alone", () => {
  assert.equal(shouldApplyLiveLeader({ ...LIVE, totalVotes: 0 }).apply, false);
});

test("live leader: off means off, even with a clear leader", () => {
  assert.equal(shouldApplyLiveLeader({ ...LIVE, enabled: false }).apply, false);
});

test("live leader: nothing to queue when no option leads", () => {
  assert.equal(shouldApplyLiveLeader({ ...LIVE, leaderId: null }).apply, false);
});

test("live leader: the settle window after a match end holds the rotation, then releases it", () => {
  const justEnded = shouldApplyLiveLeader({ ...LIVE, lastMatchEndAt: 1_000_000 - 60_000 });
  assert.equal(justEnded.apply, false);
  assert.match(justEnded.reason, /240s left/);

  const settled = shouldApplyLiveLeader({ ...LIVE, lastMatchEndAt: 1_000_000 - 301_000 });
  assert.equal(settled.apply, true);
});

test("live leader: a zero settle window disables the wait entirely", () => {
  const r = shouldApplyLiveLeader({ ...LIVE, lastMatchEndAt: 1_000_000 - 1_000, postMatchApplyDelayMs: 0 });
  assert.equal(r.apply, true);
});

test("the announcement is bounded — whole lines go, not half a map name", () => {
  // The header is bounded where staff type it, but the composed message is header PLUS one line per
  // option, and neither the option count nor a map's custom display name is bounded by anything.
  // This is now sent to each player individually, so a message the game refuses is refused once per
  // person on the server rather than once.
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, name: `A Very Long Custom Map Display Name ${i}` }));
  const text = buildVoteAnnouncement({ header: "Vote for the next map in Discord!", layout: "map_list", options: many as never });
  assert.ok(text.length <= MAX_ANNOUNCEMENT_CHARS, `composed ${text.length} chars, past the ${MAX_ANNOUNCEMENT_CHARS} cap`);
  assert.ok(text.startsWith("Vote for the next map in Discord!"), "the header always survives");
  // Whole lines only: every line after the blank one is a complete name, never a clipped one.
  const [, ...lines] = text.split("\n\n");
  for (const line of (lines.join("\n\n").split("\n").filter(Boolean))) {
    assert.ok(many.some((m) => m.name === line), `"${line}" is a half-written option`);
  }
});

test("the most-voted options are the ones that survive the cap", () => {
  // vote_counts sorts by votes before this trims, so trimming from the end keeps what matters.
  const opts = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, name: `Map With A Long Name Number ${i}` }));
  const tallies = opts.map((_, i) => i); // the last option is the most popular
  const text = buildVoteAnnouncement({ header: "Vote!", layout: "vote_counts", options: opts as never, tallies });
  assert.ok(text.length <= MAX_ANNOUNCEMENT_CHARS);
  assert.ok(text.includes("Map With A Long Name Number 29"), "the leader is on the list");
  assert.ok(!text.includes("Number 0 - 0 votes"), "the least-voted option is what got dropped");
});

test("a header that alone exceeds the cap is clipped rather than dropped", () => {
  const text = buildVoteAnnouncement({ header: "x".repeat(900), layout: "map_list", options: OPTS });
  assert.equal(text.length, MAX_ANNOUNCEMENT_CHARS);
  assert.ok(text.endsWith("…"), "and says it was clipped");
});

test("numbered lists carry each option's ballot number and NEVER re-sort", () => {
  // In-game chat voting: the number beside a map is how a player votes for it. A list that
  // reshuffles by vote count as the reminder repeats would have people voting for the wrong map.
  const opts = [{ id: "a", name: "Foy" }, { id: "b", name: "Kursk" }, { id: "c", name: "Remagen" }];
  const list = buildVoteAnnouncement({ header: "Vote!", layout: "map_list", options: opts as never, numbered: true });
  assert.ok(list.includes("1. Foy") && list.includes("2. Kursk") && list.includes("3. Remagen"));

  const counts = buildVoteAnnouncement({ header: "Vote!", layout: "vote_counts", options: opts as never, tallies: [0, 5, 2], numbered: true });
  const iFoy = counts.indexOf("1. Foy");
  const iKursk = counts.indexOf("2. Kursk - 5 votes");
  const iRemagen = counts.indexOf("3. Remagen - 2 votes");
  assert.ok(iFoy >= 0 && iKursk > iFoy && iRemagen > iKursk, "option order holds even though Kursk leads");
});

test("parseVoteBallot: the one definition of a ballot-shaped chat line", () => {
  // Accepted: a bare number, give or take the punctuation players actually type.
  assert.equal(parseVoteBallot("2"), 2);
  assert.equal(parseVoteBallot(" 2 "), 2);
  assert.equal(parseVoteBallot("!3"), 3);
  assert.equal(parseVoteBallot("3."), 3);
  assert.equal(parseVoteBallot("!10."), 10);
  assert.equal(parseVoteBallot("12"), 12);
  // Accepted too: the vote command players bring from other servers, however they type it.
  for (const line of ["!vm 4", "!VM 4", "!Vm 4", "!vm4", "! vm 4", "!votemap 4", "!votemap4", "!VoteMap 4", "!vm 4."]) {
    assert.equal(parseVoteBallot(line), 4, `${JSON.stringify(line)} is a vote for 4`);
  }
  assert.equal(parseVoteBallot("!vm"), null, "the command alone picks nothing");
  assert.equal(parseVoteBallot("!vm 4 please"), null, "and anything after the number is conversation");
  assert.equal(parseVoteBallot("!vm 1944"), null);
  // Rejected: conversation, years, and anything past two digits.
  assert.equal(parseVoteBallot("3 tanks on E5"), null);
  assert.equal(parseVoteBallot("vote 2"), null);
  assert.equal(parseVoteBallot("1944"), null);
  assert.equal(parseVoteBallot("222"), null);
  assert.equal(parseVoteBallot(""), null);
  assert.equal(parseVoteBallot("!!"), null);
});
