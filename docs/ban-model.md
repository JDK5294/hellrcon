# One ban system, not two

**Status: proposed.** Nothing in here is built. It deletes two tables and retires a page, so it is
written down before any of it happens.

## The problem

The app has two things that both mean "this person may not play", and staff cannot tell them apart —
which is how this started, with a fair question nobody in the project had a crisp answer to.

**A permanent ban is real.** `POST /api/servers/:id/actions` with `action: "permaban"` sends
`permaBanPlayer` over RCON and Hell Let Loose writes it into its own ban list. The player is kicked
and cannot reconnect. `GET /api/servers/:id/bans` reads `getPermaBans` back off the server, so the
Bans page shows the game's truth rather than a mirror of ours.

**A blacklist is a filing cabinet.** `blacklists` and `blacklist_records` hold a named list, a
reason, who added it and an optional expiry — and touch the game server never. Nothing checks a
blacklist when a player connects. The code says so plainly: the enforcer's blacklist action is
commented *"a DURABLE moderation record (not a live game ban)"*, and the Blacklist page's own
callout reads *"issuing the live ban is a separate, deliberate step"*.

That deliberate step was never built. There is no row action, no worker, nothing. So the blacklist
is a notebook that looks like a weapon: staff add a player, nothing happens, and the player keeps
playing. Calling it broken is correct.

The second half is the mirror image. `PlayerActions` offers "Add to blacklist", but its action list
has `unban_temp` and `unban_perma` and no un-blacklist, so clearing one means finding the record by
hand on the Blacklist page.

## Why the answer is to delete it rather than finish it

In CRCON a blacklist is the *source* of a ban, not a record of one: `create_blacklist` takes a
`sync` method (`BlacklistSyncMethod.KICK_ONLY` and friends), and `unblacklist_player` is documented
as *"Expires all blacklists of a player and unbans them from all servers"*. The list is the rule and
the game ban is its shadow. What it buys them, above all, is one ban decision reaching every server.

**We already have that.** `serverIds` on the four ban verbs does exactly this, and the reasoning is
already in the source: *"'Banned from the community' is what staff actually decide, but expressing
it meant repeating the same ban on each server in turn, and lifting it meant remembering to repeat
the unban — miss one and the player is quietly still banned somewhere nobody is looking."* Ours goes
to the real ban list instead of a mirror we would have to keep in sync.

So the blacklist's headline feature is redundant. Three things it does that our ban does not:

| | Covered? |
|---|---|
| One decision, many servers | **Yes** — `serverIds` fan-out, one audit row per server |
| **Servers added later** | **No.** `serverIds` is a snapshot of the servers that exist at ban time. Stand up a new server and every existing ban silently does not cover it |
| **Surviving the game server's own ban list** | **No.** The ban lives in HLL's file and we keep no copy of bans we issue (`crcon_ban` is only the imported archive). Rebuild or migrate a server and the bans go with it |
| An expiry between "24 hours" and "forever" | **No.** `tempban` takes hours; a blacklist record takes a date |
| Named reason categories, expired in bulk | **No.** Bans are a flat list with free-text reasons |

Two of those are small. Two are real. None of them needs a second system — they need the ban system
to be slightly more than a fire-and-forget RCON call.

### What this does NOT fix: HLL: Vietnam

Worth stating because it is the obvious hope and it is wrong. A standing rule cannot carry your HLL
bans onto a Vietnam server, and the fan-out code already explains why:

> Player ids do not cross games. A Hell Let Loose Steam64 means nothing to an HLL: Vietnam server
> (which keys everyone by its own per-game EOS id), so fanning a ban out to a different game's
> server would at best do nothing and at worst report success for a ban that never landed.

The route refuses cross-game fan-out with a `different game` error. There is no id to ban, so
nothing here helps. That is the identity-mapping problem in `docs/hll-vietnam.md`, and the decision
already recorded is to build it against CRCON's implementation once they ship HLL:V support.

**The "servers added later" gap is therefore about a new HLL server, not about Thursday.**

---

## The design

### 1. A ban's scope is a rule, not a list

This is the piece that makes everything else work, and it came out of a UI request: staff want to
say "banned everywhere except server 2" the way the map vote says "any map except these", rather
than ticking three boxes out of four.

That turns out to be more than convenience. **"All servers" and "these three servers" are different
kinds of statement**, and today both arrive as the same array of ids:

- `["#1","#2","#3"]` when the staff member meant *the community* — should cover #4 when it appears.
- `["#1","#2","#3"]` when the staff member meant *those three* — should not.

An exclusion mode makes the difference expressible, so the scope is stored as one of three shapes,
per game (ids do not cross games, so a rule cannot either):

```ts
type BanScope =
  | { mode: "servers"; serverIds: string[] }   // exactly these — a snapshot, no inheritance
  | { mode: "all" }                            // every server of this game, now and future
  | { mode: "except"; serverIds: string[] };   // every server of this game but these, now and future
```

`mode: "all"` is `except` with an empty list, but they are kept distinct because they read
differently in an audit summary and staff mean different things by them.

`ServerScopePicker` grows a three-way selector and emits a `BanScope` instead of `string[]`. The
existing `serverIds` request body stays accepted and maps to `{ mode: "servers" }`, so the group
bulk-apply path and any saved automation keep working unchanged.

### 2. A ban state table

The audit trail already records every ban: `player.permaban`, one row per server, with the reason,
actor and target. That is what the profile's moderation history and staff activity read, and it
stays exactly as it is.

It is not enough to reconcile from, for three reasons:

- It is an event log. "Is this player banned right now" means replaying every ban and unban per
  (player, server) and pairing them. Derivable, fragile, slow.
- It only sees the panel. A ban placed from the in-game console or straight over RCON never reaches
  our audit — a live read sees it, a replay does not.
- The imported CRCON history has its own action rows in its own shapes, so a replay has two
  dialects to understand.

**This is not hypothetical — the Bans page is that replay today, and it is quietly lossy.**
`GET /api/bans` builds its list from `audit.list({ limit: 500 })` filtered to ban actions, unioned
with the imported `crcon_ban` rows. It is not a live read (that is `/servers/:id/bans`). So the page
shows only the bans that fall inside the **last 500 audit entries of any kind** — on a busy week,
kicks and punishes and VIP grants push real bans off the end and they simply stop appearing. Nobody
has reported it because the imported CRCON rows are unbounded and keep the page looking populated.

A state table fixes the Bans page as a side effect of existing, which moves it up the value list:
this is not only reconciliation plumbing.

So: one small table for **intent**, written when the ban is issued.

```sql
CREATE TABLE player_ban (
  id            uuid PRIMARY KEY,
  game          text NOT NULL,              -- ids do not cross games; the scope rule is per game
  player_id     text NOT NULL,              -- platform id, as sent to the game
  player_name   text,
  kind          text NOT NULL CHECK (kind IN ('temp','perma')),
  reason        text NOT NULL,
  category      text,                       -- optional; what the blacklist's named lists were for
  scope         jsonb NOT NULL,             -- the BanScope above
  expires_at    timestamptz,                -- NULL = permanent. Covers the blacklist's date expiry
  created_by_user_id uuid,
  created_by_name    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  lifted_at     timestamptz,                -- set on unban; the row is kept
  lifted_by_name text
);
```

Rows are never deleted, so "banned, then unbanned, then banned again" is three facts in order — the
same reasoning as the watch history.

The Bans page keeps reading the game live. It is the truth about what the server is enforcing, and
this table is the truth about what staff decided. Showing them side by side is how a drift becomes
visible instead of silent.

### 3. Reconciliation

A worker runner, on the same footing as the VIP and console-admin sweeps: for each server, read the
game's ban list, compare against the active `player_ban` rows whose scope covers that server, and

- apply a ban the server is missing,
- lift a ban whose row is `lifted_at` or past `expires_at`,
- report — never silently fix — a ban present on the server with no row behind it. That is a ban
  placed outside the panel, which is legitimate; it wants surfacing, not deleting.

This is what closes both real gaps at once. A newly-added HLL server inherits every `all`/`except`
ban on its first pass, and a server whose ban list was lost gets it back.

The reconciler is the one genuinely risky piece in this document — it is a loop that issues bans —
so: dry-run by default behind a per-server switch, the same shape as the enforcer's dry-run, with
the intended actions written to the audit trail before any of it is armed.

### 4. Fold in what the blacklist was actually good for

- **`expires_at` as a date.** A ban until a fixed date, rather than hours of arithmetic. The action
  dialog gets the same three-mode control VIP already has (permanent / until / duration).
- **`category`.** An optional free-ish label — "cheating", "racism", "ban evasion" — so the question
  "who is on the cheat list" is a filter rather than a page, and a category can be expired in bulk.
  A named list was always a reason taxonomy wearing a table.

### 5. Retire the blacklist

- `Blacklist.tsx`, its route and tab, `moderation.blacklist` from the route registry.
- The `blacklist`/`unblacklist` kinds in `PlayerActions`, replaced by ban with a category.
- The enforcer's `blacklist` action becomes `permaban` with a category, so an auto-mod rule that
  used to file a record now actually bans — **a behaviour change that must be called out loudly in
  the release note**, because a rule that quietly did nothing will start doing something. Check the
  live rules before shipping it: a rule written expecting a no-op is the one thing here that could
  ban a real player by surprise.
- `blacklists` + `blacklist_records` tables, after migration.
- `moderation.blacklist` capability, after deciding what happens to anyone holding only it.

### 6. Un-ban parity

Wherever the ban action is offered — the action dialogs, the live roster, the profile — offer
lifting it, against the same scope. `unban_temp` and `unban_perma` already exist and already
fan out; they need to be reachable in the same places and to clear the `player_ban` row.

---

## Migration: seed from the game, not from our records

An earlier draft of this plan migrated `blacklist_records` into `player_ban` as lifted history. That
is the wrong source, and the reason is a fact about how the community this was first built for actually ran CRCON:

> **Everyone blacklisted on CRCON has a permanent ban applied as well.**

So the bans are already live, on the game servers, right now — and the game server's own ban list is
a better source than any record of ours. It is the truth, it needs no interpretation, and it does
not care which tool wrote it.

**Seed `player_ban` by reading `getPermaBans` and `getTempBans` from every connected server.** We
already do exactly this read for `GET /api/servers/:id/bans`, so it is a loop around an existing
call, run once as a bootstrap and safe to re-run.

Two consequences worth stating:

- **There is nothing to migrate out of the blacklist.** The records are duplicates of bans we are
  about to capture from a better source. The tables get dropped, not converted. The reasons and
  category names are worth keeping where the game's ban reason is thinner — that is a nicety to
  fold in during the seed by matching on player id, not a reason to keep the tables.
- **The reconciler's first pass is a no-op by construction.** State is seeded *from* reality, so
  there is nothing for it to apply. That removes most of the risk from step 5 — the dangerous
  version of a reconciler is one meeting a state table that was guessed at.

### The one judgement call in the seed

A ban read off server #1 becomes a row scoped `{mode:"servers",serverIds:["#1"]}` — that is exactly
what we know. But a player banned on *every* server almost certainly means "banned from the
community", and leaving them as three snapshot rows puts every existing ban outside the inheritance
the whole plan is for.

**Recommendation: collapse to `{mode:"all"}` when a player is banned on every server of that game,
and keep per-server rows otherwise.** It is an inference, but it is the right one — and it is
reversible in a click, because a staff member can narrow the row. The seed reports how many rows it
collapsed so the inference is visible rather than silent.

### What this retires

Both current sources for the Bans page go away, replaced by the state table:

- the `audit.list({ limit: 500 })` replay — with its truncation bug,
- `crcon_ban`, the imported CRCON ban archive, whose only live uses are that page and the
  Directory's `permaBanned=1` filter. Both move to `player_ban`.

The Directory's `blacklisted=1` filter becomes a filter on `category`.

That leaves **one** table answering "who is banned", seeded from the game, kept in step with it by
the reconciler, and readable without replaying anything. CRCON's remaining role is what the user
described: player history import, and nothing else.

## Open questions

1. **Does `except` need to survive a server being deleted?** If a ban is "all except #2" and #2 is
   removed, the rule silently widens to include nothing new — correct, but worth a note in the UI.
2. **Category: free text or a managed vocabulary?** Free text is one migration; a vocabulary is a
   table and an editor, and stops "Cheating"/"cheating"/"cheat" being three categories.
3. **Who inherits `moderation.blacklist`?** Anyone holding it and not `moderation.bans` loses a
   screen. Probably a one-line grant migration, but it is a decision.

## Order of work

All nine steps are DONE — this section keeps the shipped state and the deployment notes.

1. ✅ `BanScope` type + the three-way `ServerScopePicker`, `serverIds` still accepted. Panel + API,
   no schema change, no behaviour change.
2. ✅ Migration 020: `player_ban` table, both stores, repo methods, tests.
3. ✅ Write the row on ban, lift it on unban (rows are never deleted — `lifted_at` is stamped).
4. ✅ **Seed from the game.** `POST /api/bans/seed` (the "Adopt the game's bans" button on the Bans
   page) reads every connected server's ban list into `player_ban`, collapsing bans found on every
   server of a game to `{mode:"all"}`. Re-runnable and idempotent; reports what it inferred.
5. ✅ Bans page reads `player_ban` (with a lifted/expired history toggle); the Directory's
   perma-banned filter reads active decisions. The 500-audit-entry truncation bug is dead.
   `crcon_ban` survives as the CRCON import ARCHIVE only — it no longer feeds any page.
6. ✅ "Until a date" and category on the temp/perma ban dialogs, plus **Ban a player…** on the Bans
   page: a composer that takes a pasted platform id, so somebody who has never connected can be
   banned before they arrive. That was the one thing only the blacklist's add-by-id could do, and
   the ban record now does it for real — same route, same decision row, same scope rule.
7. ✅ The reconciler (`apps/workers/src/ban-reconcile.ts`), dry-run first: every 5 minutes it
   compares each server's live ban list to the covering decisions and audits the difference
   (throttled by a plan signature so a standing situation reports once). It only APPLIES on a
   server where both its `banSync` automation switch is on AND its "Fix what it finds" switch
   (`banSyncApply`, off by default) is on — both per server, under Administration → Connections →
   Automation. (This was a worker env flag, `BAN_RECONCILE_APPLY=1`, for every server at once; it
   is set in the app now.) Foreign bans (placed in-game or over raw RCON) are reported, never
   removed — the seed exists to adopt them. A ban (or lift) the server accepts and never carries
   out — an id it cannot act on answers 200 and changes nothing — is sent three sweeps running,
   then reported once and left alone, instead of being re-sent and re-audited every five minutes.
8. ✅ Un-ban parity: unban fans out over the same scope picker and lifts the decisions it reaches.
9. ✅ Blacklist retired: migration 021 rewrites `moderation.blacklist` grants to `moderation.bans`
   and drops both tables; the page, routes and capability are gone; the enforcer `blacklist`
   action now places a REAL ban (temp with rule hours, else permanent) scoped to the firing
   server, recorded as a decision with category `enforcer`.

### Deployment notes / release note

- **Run the seed once after deploying**, from Moderation → Bans, while all servers are reachable —
  it adopts every ban the game already enforces into the decision table.
- **The enforcer's `blacklist` rule action now really bans.** It used to file a record that never
  reached the game. Any rule using it will start banning players on the server the rule fires on:
  temp ban when the rule has hours, permanent when it does not. Review enforcement rules before
  deploying if that is not wanted.
- **Anyone who held only `moderation.blacklist` becomes a ban manager** (migration 021 rewrites
  the grant to `moderation.bans` at the same level).
- **The Blacklist page is gone**; old `/blacklist` links land on Moderation → Bans. The CRCON
  archive still pulls blacklist files (as history), but Apply-to-panel no longer imports them.
- **Ban sync ships observing, not acting**: the reconciler audits drift every 5 minutes. To let it
  fix drift on a server (apply covering decisions it is missing, lift the lifted/expired), turn on
  "Fix what it finds" under that server's "Ban reconciliation" automation switch (Administration →
  Connections → Automation). An install that armed it with `BAN_RECONCILE_APPLY=1` must switch it
  on there: the worker no longer reads that flag, so it reports until someone does.

Steps 1–6 were additive and reversible. Step 7 acts on a live server (hence the two-key arming).
Step 9 deleted data — by then a duplicate of what step 4 captured from the game itself.
