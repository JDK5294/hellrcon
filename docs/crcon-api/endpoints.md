# CRCON endpoints (generated)

> Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool —
> Copyright (c) 2020 Julien Marechal. MIT License; full text in `third_party/crcon/LICENSE`.

Every one is `/api/<name>`. 304 endpoints, extracted from the CRCON source
with `ast` — see `docs/crcon-api.md` for the envelope, auth and how to read this table.

`auto` endpoints are registered from `ENDPOINT_PERMISSIONS` in `rconweb/api/views.py` and
wrap a method on `ServerCtl`/`Rcon`/`RconAPI`, so they have a real typed signature.
`manual` ones are Django views listed in `rconweb/api/urls.py`; they take the raw request,
so the module is given instead of a signature.

| Endpoint | Verbs | Permission | Signature → returns | Notes |
|---|---|---|---|---|
| `add_admin` | POST | `api.can_add_admin_roles` | (player_id, role, description) → `bool` |  |
| `add_blacklist_record` | POST | `api.can_add_blacklist_records` | (player_id: str, blacklist_id: int, reason: str, expires_at: datetime \| None = None, admin_name: str = '') → `BlacklistType` | Adds a new record to a blacklist. |
| `add_map_to_rotation` | POST | `api.can_add_map_to_rotation` | (map_name: str, after_map_name: str \| None = None) → `None` |  |
| `add_map_to_votemap` | POST | `api.can_add_map_to_votemap` | (map_name: str) |  |
| `add_map_to_votemap_whitelist` | POST | `api.can_add_map_to_whitelist` | (map_name: str) |  |
| `add_maps_to_rotation` | POST | `api.can_add_maps_to_rotation` | (map_names: list[str]) | Add the given maps to the rotation, returns the game server response for each map |
| `add_maps_to_votemap_whitelist` | POST | `api.can_add_maps_to_whitelist` | (map_names: Iterable[str]) |  |
| `add_message_template` | POST | `api.can_add_message_templates` | (title: str, content: str, category: str \| MessageTemplateCategory, by: str) → `int` | Add a new message template and return the ID of the new record |
| `add_vip` | POST | `api.can_add_vip` | (player_id: str, description: str, expiration: str \| None = None) → `bool` | Adds VIP status on the game server and adds or updates their PlayerVIP record. |
| `add_votemap_vote` | POST | `api.can_add_votemap_vote` | (player_id: str, player_name: str, map_name: str, vote_count: int \| None = None) |  |
| `ban_profanities` | POST | `api.can_ban_profanities` | (profanities: list[str]) → `bool` |  |
| `clear_cache` | POST | `api.can_clear_crcon_cache` | () → `bool` | Clear every key in this servers Redis cache and return number of deleted keys |
| `create_blacklist` | POST | `api.can_create_blacklists` | (name: str, sync: BlacklistSyncMethod = BlacklistSyncMethod.KICK_ONLY, servers: Sequence[int] \| None = None) | Creates a new, empty blacklist. |
| `delete_blacklist` | POST | `api.can_delete_blacklists` | (blacklist_id: int) | Removes a blacklist alongside all of its records. |
| `delete_blacklist_record` | POST | `api.can_delete_blacklist_records` | (record_id: int) → `bool` | Removes a blacklist record. |
| `delete_message_template` | POST | `api.can_delete_message_templates` | (id: int) → `bool` | Delete a specific message template |
| `describe_admin_pings_discord_webhooks_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_audit_discord_webhooks_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_auto_broadcasts_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_auto_mod_level_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_auto_mod_no_leader_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_auto_mod_seeding_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_auto_mod_solo_tank_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_camera_discord_webhooks_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_camera_notification_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_chat_commands_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_chat_discord_webhooks_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_expired_vip_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_kills_discord_webhooks_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_log_line_webhook_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_log_stream_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_name_kick_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_rcon_chat_commands_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_rcon_connection_settings_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_rcon_server_settings_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_real_vip_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_scoreboard_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_seed_vip_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_server_name_change_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_standard_broadcast_messages` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_standard_punishments_messages` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_standard_welcome_messages` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_steam_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_tk_ban_on_connect_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_vac_game_bans_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_votekick_autotoggle_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_votemap_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_watch_killrate_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `describe_watchlist_discord_webhooks_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `disband_squad` | POST | `api.can_disband_squad` | (team_index: int, squad_index: int, reason: str) → `None` |  |
| `disband_squad_by_name` | POST | `api.can_disband_squad` | (team_name: str, squad_name: str, reason: str) |  |
| `do_service` |  | `` | — | (rconweb/api/services.py) |
| `download_vips` |  | `` | — | (rconweb/api/vips.py) |
| `edit_blacklist` | POST | `api.can_change_blacklists` | (blacklist_id: int, name: str = MISSING, sync_method: BlacklistSyncMethod = MISSING, servers: Sequence[int] \| None = MISSING) | Edits a blacklist. |
| `edit_blacklist_record` | POST | `api.can_change_blacklist_records` | (record_id: int, blacklist_id: int = MISSING, reason: str = MISSING, expires_at: datetime \| None = MISSING) → `bool` | Edits a blacklist record. |
| `edit_message_template` | POST | `api.can_edit_message_templates` | (id: int, title: str \| None, content: str \| None, category: str \| MessageTemplateCategory \| None, by: str) → `None` | Add a new message template and return the ID of the new record |
| `edit_player_account` | POST | `api.can_edit_player_account` | (player_id: str, name: str \| None = None, discord_id: str \| None = None, is_member: bool = False, country: str \| None = None, lang: str = 'en') | Update PlayerAccount fields for the given player_id. All fields can be updated, including setting them to null. Returns dict with account data and success message. |
| `edit_player_soldier` | POST | `api.can_edit_player_soldier` | (player_id: str, name: str \| None = None, level: int = 0, platform: str \| None = None, clan_tag: str \| None = None, eos_id: str \| None = None) | Update NULL fields only in PlayerSoldier for the given player_id. Does not overwrite any existing non-null values. Returns the updated soldier as dict or None if not found. |
| `flag_player` | POST | `api.can_flag_player` | (player_id: str, flag: str, player_name: str \| None = None, comment: str \| None = None) → `PlayerFlagType` | Adds a new flag to the specified player_id |
| `get_admin_groups` | GET | `api.can_view_admin_groups` | () → `list[str]` |  |
| `get_admin_ids` | GET | `api.can_view_admin_ids` | () → `list[AdminType]` |  |
| `get_admin_pings_discord_webhooks_config` | GET | `api.can_view_admin_pings_discord_webhooks_config` | () → `AdminPingWebhooksUserConfig` |  |
| `get_all_discord_webhooks_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `get_all_message_templates` | GET | `api.can_view_message_templates` | () → `AllMessageTemplateTypes` | Get all message templates by category |
| `get_all_standard_message_config` |  | `` | — | (rconweb/api/user_settings.py) |
| `get_all_webhook_queues` | GET | `api.can_view_webhook_queues` | () → `list[str]` |  |
| `get_audit_discord_webhooks_config` | GET | `api.can_view_audit_discord_webhooks_config` | () → `AuditWebhooksUserConfig` |  |
| `get_audit_logs` |  | `` | — | (rconweb/api/audit_log.py) |
| `get_audit_logs_autocomplete` |  | `` | — | (rconweb/api/audit_log.py) |
| `get_auto_broadcasts_config` | GET | `api.can_view_auto_broadcast_config` | () → `AutoBroadcastUserConfig` |  |
| `get_auto_mod_level_config` | GET | `api.can_view_auto_mod_level_config` | () → `AutoModLevelUserConfig` |  |
| `get_auto_mod_no_leader_config` | GET | `api.can_view_auto_mod_no_leader_config` | () → `AutoModNoLeaderUserConfig` |  |
| `get_auto_mod_seeding_config` | GET | `api.can_view_auto_mod_seeding_config` | () → `AutoModSeedingUserConfig` |  |
| `get_auto_mod_solo_tank_config` | GET | `api.can_view_auto_mod_solo_tank_config` | () → `AutoModNoSoloTankUserConfig` |  |
| `get_auto_settings` |  | `` | — | (rconweb/api/auto_settings.py) |
| `get_autobalance_enabled` | GET | `api.can_view_autobalance_enabled` | () → `bool` |  |
| `get_autobalance_threshold` | GET | `api.can_view_autobalance_threshold` | () → `int` |  |
| `get_ban` | GET | `api.can_view_player_bans` | (player_id: str) → `list[GameServerBanType]` | get all bans from player_id @param player_id: steam_id_64 or windows store ID of a user @return: a array of bans |
| `get_bans` | GET | `{'api.can_view_temp_bans', 'api.can_view_perma_bans'}` | () → `list[GameServerBanType]` |  |
| `get_blacklist` | GET | `api.can_view_blacklists` | (blacklist_id: int) → `BlacklistWithRecordsType` | Get a blacklist and its respective records. |
| `get_blacklist_records` | GET | `api.can_view_blacklists` | (player_id: str = None, reason: str = None, blacklist_id: int = None, exclude_expired: bool = False, page_size: int = 50, page: int = 1) |  |
| `get_blacklists` | GET | `api.can_view_blacklists` | () → `list[BlacklistType]` | Get all blacklists. |
| `get_broadcast_message` | GET | `api.can_view_broadcast_message` | () → `str \| bytes \| None` | Returns the current broadcast message if the cache is set |
| `get_camera_discord_webhooks_config` | GET | `api.can_view_camera_discord_webhooks_config` | () → `CameraWebhooksUserConfig` |  |
| `get_camera_notification_config` | GET | `api.can_view_camera_config` | () → `CameraNotificationUserConfig` |  |
| `get_chat_commands_config` | GET | `api.can_view_chat_commands_config` | () |  |
| `get_chat_discord_webhooks_config` | GET | `api.can_view_chat_discord_webhooks_config` | () → `ChatWebhooksUserConfig` |  |
| `get_date_scoreboard` | GET | `api.can_view_date_scoreboard` | (start: int, end: int) |  |
| `get_detailed_player_info` | GET | `api.can_view_detailed_player_info` | (player_id: str, player: GetPlayersType \| None = None) → `GetDetailedPlayer` |  |
| `get_detailed_players` | GET | `api.can_view_detailed_players` | () → `GetDetailedPlayers` |  |
| `get_expired_vip_config` | GET | `api.get_expired_vip_config` | () → `ExpiredVipsUserConfig` |  |
| `get_gamestate` | GET | `api.can_view_gamestate` | () → `GameStateType` | Returns player counts, team scores, remaining match time and current/next map |
| `get_historical_logs` | GET, POST | `api.can_view_historical_logs` | (player_name: str \| None = None, player_id: str \| None = None, action: str \| None = None, limit: int = 1000, from_: datetime \| None = None, till: datetime \| None = None, time_sort: Literal['desc', 'asc'] = 'desc', exact_player_match: bool = False, exact_action: bool = True, server_filter: str \| None = None) |  |
| `get_historical_logs_csv` |  | `` | — | (rconweb/api/history.py) |
| `get_idle_autokick_time` | GET | `api.can_view_idle_autokick_time` | () → `int` |  |
| `get_ingame_mods` | GET | `api.can_view_ingame_admins` | () → `list[AdminUserType]` |  |
| `get_kills_discord_webhooks_config` | GET | `api.can_view_kills_discord_webhooks_config` | () |  |
| `get_live_game_stats` |  | `` | — | Return stats for the currently playing match (rconweb/api/scoreboards.py) |
| `get_live_scoreboard` |  | `` | — | Return stats for all currently connected players (stats are reset on disconnect, not match start) (rconweb/api/scoreboards.py) |
| `get_log_line_webhook_config` | GET | `api.get_log_line_webhook_config` | () → `LogLineWebhookUserConfig` |  |
| `get_log_stream_config` | GET | `api.can_view_log_stream_config` | () |  |
| `get_logs` | GET | `api.can_view_game_logs` | (since_min_ago: int, filter_: str = '', by: str = '') → `list[str]` | Returns raw text logs from the game server with no parsing performed |
| `get_map` | GET | `api.can_view_current_map` | () → `Layer` |  |
| `get_map_history` |  | `` | — | (rconweb/api/scoreboards.py) |
| `get_map_rotation` | GET | `api.can_view_map_rotation` | () → `GetMapRotation` |  |
| `get_map_scoreboard` |  | `` | — | (rconweb/api/scoreboards.py) |
| `get_map_sequence` | GET | `api.can_view_current_map_sequence` | () → `GetMapSequence` |  |
| `get_map_shuffle_enabled` | GET | `api.can_view_map_shuffle_enabled` | () → `bool` |  |
| `get_maps` | GET | `api.can_view_all_maps` | () → `list[Layer]` |  |
| `get_max_ping_autokick` | GET | `api.can_view_max_ping_autokick` | () → `int` |  |
| `get_message_template` | GET | `api.can_view_message_templates` | (id: int) → `MessageTemplateType \| None` | Return the message template for the specified record if it exists |
| `get_message_template_categories` | GET | `api.can_view_message_templates` | () → `list[MessageTemplateCategory]` |  |
| `get_message_templates` | GET | `api.can_view_message_templates` | (category: MessageTemplateCategory) → `list[MessageTemplateType]` | Get all possible message type categories |
| `get_name` | GET | `api.can_view_server_name` | () → `str` |  |
| `get_name_kick_config` | GET | `api.can_view_name_kick_config` | () → `NameKickUserConfig` |  |
| `get_next_map` | GET | `api.can_view_next_map` | () → `Layer` | Return the next map in the rotation as determined by the gameserver through the gamestate command |
| `get_objective_rows` | GET | `api.can_view_current_map` | () → `List[List[str]]` |  |
| `get_online_mods` | GET | `api.can_view_online_admins` | () → `list[AdminUserType]` |  |
| `get_own_user_permissions` |  | `` | — | (rconweb/api/auth.py) |
| `get_perma_bans` | GET | `api.can_view_perma_bans` | () → `list[GameServerBanType]` |  |
| `get_player_comments` | GET | `api.can_view_player_comments` | (player_id: str) → `list[PlayerCommentType]` |  |
| `get_player_ids` | GET | `api.can_view_playerids` | (as_dict = False) → `dict[str, str] \| list[tuple[str, str]]` |  |
| `get_player_info` | GET | `api.can_view_player_info` | (player_id: str, can_fail = False) |  |
| `get_player_messages` | GET | `api.can_view_player_messages` | (player_id: str) |  |
| `get_player_profile` | GET | `api.can_view_player_profile` | (player_id: str, num_sessions: int = 10) → `PlayerProfileTypeEnriched \| None` |  |
| `get_players` | GET | `api.can_view_get_players` | () → `list[GetPlayersType]` |  |
| `get_players_history` | GET, POST | `api.can_view_player_history` | (page: int = 1, page_size: int = 500, last_seen_from: datetime \| None = None, last_seen_till: datetime \| None = None, player_id: str \| None = None, player_name: str \| None = None, blacklisted: bool \| None = None, is_watched: bool \| None = None, exact_name_match: bool = False, ignore_accent: bool = True, flags: str \| list[str] \| None = None, country: str \| None = None) |  |
| `get_previous_map` |  | `` | — | (rconweb/api/scoreboards.py) |
| `get_profanities` | GET | `api.can_view_profanities` | () → `list[str]` |  |
| `get_queue_length` | GET | `api.can_view_queue_length` | () → `int` |  |
| `get_rcon_chat_commands_config` | GET | `api.can_view_rcon_chat_commands_config` | () |  |
| `get_rcon_connection_settings_config` | GET | `api.can_view_rcon_connection_settings_config` | () → `RconConnectionSettingsUserConfig` |  |
| `get_rcon_server_settings_config` | GET | `api.can_view_rcon_server_settings_config` | () → `RconServerSettingsUserConfig` |  |
| `get_real_vip_config` | GET | `api.can_view_real_vip_config` | () → `RealVipUserConfig` |  |
| `get_recent_logs` | GET, POST | `api.can_view_recent_logs` | (filter_player: list[str] \| str = [], filter_action: list[str] = [], inclusive_filter: bool = True, start: int = 0, end: int = 10000, exact_player_match: bool = True, exact_action: bool = False) → `ParsedLogsType` |  |
| `get_round_time_remaining` | GET | `api.can_view_round_time_remaining` | () → `float` | Returns the amount of time left in the round as seconds |
| `get_scoreboard_config` | GET | `api.can_view_scorebot_config` | () → `ScoreboardUserConfig` |  |
| `get_scoreboard_maps` |  | `` | — | (rconweb/api/scoreboards.py) |
| `get_scorebot_config` | GET | `api.can_view_scorebot_config` | () → `ScorebotUserConfig` |  |
| `get_seed_vip_config` | GET | `api.can_view_seed_vip_config` | () → `SeedVIPUserConfig` |  |
| `get_server_list` |  | `` | — | (rconweb/api/multi_servers.py) |
| `get_server_name_change_config` | GET | `api.get_server_name_change_config` | () → `GtxServerNameChangeUserConfig` |  |
| `get_server_settings` | GET | `{'api.can_view_team_switch_cooldown', 'api.can_view_autobalance_threshold', 'api.can_view_autobalance_enabled', 'api.can_view_idle_autokick_time', 'api.can_view_max_ping_autokick', 'api.can_view_queue_length', 'api.can_view_vip_slots', 'api.can_view_votekick_enabled', 'api.can_view_votekick_threshold'}` | () |  |
| `get_services` |  | `` | — | (rconweb/api/services.py) |
| `get_slots` | GET | `api.can_view_player_slots` | () → `SlotsType` | Return the current number of connected players and max players allowed |
| `get_standard_broadcast_messages` | GET | `api.can_view_standard_broadcast_messages` | () → `StandardBroadcastMessagesUserConfig` |  |
| `get_standard_punishments_messages` | GET | `api.can_view_standard_punishment_messages` | () → `StandardPunishmentMessagesUserConfig` |  |
| `get_standard_welcome_messages` | GET | `api.can_view_standard_welcome_messages` | () → `StandardWelcomeMessagesUserConfig` |  |
| `get_status` | GET | `api.can_view_get_status` | () → `StatusType` |  |
| `get_steam_config` | GET | `api.can_view_steam_config` | () → `SteamUserConfig` |  |
| `get_structured_logs` | GET | `api.can_view_structured_logs` | (since_min_ago: int, filter_action: str \| None = None, filter_player: str \| None = None) → `ParsedLogsType` |  |
| `get_team_objective_scores` | GET | `api.can_view_team_objective_scores` | () → `tuple[int, int]` | Returns the number of objectives held by the allied/axis team respectively |
| `get_team_switch_cooldown` | GET | `api.can_view_team_switch_cooldown` | () → `int` |  |
| `get_team_view` | GET | `api.can_view_team_view` | () |  |
| `get_temp_bans` | GET | `api.can_view_temp_bans` | () → `list[GameServerBanType]` |  |
| `get_tk_ban_on_connect_config` | GET | `api.can_view_tk_ban_on_connect_config` | () → `BanTeamKillOnConnectUserConfig` |  |
| `get_vac_game_bans_config` | GET | `api.can_view_vac_game_bans_config` | () → `VacGameBansUserConfig` |  |
| `get_vip_ids` | GET | `api.can_view_vip_ids` | () → `list[VipIdType]` |  |
| `get_vip_slots_num` | GET | `api.can_view_vip_slots` | () → `int` |  |
| `get_vips_count` | GET | `api.can_view_vip_count` | () → `int` |  |
| `get_votekick_autotoggle_config` | GET | `api.can_view_votekick_autotoggle_config` | () → `AutoVoteKickUserConfig` |  |
| `get_votekick_enabled` | GET | `api.can_view_votekick_enabled` | () → `bool` |  |
| `get_votekick_thresholds` | GET | `api.can_view_votekick_threshold` | () → `list[list[int]]` |  |
| `get_votemap_config` | GET | `api.can_view_votemap_config` | () → `VoteMapUserConfig` |  |
| `get_votemap_results` | GET | `api.can_view_votemap_status` | () |  |
| `get_votemap_status` | GET | `api.can_view_votemap_status` | () |  |
| `get_votemap_whitelist` | GET | `api.can_view_map_whitelist` | () → `list[str]` |  |
| `get_watch_killrate_config` | GET | `api.can_view_watch_killrate_config` | () |  |
| `get_watchlist_discord_webhooks_config` | GET | `api.can_view_watchlist_discord_webhooks_config` | () → `WatchlistWebhooksUserConfig` |  |
| `get_webhook_queue_overview` | GET | `api.can_view_webhook_queues` | (queue_id: str) → `webhook_service.QueueStatus \| None` |  |
| `get_webhook_service_summary` | GET | `api.can_view_webhook_queues` | () | Return the overall status of the service |
| `get_welcome_message` | GET | `api.can_view_welcome_message` | () |  |
| `is_logged_in` |  | `` | — | (rconweb/api/auth.py) |
| `kick` | POST | `api.can_kick_players` | (player_id: str, reason, by, player_name: str \| None = None) → `bool` |  |
| `login` |  | `` | () |  |
| `logout` |  | `` | () |  |
| `message_all_players` | POST | `api.can_message_players` | (message: str) → `bool` |  |
| `message_player` | POST | `api.can_message_players` | (player_id: str, message: str = '', by: str = '', save_message: bool = False, player_name: str \| None = None) → `bool` |  |
| `perma_ban` | POST | `{'api.can_perma_ban_players'}` | (player_id: str, reason = '', by = '', player_name: str \| None = None) → `bool` |  |
| `post_player_comment` | POST | `api.can_add_player_comments` | (player_id: str, comment: str, by: str) |  |
| `punish` | POST | `api.can_punish_players` | (player_id: str, reason: str, by: str, player_name: str \| None = None) → `bool` |  |
| `reconnect_gameserver` |  | `` | () |  |
| `remove_admin` | POST | `api.can_remove_admin_roles` | (player_id) → `bool` |  |
| `remove_all_vips` | POST | `api.can_remove_all_vips` | () → `bool` |  |
| `remove_map_from_rotation` | POST | `api.can_remove_map_from_rotation` | (map_name: str) |  |
| `remove_map_from_votemap` | POST | `api.can_remove_map_from_votemap` | (map_name: str) |  |
| `remove_map_from_votemap_whitelist` | POST | `api.can_remove_map_from_whitelist` | (map_name: str) |  |
| `remove_maps_from_rotation` | POST | `api.can_remove_maps_from_rotation` | (map_names: list[str]) |  |
| `remove_maps_from_votemap_whitelist` | POST | `api.can_remove_maps_from_whitelist` | (map_names: Iterable[str]) |  |
| `remove_match_timer` | POST | `api.can_remove_match_timer` | (game_mode: str) |  |
| `remove_perma_ban` | POST | `api.can_remove_perma_bans` | (player_id: str) → `bool` | Remove a perma ban by ban log. Note that a player ID is a valid ban log. |
| `remove_player_from_squad` | POST | `api.can_remove_player_from_squad` | (player_id: str, reason: str) → `None` |  |
| `remove_temp_ban` | POST | `api.can_remove_temp_bans` | (player_id: str) → `bool` | Remove a temp ban by player ID or game server ban log |
| `remove_vip` | POST | `api.can_remove_vip` | (player_id) → `bool` | Removes VIP status on the game server and removes their PlayerVIP record. |
| `remove_warmup_timer` | POST | `api.can_remove_warmup_timer` | (game_mode: str) |  |
| `reset_all_webhook_queues_for_server_number` | POST | `api.can_change_webhook_queues` | (server_number: int \| str) → `int` | Delete each queue associated with the specified server number |
| `reset_map_votemap_whitelist` | POST | `api.can_reset_map_whitelist` | () |  |
| `reset_votekick_thresholds` | POST | `api.can_reset_votekick_threshold` | () → `bool` |  |
| `reset_votemap_state` | POST | `api.can_reset_votemap_state` | () |  |
| `reset_webhook_message_type` | POST | `api.can_change_webhook_queues` | (message_type: webhook_service.WebhookMessageType \| str) → `int` | Delete each queue of wh_type (discord, etc.) returning the number of deleted queues |
| `reset_webhook_queue` | POST | `api.can_change_webhook_queues` | (queue_id: str) → `bool` | Delete the specified queue; returning if it deleted any entries |
| `reset_webhook_queue_type` | POST | `api.can_change_webhook_queues` | (webhook_type: webhook_service.WebhookType \| str) → `int` | Delete each queue of wh_type (discord, etc.) returning the number of deleted queues |
| `reset_webhook_queues` | POST | `api.can_change_webhook_queues` | () → `int` | Delete each queue; unprocessed messages may be lost depending on timing |
| `send_votemap_reminder` | POST | `api.can_send_votemap_reminder` | () |  |
| `set_admin_pings_discord_webhooks_config` | POST | `api.can_change_admin_pings_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_audit_discord_webhooks_config` | POST | `api.can_change_audit_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_auto_broadcasts_config` | POST | `api.can_change_auto_broadcast_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_auto_mod_level_config` | POST | `api.can_change_auto_mod_level_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_auto_mod_no_leader_config` | POST | `api.can_change_auto_mod_no_leader_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_auto_mod_seeding_config` | POST | `api.can_change_auto_mod_seeding_config` | (by: str, user_config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_auto_mod_solo_tank_config` | POST | `api.can_change_auto_mod_solo_tank_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_auto_settings` |  | `` | — | (rconweb/api/auto_settings.py) |
| `set_autobalance_enabled` | POST | `api.can_change_autobalance_enabled` | (value: bool) → `bool` |  |
| `set_autobalance_threshold` | POST | `api.can_change_autobalance_threshold` | (max_diff: int) → `bool` |  |
| `set_broadcast` | POST | `api.can_change_broadcast_message` | (message: str) → `str` | Set the in game broadcast message and return the previous message if set |
| `set_camera_discord_webhooks_config` | POST | `api.can_change_camera_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_camera_notification_config` | POST | `api.can_change_camera_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_chat_commands_config` | POST | `api.can_change_chat_commands_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_chat_discord_webhooks_config` | POST | `api.can_change_chat_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_dynamic_weather_enabled` | POST | `api.can_set_dynamic_weather_enabled` | (map_name: str, enabled: bool) |  |
| `set_expired_vip_config` | POST | `api.can_change_expired_vip_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_game_layout` | POST | `api.can_change_game_layout` | (objectives: Sequence[str \| int \| None], random_constraints: GameLayoutRandomConstraints = GameLayoutRandomConstraints(0)) |  |
| `set_idle_autokick_time` | POST | `api.can_change_idle_autokick_time` | (minutes) → `bool` |  |
| `set_kills_discord_webhooks_config` | POST | `api.can_change_kills_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_log_line_webhook_config` | POST | `api.can_change_log_line_discord_webhook_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_log_stream_config` | POST | `api.can_change_log_stream_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_map` | POST | `api.can_change_current_map` | (map_name: str) → `None` |  |
| `set_map_rotation` | POST | `{'api.can_add_map_to_rotation', 'api.can_remove_map_from_rotation', 'api.can_view_map_rotation'}` | (map_names: list[str]) |  |
| `set_map_shuffle_enabled` | POST | `api.can_change_map_shuffle_enabled` | (enabled: bool) → `None` |  |
| `set_match_timer` | POST | `api.can_set_match_timer` | (game_mode: str, length: int) |  |
| `set_max_ping_autokick` | POST | `api.can_change_max_ping_autokick` | (max_ms) → `bool` |  |
| `set_name_kick_config` | POST | `api.can_change_name_kick_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_profanities` | POST | `{'api.can_view_profanities', 'api.can_ban_profanities', 'api.can_unban_profanities'}` | (profanities: list[str]) → `list[str]` |  |
| `set_queue_length` | POST | `api.can_change_queue_length` | (value: int) → `bool` |  |
| `set_rcon_chat_commands_config` | POST | `api.can_change_rcon_chat_commands_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_rcon_connection_settings_config` | POST | `api.can_change_rcon_connection_settings_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_rcon_server_settings_config` | POST | `api.can_change_rcon_server_settings_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_real_vip_config` | POST | `api.can_change_real_vip_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_scoreboard_config` | POST | `api.can_change_scorebot_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_seed_vip_config` | POST | `api.can_change_seed_vip_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_server_name` | POST | `api.can_change_server_name` | (name: str) |  |
| `set_server_name_change_config` | POST | `api.can_change_server_name_change_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_standard_broadcast_messages` | POST | `api.can_change_standard_broadcast_messages` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_standard_punishments_messages` | POST | `api.can_change_standard_punishment_messages` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_standard_welcome_messages` | POST | `api.can_change_standard_welcome_messages` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_steam_config` | POST | `api.can_change_steam_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_team_switch_cooldown` | POST | `api.can_change_team_switch_cooldown` | (minutes: int) → `bool` |  |
| `set_tk_ban_on_connect_config` | POST | `api.can_change_tk_ban_on_connect_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_vac_game_bans_config` | POST | `api.can_change_vac_game_bans_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_vip_slots_num` | POST | `api.can_change_vip_slots` | (value: int) → `bool` |  |
| `set_votekick_autotoggle_config` | POST | `api.can_change_votekick_autotoggle_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_votekick_enabled` | POST | `api.can_change_votekick_enabled` | (value: bool) → `bool` |  |
| `set_votekick_thresholds` | POST | `api.can_change_votekick_threshold` | (threshold_pairs: list[tuple[int, int]]) |  |
| `set_votemap_config` | POST | `api.can_change_votemap_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_votemap_whitelist` | POST | `api.can_set_map_whitelist` | (map_names: Iterable[str]) |  |
| `set_votemap_winner` | POST | `api.can_set_votemap_winner` | (map_name: str) |  |
| `set_warmup_timer` | POST | `api.can_set_warmup_timer` | (game_mode: str, length: int) |  |
| `set_watch_killrate_config` | POST | `api.can_change_watch_killrate_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_watchlist_discord_webhooks_config` | POST | `api.can_change_watchlist_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `set_welcome_message` | POST | `api.can_change_welcome_message` | (message: str) → `str` | Set the in game welcome (rules) message and return the previous message if set |
| `switch_player_now` | POST | `api.can_switch_players_immediately` | (player_id: str) → `bool` |  |
| `switch_player_on_death` | POST | `api.can_switch_players_on_death` | (player_id, by) → `bool` |  |
| `temp_ban` | POST | `api.can_temp_ban_players` | (player_id: str, duration_hours: int = 2, reason: str = '', by: str = '', player_name: str \| None = None) → `bool` |  |
| `unban` | POST | `{'api.can_remove_temp_bans', 'api.can_remove_perma_bans'}` | (player_id: str) → `bool` | Remove all temporary and permanent bans from the player_id. |
| `unban_profanities` | POST | `api.can_unban_profanities` | (profanities: list[str]) → `bool` |  |
| `unblacklist_player` | POST | `{'api.can_delete_blacklist_records', 'api.can_remove_temp_bans', 'api.can_remove_perma_bans'}` | (player_id: str) → `bool` | Expires all blacklists of a player and unbans them from all servers. |
| `unflag_player` | POST | `api.can_unflag_player` | (flag_id: int \| None = None, player_id: str \| None = None, flag: str \| None = None) → `PlayerFlagType` | Flags can be removed either by flag_id (database key) or by passing a player ID and flag |
| `unwatch_player` | POST | `api.can_remove_player_watch` | (player_id: str) → `bool` |  |
| `upload_vips` |  | `` | — | (rconweb/api/vips.py) |
| `upload_vips_result` |  | `` | — | (rconweb/api/vips.py) |
| `validate_admin_pings_discord_webhooks_config` | POST | `api.can_change_admin_pings_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_audit_discord_webhooks_config` | POST | `api.can_change_audit_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_auto_broadcasts_config` | POST | `api.can_change_auto_broadcast_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_auto_mod_level_config` | POST | `api.can_change_auto_mod_level_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_auto_mod_no_leader_config` | POST | `api.can_change_auto_mod_no_leader_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_auto_mod_seeding_config` | POST | `api.can_change_auto_mod_seeding_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_auto_mod_solo_tank_config` | POST | `api.can_change_auto_mod_solo_tank_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_camera_discord_webhooks_config` | POST | `api.can_change_camera_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_camera_notification_config` | POST | `api.can_change_camera_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_chat_commands_config` | POST | `api.can_change_chat_commands_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_chat_discord_webhooks_config` | POST | `api.can_change_chat_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_expired_vip_config` | POST | `api.can_change_expired_vip_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_kills_discord_webhooks_config` | POST | `api.can_change_kills_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_log_line_webhook_config` | POST | `api.can_change_log_line_discord_webhook_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_log_stream_config` | POST | `api.can_change_log_stream_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_name_kick_config` | POST | `api.can_change_name_kick_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_rcon_chat_commands_config` | POST | `api.can_change_rcon_chat_commands_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_rcon_connection_settings_config` | POST | `api.can_change_rcon_connection_settings_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_rcon_server_settings_config` | POST | `api.can_change_rcon_server_settings_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_real_vip_config` | POST | `api.can_change_real_vip_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_scoreboard_config` | POST | `api.can_change_scorebot_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_seed_vip_config` | POST | `api.can_change_seed_vip_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_server_name_change_config` | POST | `api.can_change_server_name_change_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_standard_broadcast_messages` | POST | `api.can_change_standard_broadcast_messages` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_standard_punishments_messages` | POST | `api.can_change_standard_punishment_messages` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_standard_welcome_messages` | POST | `api.can_change_standard_welcome_messages` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_steam_config` | POST | `api.can_change_steam_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_tk_ban_on_connect_config` | POST | `api.can_change_tk_ban_on_connect_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_vac_game_bans_config` | POST | `api.can_change_vac_game_bans_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_votekick_autotoggle_config` | POST | `api.can_change_votekick_autotoggle_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_votemap_config` | POST | `api.can_change_votemap_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_watch_killrate_config` | POST | `api.can_change_watch_killrate_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `validate_watchlist_discord_webhooks_config` | POST | `api.can_change_watchlist_discord_webhooks_config` | (by: str, config: dict[str, Any] \| BaseUserConfig \| None = None, reset_to_default: bool = False) → `bool` |  |
| `watch_player` | POST | `api.can_add_player_watch` | (player_id: str, reason: str, by: str, player_name: str \| None = None) → `bool` |  |
