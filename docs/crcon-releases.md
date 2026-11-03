# What each CRCON release changed, and what we did about it

CRCON is the tool this project replaced, and it is still the best available reference for HLL's
domain facts — role ids, squad rules, log shapes — because it is maintained against the live game
by people running it at scale. We do not track it, port from it, or depend on it. We read it.

This file is the running log of that reading, so a release can be checked once and the conclusion
kept, rather than re-derived from source every time someone asks "did they change anything?".

**How to check a new release**

```
git clone --filter=blob:none https://github.com/MarechJ/hll_rcon_tool.git   # read only
cd docs/crcon-api && python3 extract.py <path-to-clone> > catalogue.json && python3 render.py
git diff docs/crcon-api            # the API surface, endpoint by endpoint
```

Then read `git log --no-merges --format=%s <previous-tag>..<new-tag>` in the clone for intent, and
check the three things below that we actually depend on.

**Watching for: HLL: Vietnam support.** It launches 2026-08-13 and our first community will run it alongside
HLL. We are deliberately not writing our game module from Team 17's PDF — when CRCON ships HLL:V,
their implementation becomes the verified baseline we build against. `docs/hll-vietnam.md` §6a has
the reasoning and the three specific things to read out of it; the most important is how they key
an HLL:V player, because that decision is irreversible once rows exist.

**What we depend on them for** — check these on every release:

| What | Where it lives in their tree | Why we care |
|---|---|---|
| HLL role ids | the `hllrcon` pip package, `hllrcon/data/roles.py` — CRCON pins it and resolves names through `Role.by_id()` | our `packages/games/src/hll.ts` descriptor |
| Squad-leader rule | `Rcon._has_leader` in `rcon/rcon.py` | our `squadLeaderRoles` |
| Bundled artwork | `assets/images/maps`, role and faction icons | `apps/panel/public/game/hll` |

---

## v12.0.0 / v12.0.1 — tagged 2026-08-13/14 (checked 2026-08-15)

The Vietnam release, formally. v12.0.0 is essentially the master we read yesterday — our
`4cf1e7e` read sits one day PAST the v12.0.0 tag and already contained six of v12.0.1's nine
fixes — so only three commits were genuinely new, and all three are one bug: **votemap and the
log loop were still wired to the WW2 layer parser for every game**, which is their announcement's
"(HLL:V) vote map does not show human-friendly names" and "maps are not being recorded". An
architecture hole our per-game descriptors do not have. API surface: 304 → 304, nothing moved.

**The real event is `hllrcon` 1.2.1 → 2.0.0**, which now pins BOTH games' role tables. Verified
against ours, table by table:

- **HLL:V roles** — ours (`packages/games/src/hllv/data.ts`) matches exactly: the 1–2 gap is
  real, mortar trio 13–15, helicopter crew 16–17, Commander at 20.
- **HLL:V squad leaders** — their `is_squad_leader` set is {Commander, Squad Leader, Tank
  Commander, Spotter, Observer, Logistics Officer}; ours is the same five minus Commander,
  excluded deliberately (the same line HLL draws). Verified, no change.
- **WW2 roles** — grew to 17 with Operator (15) and Gunner (16); ours already had both.
- **`_has_leader`** — still the WW2 four, and still WW2-only in their tree: for Vietnam it
  misses Squad Leader/Mortar Observer/Logistics Officer entirely, so their no-leader detection
  is broken on HLL:V. Do not copy; ours is per-game already.

**Domain facts worth keeping** from the v12.0.1 fixes (each checked against our code):

| Fact | Us |
|---|---|
| HLL:V reports offensive modes faction-prefixed: mapId `wdeve_offensiveus_day`, gameMode `"US Offensive"` / `"NVA Offensive"`. Their enum parse crashed the live view on every offensive round | our map inference already matches `offensiveus`/`offensivenva`; we display gameMode as a string and only use it squashed as a disambiguator — unaffected |
| hllrcon names Vietnam sides South/North; their team view bucketed on the raw string and rendered nothing | their abstraction's bug — the wire team is numeric, and ours resolves `Number(team)` against teamValues [1]/[2] + headcounts |
| During a map transition the session's map id and game mode do not update atomically | we take the map from the MATCH START log line itself, never from a racing gamestate read — unaffected |

**Still no Vietnam artwork** — `assets/images/icons/teams` remains exactly can/gb/ger/rus/us and
the map art is all WW2. Our name-only board fallback stays until art exists anywhere.

## master @ `4cf1e7e` — 2026-08-13 (checked 2026-08-14, one day after HLL:V launch)

A targeted read, not a release review: does CRCON have HLL: Vietnam artwork we should carry?

**No Vietnam artwork exists in their tree.** `assets/images/maps` still lists only the WW2
families; `assets/images/icons/teams` is still exactly `can/gb/ger/rus/us`; their own frontend
`FactionEnum` (rcongui_public `types/player.ts`) is still WW2-only. Nothing to take — our board
falls back to name-only sides until real Vietnam art exists anywhere.

**Vietnam support code landed** ahead of the artwork: `rcon/game/hllv/` (maps, roles, weapons,
profile) built on the `hllrcon` package's reference export — the same `data.hllv.json` dump our
descriptor uses — plus an alembic migration named `vietnam_support_steam_id_and_game`, which is
the §6a player-key question answered the way we answered it (platform id + a game dimension).
Their HLLV map catalog notes `hllrcon` does not preserve outdated map ids and deliberately never
falls back to the WW2 layer registry — the same isolation our per-game descriptors enforce.

Worth a fuller read when they actually tag a Vietnam release.

29 commits since v11.11.1 (2026-06-03). API surface: 298 → 304 endpoints, none removed.

**Nothing we depend on moved.** `hllrcon>=1.2.1.0` pinned identically, so the role table is
unchanged; `_has_leader` is still exactly `{officer, spotter, tankcommander, artilleryobserver}`;
our bundled Juno Beach art already matches their new files byte-for-byte, so their two Juno commits
(replacing a placeholder that was one image reused for all three times of day) were already in.

**Votemap rework** (#1064, ~2,300 lines) — the substantial change, and additive at the API:
`add_map_to_votemap`, `remove_map_from_votemap`, `add_votemap_vote`, `get_votemap_results`,
`send_votemap_reminder`, `set_votemap_winner`. Behaviour:

- multiple votes per player, weighted per flag (`vote_flags`), with a separate `vip_vote_count`
- players add a map to the selection from chat: `!vm add car offensive axis day`, defaults filling
  in the parts they leave out
- vote bans by flag, restrict voting to VIPs or to flagged players
- reminders on match start as well as match end
- `consider_environment_as_same_map` / `allow_multiple_maps_with_same_environment`

**Live stats collection** grew per-player detail we do not keep: `UnitHistoryEntry`
(`{ts, team, squad, role}` — squad and role over time), kill/death `encounters`,
`kills_by_type`/`deaths_by_type` by weapon class, a names list, `last_spawn`, and an
online/offline/idle status.

**Rate limiting** on auth and the public endpoints (new `django-ratelimit` dependency).

Housekeeping: naive `datetime.utcnow()` → timezone-aware `datetime.now(tz=UTC)` throughout, votemap
cache migrations, dependency bumps.

### What we took, and what we left

| Their change | Us |
|---|---|
| Role table, squad-leader rule | already matched — verified, no change |
| Juno Beach artwork | already had it |
| Rate limiting auth | **gap on our side** — `POST /api/auth/login` has no throttle, no attempt counter, no lockout, and no 429 anywhere in `apps/api/src`. Their adding it is a fair signal it matters for an internet-facing panel |
| Votemap rework | not taken. Real capability we lack, but a project rather than an afternoon, and our vote setup was rebuilt recently |
| Unit history | not taken. Cheapest of the three to copy in spirit — we already sample the roster every 15s, so recording squad/role transitions is a store plus a panel, and it answers "what squad were they in when this happened" |
| Everything else | theirs is a Django/React app and ours is not; the interesting part is the domain knowledge, not the code |
