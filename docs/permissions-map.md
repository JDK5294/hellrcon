# The permission map

Every place the panel can show you something, and the permission that decides whether it does.

This exists because "is this gated?" was a question you had to answer by reading three files at
once, and because the answer turned out to be different at each of three layers. It is a map first
and a gap list second; the gaps are at the bottom, with what has to be decided before they can be
closed.

Sources of truth, all machine-checkable:

| Layer | Lives in | Decides |
| --- | --- | --- |
| 1. Destinations & tabs | `apps/panel/lib/routes.ts` (`caps`) | whether the nav offers it |
| 2. API endpoints | `can(...)` / `serverRoute(...)` in `apps/api/src/routes/*` | whether the data is served |
| 3. Panels & tables | `caps` on each `<Panel>`, resolved by `apps/panel/lib/panels.ts` | whether the block renders |

All three layers now have a registry and a test that fails the build when something declares
nothing. Layer 3's registry is new: the mechanism is in place and enforced, and the panels written
before it exist on a grandfather list that may only shrink. See "3. Panels and tables" below for
how many are left.

---

## 1. Destinations and tabs — 52 routes, 3 ungated

Every top-level destination and every tab declares the capabilities that reveal it. A test already
asserts containment: a capability on a tab must also appear on its parent, so no screen exists that
its holder can only reach by typing the URL.

| Destination | Tabs | Gate |
| --- | --- | --- |
| Dashboard | — | **none** — see below |
| Live | — | `server.view` |
| History | Game log, Matches, Admin camera, Map votes | `server.view` / `server.view` / `server.admins` / `mapvote.config` |
| Announcements | — | **none** — see below |
| Players | Directory, Leaderboard, VIPs, Groups | `server.view` ×2, `vip.grant`+`vip.revoke`, `player.groups` |
| Moderation | — (the ban record; the blacklist folded in) | `moderation.bans` |
| Maps | Vote, Rotation, Vote setup, Catalogue | `mapvote.config` / `server.view` / `mapvote.config` / `server.view` |
| Auto settings | Settings, Rules, Chat filter, Map zones, Seeding | `autosettings.profiles` / `admin.moderation` / `moderation.chatfilter` / `moderation.zones` (`admin.moderation` reads it) / `seeding.config` — its reward panel and payouts `seeding.rewards`, per server |
| Broadcast | — | `broadcast.config`, `action.message` |
| Discord | Setup, Relay, Sign-in | `discord.setup` / `discord.relay`+`community.edit` / `admin.users` |
| Analytics | 8 tabs | one capability each — none implies another |
| Administration | 13 tabs: Users & roles, Staff activity, Connections, Live settings, Broadcast, Console admins, RCON console, Templates, VIP presets, Data trim, Backup, System, Online access | one capability each (console + templates at **write**) |
| Settings | — | **none** — personal preferences |
| Match detail | — | `server.view` (hidden route) |

**The three ungated destinations, with verdicts:**

- **Settings** — correct. Personal display preferences; there is nothing to protect.
- **Dashboard** — correct as a destination. It is a container of tiles, and each tile is gated
  individually (`WIDGET_CAP` in `app/page.tsx`) so the page is only ever as revealing as its parts.
- **Announcements** — *deliberate, and worth re-confirming.* Any signed-in account can read the
  staff noticeboard; only `community.edit` can post. That is almost certainly right — a notice
  nobody can read is not a notice — but it is the one place where "signed in" is the whole check.

**Owner-only screens.** None of the panel's own screens is owner-only now (Administration → Map
points was, until it was removed), but a plugin's page can be. Such a row carries no `caps`, because
no capability is owner-only: every one can be given to a role, and the Administrator preset holds
all but one. It says `ownerOnly: true` instead, and the one shared predicate every nav surface asks
(`canOpenRoute` in `apps/panel/lib/routes.ts` — sidebar, sub-nav, command palette, Help) opens it
only for an owner: the **global** `*` grant at **write** (`isOwner` in `apps/panel/lib/access.ts`).
A `*` scoped to one server, the Administrator preset, and the request builder's read-level view
elevation all fail it. `apps/panel/test/routes.test.mjs` asserts the rule.

**View as (role preview).** Users & roles → View as narrows the panel's screens to the role
(`previewGrantsForRole`), and the API answers the preview's reads as the role too: the panel sends
`x-preview-role` on every request but the account's own `/me` (the live stream carries
`?previewRole=`), and `withRolePreview` in `apps/api/src/auth.ts` holds the caller's grants down to
the role's (`previewRoleGrants` in `@app/access`) — never past what the caller holds, server by
server. Only an `admin.users` reader is answered as a role; anyone else naming one is answered as
themselves, and a role that no longer exists answers with nothing. A write inside a preview is
refused (`requirePrincipal`), and setup-account-only answers (decommissioned servers, the update
notice) are not given to it. Narrowing only the screens left whatever a screen showed without asking
first — the dashboard's cards, the server list, the host figures — on the previewer's own access.

**Carved-off permissions (migration 156).** Three permissions each gave away a second job: the chat
filter and the zone sets rode the enforcer rules (`admin.moderation`), the seed reward rode seeding
(`seeding.config`), and the Discord bot's setup and online access rode user & role admin
(`admin.users`). Each job is its own key now — `moderation.chatfilter`, `moderation.zones`,
`seeding.rewards`, `discord.setup`, `admin.online` — and the upgrade gave every holder of an old key,
and every block on one, the same on its new keys, so nobody's access moved until a role is edited.
Two checks came with them. Switching the chat filter on, or changing what it does, also takes that
player action's own key somewhere, as an "any server" trigger does. A seeding save, or an applied
seeding setup, that changes the reward takes `seeding.rewards` at write on that server, and a reader
without it is sent the seeding config without the reward. The app-wide settings store answers per
field: its Discord fields (public server, approvals relay, badges) to `discord.setup`, the rest to
`admin.users`.

## 2. API endpoints — 201, all gated or intentionally open

Every endpoint either checks a capability or is deliberately open. The deliberate ones:

| Endpoint(s) | Why open |
| --- | --- |
| `/api/health` | liveness, no data |
| `/api/auth/*` (login, Discord start/callback/status) | pre-authentication by definition |
| `/api/me`, `PUT /api/me/prefs`, `/api/me/announcements-seen` | your own account |
| `/api/tokens` GET, `/api/tokens/:id` DELETE | seeing and revoking your own API tokens. Making one (POST) needs `api.tokens`, and a token works only while its maker holds it |
| `/api/games`, `/api/games/:id/descriptor` | game vocabulary (roles, factions); no instance data |
| `/api/community/announcements` + read/ack | see the Announcements verdict above |
| `/api/layout/:surface` GET | reading a layout; saving one needs `layout.edit` |
| `/api/discord/interactions` | Ed25519-verified webhook, not a user session |

Three endpoints resolve their capability **dynamically** and so cannot be found by grepping for
`can(`; all three were read by hand and are correctly gated:

- `POST /api/servers/:id/actions` — from `ADMIN_ACTIONS[action].cap`
- `POST /api/servers/:id/actions/bulk` — same table
- `POST /api/player-groups/:id/apply` — `capOf[action]`, and `canAnywhere` when the request says
  all-servers

`GET /api/presets` is the pattern to copy: it does not gate the request, it filters the *response*
per capability, so a caller sees exactly the presets they may see.

## 3. Panels and tables — 148 panels, all declared

This is the layer the audit was asked for. It had no mechanism at all: a panel rendered if its tab
rendered, some added their own ad-hoc condition, most did not.

**Both halves are now done — the mechanism, then the sweep.** Every `<Panel>` declares `caps`; the
prop is required, so the compiler stops you writing one without it, and
`apps/panel/test/panel-registry.test.mjs` proves the whole app is covered:

```tsx
<Panel id="notes" caps="player.notes" title="Notes">                    // one capability
<Panel id="overview" caps="open" title="Overview">                      // the tab's own gate is the whole answer
<Panel id="viphistory" caps={["vip.grant", "vip.revoke"]} …>            // any one of them is enough
<Panel id="grant" caps="vip.grant" capLevel="write" …>                  // a control, not a view
```

`"open"` is a real and common answer — 129 of the 148 give it. It has to be *said*, because in
source code "anyone may see this" and "nobody thought about it" must not look identical; that
indistinguishability is what let this layer drift in the first place. The other 19 name a
capability the page itself does not require.

Four things the test asserts beyond mere presence: the declaration is a literal (a registry you
cannot read without running the app is not a registry); every capability named exists in the
catalogue; a panel rendered down several branches — loading, empty, loaded — declares the same
thing on each, since a panel whose skeleton is visible to more people than its content is a leak
wearing a skeleton; and the grandfather list of unreviewed panels is empty and stays empty.

The gate is **display-gated** by construction (see decision 1 below): it hides the block, it does
not withhold the data. Anything that must not leave the server is data-gated at the API as well.
Declaring `caps` on a panel whose data is already withheld is still worth doing — it puts the
answer in the source next to the panel instead of in the name of a boolean two files away.

### What the sweep found

Six panels were showing something the page they sit on does not require. Every hub is a set of
tabs opened by *any* of several capabilities, and that is where all six came from: hold one of the
capabilities and you got the tab, and the tab gave you every panel on it.

| Panel | Was visible to | Now |
| --- | --- | --- |
| Staff profile → **Staff notices** | anyone with `staff.analytics` | `analytics.announcements` — **and data-gated**, see below |
| Discord → Relay & alerts → **Relay**, **Match board** | the tab opens on `discord.config` *or* `community.edit`, so a noticeboard poster saw the relay configuration | `discord.config` |
| VIPs → **Grant / extend VIP** | the tab opens on `vip.grant` *or* `vip.revoke`, so a revoke-only holder got the grant form and a 403 on submit | `vip.grant` at write |
| Maps → **Edit rotation**, **Objectives** | prop-gated at the call site only | `maps.control` at write |
| Broadcast → **Send now**, **Rotation** | prop-gated at the call site only | `action.message` / `broadcast.config`, both at write |
| Connections → **CRCON backup** | prop-gated at the call site only | `crcon.import` |

The prop-gated ones were not broken — they were correct because the *caller* remembered. Moving
the condition onto the panel makes it true wherever the panel is used, which is the difference
between a fix and a rule.

**Staff notices is the one that was actually leaking data**, so it got the full treatment. The
capability catalogue puts read rates, time-to-see and acknowledgements squarely under
`analytics.announcements` and says nothing about them under `staff.analytics` — yet
`GET /api/audit/staff/:userId` computed and shipped them to anyone who could open a staff profile.
It is a record about a named person, so by the rule in decision 1 it is now withheld from the
payload (`canViewNotices`), not merely hidden in the component.

### The player profile — CLOSED

The player profile is reachable with `server.view` — the Viewer role — and it gathers data that
each has its own gated page elsewhere. It was the back door into three of them.

*(An earlier draft of this table said moderation history was gated by nothing. That was wrong: it
was gated, by `staff.analytics`, which is the wrong capability rather than no capability. The row
below is the corrected one.)*

| Panel | Needs | Was | Now |
| --- | --- | --- | --- |
| Overview, Round performance, By server | `server.view` | tab | tab — correct |
| Moderation history | `moderation.bans` | `staff.analytics` | `canViewModeration`, data-gated |
| Ban status (the header badge) | `moderation.bans` | **nothing** | `canViewBans`, data-gated |
| Ban decisions (was: blacklist memberships) | `moderation.bans` | **nothing** | `banDecisions`, data-gated |
| VIP status | `vip.grant` | **nothing** | `canViewVip`, data-gated |
| Watch reason / by / history | `player.flags` | **nothing** | `canViewWatch`, data-gated |
| Notes | `player.notes` | `canViewNotes` | unchanged — this was the pattern |
| IP history | `player.ips` | own endpoint | unchanged |
| Activity, Match performance | `server.view` | tab | tab — correct |

Two judgements worth recording:

- **Moderation history moved from `staff.analytics` to `moderation.bans`.** staff.analytics answers
  "who on our team did what", a question about STAFF. This is the record of what was done to a
  PLAYER — the Bans page's data with kicks and punishes alongside. Anyone holding only
  staff.analytics loses this panel from the profile and keeps the Staff activity page it belongs to.
- **The watch MARKER stays; its provenance goes.** The 👁 is shown on the live roster to anyone who
  can see the roster, so hiding it on the profile would only make the two disagree. The reason, who
  set it and the full spell history are staff notes about a person, and go behind `player.flags`.

Staff profile, System, Trim and the analytics pages had the same shape — several panels behind one
tab-level gate. They have since been read panel by panel; see "What the sweep found" above.

---

## What has to be decided before this can be closed

**1. What does "every table has a permission" mean?** Two readings, and they cost very differently:

- *Display-gated*: the panel is hidden without the capability, but the data still arrives in the
  payload. Cheap, consistent, and honest about being a UI convenience — it is not a security
  boundary, because anyone can read the network response.
- *Data-gated*: the API omits the block and sends a flag saying it did, the way `canViewNotes`
  already works. More work per panel, and the only version that actually protects anything.

The recommendation is **data-gated for anything about a person** (moderation history, VIP grants,
notes, IPs, alias history) and **display-gated for everything else**, because that is where the
difference between "tidier screen" and "did not leak" actually lands.

**2. Should this be enforced, not just done?** ~~Layer 1 has a containment test and layer 2 has a
capability-coverage test; that is why both stayed correct. Layer 3 has neither, which is why it
drifted.~~ **Settled — enforced.** The panel registry is in, with the same shape as the other two
layers: a declaration on every `<Panel>` and a test that fails the build without one. Fixing the
panels once would have fixed today and nothing else; the 149th panel, written next month, would
have been undeclared again.

**3. Announcements.** Confirm that any signed-in account should read the noticeboard. If some
accounts should not, it needs a `community.view` capability, and that is a new catalogue entry
rather than a re-use. **Still open — a policy call, not a code question.** Note that the sweep
narrowed the two panels on that board that were never about reading it: composing a notice now
declares `community.edit` at write, and the jump links to the nudge settings and the read
analytics declare the capabilities of the things they link to.

## Order of work

1. ~~Move the person-data panels on the player profile to data-gating.~~ **Done** — ban status,
   ban decisions, VIP grants, watch provenance and moderation history, each behind the
   capability its own page uses, withheld from the payload rather than hidden in the component.
   Decision 1 above is therefore settled in practice for person data: **data-gated**.
2. ~~Introduce the panel registry + a coverage test — the mechanism, before the rest of the
   migration.~~ **Done** — `caps` on `<Panel>`, resolved by `lib/panels.ts`, enforced by
   `test/panel-registry.test.mjs`.
3. ~~Sweep the remaining hubs panel by panel against the registry.~~ **Done** — all 148 panels
   declare, the grandfather list is empty, and `caps` is now a required prop so the compiler
   catches the next one before the test does. Six real findings, in the table above; one of them
   (staff notice engagement) was withheld from the payload as well.
4. Announcements: confirm that any signed-in account should read the noticeboard, or add a
   `community.view` capability. **Still open — this one is a policy call, not a code question.**
