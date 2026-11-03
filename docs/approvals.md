# Approvals: requests, signatures, and the builder

The staffing problem this solves: junior staff need to act, senior staff need oversight, and the
app must not become a second workflow anybody has to learn. The design collapses everything into
one idea — **lacking the permission IS the ask** — and lets the app itself be the request form.

## The model

**Asking needs no grant.** Any signed-in staff member who lacks a capability at write may open
the same dialog everyone else uses; the confirm button says "Send for approval" and the action
files as a request instead of executing (202: accepted, not performed). There is no separate
"Ask" permission level and no per-capability "askable" list — the matrix stays `inherit · Block ·
Read · Write`, and the fate of each line is computed from write at submit and at signing. (An
earlier design carried an Ask level between Read and Write; it was dropped when we noticed its
only job — deciding who may file — collapses to "everyone", because the write check already
decides everything else.)

**Who approves needs no configuration.** A requester files precisely because they lack write,
so whoever holds that capability at write on that server IS the senior tier for that action — the
ladder is the matrix itself, and a separate approver roster could only ever disagree with it.
`approvalRefusal()` states the whole rule: you only sign what you could do yourself, there. (An
earlier design also carried a per-role `canApprove` list; it was dropped when we noticed peer
approval is structurally impossible — someone at write never needs to ask, and someone without it
cannot sign.)

**Strict pre-approval.** Nothing gated executes without a signature; requests age out after 48
hours (worker sweep, audited) rather than lingering as cards nobody can act on. Nothing ever
auto-executes on expiry.

## Requests

**What can be asked for.** Everything a role can be granted — the owner's rule: everything a role
can see, it can request. Everything the panel does to a PLAYER (the server actions, VIP, the
watchlist, comments, linked accounts, tags, triggers, VIP timeouts), to a SERVER (map work and the
rotation, every map-vote control, seeding, the broadcast, the admin camera, the Discord relay, auto
settings, presets, the in-game settings, the raw console, its switches and its public page), to a
GROUP (members, VIP perks, bulk actions) and to the COMMUNITY (rules, zones, map sets, templates,
the shop and points, payouts and events, staff notices, roles and staff accounts, stored data). A
watch line carries no server on purpose — a
watch is a fact about a person and follows them to every server this community runs, which is why
`approvalRefusal` tests an unscoped line with `canAnywhere` (the same test its own route uses)
rather than demanding a global grant nobody holds.

**In the panel.** A screen's write controls are offered to whoever can see the screen, not only
to holders of its write permission — otherwise nothing on it could be asked for. They keep their
own names (a row of "Send for approval" buttons would no longer say which does what); one line,
`AskNotice`, says above them that a change is sent for approval, or added to the request being
built. Single confirms still name it on the button: the player menu, the Edit VIP dialog, a
player's flags and watch reasons, and "Ask to save as team default" on a layout.
The writes that never ask keep their write gate in the panel too: a server's RCON connection and
adding a server, the bot.db upload, the CRCON import.

Three mechanisms, for three shapes of action:

- **Player actions file a validated LINE.** The route checks every field first, so the payload an
  approver reads has already passed everything an executed action passes, and `executeApprovedLine`
  has a branch that knows how to run it.
- **Server-scoped writes file the CALL.** They all pass through one wrapper (`serverRoute`), so the
  wrapper is where they capture and file: method, path, query and body, stored as a `route` line
  with a plain-words label (`ROUTE_ASK_LABELS`, held to the route list by a test in both
  directions). Approving replays the same handler — the approver's grants for authority, the
  requester's account for the name on everything it writes — and a handler that refuses puts its
  own sentence on the line as `applyError`. The trade is that these are validated at APPROVAL
  rather than at filing; what it buys is the entire surface at once, and every route added later,
  with no second list to keep in step and no twenty-six branches in the executor.
- **Every other write files the CALL from inside.** A group, a rule, a role, the shop — writes about
  the community, or whose key depends on the body — cannot be gated at a door that knows one
  capability. So the handler's own refusal is the filing point: inside any write that can be asked
  for (`route()` marks them, carried on `request-scope.ts`), `sendForbidden` at write files the
  call with exactly the capability the handler found missing, at the scope it checked, instead of
  answering 403. That is also how a write asks for its SECOND key: adding someone to a VIP-perk
  group needs `player.groups` and then `vip.grant` on every server the perk covers, and the request
  asks for whichever one is missing. A line with no server is approved by anyone holding the
  capability anywhere — the same `canAnywhere` the community routes themselves use. Approving
  replays the handler with the signer's grants under the requester's name, and a replay's own
  refusals refuse (they never file again), landing on the line as `applyError`.
- **A filed call names its subject.** The path names it by id, so `ask-subject.ts` reads the names
  when the call is filed — the account, the group, the player, the rule, the roles and
  permissions a set becomes, and the players a call carries in its body (a list names its first
  ten and counts the rest) — and keeps them on the line (`payload.subject`). The queue, the
  Discord card and the trail print them ahead of the body, so nobody signs an id.
- **Names come from the app, not the call.** A call's `playerName` is whatever its sender put
  there, so a line's player is named as the directory knows them (`requests.ts`), and so is a
  player a subject names. A player the directory has never seen keeps the name the call gave, and
  a subject marks it as the request's own words. A Discord role is named by Discord when the bot
  can read the server's roles, never by the call's `discordRoleName`.
- **"Your own account" means the signer's too.** While a request is carried out the principal
  carries `signer`, and the guards that refuse acting on your own account (`ownAccounts` in
  `routes/kit.ts`) ask about both: a request naming the signer's account cannot delete it, merge
  it away or take their user-admin access, which the signer could not do to it by hand.

An open, unparked draft captures a write even from somebody who holds the permission — that is
what the bar promises on every screen while it is up. For the writes filed from inside, building
holds the caller's write grants back for the call, so the handler refuses at its first key and the
refusal is captured with that key; at submit the fate is decided on the real grants, and a line
that then stops at a second key the caller lacks goes for a signature asking for that key.

The writes that never ask are listed, each with its reason, in `NOT_ASKABLE` (held to the route
list by a test, so a new write cannot slip out without one): your own account and screens (there
is no permission to lack), the request system itself, anything carrying a password (a new account,
a password reset, a server's RCON connection — a request keeps its call to replay it, so the
password would sit in the queue in plain text), file uploads, previews, machine callbacks, the
owner's and the setup account's own controls, and the CRCON import. Profile notes, Discord links,
group membership and removing VIP time used to sit out as well; they ask like everything else.

A request is a bundle of **lines** (one action, one server, one capability each) in
`approval_requests`/`approval_lines` — durable rows, so a restart orphans nothing (state kept in
process memory would strand every pending card on a restart). Lines resolve
independently, each stamped with who decided it and when:

- **Approve** executes immediately, ON THE APPROVER'S AUTHORITY: their hour caps are what bound it.
  Execution failure is recorded on the line (`applyError`) — "approved but the server was down"
  must never read as done.
- **The action is the requester's, everywhere it is named.** The in-game notice is signed with the
  REQUESTER's name and the game gets them as `adminName` (`signerFor` takes a name, not only a
  principal, for exactly this); so do the executed `player.*`/`vip.*` audit row, the `player_bans`
  decision and the VIP grant, with `data.approvedBy`/`approvedByUserId` and `data.requestId`
  recording who authorised it and through which request. The player appeals to the person who
  handled their case, not to whoever happened to sign the form. The approver's own trail carries `request.approve` and
  nothing else. Crediting the approver (as this first shipped) filed every signature into their
  personal ban and kick counts, so the people who approve the most read as the people who moderate
  the most — and the moderator who found the player had nothing on their profile but a filing.
- **Deny** requires a reason on every surface; the requester reads it. That reason is what makes
  the queue coaching instead of a wall.
- **Approve all** is the same per-line decision in a loop: signs what THIS approver may sign,
  reports what it skipped.
- **The cascade.** A signature covers as much as the SIGNER's own authority reaches, and the
  remainder is filed onwards as a fresh `tempban_extend` request in the original requester's name.
  A 48h ask signed by a 24h-capped moderator applies 24h now and sends the other 24h up the chain;
  it used to dead-end at "approved, but not applied: your temp-ban limit is 24h", throwing away the
  authority they did have. A signer whose limit cannot advance the line at all is not offered it.
  A cap is a ceiling on the SENTENCE, not on each command: with 24 of 48 applied, NO 24h signer can
  advance it — not a second one, and not the same one once time has passed. Served time is
  deliberately absent from that calculation, because `served + cap` would let one patient moderator
  ratchet a ban to any length with nobody senior ever agreeing to it. It still governs EXECUTION
  (the game entry covers what is left to serve), just not who may authorise the sentence.
- **There is no never-yourself rule**, and the cascade is why: a signature can never reach past
  what its signer could do unilaterally, so a requester promoted between filing and signing may
  cover their own ask — up to their new authority, with anything beyond it still climbing. The old
  rule bought nothing and stranded exactly the case the feature exists for.
- **Approve-with-modification** (numeric fields only, only DOWN): recorded as requested→granted
  on the line. Granting more than asked would be a new action nobody requested.
- Two simultaneous decisions are settled by a conditional state transition in the store — one
  winner, one "already handled", never a double execution.

The filing path is the SAME route that would have executed the action: it runs every check an
execution runs, then lands in the queue instead of at the game (202: accepted, not performed).
So a line can never be garbage an approver has to debug.

## The record (all request history)

Filing and signing fall out of who you are — the requester sees theirs, a write-holder sees what
waits on them — so neither needs a permission. Reading the TEAM's finished work is a different
question, and the only thing here that is granted: `moderation.requests.history` (read-only) adds
an "All request history" panel listing every decided line, whoever filed it. One row per DECISION
rather than per request, because the questions it answers ("was that ban approved?", "who keeps
denying these?", "what did we decide about this player last month?") all sort by a column —
decided, outcome, action, player, server, asked by, signed by — with a free-text filter over the
same window. Drafts and still-open requests are excluded: scratch and live work are not history.
Note the builder's view ceiling reaches this page like any other read, so a community that does
not want builders browsing it caps them with the ceiling role.

## The builder (request mode)

"Build a request" (Moderation → Requests) flips the panel into a cart: same views, same dialogs,
confirm buttons become "Add to request", a pinned bar keeps the count — and NOTHING fires until
Review & submit. Each captured line is validated by its real route and stored in the user's one
server-side draft (a closed laptop loses nothing). At review, every line is badged with its fate:
lines the user holds at write **apply immediately on submit, under their own name** (stamped
`executed` — the cart is a cart, not a demotion); the rest are filed as one bundle. This is also
how staff learn the app: a trial mod with no write grants drives the real screens end to end.

## The builder's view ceiling

Building a request means browsing the surfaces it touches, which a requester's own grants may not
show. While a user HAS AN OPEN DRAFT — the server-verifiable form of "building a request" — their
READ view is elevated: everything readable by default, or capped at what a configured ceiling role
can see (`app-config.requestCeilingRoleId`, set under Administration → Users & roles — usually the
top approver role, so requesters see at most what the people signing for them see). The elevation
is read-clamped grants under their own source: it never satisfies a write check (submit fates and
signatures use real grants only), the ceiling role's explicit blocks stay invisible without ever
subtracting from the user's real grants, and a personal Block still hides everything. A dangling
ceiling fails closed (deleting the ceiling role is refused; a bogus id never stores).

Leaving the builder ends the widened view for real: "Save draft" PARKS the draft (kept, resumes
on the next "Build a request", but a parked draft confers no elevation) while "Exit" leaves
WITHOUT saving — the draft is dropped, after one warning naming Save draft as the alternative.
Every way out — save, exit, submit — returns the user to the page they were on before entering,
which their own grants could see by construction. Unsubmitted drafts nobody touches are deleted by the sweep
after `app-config.requestDraftTtlHours` (default 72; 0 = keep forever; measured from the last
capture/save/resume), so an abandoned cart cannot sit resumable-and-elevating forever.

## The over-cap temp ban split

A temp ban past the actor's own `tempban.maxHours` no longer 403s on a single server: it executes
AT the cap now (that much was always theirs to give) and files the remainder as a
`tempban_extend` line. Approval serves the FULL sentence in time actually banned — served = how
long the capped ban kept them out, remaining = requested − served at signing — by moving the SAME
`player_ban` decision's expiry (`setExpiry`; one sentence, never a ban/unban/ban zigzag) plus a
game entry for the remainder. Denial needs no rollback. An unban voids the extension: approving
after a deliberate release reports "nothing to extend" instead of quietly re-banning. Fan-out
bans keep the plain refusal — per-server remainders are a bundle for the builder, not a surprise.

## The Discord relay (optional, off by default)

`app-config.approvalsChannelId` (Discord hub → Approvals relay) + a bot token arm it; blank = off,
and the panel never depends on it. Each filed request posts a card that edits itself as lines are
decided, with two buttons: **Approve all I can** and **Deny…** (a modal demanding the reason).
A press resolves the presser through their linked staff account and flows through the same
`approveLine`/`denyLine` as the panel — one permission model, one audit trail, whichever surface
pressed it. Posts and edits are fire-and-forget: a Discord outage can never fail a filing or an
approval that already happened.

A card that ages out closes too. The expiry sweep runs in the WORKER, which has no business
knowing how a request is worded — so the card used to keep its ✋ and its working buttons on
something dead for days, answering "already expired" to anyone who pressed them. The API stores
the card's rendered text beside its message id (`pluginKv[APPROVALS_RELAY_KV_NS][requestId]`,
kept current on every edit so it reflects the lines already signed), and the sweep puts that text
back with a closing line under it and no components at all. A 404 from Discord — somebody deleted
the card — drops the reference rather than retrying forever.

## Audit vocabulary

`request.file` · `request.approve` · `request.deny` · `request.withdraw` · `request.expire`, plus
the executed action's own `player.*`/`vip.*` row naming the REQUESTER, with `data.requestId` and
`data.approvedBy` recording the request and who signed it.

Both rows the cascade writes are marked `data.continues` — the extension with the ban decision it
carries on, the follow-up filing with the request it carries on — so `countableActions` keeps them
out of the staff counts. A 48h ban that needed three signatures is ONE ban and ONE request on the
requester's record: the climb is about who may sign, not about how much anybody did. The trail and
the player's history still hold every row ("extended to 48h total"), and each says which decision
or request it continues.

Staff analytics counts every `request.*` verb as its own kind of work — `requests` on a staff
profile (`staff-analytics.ts`), `approvals` on the team page (`teamCategoryOf`) — so an approver's
numbers are their judgement calls, and the action they signed off is counted once, against the
requester, as the ban or grant it is.
