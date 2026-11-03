import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Field report: Carentan played at 3:12, 4:11 and 5:44, and St Marie Du Mont twice in a row the
 * next morning, with no vote result for the repeats. The vote collapses the rotation to the map it
 * queued, so any round it did not settle replayed that map — and the watch for a missed MATCH
 * ENDED looks for the map CHANGING, which a replay never does. The decision is pinned in the maps
 * package (replayGuardPick); these pin where the vote loop uses it. The loop holds a live RCON
 * session and is not runnable here, so — as with the rollover test — the source is read.
 */
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"), "utf8");

function section(fromMarker: string, toMarker: string): string {
  const from = src.indexOf(fromMarker);
  const to = src.indexOf(toMarker, from);
  assert.ok(from > 0 && to > from, `section "${fromMarker}" is in place`);
  return src.slice(from, to);
}

const applySection = () => section("--- match ended: close the poll", "--- a match that ended without MATCH ENDED reaching the log");

test("the result at MATCH ENDED is applied even when the final count cannot be read", () => {
  const apply = applySection();
  assert.match(apply, /try \{ counts = await surface\.close\(/, "the close read is caught on its own");
  assert.ok(apply.includes("state.tallies?.[i]"), "and the last count read stands in for it");
  assert.ok(apply.includes("attempt >= 3"), "a refused rotation edit is tried again before the next map loads");
  assert.ok(apply.includes('action: "mapvote.applyFailed"'), "and a result that never reached the server is on the trail");
});

test("the apply bars the round's own map, not whatever has loaded by the time the end is read", () => {
  const apply = applySection();
  assert.ok(
    apply.includes("resolveRoundResult({ options: state.options, counts, roundMap: roundMapOf(state), inPlay: await readInPlay() })"),
    "the shared decision, given the poll's round map",
  );
  assert.ok(apply.includes("!dryRun && !alreadyInPlay"), "a result already in play is not queued a second time");
  assert.ok(apply.includes('alreadyInPlay ? "it is the map being played now"'), "and players are not told it is queued");
  // The history row's outcome follows the result, not the raw counts.
  assert.ok(apply.includes('noVotes ? "no_votes" : "vote"'));
  // roundMapOf answers only for the poll it was read for.
  assert.ok(src.includes("pollRound.messageId === s.activeMessageId ? pollRound.mapId : null"));
});

test("the apply's rotation edit refuses an empty read, and a dead session reconnects instead of being retried", () => {
  const apply = applySection();
  assert.ok(apply.includes("scheduleNextMap(liveRotationIO, target)"), "the edit that throws on an empty rotation read");
  assert.ok(!apply.includes("const io: RotationIO"), "no edit of its own that would insert into an unread rotation");
  assert.ok(apply.includes("if (isDeadSession(err) || attempt >= 3 || ctl.stopped) throw err;"), "never retried on a dead session");
  const rethrow = apply.indexOf("if (isDeadSession(e) && reconnectedFor !== lastMatchEndAt) {");
  assert.ok(rethrow > 0 && rethrow < apply.indexOf('action: "mapvote.applyFailed"'), "out to the reconnect before anything is recorded");
  const closes = apply.indexOf("tallies: [], talliedAt: null, overrideMapId: null, liveAppliedMapId: null, liveApplyNote: null, savedOptions: [],");
  assert.ok(closes > rethrow, "and before the vote is closed, so the fresh session settles it");
});

const noVoteEnd = () => section("const ends = recent.filter(", "if (ends.length > 0 && state.activeMessageId && state.options.length)");

test("a round that ends with no vote open still gets a next map, except during a staff stand-down", () => {
  const ends = noVoteEnd();
  assert.ok(ends.includes('fallbackOverReplay(await composeBallot(state), "the round ended with no vote open", null)'), "the fallback draws from the ballot the vote would have offered");
  assert.ok(ends.includes("!state.activeMessageId"), "only when no vote is up to settle the round");
  assert.ok(ends.includes("state.manualHoldUntil"), "never over a manual change or a preset's restart");
  assert.ok(ends.includes('server.engagementMode === "active"'), "and never in observe mode");
  assert.ok(src.indexOf("const composeBallot") < src.indexOf("composeBallot(state)"), "declared before the round-end use");
});

test("only a round end that just happened is acted on — a backlog read late is not", () => {
  assert.ok(noVoteEnd().includes("Date.now() - Date.parse(lastMatchEndAt) <= FRESH_ROUND_END_MS"));
});

test("a staff override with no vote open is still the next map, and is spent", () => {
  const ends = noVoteEnd();
  const forced = ends.indexOf("if (state.overrideMapId) {");
  assert.ok(forced > 0 && forced < ends.indexOf("composeBallot(state)"), "ahead of any random pick");
  assert.ok(ends.includes("await scheduleNextMap(liveRotationIO, forced);"));
  assert.ok(ends.includes("await persist({ overrideMapId: null });"));
  // And the replay fallbacks queue it rather than a ballot map.
  const fallback = section("const fallbackOverReplay = async", "const settled = ");
  assert.ok(fallback.includes("options: b.poll.options, overrideMapId })"));
});

test("a ballot is composed only once the rotation is known to be set to replay", () => {
  const ends = noVoteEnd();
  const check = ends.indexOf("replayQueued(await liveRotationIO.getRotation(), inPlay)");
  assert.ok(check > 0 && check < ends.indexOf("composeBallot(state)"));
  // …and the "nothing eligible" warning is given once per map in play, not every tick.
  assert.ok(section("const fallbackOverReplay = async", "const settled = ").includes("warnedNoPick !== b.inPlay"));
});

test("while voting is paused the guard never runs, and resuming does not hand it the pause's round ends", () => {
  const pauseMarker = "--- paused: park the open vote's options";
  const paused = section(pauseMarker, "--- just un-paused");
  assert.ok(paused.includes("await ctl.sleep(MAPVOTE_POLL_MS); continue;"), "a paused pass stops here");
  for (const site of ["fallbackOverReplay(await composeBallot(state)", "--- the replay guard: while a vote is up", 'queueFallback("no vote could be composed")']) {
    assert.ok(src.indexOf(site) > src.indexOf(pauseMarker), `"${site}" sits after the pause`);
  }
  assert.match(paused, /e\.kind === "evt\.match\.ended" && e\.ts > lastMatchEndAt\) \{ lastMatchEndAt = e\.ts;/, "the pause's round ends are read while paused");
  assert.ok(paused.includes("await persist({})"), "with the cursor kept, so a restart mid-pause does not bring them back");
});

test("during a manual change's stand-down no vote is up and none opens, so the guard has nothing to act through", () => {
  const hold = section("--- staff changed the map BY HAND", "--- match ended: close the poll");
  assert.ok(hold.includes("activeMessageId: null"), "the open vote is closed");
  assert.ok(hold.includes("savedOptions: [], reopenAt,"), "and the next one waits out the hold");
  const open = section("--- no active poll → restore the parked one", 'queueFallback("no vote could be composed")');
  assert.ok(open.includes("Date.now() < Date.parse(cur.reopenAt)"), "the open path waits out that hold before it could fall back");
});

test("while a vote is up, a rotation set to replay the map in play is given the vote's current pick", () => {
  const guard = section("--- the replay guard: while a vote is up", "--- keep the next map pointed at whatever is currently winning ---");
  assert.ok(guard.includes("replayGuardPick({"), "the shared decision");
  assert.ok(guard.includes("overrideMapId: state.overrideMapId"), "a staff override is honoured");
  assert.ok(guard.includes("settled()"), "after the post-match settle, like live apply");
  assert.ok(guard.includes("const inPlay = cfg.liveApply &&"), "and only with live apply on: off, the panel promises no mid-round edit");
  assert.ok(guard.includes("if (seen && pollMapWatch && !pollMapWatch.changedTo) pollRound = { messageId: state.activeMessageId, mapId: seen };"), "the round's map is noted only while it is not changing");
  assert.ok(guard.includes("scheduleNextMap(liveRotationIO, pick)"), "queued with the live rotation edit");
  assert.ok(guard.includes("liveAppliedMapId: pick"), "and the live tracker told what is standing there");
});

test("a vote that cannot open still moves the rotation on", () => {
  const open = section("--- no active poll → restore the parked one", "await ctl.sleep(MAPVOTE_POLL_MS);\n      }");
  assert.ok(open.includes('queueFallback("no vote could be composed")'), "too few options");
  assert.ok(open.includes('queueFallback("the vote could not be posted")'), "Discord refused or was down");
  assert.ok(open.includes("if (!ballot || !cfg.liveApply || !settled()) return;"), "mid-round, so only with live apply on");
  assert.ok(open.includes("fallbackOverReplay(ballot, why, cur.overrideMapId)"), "a standing override is queued over a random pick");
});

test("the map in play is read from the session alone, never the rotation", () => {
  const read = section("const readInPlay = async", "const queueOverReplay");
  assert.ok(!/rotation\s*:/.test(read), "no rotation fallback: it names the NEXT map once the vote has queued one");
  const compose = section("const composeBallot = async", "const fallbackOverReplay");
  assert.match(compose, /const inPlay = resolveCurrentMapId\(\{ session: normalizeSession\(rawSession\), catalogue \}\)/);
});

test("the live tracker never queues the round's own map either, and never a previous round's", () => {
  const live = section("--- keep the next map pointed at whatever is currently winning ---", "--- no active poll → restore the parked one");
  assert.ok(live.includes("{ exclude: roundMapOf(state) }"));
});

test("a dead session at a round end gets one reconnect and retry — never a loop on the same round end", () => {
  assert.ok(applySection().includes("if (isDeadSession(e) && reconnectedFor !== lastMatchEndAt) {"), "the apply goes out to the reconnect once per round end");
  assert.ok(noVoteEnd().includes("if (isDeadSession(e) && reconnectedFor !== lastMatchEndAt) { reconnectedFor = lastMatchEndAt; throw e; }"), "and so does the no-vote fallback");
  // Remembered across the reconnect: declared with the runner, not with the connection.
  const fn = src.indexOf("async function mapVoteServer(");
  const decl = src.indexOf("let reconnectedFor", fn);
  const connection = src.indexOf("const client = gameClientFor(server);", fn);
  assert.ok(fn > 0 && decl > fn && decl < connection);
});
