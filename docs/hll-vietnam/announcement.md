# HLL: Vietnam — developer announcement (verbatim capture)

Captured 2026-08-07/08 from the Team 17 server-admin announcement channel, plus a follow-up from
the developer who published the RCON document. Reproduced here because the announcement carries
material the RCON PDF does not — notably the ID scheme and the fact that the `players` payload
changed shape.

Quoted as posted; our reading of it is in `docs/hll-vietnam.md`, not here.

## Tooling readiness (as announced)

- Community RCON: "Aims to deliver an update shortly before launch."
- One other third-party manager: "Aims to support the game immediately upon launch."
- Battlemetrics: "Aims to support the game within a few days after launch."

## ⚠ Player IDs are changing

> One major change that will affect every server admin is the jump to EOS IDs as primary player
> identifiers.
>
> In the original Hell Let Loose, we identify players using one of two identifiers:
>
> - A **Steam64ID**, if the player plays the game through Steam (eg. `76561234567890123`)
> - A hexadecimal string of 32 characters long, sometimes referred to as "Team17 ID" or
>   **"XPlay ID"** (eg. `1a2b3c4d5e6f78901a2b3c4d5e6f7890`)
>
> In Hell Let Loose: Vietnam, players will instead be identified by their **HLL:V EOS ID**,
> regardless of platform. This too is a 32-char long hex string, but can be characterized by its 4
> first characters, which are always `0002` (eg. `00021a2b3c4d5e6f78901a2b3c4d5e6f`).
> Note that EOS IDs are game-specific: Your HLL EOS ID and HLL:V EOS ID are **not** the same!
>
> A player's Steam64ID can still be found through RCON. XPlay IDs on the other hand, cannot.
>
> This has a few important implications:
>
> - Bans and VIPs cannot simply be copied over, as both games will use different IDs (Steam/XPlay
>   vs. EOS). You can find a player's EOS ID through RCON once the game goes live.
> - RCON tools will be unable to tell whether a non-Steam HLL:V player has also played HLL and vice
>   versa and will be forced to treat them as two distinct players (until manually linked).

## ⚙ RCON changelog

> - All instances of player IDs are now EOS IDs
> - Updated `GetServerInformation->players`: Removed `eosId`, added `steamId`.
> - Updated `SetSectorLayout`: Now takes a `MapId` argument and does not immediately restart the
>   current match.
> - Added `GetSectorLayout` and `RemoveSectorLayout`

## Follow-up from the document's author

> Should be mostly identical. There's some changes to the game layout commands (you can now
> set/get/remove layouts without immediately restarting the map). Of course the player info
> response has changed slightly as mentioned the other day.
>
> Not reflected in the document is that enums are formatted differently, which off of the top of my
> head only affects the `Platform` and `SupportedPlatforms` fields of various
> `GetServerInformation` responses.

That last line is the only known undocumented difference, and it is the kind that passes type
checks and produces wrong labels rather than errors. Treat `Platform` as unknown-shaped until a
live capture says otherwise.
