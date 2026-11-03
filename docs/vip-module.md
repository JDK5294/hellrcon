# The VIP module: the public front door

## What this is

Every other surface in this project is for staff. This one is for **players**, and they reach it
through exactly one door: a message in Discord with a button on it. Public users get no panel
account, no Discord sign-in to the web app, no capability grants. They press a button, and from
that point on everything happens in an ephemeral Discord message only they can see.

That makes this module the community's identity system as well as its VIP shop, because linking a
Discord account to a game account is the first thing a player does here and everything else depends
on it.

Players touch it only in Discord. Everything staff-facing is a screen in the web panel.

## What players can do

1. **Link an account.** Prove they own a game account and attach it to their Discord identity —
   separately for Hell Let Loose and HLL: Vietnam.
2. **See their VIP.** Which servers, expiring when.
3. **Collect points** (under whatever name the community gives its currency, in Economy). A daily and a monthly claim, each of which can be opened to everyone
   (the default) or restricted to chosen Discord roles — boosters, patrons, members. A member who
   lacks the role is not shown the button at all. **Claiming needs no link**: the balance belongs
   to the Discord account. Linking is what a PURCHASE needs, because that is the moment VIP days
   have to reach a game account.
4. **Buy VIP** with points, from a small shop of offers.
5. **Gift VIP** to somebody else.

Staff do one thing in Discord: post the launcher message — from the app (Economy → VIP panel
launcher) or from the slash command's own **VIP launcher** module, which posts it into the channel
they ran it in. Everything else staff-facing — lookups, manual links, balance adjustments, shop
editing, the audit — is a screen in the web panel.

## Registration: how a player proves the account is theirs

1. Player picks a server from the ones we run.
2. The bot reads that server's **live roster** and shows it, paged and searchable.
3. Player picks themselves out of the list.
4. The bot sends a short numeric code **to that player, in game, over RCON**.
5. Player types the code into a Discord modal.
6. Verified — the link is written, and a one-time bonus of VIP days may be granted.

The welcome bonus belongs to the FIRST link, however it is made: this flow, staff linking a member
from the Discord staff panel, or staff linking them on the web panel's player page. All three pay
through one function whose key (the Discord account, or account + game with per-game on) is what
keeps it paid once — a link remade, moved, or made a second way pays nothing more. Links brought
over from an earlier bot (see the last section) are the exception: they arrive marked paid where
that bot had already paid them.

The proof is the point: you have to be on the server right now, and you have to be able to read a
message addressed to that specific player. No support ticket, no screenshot, no honour system.
Attempts are limited — three wrong codes, and a resend does not bring tries back while the code
they were spent on is still live — and a lockout points the player at a staff channel. One step
runs at a time per Discord account, so a double-click sends one code and a burst of guesses is
checked one by one.

**One link per game.** Player ids do not cross games — a Steam64 means nothing to a Vietnam
server, which keys everyone by its own per-game id — so one Discord account links to *one game
account per game*. The flow above runs once per game, the panel shows both, and a purchase names
the game it applies to. The `external_links` table is keyed `(player_id, provider)` with a lookup
index on `(provider, external_id)`, so one Discord id fans out to several player rows through a
plural lookup (`findPlayers`) and a per-game resolution helper.

## What it builds on

The module reuses what the panel already has:

- **VIP grants** — per server, cumulative extension, absolute expiry or duration, pause, presets,
  full history. A purchase is "add N days on these servers", which is a call we already make.
- **Player identity** — player rows, name history, per-game platform ids, the link table.
- **Live roster reads and in-game messaging** — steps 2 and 4 of registration, already routed and
  engagement-mode guarded.
- **Audit trail** — every write attributed, per server, already surfaced on profiles and Activity.
- **Discord plumbing** — signed interactions endpoint, replay window, REST sink, name resolution.
- **Storage** — Postgres with migrations.

## How it works

### 1. Members and the ledger

The economy's subject is the **Discord user**, not a panel account (public users have none) and not
a player row (a person may have two, one per game, or none yet — you can hold a balance before you
link anything).

```
community_member   discord_id PK, discord_name, balance, created_at, updated_at
economy_ledger     id, discord_id, delta, reason, ref, actor, created_at
```

Append-only ledger, cached balance on the member row, both written in one transaction. The ledger
is the truth and the reason every balance can be explained; the column exists so the panel does not
sum a million rows to draw a number. Caps are enforced on write: clamp, don't reject.

### 2. Claims

Daily and monthly, each a random amount inside a configured band, each with its own cooldown. A
claim is a ledger row like any other; the cooldown is derived from the last claim of that kind
rather than stored separately, so there is no second thing to keep in sync. **Claiming needs no
link** — the balance belongs to the Discord account.

### 3. The shop

Offers are `{ id, label, points, days, scope }` — editable in the web panel rather than a JSON
file on disk. **The scope is the decision the panel configures**: an offer applies to one server,
a chosen set, or all servers, and the Discord panel simply renders one button per enabled offer.
A community that sells VIP per server creates "Two Weeks · #1" and "Two Weeks · #2"; one that
sells it community-wide creates a single "Two Weeks" scoped to all — the buttons follow the
configuration instead of being hardcoded either way.

**Every purchase is confirmed before it spends anything** (owner request, 2026-08-22). Pressing an
offer opens a screen naming the currency, the offer and the price, saying plainly that purchases
are non-refundable, and offering Confirm or Cancel; only the Confirm button buys. Points take weeks
to accumulate and a purchase genuinely cannot be undone — the VIP days land on a game server
immediately and the economy has no return path — so a row of primary-styled buttons where one press
was final produced mistakes that reached staff as refund requests nobody had a button for. The
confirmation re-checks that the offer still exists, is still enabled, and is still one the recipient
can receive, because the panel is ephemeral but sits open indefinitely.

A purchase:

1. takes an idempotency key (a Discord double-click is not two purchases),
2. checks the balance,
3. debits,
4. grants the VIP days through the existing grant path on every server the offer's scope covers,
5. and on failure **credits back with a visible ledger row**, never a silent rollback.

Gifting is the same transaction with a different recipient and no special limits of its own.
**Every purchase and every gift requires the receiving account to be linked** — for a purchase
that is the buyer, for a gift both the giver and the recipient — because a grant lands on a game
id, and an unlinked member does not have one to land on.

### 4. The Discord surface

Two entry points, and they are different kinds of thing:

- **The launcher** — a permanent message with a button, posted by staff, pressable by anyone. Its
  `custom_id` is static, so it survives restarts and redeploys. Posting a second one makes a second
  working launcher rather than breaking the first, which is why both posters ask before firing.
- **The panel** — everything after that press, ephemeral and per-user: status, claim, buy, gift,
  link. The root ALWAYS shows the reader their balance and VIP; being unlinked removes the buttons
  that need a game account (buy, gift) and adds the one that fixes it, rather than replacing the
  screen with a locked door.
- **The roster picker** is a dropdown, not a grid of name buttons. A full server is ~100 names;
  as buttons that is four rows a page, which fills Discord's five-row budget and leaves nothing
  for paging — the first cut shipped exactly that and stranded people on page 1 of 5.
  Anyone in the Discord can open it, so it names players by an opaque token and the platform in
  words ("Steam (PC)", "PlayStation"), never by platform id — an option's value reaches the
  reader's client even though Discord does not draw it. The token's key lives for the process: a
  list drawn before a restart answers "pick yourself again".

We speak HTTP interactions, not the gateway, so there are no in-memory view objects: state lives in
the `custom_id` or in the database. That is more deliberate per screen and strictly better in one
way — a restart does not kill an open panel. Anything that takes longer than three seconds (a
roster read, an RCON message, a grant) defers first and follows up. The module registry, component
routing and defer/follow-up are `docs/discord-modules.md`; this module is their first real
consumer.

### 5. Staff, in the web app

Lookup, manual link, unlink, balance adjustment with a reason, shop editing, claim/cap settings
(including which roles a claim is for), purchase and gift history, the audit. Each behind a capability, on a page, using the same tables —
the Discord side keeps only the launcher.

## Bringing over an earlier bot's data

Economy → **v4 cutover import** takes an earlier Discord bot's SQLite file (`bot.db`) directly and
imports what carries over: Discord↔game links (with provenance), currency balances (as
opening-balance ledger rows, so day one is explainable like every day after), and registration
state. Run it at conversion time, not before — two systems must never both be authoritative. It is
re-runnable, converging instead of duplicating, like the CRCON apply.

## Decisions

1. **Linking is the ticket to spend.** Claims need no link — the balance belongs to the Discord
   account — but a purchase requires the buyer linked, and a gift requires both parties linked.
   Nothing lands on a game server until you have.
2. **Offer scope is configuration, not code.** Each offer names the servers it covers (one, a
   set, or all); the Discord buttons render from that. Nothing about "per server" or
   "community-wide" is hardcoded.
3. **Gifting has its own switches and its own ceiling** (revised — this started as "no gift cap",
   which turned out to be two decisions wearing one hat):
   - **Gifting VIP is a switch of its own.** Selling VIP is not consent to it changing hands, so
     the Gift VIP button renders from `vipGifting.enabled`, not from "the shop has offers".
   - **Currency gifts have a minimum AND a maximum per gift** (`gifting.minAmount` /
     `gifting.maxAmount`, the maximum blank = uncapped). The ceiling bounds ONE gift — a brake on
     a fat finger and on funnelling a whole balance in a single press — not a daily allowance.
4. **Balances from an earlier bot come in through the import** (the section above), never by hand
   and never early.
