# CRCON response shapes (generated)

> Derived from Hell Let Loose Community RCON (CRCON) — https://github.com/MarechJ/hll_rcon_tool —
> Copyright (c) 2020 Julien Marechal. MIT License; full text in `third_party/crcon/LICENSE`.

The 93 types named in the endpoint table's `returns` column, from
`rcon/types.py`. TypedDicts are the JSON objects that come back inside the response
envelope's `result`; the enums are the string values those fields take.

## Response objects

### `AdminType`

| Field | Type |
|---|---|
| `player_id` | `str` |
| `name` | `str` |
| `role` | `str` |

### `AdminUserType`

| Field | Type |
|---|---|
| `username` | `str` |
| `player_id` | `str` |

### `AllMessageTemplateTypes`

| Field | Type |
|---|---|
| `AUTO_SETTINGS` | `list[MessageTemplateType]` |
| `BROADCAST` | `list[MessageTemplateType]` |
| `MESSAGE` | `list[MessageTemplateType]` |
| `REASON` | `list[MessageTemplateType]` |
| `WELCOME` | `list[MessageTemplateType]` |

### `AuditLogType`

| Field | Type |
|---|---|
| `id` | `int` |
| `username` | `str` |
| `creation_time` | `datetime.datetime` |
| `command` | `str` |
| `command_arguments` | `Optional[str]` |
| `command_result` | `Optional[str]` |

### `BasicPlayerProfileType`

| Field | Type |
|---|---|
| `id` | `int` |
| `player_id` | `str` |
| `created` | `datetime.datetime` |
| `names` | `list[PlayerNameType]` |
| `steaminfo` | `Optional[SteamInfoType]` |

### `BlacklistRecordType`

| Field | Type |
|---|---|
| `id` | `int` |
| `player_id` | `str` |
| `reason` | `str` |
| `admin_name` | `str` |
| `created_at` | `datetime.datetime` |
| `expires_at` | `Optional[datetime.datetime]` |
| `is_active` | `bool` |

### `BlacklistType`

| Field | Type |
|---|---|
| `id` | `int` |
| `name` | `str` |
| `sync` | `BlacklistSyncMethod` |
| `servers` | `Optional[List[int]]` |

### `CachedLiveGameStats`

| Field | Type |
|---|---|
| `snapshot_timestamp` | `datetime.datetime` |
| `stats` | `list[PlayerStatsType]` |
| `refresh_interval_sec` | `int` |

### `DBLogLineType`

| Field | Type |
|---|---|
| `id` | `int` |
| `version` | `int` |
| `creation_time` | `datetime.datetime` |
| `event_time` | `datetime.datetime` |
| `type` | `Optional[str]` |
| `player1_name` | `Optional[str]` |
| `player1_id` | `Optional[str]` |
| `player2_name` | `Optional[str]` |
| `player2_id` | `Optional[str]` |
| `raw` | `str` |
| `content` | `str` |
| `server` | `str` |
| `weapon` | `Optional[str]` |

### `DjangoGroup`

| Field | Type |
|---|---|
| `name` | `str` |

### `DjangoPermission`

| Field | Type |
|---|---|
| `permission` | `str` |
| `description` | `str` |

### `DjangoUserPermissions`

| Field | Type |
|---|---|
| `permissions` | `list[DjangoPermission]` |
| `groups` | `list[DjangoGroup]` |
| `is_superuser` | `bool` |
| `username` | `str` |
| `player_id` | `str` |

### `GameLayout`

| Field | Type |
|---|---|
| `requested` | `Sequence[str \| int \| None]` |
| `set` | `list[str]` |

### `GameServerBanType`

| Field | Type |
|---|---|
| `type` | `str` |
| `name` | `str \| None` |
| `player_id` | `str \| None` |
| `timestamp` | `datetime.datetime \| None` |
| `ban_time` | `str \| None` |
| `reason` | `str \| None` |
| `by` | `str \| None` |
| `raw` | `str` |

### `GameStateType`

| Field | Type |
|---|---|
| `num_allied_players` | `int` |
| `num_axis_players` | `int` |
| `allied_score` | `int` |
| `axis_score` | `int` |
| `allied_faction` | `int` |
| `axis_faction` | `int` |
| `allied_faction_id` | `int` |
| `axis_faction_id` | `int` |
| `allied_morale` | `int` |
| `axis_morale` | `int` |
| `initial_morale` | `int` |
| `raw_time_remaining` | `str` |
| `time_remaining` | `datetime.timedelta` |
| `current_map` | `'LayerType'` |
| `next_map` | `'LayerType'` |
| `game_mode` | `GameMode` |
| `queue_count` | `int` |
| `max_queue_count` | `int` |
| `vip_queue_count` | `int` |
| `max_vip_queue_count` | `int` |
| `match_time` | `int` |
| `server_name` | `str` |

### `GetDetailedPlayer`

| Field | Type |
|---|---|
| `name` | `str` |
| `player_id` | `str` |
| `profile` | `PlayerProfileType \| None` |
| `is_vip` | `bool` |
| `unit_id` | `Optional[int]` |
| `unit_name` | `Optional[str]` |
| `loadout` | `Optional[str]` |
| `team` | `Optional[str]` |
| `faction` | `Optional[str]` |
| `role` | `Optional[str]` |
| `kills` | `int` |
| `deaths` | `int` |
| `team_kills` | `int` |
| `vehicle_kills` | `int` |
| `vehicles_destroyed` | `int` |
| `combat` | `int` |
| `offense` | `int` |
| `defense` | `int` |
| `support` | `int` |
| `level` | `int` |
| `platform` | `str` |
| `eos_id` | `str` |
| `world_position` | `dict[str, float]` |
| `clan_tag` | `str` |
| `map_playtime_seconds` | `int` |

### `GetDetailedPlayers`

| Field | Type |
|---|---|
| `players` | `dict[str, GetDetailedPlayer]` |
| `fail_count` | `int` |

### `GetMapRotation`

| Field | Type |
|---|---|
| `maps` | `list[Layer]` |
| `current_index` | `int` |
| `next_index` | `int` |

### `GetMapSequence`

| Field | Type |
|---|---|
| `maps` | `list[Layer]` |
| `current_index` | `int` |

### `GetPlayersType`

| Field | Type |
|---|---|
| `name` | `str` |
| `player_id` | `str` |
| `platform` | `NotRequired[str \| None]` |
| `country` | `str \| None` |
| `steam_bans` | `Optional[SteamBansType]` |
| `is_vip` | `bool` |
| `profile` | `PlayerProfileType \| None` |

### `KillInfo`

| Field | Type |
|---|---|
| `action` | `Literal['KILL', 'DEATH']` |
| `player_id` | `str` |
| `player_name` | `str` |
| `ts` | `int` |
| `weapon` | `str` |

### `MapInfo`

| Field | Type |
|---|---|
| `_schema_version` | `NotRequired[int]` |
| `name` | `str` |
| `start` | `int \| None` |
| `end` | `int \| None` |
| `guessed` | `bool` |
| `player_stats` | `dict[str, PlayerStat]` |
| `game_layout` | `GameLayout` |
| `cap_flips` | `list[MapScore]` |
| `match_time` | `int` |

### `MapInfoISODates`

| Field | Type |
|---|---|
| `name` | `str` |
| `start` | `str \| None` |
| `end` | `str \| None` |
| `guessed` | `bool` |
| `player_stats` | `dict[str, PlayerStat]` |

### `MapResult`

| Field | Type |
|---|---|
| `axis` | `int` |
| `allied` | `int` |

### `MapRotationResponse`

| Field | Type |
|---|---|
| `maps` | `list[str]` |
| `current_index` | `int` |

### `MapScore`

| Field | Type |
|---|---|
| `ts` | `int` |
| `allied_score` | `int` |
| `axis_score` | `int` |

### `MapSequenceResponse`

| Field | Type |
|---|---|
| `maps` | `list[str]` |
| `current_index` | `int` |

### `MapsType`

| Field | Type |
|---|---|
| `id` | `int` |
| `creation_time` | `datetime.datetime` |
| `start` | `datetime.datetime` |
| `end` | `Optional[datetime.datetime]` |
| `server_number` | `Optional[int]` |
| `map_name` | `str` |
| `result` | `Optional[MapResult]` |
| `game_layout` | `GameLayout` |
| `player_stats` | `List[PlayerStatsType]` |
| `cap_flips` | `list[MapScore]` |

### `MessageTemplateType`

| Field | Type |
|---|---|
| `id` | `int` |
| `title` | `str` |
| `content` | `str` |
| `category` | `MessageTemplateCategory` |
| `created_at` | `datetime.datetime` |
| `updated_at` | `datetime.datetime` |
| `updated_by` | `str` |

### `ParsedLogsType`

| Field | Type |
|---|---|
| `actions` | `list[str]` |
| `players` | `list[str]` |
| `logs` | `list[StructuredLogLineWithMetaData]` |

### `PenaltyCountType`

| Field | Type |
|---|---|
| `KICK` | `int` |
| `PUNISH` | `int` |
| `TEMPBAN` | `int` |
| `PERMABAN` | `int` |

### `Player`

| Field | Type |
|---|---|
| `id` | `str` |
| `name` | `str` |

### `PlayerAccountType`

| Field | Type |
|---|---|
| `name` | `Optional[str]` |
| `discord_id` | `Optional[str]` |
| `is_member` | `bool` |
| `country` | `Optional[str]` |
| `lang` | `str` |
| `updated` | `datetime.datetime` |

### `PlayerActionType`

| Field | Type |
|---|---|
| `action_type` | `str` |
| `reason` | `Optional[str]` |
| `by` | `Optional[str]` |
| `time` | `datetime.datetime` |

### `PlayerAtCountType`

| Field | Type |
|---|---|
| `player_id` | `str` |
| `name` | `str` |
| `vip` | `Optional[bool]` |

### `PlayerCommentType`

| Field | Type |
|---|---|
| `id` | `int` |
| `player_id` | `str` |
| `creation_time` | `datetime.datetime` |
| `by` | `Optional[str]` |
| `content` | `str` |

### `PlayerFlagType`

| Field | Type |
|---|---|
| `id` | `int` |
| `flag` | `str` |
| `comment` | `Optional[str]` |
| `modified` | `datetime.datetime` |

### `PlayerInfoType`

| Field | Type |
|---|---|
| `iD` | `str` |
| `team` | `int` |
| `role` | `int` |
| `level` | `int` |
| `loadout` | `str` |
| `name` | `str` |
| `platoon` | `str` |
| `platoonIndex` | `int` |
| `scoreData` | `ScoreDataType` |
| `stats` | `StatsDataType` |
| `platform` | `str` |
| `clanTag` | `str` |
| `eosId` | `str` |
| `worldPosition` | `WorldPositionType` |

### `PlayerNameType`

| Field | Type |
|---|---|
| `id` | `int` |
| `name` | `str` |
| `player_id` | `str` |
| `created` | `datetime.datetime` |
| `last_seen` | `datetime.datetime` |

### `PlayerOptinsType`

| Field | Type |
|---|---|
| `id` | `int` |
| `optin_name` | `str` |
| `optin_value` | `Optional[str]` |
| `modified` | `datetime.datetime` |

### `PlayerSessionType`

| Field | Type |
|---|---|
| `id` | `int` |
| `player_id` | `str` |
| `start` | `Optional[datetime.datetime]` |
| `end` | `Optional[datetime.datetime]` |
| `created` | `datetime.datetime` |

### `PlayerSoldierType`

| Field | Type |
|---|---|
| `eos_id` | `Optional[str]` |
| `name` | `Optional[str]` |
| `level` | `int` |
| `platform` | `Optional[str]` |
| `clan_tag` | `Optional[str]` |
| `updated` | `datetime.datetime` |

### `PlayerStat`

| Field | Type |
|---|---|
| `combat` | `int` |
| `p_combat` | `int` |
| `offense` | `int` |
| `p_offense` | `int` |
| `defense` | `int` |
| `p_defense` | `int` |
| `support` | `int` |
| `p_support` | `int` |
| `vehicle_kills` | `int` |
| `p_vehicle_kills` | `int` |
| `vehicles_destroyed` | `int` |
| `p_vehicles_destroyed` | `int` |
| `level` | `int` |
| `p_kills_and_assists` | `int` |
| `kills_and_assists` | `int` |
| `p_deaths_and_redeploys` | `int` |
| `deaths_and_redeploys` | `int` |
| `units` | `Optional[list[UnitHistoryEntry]]` |
| `p_unit` | `UnitHistoryEntry` |
| `p_coord` | `'WorldPositionType'` |
| `has_spawned` | `bool` |
| `names` | `list[str]` |
| `status` | `Literal['offline', 'online', 'idle']` |

### `PlayerStatsType`

| Field | Type |
|---|---|
| `id` | `int` |
| `player_id` | `str` |
| `map_id` | `int` |
| `player` | `Optional[str]` |
| `platform` | `Optional[str]` |
| `steaminfo` | `Optional[SteamInfoType]` |
| `kills` | `Optional[int]` |
| `kills_streak` | `Optional[int]` |
| `kills_by_type` | `Optional[dict[WeaponType, int]]` |
| `deaths_by_type` | `Optional[dict[WeaponType, int]]` |
| `deaths` | `Optional[int]` |
| `deaths_without_kill_streak` | `Optional[int]` |
| `teamkills` | `Optional[int]` |
| `teamkills_streak` | `Optional[int]` |
| `deaths_by_tk` | `Optional[int]` |
| `deaths_by_tk_streak` | `Optional[int]` |
| `nb_vote_started` | `Optional[int]` |
| `nb_voted_yes` | `Optional[int]` |
| `nb_voted_no` | `Optional[int]` |
| `time_seconds` | `Optional[int]` |
| `last_spawn` | `Optional[datetime.datetime]` |
| `kills_per_minute` | `Optional[float]` |
| `deaths_per_minute` | `Optional[float]` |
| `kill_death_ratio` | `Optional[float]` |
| `longest_life_secs` | `Optional[int]` |
| `shortest_life_secs` | `Optional[int]` |
| `combat` | `Optional[int]` |
| `offense` | `Optional[int]` |
| `defense` | `Optional[int]` |
| `support` | `Optional[int]` |
| `most_killed` | `Optional[dict]` |
| `death_by` | `Optional[dict]` |
| `weapons` | `Optional[dict]` |
| `death_by_weapons` | `Optional[dict]` |
| `team` | `Optional[PlayerTeamAssociation]` |
| `units` | `Optional[list[UnitHistoryEntry]]` |
| `level` | `Optional[int]` |
| `vehicles_destroyed` | `Optional[int]` |
| `vehicle_kills` | `Optional[int]` |
| `kills_and_assists` | `Optional[int]` |
| `deaths_and_redeploys` | `Optional[int]` |
| `names` | `Optional[list[str]]` |
| `status` | `Optional[Literal['online', 'offline', 'idle']]` |
| `encounters` | `Optional[PlayerEncounters]` |

### `PlayerTeamAssociation`

| Field | Type |
|---|---|
| `side` | `Team` |
| `confidence` | `PlayerTeamConfidence` |
| `ratio` | `float` |

### `PlayerVIPType`

| Field | Type |
|---|---|
| `server_number` | `int` |
| `expiration` | `datetime.datetime` |

### `PublicInfoMapType`

| Field | Type |
|---|---|
| `map` | `LayerType` |
| `start` | `float \| None` |

### `PublicInfoNameType`

| Field | Type |
|---|---|
| `name` | `str` |
| `short_name` | `str` |
| `public_stats_port` | `int \| None` |
| `public_stats_port_https` | `int \| None` |

### `PublicInfoPlayerType`

| Field | Type |
|---|---|
| `allied` | `int` |
| `axis` | `int` |

### `PublicInfoScoreType`

| Field | Type |
|---|---|
| `allied` | `int` |
| `axis` | `int` |

### `PublicInfoType`

| Field | Type |
|---|---|
| `current_map` | `PublicInfoMapType` |
| `next_map` | `PublicInfoMapType` |
| `player_count` | `int` |
| `max_player_count` | `int` |
| `player_count_by_team` | `PublicInfoPlayerType` |
| `score` | `PublicInfoScoreType` |
| `time_remaining` | `float` |
| `vote_status` | `VoteMapStatus` |
| `name` | `PublicInfoNameType` |
| `config` | `ServerConfigType` |
| `cap_flips` | `list[MapScore]` |
| `match_time` | `int` |

### `ScoreDataType`

| Field | Type |
|---|---|
| `cOMBAT` | `int` |
| `offense` | `int` |
| `defense` | `int` |
| `support` | `int` |

### `ServerConfigType`

| Field | Type |
|---|---|
| `build_number` | `str` |
| `build_revision` | `str` |
| `password_protected` | `bool` |
| `server_name` | `str` |
| `supported_platforms` | `list[str]` |

### `ServerCountType`

| Field | Type |
|---|---|
| `server_number` | `Optional[int]` |
| `minute` | `datetime.datetime` |
| `count` | `int` |
| `players` | `List[PlayerAtCountType]` |
| `map` | `str` |
| `vip_count` | `int` |

### `ServerInfoType`

| Field | Type |
|---|---|
| `host` | `str \| None` |
| `port` | `str \| None` |
| `password` | `str \| None` |

### `SlotsType`

| Field | Type |
|---|---|
| `current_players` | `int` |
| `max_players` | `int` |

### `StatsDataType`

| Field | Type |
|---|---|
| `teamKills` | `int` |
| `vehicleKills` | `int` |
| `vehiclesDestroyed` | `int` |
| `infantryKills` | `int` |
| `deaths` | `int` |

### `StatusType`

| Field | Type |
|---|---|
| `name` | `str` |
| `map` | `'LayerType'` |
| `current_players` | `int` |
| `max_players` | `int` |
| `short_name` | `str` |
| `server_number` | `int` |

### `SteamBansType`

| Field | Type |
|---|---|
| `SteamId` | `str` |
| `CommunityBanned` | `bool` |
| `VACBanned` | `bool` |
| `NumberOfVACBans` | `int` |
| `DaysSinceLastBan` | `int` |
| `NumberOfGameBans` | `int` |
| `EconomyBan` | `str` |

### `SteamInfoType`

| Field | Type |
|---|---|
| `id` | `int` |
| `created` | `datetime.datetime` |
| `updated` | `datetime.datetime` |
| `profile` | `SteamPlayerSummaryType \| None` |
| `country` | `str \| None` |
| `bans` | `SteamBansType \| None` |
| `has_bans` | `bool` |

### `SteamPlayerSummaryType`

| Field | Type |
|---|---|
| `avatar` | `str` |
| `avatarfull` | `str` |
| `avatarhash` | `str` |
| `avatarmedium` | `str` |
| `communityvisibilitystate` | `Literal[1] \| Literal[3]` |
| `lastlogoff` | `int` |
| `loccityid` | `int` |
| `loccountrycode` | `str` |
| `locstatecode` | `str` |
| `personaname` | `str` |
| `personastate` | `int` |
| `personastateflags` | `int` |
| `primaryclanid` | `str` |
| `profilestate` | `int` |
| `profileurl` | `str` |
| `realname` | `str` |
| `steamid` | `str` |
| `timecreated` | `int` |

### `StructuredLogLineType`

| Field | Type |
|---|---|
| `action` | `str` |
| `player_name_1` | `str \| None` |
| `player_id_1` | `str \| None` |
| `player_name_2` | `str \| None` |
| `player_id_2` | `str \| None` |
| `weapon` | `str \| None` |
| `message` | `str` |
| `sub_content` | `str \| None` |

### `StructuredLogLineWithMetaData`

| Field | Type |
|---|---|
| `version` | `int` |
| `timestamp_ms` | `int` |
| `event_time` | `datetime.datetime` |
| `relative_time_ms` | `float \| None` |
| `raw` | `str` |
| `line_without_time` | `str \| None` |
| `action` | `str` |
| `player_name_1` | `str \| None` |
| `player_id_1` | `str \| None` |
| `player_name_2` | `str \| None` |
| `player_id_2` | `str \| None` |
| `weapon` | `str \| None` |
| `message` | `str` |
| `sub_content` | `str \| None` |

### `UnitHistoryEntry`

| Field | Type |
|---|---|
| `ts` | `int` |
| `team` | `int` |
| `squad` | `int` |
| `role` | `int` |

### `UserConfigType`

| Field | Type |
|---|---|
| `key` | `str` |
| `value` | `str` |

### `VACGameBansConfigType`

| Field | Type |
|---|---|
| `ban_on_vac_history_days` | `int` |
| `max_game_ban_threshold` | `int` |
| `ban_on_vac_history_reason` | `str` |
| `whitelist_flags` | `list[str]` |

### `VipId`

| Field | Type |
|---|---|
| `player_id` | `str` |
| `name` | `str` |

### `VipIdType`

| Field | Type |
|---|---|
| `player_id` | `str` |
| `name` | `str` |
| `vip_expiration` | `datetime.datetime \| None` |

### `VoteMapHistory`

| Field | Type |
|---|---|
| `ts` | `int` |
| `map_id` | `str` |
| `results` | `list[VoteMapHistoryResult]` |

### `VoteMapHistoryResult`

| Field | Type |
|---|---|
| `map_id` | `str` |
| `votes_count` | `int` |

### `VoteMapMapResult`

| Field | Type |
|---|---|
| `map` | `Layer` |
| `voters` | `list[VoteMapVoter]` |
| `votes_count` | `int` |

### `VoteMapPlayerChoice`

| Field | Type |
|---|---|
| `player_name` | `str` |
| `player_id` | `str` |

### `VoteMapStatus`

| Field | Type |
|---|---|
| `enabled` | `bool` |
| `paused` | `bool` |
| `results` | `list[VoteMapMapResult]` |
| `next_map` | `Optional[str]` |
| `last_reminder` | `Optional[datetime.datetime]` |
| `player_choice` | `Optional[VoteMapPlayerChoice]` |

### `VoteMapVote`

| Field | Type |
|---|---|
| `player_id` | `str` |
| `player_name` | `str` |
| `map_id` | `str` |
| `vote_count` | `int` |

### `VoteMapVoter`

| Field | Type |
|---|---|
| `player_id` | `str` |
| `player_name` | `str` |
| `count` | `int` |

### `WatchListType`

| Field | Type |
|---|---|
| `id` | `int` |
| `modified` | `datetime.datetime` |
| `player_id` | `str` |
| `is_watched` | `bool` |
| `reason` | `str` |
| `by` | `str` |
| `count` | `int` |

### `WorldPositionType`

| Field | Type |
|---|---|
| `x` | `float` |
| `y` | `float` |
| `z` | `float` |


## Enums

### `AllLogTypes` — extends `str`

| Name | Value |
|---|---|
| `admin` | `'ADMIN'` |
| `admin_anti_cheat` | `'ADMIN ANTI-CHEAT'` |
| `admin_banned` | `'ADMIN BANNED'` |
| `admin_idle` | `'ADMIN IDLE'` |
| `admin_kicked` | `'ADMIN KICKED'` |
| `admin_misc` | `'ADMIN MISC'` |
| `admin_perma_banned` | `'ADMIN PERMA BANNED'` |
| `allies_chat` | `'CHAT[Allies]'` |
| `allies_team_chat` | `'CHAT[Allies][Team]'` |
| `allies_unit_chat` | `'CHAT[Allies][Unit]'` |
| `axis_chat` | `'CHAT[Axis]'` |
| `axis_team_chat` | `'CHAT[Axis][Team]'` |
| `axis_unit_chat` | `'CHAT[Axis][Unit]'` |
| `camera` | `'CAMERA'` |
| `chat` | `'CHAT'` |
| `connected` | `'CONNECTED'` |
| `disconnected` | `'DISCONNECTED'` |
| `kill` | `'KILL'` |
| `match` | `'MATCH'` |
| `match_end` | `'MATCH ENDED'` |
| `match_start` | `'MATCH START'` |
| `team_kill` | `'TEAM KILL'` |
| `team_switch` | `'TEAMSWITCH'` |
| `tk` | `'TK'` |
| `tk_auto` | `'TK AUTO'` |
| `tk_auto_banned` | `'TK AUTO BANNED'` |
| `tk_auto_kicked` | `'TK AUTO KICKED'` |
| `vote` | `'VOTE'` |
| `vote_completed` | `'VOTE COMPLETED'` |
| `vote_expired` | `'VOTE EXPIRED'` |
| `vote_passed` | `'VOTE PASSED'` |
| `vote_started` | `'VOTE STARTED'` |

### `BlacklistSyncMethod` — extends `str`

| Name | Value |
|---|---|
| `KICK_ONLY` | `'kick_only'` |
| `BAN_ON_CONNECT` | `'ban_on_connect'` |
| `BAN_IMMEDIATELY` | `'ban_immediately'` |

### `MessageTemplateCategory`

| Name | Value |
|---|---|
| `AUTO_SETTINGS` | `'AUTO_SETTINGS'` |
| `BROADCAST` | `'BROADCAST'` |
| `MESSAGE` | `'MESSAGE'` |
| `REASON` | `'REASON'` |
| `WELCOME` | `'WELCOME'` |

### `MessageVariable`

| Name | Value |
|---|---|
| `vip_status` | `'vip_status'` |
| `vip_expiration` | `'vip_expiration'` |
| `server_name` | `'server_name'` |
| `server_short_name` | `'server_short_name'` |
| `discord_invite_url` | `'discord_invite_url'` |
| `admin_ping_trigger_words` | `'admin_ping_trigger_words'` |
| `num_online_mods` | `'num_online_mods'` |
| `num_ingame_mods` | `'num_ingame_mods'` |
| `next_map` | `'next_map'` |
| `next_map_id` | `'next_map_id'` |
| `map_rotation` | `'map_rotation'` |
| `admin_names` | `'admin_names'` |
| `owner_names` | `'owner_names'` |
| `senior_names` | `'senior_names'` |
| `junior_names` | `'junior_names'` |
| `vip_names` | `'vip_names'` |
| `random_vip_name` | `'random_vip_name'` |
| `online_mods` | `'online_mods'` |
| `ingame_mods` | `'ingame_mods'` |
| `votenextmap_line` | `'votenextmap_line'` |
| `votenextmap_noscroll` | `'votenextmap_noscroll'` |
| `votenextmap_vertical` | `'votenextmap_vertical'` |
| `votenextmap_by_mod_line` | `'votenextmap_by_mod_line'` |
| `votenextmap_by_mod_vertical` | `'votenextmap_by_mod_vertical'` |
| `votenextmap_by_mod_vertical_all` | `'votenextmap_by_mod_vertical_all'` |
| `votenextmap_by_mod_split` | `'votenextmap_by_mod_split'` |
| `total_votes` | `'votenextmap_line'` |
| `winning_maps_short` | `'winning_maps_short'` |
| `winning_maps_all` | `'winning_maps_all'` |
| `scrolling_votemap` | `'scrolling_votemap'` |
| `top_kills_player_name` | `'top_kills_player_name'` |
| `top_kills_player_score` | `'top_kills_player_score'` |
| `top_kill_streak_player_name` | `'top_kill_streak_player_name'` |
| `top_kill_streak_player_score` | `'top_kill_streak_player_score'` |

### `MessageVariableContext`

| Name | Value |
|---|---|
| `player_name` | `'player_name'` |
| `player_id` | `'player_id'` |
| `last_victim_player_id` | `'last_victim_player_id'` |
| `last_victim_name` | `'last_victim_name'` |
| `last_nemesis_player_id` | `'last_nemesis_player_id'` |
| `last_nemesis_name` | `'last_nemesis_name'` |
| `last_victim_weapon` | `'last_victim_weapon'` |
| `last_nemesis_weapon` | `'last_nemesis_weapon'` |
| `last_tk_victim_player_id` | `'last_tk_victim_player_id'` |
| `last_tk_victim_name` | `'last_tk_victim_name'` |
| `last_tk_victim_weapon` | `'last_tk_victim_weapon'` |
| `last_tk_nemesis_player_id` | `'last_tk_nemesis_player_id'` |
| `last_tk_nemesis_name` | `'last_tk_nemesis_name'` |
| `last_tk_nemesis_weapon` | `'last_tk_nemesis_weapon'` |

### `PlayerActionState`

| Name | Value |
|---|---|
| `KICK` | `0` |
| `PUNISH` | `1` |
| `TEMPBAN` | `2` |
| `PERMABAN` | `3` |
| `MESSAGE` | `4` |

### `PlayerStatsEnum` — extends `str`

| Name | Value |
|---|---|
| `KILLS` | `'kills'` |
| `KILLS_STREAK` | `'kills_streak'` |
| `DEATHS` | `'deaths'` |
| `DEATHS_WITHOUT_KILL_STREAK` | `'deaths_without_kill_streak'` |
| `TEAMKILLS` | `'teamkills'` |
| `TEAMKILLS_STREAK` | `'teamkills_streak'` |
| `DEATHS_BY_TK` | `'deaths_by_tk'` |
| `DEATHS_BY_TK_STREAK` | `'deaths_by_tk_streak'` |
| `NB_VOTE_STARTED` | `'nb_vote_started'` |
| `NB_VOTED_YES` | `'nb_voted_yes'` |
| `NB_VOTED_NO` | `'nb_voted_no'` |
| `LONGEST_LIFE_SECS` | `'longest_life_secs'` |
| `SHORTEST_LIFE_SECS` | `'shortest_life_secs'` |
| `KILL_DEATH_RATIO` | `'kill_death_ratio'` |
| `KILLS_PER_MINUTE` | `'kills_per_minute'` |
| `DEATHS_PER_MINUTE` | `'deaths_per_minute'` |
| `TIME_SECONDS` | `'time_seconds'` |

### `PlayerTeamConfidence`

| Name | Value |
|---|---|
| `STRONG` | `'strong'` |
| `MIXED` | `'mixed'` |

### `Roles` — extends `str`

| Name | Value |
|---|---|
| `commander` | `'armycommander'` |
| `squad_lead` | `'officer'` |
| `rifleman` | `'rifleman'` |
| `engineer` | `'engineer'` |
| `medic` | `'medic'` |
| `anti_tank` | `'antitank'` |
| `automatic_rifleman` | `'automaticrifleman'` |
| `assault` | `'assault'` |
| `machine_gunner` | `'heavymachinegunner'` |
| `support` | `'support'` |
| `spotter` | `'spotter'` |
| `sniper` | `'sniper'` |
| `tank_commander` | `'tankcommander'` |
| `crewman` | `'crewman'` |
| `artillery_observer` | `'artilleryobserver'` |
| `operator` | `'operator'` |
| `gunner` | `'gunner'` |

### `WindowsStoreIdActionType` — extends `str`

| Name | Value |
|---|---|
| `kick` | `'KICK'` |
| `temp_ban` | `'TEMP BAN'` |
| `perma_ban` | `'PERMA BAN'` |


## Other

### `BlacklistRecordWithBlacklistType` — extends `BlacklistRecordType`

| Field | Type |
|---|---|
| `blacklist` | `BlacklistType` |

### `BlacklistRecordWithPlayerType` — extends `BlacklistRecordWithBlacklistType`

| Field | Type |
|---|---|
| `player` | `BasicPlayerProfileType` |
| `formatted_reason` | `str` |

### `BlacklistWithRecordsType` — extends `BlacklistType`

| Field | Type |
|---|---|
| `records` | `List[BlacklistRecordType]` |

### `MostRecentEvents`

| Field | Type |
|---|---|
| `player_name` | `str \| None` |
| `last_victim_name` | `str \| None` |
| `last_victim_player_id` | `str \| None` |
| `last_nemesis_name` | `str \| None` |
| `last_nemesis_player_id` | `str \| None` |
| `last_victim_weapon` | `str \| None` |
| `last_nemesis_weapon` | `str \| None` |
| `last_tk_victim_name` | `str \| None` |
| `last_tk_victim_player_id` | `str \| None` |
| `last_tk_victim_weapon` | `str \| None` |
| `last_tk_nemesis_name` | `str \| None` |
| `last_tk_nemesis_player_id` | `str \| None` |
| `last_tk_nemesis_weapon` | `str \| None` |

### `PlayerProfileType` — extends `BasicPlayerProfileType`

| Field | Type |
|---|---|
| `sessions` | `list[PlayerSessionType]` |
| `sessions_count` | `int` |
| `total_playtime_seconds` | `int` |
| `current_playtime_seconds` | `int` |
| `received_actions` | `list[PlayerActionType]` |
| `penalty_count` | `PenaltyCountType` |
| `blacklists` | `list[BlacklistRecordWithBlacklistType]` |
| `is_blacklisted` | `bool` |
| `flags` | `list[PlayerFlagType]` |
| `watchlist` | `Optional[WatchListType]` |
| `is_watched` | `bool` |
| `vips` | `Optional[list[PlayerVIPType]]` |
| `is_vip` | `bool` |
| `soldier` | `PlayerSoldierType` |
| `account` | `PlayerAccountType` |

### `PlayerProfileTypeEnriched` — extends `PlayerProfileType`

| Field | Type |
|---|---|
| `bans` | `list[GameServerBanType]` |
| `comments` | `list[PlayerCommentType]` |
