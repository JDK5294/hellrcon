# CRCON native-feature parity audit

_Audited 2026-09-15 against the API inventory in `third_party/crcon/views.py` (the permission map
enumerates every `rcon_api.*` endpoint — the closest thing to a complete CRCON feature list) plus
the maps/scoreboards/multi-server modules. REFERENCE-ONLY: behaviour was compared, no code taken._

The short version: after the chat filter and in-game map voting landed, the remaining gaps are
few and mostly niche. Everything player- and moderation-facing that communities actually run
CRCON for has an equivalent here, usually a stronger one.

## Covered (equivalent or better)

| CRCON | Ours |
|---|---|
| kick/punish/message/temp+perma ban/unban, message_all_players | Moderation hub, Messages tab, group bulk actions; unbans verified against the game's own list |
| blacklists + records | Real ban records, cross-game, with evasion tripwire |
| watch/unwatch, flag, comments, player history | Watchlist v2 (multi-reason, expiry, history), tags, notes, per-player decision timeline |
| VIP add/remove/slots, expired VIP, seed VIP | VIP editor with until-dates, presets, calculators; seeding rewards (VIP + points) |
| votemap (whitelist, reminders, force winner, reset) | Map vote: schedules, pools, live-apply leader, reminders, force map, pause/skip/reroll — Discord poll **and now in-game chat-number voting** |
| profanities (the game censor) | **Chat filter tab**: one word list driving two managed enforcement rules AND the game censor |
| auto-mods: no leader, solo tank, level, seeding; name kick | The rules engine: same triggers plus chat/TK/idle/zones/weapons, ladders, exemptions, trial run, breaker |
| auto broadcasts, welcome message, standard message libraries | Broadcast module, Auto settings profiles, message templates |
| server settings (autobalance, idle kick, ping, queue, cooldown) | Auto settings profiles, by schedule or player count |
| Discord webhooks: kills/chat/admin ping/camera/watchlist/audit | Relay categories + alert rules (admin ping, watchlist joins, automation, server-dark) |
| camera notification | Admin-cam triggers, per-rule channels, paired history |
| scoreboard / scorebot / stats site | Public stats site, match reports, records, career pages — well beyond |
| team view | Live: the two teams side by side, squad by squad |
| historical logs, audit | History, Game log, Activity trail, CRCON import |
| multi-server forwarding | Community-wide rules, cross-game bans, group actions |
| permission model | Roles + capabilities + the approvals/request builder (richer) |

## Real gaps, ranked

1. **Player chat commands** (`chat_commands_config`): players type `!rules`, `!discord`, `!vip`
   and get an automatic reply. TODAY this is buildable one command at a time as a rule (chat
   trigger, match `^!rules$`, action *message*), but there is no command LIST screen and no
   shared library of replies. _Recommend: build — a small tab that manages message-action rules
   the way the chat filter manages its two._
2. **Votekick controls** (`votekick_enabled/thresholds/autotoggle`): the game commands are
   already on our wire (`setVoteKickEnabled`, `setVoteKickThreshold`, `resetVoteKickThreshold`)
   but no config surface uses them. CRCON's autotoggle (votekick on only above N players) maps
   exactly onto Auto settings' player-count profiles. _Recommend: build — add the fields to the
   profile schema._
3. **Watch-killrate** (`watch_killrate`): ping staff when someone's kills-per-minute is
   implausible (cheat triage). We record everything needed; no live alert reads it.
   _Recommend: build as a rules-engine state trigger with a Discord ping._
4. **Squad tools** (`disband_squad`, `remove_player_from_squad`): not on our wire at all —
   needs the v2 command mappings first, then Moderation buttons. _Recommend: probe the v2 wire
   (same path as the squad-lock investigation), then build if the game answers._
5. **TK ban on connect** (`tk_ban_on_connect`): auto-ban a team kill in the first moments after
   connecting. Notorious for false positives in CRCON. Our TK rules + ladders cover the policy
   without the connect-window nuance. _Recommend: skip unless asked again._
6. **Real VIP** (`real_vip_config`): dynamically shrink/grow VIP slot count with population.
   _Recommend: skip (niche); revisit if VIP queueing becomes a complaint._
7. **VAC/game-ban gate** (`vac_game_bans`, `steam_config`): auto-ban on Steam VAC history.
   Needs a Steam API key and never covers console players — half this community. _Recommend:
   skip; the ban-evasion tripwire covers the sharper edge of the same problem._
8. **Match/warmup timers, dynamic weather** (`set_match_timer`, `set_warmup_timer`,
   `set_dynamic_weather_enabled`): newer server knobs, not mapped on our wire. _Recommend:
   add as plain Auto settings fields when the wire mappings are confirmed._
9. **Live Discord scoreboard** (scorebot): an auto-updating embed with the running round's top
   players. Our status board shows server state, not per-player scores. _Recommend: optional —
   the public stats site already serves the need via link._

Webhook queue plumbing, log streams, `clear_cache` and CRCON's connection-settings screens are
infrastructure specific to CRCON's architecture, not features — no equivalents needed.
