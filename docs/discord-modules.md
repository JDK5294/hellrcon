# Discord modules: the `/staff` panel and everything behind it

The staff side of Discord is a module system: `/staff` opens an ephemeral, paginated button panel,
each button a module. It runs on this codebase's spine — HTTP interactions instead of a gateway
process, panel capabilities instead of role lists, one registry that both first-party code and SDK
plugins feed.

## The shape

- **One slash command, and only one.** `/staff` renders the launcher: one button per module the
  invoker may open, decided per press from their linked staff account. Nothing else is a command
  — a second one would be a second surface to find, permission and register, when the panel
  already shows exactly what the presser is allowed to do. A read-only `/status` existed briefly
  and was removed: it was a worse copy of the Servers module, and public server status belongs on
  the posted status board, not behind a command.
  The name is a **setting**, not a literal — Discord hub → Setup & status → Slash command renames
  it, switches it off, and installs the change with a **Register command** button. The stored
  config (`discord_commands`) is what both the registration payload and the dispatcher read, so
  they cannot drift. `/staff` throughout this document means "whatever the command is called
  here".
- **Modules are registrations, not switch arms.** A module is `{ id, label, description,
  capability, open(), action?() }` in a registry. First-party modules register at startup;
  plugins register through the SDK's `discord` capability (`host.discord.registerModule`),
  namespaced by plugin id exactly like widgets. Unloading a plugin removes its modules.
- **Views are declarative.** A handler returns `{ content, rows }` — text plus button rows.
  The host converts that to Discord components, enforces Discord's limits, and appends its own
  **Back** row so every module screen can return to the launcher without the module knowing
  the launcher exists. Everything is ephemeral.
- **State lives in the `custom_id` or the database — never in process memory.** Restarting the
  API must not kill open panels.

## Identity and permission

A press carries the Discord user id. The host resolves it to a panel account
(`users.findByDiscordId`) and that account's effective grants (personal ∪ roles) — the same
`resolveAccess` every API request uses. A module renders on the launcher only if the invoker
holds its capability, and the capability is **re-checked on every interaction**: a button
rendered yesterday proves nothing about today. No linked account → the panel says so and stops.

This file covers the STAFF side. The public VIP panel (docs/vip-module.md) is a separate
launcher whose modules gate on linking rather than on capabilities; it reuses this routing.

## Help's drawing of it

The panel lives in Discord, where no screen of the panel's can show it, so the steps of Help's
walkthrough of it ("Do staff work from Discord") draw it in their pictures' place, and Show me on
my screen draws it over the person's screen (`GET /api/discord/staff-panel`, discord-preview.ts,
drawn by the panel's components/StaffPanelDrawing): the launcher and each module the
signed-in person may open, each module's opening screen drawn by its own `open()`. A module that
starts by picking a server (Maps & vote, Moderation) can also give `serverScreen(ev, serverKey)`:
the screen picking that server shows, drawn without doing anything — Moderation's is an empty
cart that is never kept, so nobody's cart in Discord is started or touched. Nothing else is
called: no `action()`, no press recorded, nothing posted, and Discord is never asked, so the
staff-role check Discord makes on every press is the one thing the drawing does not show. Each
step opens the drawing at its module, and at a server's screen where the module starts by picking
one, and rings the button it is about.

## The `custom_id` wire format

    sp:<moduleId>:<action>:<state>

- `sp:` marks the staff panel's ids; anything else is left for other surfaces.
- `moduleId` is `[a-z0-9_-]{1,32}`, or `<pluginId>.<moduleId>` for plugin modules (dot, not
  colon — the colon splits segments).
- `action` is `[a-z0-9_-]{0,24}`; empty means "open the module's root view".
- `state` is the remainder verbatim (it may contain colons); the module owns its meaning.
- The whole id must fit Discord's 100-character limit — the codec refuses anything longer at
  render time, where the bug is, instead of at press time, where it would be a dead button.
- `sp:home::` is the host's own Back/launcher id; `sp:home:page:<n>` pages the launcher.

## Slow work: defer, then follow up

Discord gives an interaction three seconds. A module that talks to a game server (the
registration code send, a roster read) declares `defer: true`; the host acknowledges with
DEFERRED_UPDATE_MESSAGE immediately, runs the handler, then edits the original message through
the interaction webhook (`PATCH /webhooks/<appId>/<token>/messages/@original`). Fast modules
(DB reads) respond in-band with UPDATE_MESSAGE, which is cheaper and leaves no "thinking…"
flicker.

Discord leaves a panel's buttons pressable while a deferred press runs, so the host holds the
panel: while one slow press is running on a message, another press there by the same person is
acknowledged and dropped (it never reaches the module, and is not recorded as an action), and the
running press's own answer lands a moment later. Other panels, and other people, are not held. A
hold lapses after two minutes, so a follow-up that never returns cannot lock a panel for good.
A module whose work must not run twice across panels guards that itself — the moderation cart is
taken the moment its volley starts firing.

## Discord rate limits: the budget a module lives on

Discord's REST budget is shared by everything the bot does — the relay, the events post, the
vote polls, the role sweep — so the panel is built to spend almost none of it, and a module must
keep it that way:

- **Modules never call Discord's REST API themselves.** A press costs one interaction callback
  (free of the bot's REST budget) plus, when deferred, one webhook PATCH. That is the whole
  per-press price, and it must stay the whole price.
- **Names come from the interaction payload** (`selectedNames`, the member object Discord signs
  into every press), never from member fetches. The user-select control is Discord searching its
  own guild — a member picker that costs us zero requests.
- **The host's per-press staff-guild check** is the one REST read on the press path; it runs
  through the shared limiter (`discordRest()`, interactive lane) and its definitive verdicts are
  cached for 30 seconds, so a multi-press flow (a moderation volley, the objectives walk) costs
  one member read, not one per press.
- **Posting into a channel** (an approval card, the public VIP panel) is one POST per *human
  decision*, never per line — the moderation panel files a whole volley as ONE request with ONE
  card — and always fire-and-forget, so a 429 or outage degrades to "no card", never to a failed
  action.
- Anything periodic (rosters, badges, role re-sync) belongs to the worker's sweeps on the
  `background` lane, where it yields to everything a person is waiting on.

## What this deliberately is not

- Not a gateway bot: no session, no privileged intents, no in-memory view objects.
- Not a second permission system: module access IS a panel capability.
- Not per-module config files: modules read the same stores the panel edits.
