# Bulk payout

**Status: built**, except a Discord surface for it: the engine `@app/payout`, migrations 044/045
and both stores, the executor, the `/api/payouts` and `/api/payout-events` routes, and the panel's
Payouts tab under Players.

Paying a hundred people is its own job with its own audit trail, not a button on someone's profile.
Staff choose **who**, choose **what**, preview, optionally dry-run, and execute; every step is
recorded. Read `## The decisions` for why it is built the way it is.

**Event windows.** Each boundary of an event is either a hard time or **the next match boundary
at/after an anchor** — open with the first fresh round after 8pm (so the event doesn't slice into
the round already underway), close when the round being played at 11pm finishes (so it counts
whole). Events are creatable in advance for future times OR pointed at the past — presence is in
`player_sessions` regardless, so a retroactive window resolves on creation. The transition policy
is one pure function (`resolveEventBoundaries`/`sweepPayoutEvents` in `@app/payout`), applied both
by a worker timer and by the API's resolve-on-read, with status-guarded SQL so the two racing is
harmless. At close, the who-was-there roster is materialised onto the event row (the retention
caveat below), and paying the event applies its minutes floor by default.

Events then became their own panel category (owner request, 2026-08-21): the **Events hub**
(`#/events`) holds the schedule, the payouts, and a per-event **report** — analytics scoped to
the event's exact resolved window (attendance with per-player minutes and peak concurrency, the
rounds played inside it, kills summed across them; `GET /api/payout-events/:id/report`). Reading
events and reports is open to `analytics.server`/`analytics.match` holders as well as
`events.manage` and `economy.payout`.

Scheduling is its own capability, **`events.manage`** (added 2026-08-21 after an owner review of
the day's permissions). Both halves had shipped gated on `economy.payout`, which is the
trust-them-with-the-whole-float grant, so running Friday night implied being able to mint
currency for the community. It does not any more: `events.manage` write schedules and cancels,
`economy.payout` write pays, and the payout grant is still accepted for scheduling because it is
strictly the larger trust (no existing install loses the feature).

An event can also **pin one of its server's map-vote profiles while open** (`map_vote_profile`,
validated against the server's real profile list at creation): the vote worker composes from the
pinned pool instead of the schedule's choice, falling back to the schedule if the profile is
later renamed away. Pinning additionally requires **`mapvote.config` write on that server** —
deciding what everybody plays for the length of an event is the same power as editing the
profiles directly, and scheduling rights alone must not confer it. The panel hides the pin field
entirely without that grant rather than offering a control that can only 403. `analyticsWindow`
also learned explicit `?from=&to=` bounds, so any analytics page can be pointed at an arbitrary
window by URL.

**Editing a scheduled event** (owner request, 2026-08-24) — `PATCH /api/payout-events/:id`. Until
this existed the only way to move an event was to cancel it and schedule another, which loses the
audit thread and, once it had opened, the presence it had accrued. The rule is the event's status,
enforced in SQL rather than in the route because a staff edit and the sweep can land in the same
millisecond: **scheduled** takes every field; **open** keeps its resolved start and its server (the
event is already running there, from that instant) while the close time, name, minutes floor and
map pin still move; **closed/cancelled** refuses outright — a finished window is a record. The
window is re-validated as it will *stand*, the patch merged onto the stored row first, so a
one-field edit cannot leave the pair backwards. Audited with both sides.

**Posting the list to Discord** (owner request, 2026-08-24) — `POST /api/payout-events/post` sends
it now (`preview: true` returns the text without sending, which is what the panel shows), and
`GET`/`PUT /api/payout-events/post-config` hold a self-sending schedule: a channel, how many days
ahead to cover, a weekday (or every day) and a local time, in `event_post_config` (migration 059).
The message is built by `buildEventsPost` in `@app/payout` — pure, and shared by the button and the
worker's `postEventsList`, so the automatic post and a pressed one cannot drift. Every instant in
it is Discord's `<t:UNIX:STYLE>` markup: the community spans time zones, and a composed wall clock
would be right for whoever pressed the button and wrong for everyone else with nothing in the
message to say so. `dueEventsPost` decides "is it due, and for which local date"; the caller
latches that date, which is what makes a worker ticking every five minutes post once, and a worker
that was down at the appointed minute still post when it comes back the same day.

**Server and Payment columns on the events list** (staff request, 2026-10-13). The list named
neither, so finding an event still to pay meant matching Payouts history to events by date.
`GET /api/payout-events` now adds two fields to each item. `serverName` is the server's name
(the staff nickname when one is set), resolved from every server, retired ones included, so an
event keeps naming its server; it is null once the server has been deleted outright, and for anyone
but the setup account once it has been decommissioned (stage 2 takes a server away from every other
account, so its name is not printed to them; the panel says "a removed server"). `payment` is
`{state, unpaid, at}` or null when nobody has paid the event, worked out by `eventPayments` in
`@app/payout` from the runs made for it. `payouts.forEvents` returns those runs: each real
(non-dry-run) event payout, and every retry down its chain, followed by `sourceRef.jobId` so
retries recorded before `rootJobId` existed are found too. A payout stands where its latest run
left it, so `paid` means everyone its list named was reached (a run that failed some people and
was retried to the end is paid), `part` means its latest run left `unpaid` people still owed, and
`paying` means a run is going now. Dry runs never count. The field is a state and a count, never an
amount or a name: reading events does not take `economy.payout`. The panel shows the server after
the event's name, then the payment ahead of the status, so a phone shows both without scrolling. A
closed event with no payout reads **Awaiting payment** and a `part` one reads **Part paid** (both
flagged, since someone has to act), a closed one nobody attended reads "Nobody to pay" (a payout
would be refused for want of recipients), an open one with no payout reads "Not paid yet", and a
paid one shows when.

**No payout needed** (staff request, 2026-10-13). Some finished events are never meant to be paid
(a practice night, a scrim), and they said "Awaiting payment" forever: a closed event refuses
cancel, rightly, because it is a record and its report stays readable. `POST
/api/payout-events/:id/no-payout` with `{ noPayout: true }` marks a closed event as needing no
payout, and `false` takes the mark back. The mark is stored on the event as `no_payout_at` and
`no_payout_by` (migration 146; `payoutEvents.setNoPayout`, status-guarded to closed events in both
stores), so it is exported and restored with the event. It takes scheduling rights, the same as
cancel, because deciding not to pay spends nothing. It is reversible and audited
(`economy.payoutEvent.noPayout`), and a repeated press changes nothing and logs nothing. The panel
offers the button wherever the column says "Awaiting payment", shows "No payout needed" with who
marked it, and offers "Needs a payout" to undo. A payout made anyway still shows as the payout.

## How a payout works

Three ways to choose who:

| Source | How it picks people | What it is for |
|---|---|---|
| **filters** | every linked user, or only those online on a server now; then optionally narrowed to one Discord role | "everyone with the Donator role", "everyone on Main right now" |
| **event** | everyone present during an event's window, from recorded sessions (see decision 3) | "everyone who showed up to Friday night" |
| **retry** | the FAILED items of an earlier job — and, for one cut off by a restart, its unreached (PENDING) items | a payout that half-worked, finished without paying twice |

Then a type (`currency` or `vip`), an amount, and:

- **preview** — resolve the recipient list and show it. `execute` refuses without it.
- **dry run** — walk every recipient computing before/after without writing. Optionally mandatory.
- **execute** — walk the list, write each result as its own row, keep going past failures.

### What keeps it safe

These are the bits that make it safe rather than merely functional. Each one is here because a
bulk write to real balances and real VIP is not undoable:

0. **Receipts first, payments second.** Every recipient's row is written PENDING before anyone is
   paid, settled in place as the run reaches them, and the pacing pause comes after the receipt.
   A restart mid-run therefore leaves an INTERRUPTED job whose PENDING rows are exactly who it
   still owes; a re-run of it is refused (it would pay the reached twice), and its retry pays under
   the ROOT job's ref — currency is then idempotent by ledger ref, and a VIP server that already
   carries a grant under that ref is skipped — so the one person granted right before the cut is
   not granted again.
1. **Per-recipient rows, not a per-job summary.** `payout_items` stores one row per person with
   `status`, `error`, and `currency_before/after` + `vip_before/after`. That is what makes retry
   possible and what answers "did Dave actually get his 30 days".
2. **`duplicate_key`.** The payout's identity: (source, type, amount, servers, sorted recipient
   ids), stored readable and indexed by its md5 (the raw text outgrows a btree entry once a few
   hundred recipients are named). Held in memory while running AND checked against the table, so a
   double-click and a re-run after a restart are both refused. Without it the failure mode is
   paying everyone twice.
3. **Continue past failures.** One player's grant failing must not abandon the other ninety-nine.
   Final status is `COMPLETE` or `COMPLETE_WITH_FAILURES`.
4. **Deliberate pacing.** A pause between VIP grants (1.5 seconds by default). VIP writes go to the
   game server; a hundred back-to-back is a way to hurt a live server during an event.
5. **Progress that updates in place** every N recipients — a 200-person VIP payout takes minutes.

## The decisions

### 1. Where the engine lives — `packages/payout`, pure

A pure package: recipient resolution, duplicate key, preview/dry-run/execute planning. No Discord
types, no HTTP, no repo — it takes data and returns a plan. The API drives it, a Discord surface
would drive the same one, and it is unit-testable without a database.

*Why:* an engine that reaches into a Discord interaction for the guild, the actor and progress
rendering can only ever be driven from Discord. There are two front ends (panel + Discord) and a
third later is likely; the engine must not know.

### 2. The panel is the primary surface, Discord is the second

*Why:* a 200-row preview with per-person status is a table, and Discord makes tables badly. The
engine stays pure (decision 1) precisely so a Discord surface later is a thin driver, not a second
implementation.

### 3. Events come from recorded sessions

Event capture is built on `player_sessions`. **Checked, not assumed:**

- `roster_snapshots.composition` is aggregate only — counts by side and role, no player ids. It
  cannot answer "who". So the obvious source is out.
- `player_sessions` can: `(player_id, server_id, connected_at, disconnected_at, duration_sec)`,
  with a unique index on `(player_id, server_id, connected_at)`.

Sessions are exact intervals, which beats sampling who is online every few minutes and taking the
union: sampling never pays a player who joined and left between two samples, and counts one seen
once the same as one who stayed four hours. So:

- **you can pay out an event nobody remembered to open.** The sessions are already recorded.
- **"present for at least N minutes" is expressible** — a real control against someone joining for
  ninety seconds to collect.
- there is no capture loop, snapshot table or scheduler to run.

Two things to handle, both known rather than open:

- **`disconnected_at` is NOT NULL** — only CLOSED sessions are in the table, so a payout run
  *during* a live event must union the sessions with the current roster read. A payout run after
  the event needs only the table.
- **Retention.** Sessions age out with the trim policy, so materialise the resolved recipient list
  onto the payout event row when its window closes; the payout then outlives its evidence.

### 4. Currency and VIP go through the services we already have

The executor calls `shop.ts`'s existing grant paths, not new ones.

*Why:* `grantDays` already carries the permanent-VIP guard — a cumulative grant against a permanent
VIP returns null rather than downgrading it. A bulk path that wrote VIP itself would reintroduce
exactly that bug, ninety-nine times, silently. Same for the ledger: bulk currency must land in
`economy_ledger` like every other movement or the balances stop reconciling.

### 5. Every payout is an audit action

One audit row for the job (who ran it, source, type, amount, counts) plus the existing per-grant
audit each service already writes.

*Why:* our audit trail is the thing staff analytics reads. A payout that moved 4,000 currency
across 130 accounts and left no staff action would be the largest untracked write in the app.

### 6. Who a payout can reach

It follows from what each reward IS:

- **Currency is a Discord-account balance**, so a currency payout can only reach **linked users**.
  Not a policy preference — an unlinked player has no balance row to credit. The preview says how
  many candidates were dropped for being unlinked, so "why didn't Dave get paid" answers itself.
- **VIP is granted to a platform id on the game server**, so its audience is selectable:
  - **everyone** — every player the source produced, linked or not. Only meaningful with a
    presence source (online now / event window); "everyone in the directory" is refused rather
    than letting one typo VIP twelve thousand rows.
  - **linked users** — the source's players, filtered to those with a Discord link.
  - **role-specific** — filtered to linked users holding a given Discord role (a role is a
    Discord attribute, so role-specific implies linked).

## Data model

Two tables. Both server-scoped and trim-aware like the rest of the schema.

```
payout_jobs     id, server_id (nullable — currency is community-wide), source_type,
                source_ref, payout_type, amount, dry_run, status, requested_by,
                created_at, completed_at, total_count, success_count, failed_count,
                duplicate_key
payout_items    job_id, player_id, discord_user_id, display_name, status, error,
                currency_before/after, vip_before/after, created_at
```

- **`player_id`, with the Discord id beside it.** Identity here is player-first, with links.
- **`server_id` nullable.** VIP is per server; currency is community-wide.
- **No exports table.** A CSV is generated on demand from the items rather than written to a path
  and remembered.

Events: **no snapshot table** (decision 3) — a `payout_events` row is name + server + window + the
materialised recipient list once closed.
