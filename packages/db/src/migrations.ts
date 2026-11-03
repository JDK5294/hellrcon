/**
 * Ordered SQL migrations — the source of truth for the Postgres schema. Applied by the
 * Postgres repository on startup (each runs once, tracked in `schema_migrations`).
 *
 * PRE-RELEASE SQUASH #2 (2026-08): the 001–053 incremental chain was collapsed into this single
 * baseline for the release reset, while the project had no data worth keeping. Every upgrade-era
 * data rewrite (capability splits and merges, player-identity repairs, table add-then-drop churn)
 * evaporated; what remains is the end state those 53 migrations produced, verified by schema-diff
 * against a database migrated with the old chain. Databases created from the old chain must be
 * recreated — the runner refuses them loudly rather than half-applying guarded DDL.
 * Post-release, new changes append migrations; never edit this baseline again.
 *
 * Column-order note: columns that arrived later in the old chain sit at the END of their CREATE
 * (e.g. servers-config tables have updated_at mid-table). That is deliberate — it keeps the
 * baseline byte-comparable with databases produced by the old chain, which is how it was proven.
 */

import { SEED_MAP_SETS, SEED_VOTE_SCHEDULES } from "./seed/map-sets.js";

export interface Migration {
  id: string;
  sql: string;
}

/** A single-quoted SQL string literal. Doubling the quote is the whole escape — these are our own
 *  curated constants, not user input, but a map name with an apostrophe must not break the file. */
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * The starter library, built from the curated seed rather than pasted into the SQL by hand: ten
 * kilobytes of map ids inline would bury the migration that carries it, and the data belongs next
 * to its own documentation.
 *
 * ON CONFLICT DO NOTHING is load-bearing. The lift in the migration before this one has already
 * put every set a server was actually using into the library under its own name; a starter row
 * that collides with one of those must lose, so a community that curated their own "friday" keeps
 * it instead of ending up with two.
 */
const SEED_LIBRARY_SQL = `
  INSERT INTO map_sets (name, pool) VALUES
    ${SEED_MAP_SETS.map((s) => `(${lit(s.name)}, ${lit(JSON.stringify(s.pool))}::jsonb)`).join(",\n    ")}
  ON CONFLICT DO NOTHING;

  INSERT INTO vote_schedules (name, spec) VALUES
    ${SEED_VOTE_SCHEDULES.map((s) => `(${lit(s.name)}, ${lit(JSON.stringify(s.spec))}::jsonb)`).join(",\n    ")}
  ON CONFLICT DO NOTHING;
`;

export const MIGRATIONS: Migration[] = [
  {
    id: "001_baseline",
    sql: `
      -- ---- identity & access ----

      CREATE TABLE IF NOT EXISTS users (
        id            uuid PRIMARY KEY,
        username      text NOT NULL UNIQUE,
        -- Discord-only accounts have no password.
        password_hash text,
        email         text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        -- Discord sign-in: the stable @handle, the guild nickname (what a staff team actually
        -- calls each other — identity keys on discord_id, so renames are cosmetic), and whether
        -- this account's panel roles are driven by the Discord role mapping rather than by hand.
        discord_id       text UNIQUE,
        discord_username text,
        discord_managed  boolean NOT NULL DEFAULT false,
        discord_nick     text,
        -- When they last opened the staff announcements board; anything newer is "new to them".
        announcements_seen_at timestamptz,
        -- The counter that makes a stateless HMAC session revocable: tokens carry the epoch they
        -- were signed under, and bumping this ends every session for the account at once.
        session_epoch integer NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS api_tokens (
        id          uuid PRIMARY KEY,
        user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        text NOT NULL,
        token_hash  text NOT NULL UNIQUE,
        created_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz
      );

      CREATE TABLE IF NOT EXISTS grants (
        id         uuid PRIMARY KEY,
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        capability text NOT NULL,
        scope_type text NOT NULL CHECK (scope_type IN ('global','server','group')),
        scope_id   uuid,
        level      text NOT NULL CHECK (level IN ('none','read','write'))
      );
      CREATE INDEX IF NOT EXISTS grants_user_idx ON grants(user_id);

      -- Per-user action limits: numeric caps refining a capability (e.g. tempban.maxHours = the
      -- longest temp ban that user may issue). No row = unlimited; owners are never limited.
      CREATE TABLE IF NOT EXISTS user_limits (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key     text NOT NULL,
        value   numeric NOT NULL,
        PRIMARY KEY (user_id, key)
      );

      -- ---- servers ----

      CREATE TABLE IF NOT EXISTS servers (
        id              uuid PRIMARY KEY,
        name            text NOT NULL,
        game            text NOT NULL DEFAULT 'hll',
        protocol        text NOT NULL DEFAULT 'binary-v2',
        host            text NOT NULL,
        port            integer NOT NULL,
        password        text NOT NULL,
        engagement_mode text NOT NULL DEFAULT 'observe' CHECK (engagement_mode IN ('observe','active')),
        header_mode     text DEFAULT 'magic',
        game_version    text,
        timezone        text,
        crcon_base_url  text,
        created_at      timestamptz NOT NULL DEFAULT now()
      );

      -- Custom named roles: a reusable permission bundle. grants = [{capability, level}] (global
      -- scope by design), limits = {key: number}. A user's effective access is the UNION of all
      -- their roles plus their individual grants; editing a role updates every member at once.
      CREATE TABLE IF NOT EXISTS roles (
        id              uuid PRIMARY KEY,
        name            text NOT NULL UNIQUE,
        description     text,
        grants          jsonb NOT NULL DEFAULT '[]'::jsonb,
        limits          jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by_name text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );

      -- Role membership. The ASSIGNMENT is scoped, not the role: scope_id NULL = the bundle
      -- applies everywhere, a server id = only there — so one "Moderator" role serves every
      -- server without baking a server into the bundle. No primary key: the same (user, role)
      -- pair may exist at several scopes; the COALESCE unique index is what stops duplicate
      -- rows, folding NULL-as-global to the all-zero uuid (NULLs never collide in an index).
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id  uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        scope_id uuid REFERENCES servers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role_id);
      CREATE UNIQUE INDEX IF NOT EXISTS user_roles_uniq
        ON user_roles (user_id, role_id, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
      CREATE INDEX IF NOT EXISTS user_roles_scope_idx ON user_roles (scope_id);

      -- Maps a Discord role id → a panel role (permission bundle), optionally scoped to one
      -- server (same assignment-scoping as user_roles). Many-to-many; discord_role_name is
      -- cached for display. Deleting a panel role or a server removes its mappings.
      CREATE TABLE IF NOT EXISTS discord_role_map (
        discord_role_id   text NOT NULL,
        discord_role_name text,
        role_id           uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        created_at        timestamptz NOT NULL DEFAULT now(),
        scope_id          uuid REFERENCES servers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS discord_role_map_role_idx ON discord_role_map (role_id);
      CREATE UNIQUE INDEX IF NOT EXISTS discord_role_map_uniq
        ON discord_role_map (discord_role_id, role_id, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
      CREATE INDEX IF NOT EXISTS discord_role_map_scope_idx ON discord_role_map (scope_id);

      -- ---- players & identity history ----

      -- One human per platform_id (globally unique across platforms in practice); platform is
      -- display metadata, not identity — writers disagree on it for the same person, and letting
      -- it key identity forked players into twin rows.
      CREATE TABLE IF NOT EXISTS players (
        id          uuid PRIMARY KEY,
        platform    text NOT NULL,
        platform_id text NOT NULL,
        name        text NOT NULL,
        first_seen  timestamptz NOT NULL DEFAULT now(),
        last_seen   timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS players_platform_id_key ON players (platform_id);

      -- Identity history: every past name + clan tag a player has been seen using. Recorded at
      -- ingest and from live reads. first_seen is stamped once; last_seen + seen_count bump on
      -- each later sighting. Powers "Also known as" and clan-tag history on the profile.
      CREATE TABLE IF NOT EXISTS player_aliases (
        player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        kind       text NOT NULL CHECK (kind IN ('name','clan')),
        value      text NOT NULL,
        first_seen timestamptz NOT NULL DEFAULT now(),
        last_seen  timestamptz NOT NULL DEFAULT now(),
        seen_count integer NOT NULL DEFAULT 1,
        PRIMARY KEY (player_id, kind, value)
      );
      CREATE INDEX IF NOT EXISTS player_aliases_player_idx ON player_aliases (player_id, last_seen DESC);

      -- Generic linked identities: (provider, external_id) ↔ player — 'eos', 'discord', and any
      -- future integration. Integration-specific ids never live on the players table itself.
      CREATE TABLE IF NOT EXISTS external_links (
        player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        provider        text NOT NULL,
        external_id     text NOT NULL,
        created_by_name text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (player_id, provider)
      );
      CREATE INDEX IF NOT EXISTS external_links_lookup_idx ON external_links (provider, external_id);

      -- Player IP history — sensitive data, read-gated by the player.ips capability. One row per
      -- (player, ip) with the first/last time it was seen and how often. Populated by the CRCON
      -- archive transform, ONLY from records that carry the player's own id — never name-matched.
      CREATE TABLE IF NOT EXISTS player_ips (
        player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        ip         text NOT NULL,
        first_seen timestamptz NOT NULL,
        last_seen  timestamptz NOT NULL,
        seen_count integer NOT NULL DEFAULT 1,
        source     text NOT NULL,
        PRIMARY KEY (player_id, ip)
      );
      CREATE INDEX IF NOT EXISTS player_ips_ip_idx ON player_ips (ip);

      -- ---- events ----

      -- Raw normalized events. Partitioned by month so whole-window purges can DROP a
      -- partition (reclaims disk cleanly); the manual trim tool filters by kind + ts.
      -- dedupe_key: idempotent ingestion — the same admin-log line can be read by the worker,
      -- the one-shot API ingest, and again after a reconnect. The unique index (which must
      -- include ts on a ts-partitioned table) + ON CONFLICT DO NOTHING inserts each event once,
      -- so career stats are never double-counted.
      CREATE TABLE IF NOT EXISTS evt (
        id               uuid NOT NULL,
        server_id        uuid NOT NULL,
        ts               timestamptz NOT NULL,
        kind             text NOT NULL,
        actor_player_id  uuid,
        actor_name       text,
        victim_player_id uuid,
        victim_name      text,
        weapon           text,
        data             jsonb,
        dedupe_key       text,
        PRIMARY KEY (id, ts)
      ) PARTITION BY RANGE (ts);

      -- Default partition so inserts always land somewhere; monthly partitions can be
      -- added by a maintenance step later for DROP-PARTITION purges.
      CREATE TABLE IF NOT EXISTS evt_default PARTITION OF evt DEFAULT;

      CREATE INDEX IF NOT EXISTS evt_server_ts_idx ON evt (server_id, ts DESC);
      CREATE INDEX IF NOT EXISTS evt_kind_ts_idx ON evt (kind, ts);
      CREATE UNIQUE INDEX IF NOT EXISTS evt_dedupe_uidx ON evt (server_id, dedupe_key, ts);
      -- Per-player lookups (profile combat panel reads thousands of rows through these). Partial —
      -- most events carry no player — and declared on the parent so every partition inherits them.
      CREATE INDEX IF NOT EXISTS evt_actor_ts_idx  ON evt (actor_player_id,  ts DESC) WHERE actor_player_id  IS NOT NULL;
      CREATE INDEX IF NOT EXISTS evt_victim_ts_idx ON evt (victim_player_id, ts DESC) WHERE victim_player_id IS NOT NULL;

      -- ---- rollups & sessions ----

      -- Career rollup, accumulated at ingest time. Kept forever and independent of the raw evt
      -- table, so trimming events never loses these totals. One row per (player, server): the
      -- IDENTITY is community-wide, the PERFORMANCE is per-server — two servers are two
      -- populations, and ranking them together is meaningless. The all-zero server bucket holds
      -- history that has no honest attribution (e.g. an import into a multi-server community):
      -- it counts toward career totals but no per-server view claims it.
      CREATE TABLE IF NOT EXISTS player_stats (
        player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        kills        integer NOT NULL DEFAULT 0,
        deaths       integer NOT NULL DEFAULT 0,
        teamkills    integer NOT NULL DEFAULT 0,
        visits       integer NOT NULL DEFAULT 0,
        playtime_sec bigint  NOT NULL DEFAULT 0,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        -- The game's own score buckets — the fix for K/D being a poor measure of a Hell Let
        -- Loose player (the person building nodes and holding points scores almost no kills).
        -- bigint: these accumulate across every round; five figures a match on a busy server.
        combat             bigint NOT NULL DEFAULT 0,
        offense            bigint NOT NULL DEFAULT 0,
        defense            bigint NOT NULL DEFAULT 0,
        support            bigint NOT NULL DEFAULT 0,
        vehicle_kills      bigint NOT NULL DEFAULT 0,
        vehicles_destroyed bigint NOT NULL DEFAULT 0,
        -- Seconds per role, keyed by the game's raw role number (JSON: the role set is the
        -- game's, not ours). Squad-lead time is pulled out because it is the one role staff ask
        -- about by name, and a JSON key is a poor thing to sort a leaderboard on.
        role_seconds       jsonb  NOT NULL DEFAULT '{}'::jsonb,
        sl_seconds         bigint NOT NULL DEFAULT 0,
        -- Highest level seen: the game reports current level, which only climbs, so max is both
        -- the right accumulation and self-healing if a poll is missed.
        highest_level      int    NOT NULL DEFAULT 0,
        matches_played     int    NOT NULL DEFAULT 0,
        matches_won        int    NOT NULL DEFAULT 0,
        -- No FK to servers, matching evt and player_match_stats: deleting a server connection
        -- must not silently delete the history played on it.
        server_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
        PRIMARY KEY (player_id, server_id)
      );
      -- Global single-column sorts serve the all-servers board…
      CREATE INDEX IF NOT EXISTS player_stats_kills_idx ON player_stats (kills DESC);
      CREATE INDEX IF NOT EXISTS player_stats_support_idx ON player_stats (support DESC);
      CREATE INDEX IF NOT EXISTS player_stats_defense_idx ON player_stats (defense DESC);
      CREATE INDEX IF NOT EXISTS player_stats_offense_idx ON player_stats (offense DESC);
      CREATE INDEX IF NOT EXISTS player_stats_sl_seconds_idx ON player_stats (sl_seconds DESC);
      -- …and the per-server ones serve the scoped leaderboard.
      CREATE INDEX IF NOT EXISTS player_stats_player_idx ON player_stats (player_id);
      CREATE INDEX IF NOT EXISTS player_stats_server_kills_idx      ON player_stats (server_id, kills DESC);
      CREATE INDEX IF NOT EXISTS player_stats_server_playtime_idx   ON player_stats (server_id, playtime_sec DESC);
      CREATE INDEX IF NOT EXISTS player_stats_server_combat_idx     ON player_stats (server_id, combat DESC);
      CREATE INDEX IF NOT EXISTS player_stats_server_support_idx    ON player_stats (server_id, support DESC);
      CREATE INDEX IF NOT EXISTS player_stats_server_defense_idx    ON player_stats (server_id, defense DESC);
      CREATE INDEX IF NOT EXISTS player_stats_server_offense_idx    ON player_stats (server_id, offense DESC);
      CREATE INDEX IF NOT EXISTS player_stats_server_sl_seconds_idx ON player_stats (server_id, sl_seconds DESC);

      -- Currently-open play sessions, one per (player, server). Opened on connect; on disconnect the
      -- elapsed time is folded into the playtime rollup and the row is deleted — so this stays small.
      CREATE TABLE IF NOT EXISTS open_sessions (
        player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        server_id    uuid NOT NULL,
        connected_at timestamptz NOT NULL,
        PRIMARY KEY (player_id, server_id)
      );

      -- Completed play sessions (a connect→disconnect pair), for the profile's session history.
      -- The aggregate visit/playtime rollup lives on player_stats, so this table can be trimmed
      -- for space without losing those totals.
      CREATE TABLE IF NOT EXISTS player_sessions (
        id              uuid PRIMARY KEY,
        player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        server_id       uuid NOT NULL,
        connected_at    timestamptz NOT NULL,
        disconnected_at timestamptz NOT NULL,
        duration_sec    integer NOT NULL
      );
      CREATE INDEX IF NOT EXISTS player_sessions_player_idx ON player_sessions (player_id, disconnected_at DESC);
      -- Idempotent import target: a player's live open/close never produces two sessions with the
      -- same connect instant on one server, so ON CONFLICT can de-duplicate historical inserts.
      CREATE UNIQUE INDEX IF NOT EXISTS player_sessions_unique_idx
        ON player_sessions (player_id, server_id, connected_at);
      -- Concurrency reads ask "which sessions overlapped this window on this server".
      CREATE INDEX IF NOT EXISTS player_sessions_server_time_idx
        ON player_sessions (server_id, connected_at);
      CREATE INDEX IF NOT EXISTS player_sessions_server_end_idx
        ON player_sessions (server_id, disconnected_at);

      -- Periodic samples of a server's SHAPE: how many players, split how, in which roles, with
      -- which squads leaderless. None of this is derivable after the fact — the admin log records
      -- what people DID, never what they were playing, so composition over time only exists if it
      -- is sampled while it is happening.
      --
      -- Deliberately no player ids: a snapshot is a shape, not a roster. Keeping identities out is
      -- what makes a row ~200 bytes and lets a busy server keep a year of minute-resolution
      -- history without it becoming the biggest table in the database.
      CREATE TABLE IF NOT EXISTS roster_snapshots (
        id BIGSERIAL PRIMARY KEY,
        server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        ts TIMESTAMPTZ NOT NULL,
        player_count INT NOT NULL,
        -- the sides, roles and squad counts, as summarizeRoster produced them. JSON because the
        -- side ids and role numbers are the GAME's, not ours.
        composition JSONB NOT NULL DEFAULT '{}'::jsonb,
        -- the map/mode in play at the sample, so composition can be read per map without joining
        -- back to a match that may not have been recorded.
        map_name TEXT,
        game_mode TEXT
      );
      CREATE INDEX IF NOT EXISTS roster_snapshots_server_ts_idx ON roster_snapshots (server_id, ts);
      -- One sample per server per instant: the sampler is idempotent if it retries, and two workers
      -- running at once cannot double-count a population.
      CREATE UNIQUE INDEX IF NOT EXISTS roster_snapshots_server_ts_uniq ON roster_snapshots (server_id, ts);

      -- ---- matches ----

      -- Persistent match history. Each round is one row, opened on MATCH START and closed on
      -- MATCH ENDED with the parsed outcome; carries per-player scoreboards.
      CREATE TABLE IF NOT EXISTS matches (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        server_id     uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        map           text,
        started_at    timestamptz NOT NULL,
        ended_at      timestamptz,
        winner        text CHECK (winner IN ('allies','axis')),
        allied_score  int,
        axis_score    int,
        result        text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        -- The objective layout WE SET for the round (RCON has no reader for the layout in play —
        -- see docs/rcon-503.md), so NULL on untouched rounds is correct, not missing data.
        sector_layout    jsonb,
        sector_layout_by text,
        sector_layout_at timestamptz,
        UNIQUE (server_id, started_at)
      );
      CREATE INDEX IF NOT EXISTS matches_server_idx ON matches (server_id, started_at DESC);
      -- Only one open (unfinished) match per server at a time.
      CREATE UNIQUE INDEX IF NOT EXISTS matches_one_open_idx ON matches (server_id) WHERE ended_at IS NULL;

      -- Per-player scoreboard for a match, folded live from the kill stream during the round.
      -- The game RESETS scoreData each round, so a row holds the round's final figure and the
      -- sampler keeps it monotonic (max-wins) rather than summing samples.
      CREATE TABLE IF NOT EXISTS player_match_stats (
        match_id    uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        player_name text,
        side        text CHECK (side IN ('allies','axis')),
        kills       int NOT NULL DEFAULT 0,
        deaths      int NOT NULL DEFAULT 0,
        teamkills   int NOT NULL DEFAULT 0,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        combat              int NOT NULL DEFAULT 0,
        offense             int NOT NULL DEFAULT 0,
        defense             int NOT NULL DEFAULT 0,
        support             int NOT NULL DEFAULT 0,
        vehicle_kills       int NOT NULL DEFAULT 0,
        vehicles_destroyed  int NOT NULL DEFAULT 0,
        role_seconds        jsonb NOT NULL DEFAULT '{}'::jsonb,
        sl_seconds          int NOT NULL DEFAULT 0,
        -- Outcome. Nullable on purpose: a row written mid-round genuinely does not know yet, and
        -- false would claim it lost. Set when the match closes.
        won                 boolean,
        -- Whether they were still connected at the final whistle, so "played" can exclude someone
        -- who left at 5 minutes without pretending they were absent all round.
        present_at_end      boolean,
        PRIMARY KEY (match_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS player_match_stats_player_idx ON player_match_stats (player_id);

      -- ---- moderation ----

      -- Immutable staff/system action trail: powers staff analytics, the moderation record,
      -- ban history, and search. actor_user_id is null for system/auto (e.g. the enforcer).
      CREATE TABLE IF NOT EXISTS audit (
        id            uuid PRIMARY KEY,
        ts            timestamptz NOT NULL DEFAULT now(),
        actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        actor_name    text NOT NULL,
        action        text NOT NULL,
        target_type   text,
        target_id     text,
        target_name   text,
        server_id     uuid,
        summary       text NOT NULL,
        data          jsonb
      );
      CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit (ts DESC);
      CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit (actor_user_id);
      CREATE INDEX IF NOT EXISTS audit_action_idx ON audit (action);
      CREATE INDEX IF NOT EXISTS audit_target_idx ON audit (target_id);

      -- Freeform admin notes on a player (viewable with the player.notes capability).
      CREATE TABLE IF NOT EXISTS player_notes (
        id             uuid PRIMARY KEY,
        player_id      uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        author_name    text NOT NULL,
        body           text NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS player_notes_player_idx ON player_notes (player_id, created_at DESC);

      -- Watchlist / VIP flags, one row per flagged player.
      CREATE TABLE IF NOT EXISTS player_flags (
        player_id       uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        watchlist       boolean NOT NULL DEFAULT false,
        vip             boolean NOT NULL DEFAULT false,
        updated_by_name text,
        updated_at      timestamptz NOT NULL DEFAULT now()
      );

      -- Custom player flags/tags: short colored labels (emoji or text) admins attach to a player.
      CREATE TABLE IF NOT EXISTS player_tags (
        id              uuid PRIMARY KEY,
        player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        label           text NOT NULL,
        note            text,
        created_by_name text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS player_tags_player_idx ON player_tags (player_id, created_at);

      -- Event-driven player rules (the Rules tab of Auto settings). The enforcer reacts to evt.*
      -- and acts on the offending player; on observe servers actions are dry-run (audited only)
      -- so rules can be tuned safely.
      CREATE TABLE IF NOT EXISTS enforcer_rules (
        id          uuid PRIMARY KEY,
        name        text NOT NULL,
        enabled     boolean NOT NULL DEFAULT true,
        event_kind  text NOT NULL,
        match       text,
        threshold   integer NOT NULL DEFAULT 1,
        window_sec  integer NOT NULL DEFAULT 0,
        action      text NOT NULL,
        reason      text,
        hours       integer,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      -- Named blacklists — persistent, reason-carrying, optionally-expiring ban lists (like CRCON).
      -- server_id NULL = applies to all servers; otherwise scoped to that one server.
      CREATE TABLE IF NOT EXISTS blacklists (
        id              uuid PRIMARY KEY,
        name            text NOT NULL,
        server_id       uuid REFERENCES servers(id) ON DELETE CASCADE,
        created_by_name text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      );

      -- One entry per (list, player): the durable moderation record. expires_at NULL = permanent.
      CREATE TABLE IF NOT EXISTS blacklist_records (
        id                 uuid PRIMARY KEY,
        blacklist_id       uuid NOT NULL REFERENCES blacklists(id) ON DELETE CASCADE,
        player_id          text NOT NULL,
        player_name        text,
        reason             text NOT NULL,
        expires_at         timestamptz,
        created_by_user_id uuid,
        created_by_name    text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS blacklist_records_list_idx ON blacklist_records (blacklist_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS blacklist_records_player_idx ON blacklist_records (player_id);

      -- VIP grants. Many games' native VIP has no expiry, so we own expiration here (like CRCON):
      -- expiration NULL = permanent; a timestamp is swept by the worker, which removes the game
      -- VIP once it passes. One row per (server, player).
      CREATE TABLE IF NOT EXISTS vips (
        id                 uuid PRIMARY KEY,
        server_id          uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        player_id          text NOT NULL,
        player_name        text,
        comment            text,
        expiration         timestamptz,
        created_by_user_id uuid,
        created_by_name    text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        UNIQUE (server_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS vips_expiration_idx ON vips (expiration) WHERE expiration IS NOT NULL;

      -- Console-admin grants: the game server's own admin list, with the panel as the book of
      -- record — the exact vips pattern (grant writes the game AND this row; the list the panel
      -- shows is THIS, not a live RCON read). One row per (server, player); the group is whatever
      -- the game reports via GetAdminGroups. Purely in-game powers: no relation to panel users.
      CREATE TABLE IF NOT EXISTS console_admins (
        id                 uuid PRIMARY KEY,
        server_id          uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        player_id          text NOT NULL,
        player_name        text,
        admin_group        text NOT NULL,
        comment            text,
        -- null = permanent. The game only knows permanent admins, so the expiry lives here and
        -- the always-on worker removes lapsed grants from the game — the exact vips arrangement.
        expiration         timestamptz,
        created_by_user_id uuid,
        created_by_name    text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        UNIQUE (server_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS console_admins_player_idx ON console_admins (player_id);

      -- Named player groups (clan-vs-clan rosters, streamers, event squads): the unit that bulk
      -- actions apply to — bulk VIP / console admin / temp ban / team swap. Membership is keyed
      -- by GAME player id, so a group is global; servers are picked when an action is applied.
      CREATE TABLE IF NOT EXISTS player_groups (
        id                 uuid PRIMARY KEY,
        name               text NOT NULL UNIQUE,
        description        text,
        created_by_user_id uuid,
        created_by_name    text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS player_group_members (
        group_id      uuid NOT NULL REFERENCES player_groups(id) ON DELETE CASCADE,
        player_id     text NOT NULL,
        player_name   text,
        added_by_name text NOT NULL,
        added_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (group_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS player_group_members_player_idx ON player_group_members (player_id);

      -- Bans imported from an existing CRCON instance. These are game bans, not blacklist entries,
      -- so they get their own durable store and surface under the Bans view (not the Blacklist).
      -- One row per (server, player, type); re-importing upserts rather than duplicating.
      CREATE TABLE IF NOT EXISTS crcon_ban (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        player_id   text NOT NULL,
        player_name text,
        type        text NOT NULL CHECK (type IN ('temp','perma')),
        reason      text,
        expires_at  timestamptz,
        author      text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (server_id, player_id, type)
      );
      CREATE INDEX IF NOT EXISTS crcon_ban_server_idx ON crcon_ban (server_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS crcon_ban_player_idx ON crcon_ban (player_id);

      -- ---- automation ----

      -- Per-server seeding enforcement + seed-VIP reward config. Enforces low-population rules
      -- while a server fills, then rewards the seeders with VIP once it goes live.
      CREATE TABLE IF NOT EXISTS seeding_config (
        server_id           uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        enabled             boolean NOT NULL DEFAULT false,
        dry_run             boolean NOT NULL DEFAULT true,
        seed_target         integer NOT NULL DEFAULT 40,
        min_players         integer NOT NULL DEFAULT 5,
        disallowed_roles    jsonb   NOT NULL DEFAULT '[]'::jsonb,
        immune_level        integer NOT NULL DEFAULT 0,
        immune_tags         jsonb   NOT NULL DEFAULT '[]'::jsonb,
        announce_message    text    NOT NULL DEFAULT '',
        max_warnings        integer NOT NULL DEFAULT 2,
        warn_interval_sec   integer NOT NULL DEFAULT 60,
        warn_message        text    NOT NULL DEFAULT '',
        max_punishes        integer NOT NULL DEFAULT 2,
        punish_interval_sec integer NOT NULL DEFAULT 60,
        punish_message      text    NOT NULL DEFAULT '',
        kick_after          boolean NOT NULL DEFAULT true,
        kick_message        text    NOT NULL DEFAULT '',
        reward_enabled      boolean NOT NULL DEFAULT true,
        reward_hours        integer NOT NULL DEFAULT 24,
        min_seed_minutes    integer NOT NULL DEFAULT 15,
        reward_cumulative   boolean NOT NULL DEFAULT true,
        reward_message      text    NOT NULL DEFAULT '',
        updated_at          timestamptz NOT NULL DEFAULT now(),
        -- Debounce for a population that hovers at the go-live line: once a reward round fires,
        -- hold further rounds (and their messages) for this long.
        reward_delay_sec    integer NOT NULL DEFAULT 1800,
        -- Phase stability: a new phase must hold phase_confirm_sec before it commits, and
        -- phase_hysteresis is a player-count dead band on the down-crossing — so a count that
        -- flaps at a boundary doesn't churn the phase (wiping progress, re-greeting everyone).
        phase_confirm_sec   integer NOT NULL DEFAULT 60,
        phase_hysteresis    integer NOT NULL DEFAULT 3
      );

      -- Accrued presence per player for the CURRENT seed cycle (cleared when the cycle ends).
      CREATE TABLE IF NOT EXISTS seed_progress (
        server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        player_id   text NOT NULL,
        player_name text,
        seconds     integer NOT NULL DEFAULT 0,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (server_id, player_id)
      );

      -- Runtime phase, written by the worker so the panel can show live seeding status.
      CREATE TABLE IF NOT EXISTS seeding_state (
        server_id      uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        phase          text NOT NULL DEFAULT 'idle',
        live_count     integer NOT NULL DEFAULT 0,
        seeder_count   integer NOT NULL DEFAULT 0,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        last_reward_at timestamptz
      );

      -- Auto settings: the server managing itself, one config row per server holding both halves —
      -- the schedule/population/team-count settings profiles, and the player-rule modules keyed by
      -- module id: { "no-leader": { "enabled": true, "dryRun": false, "config": { … } }, … }.
      -- A map rather than rows because the worker reads every module for a server on each tick —
      -- one row read instead of N — and per-module writes go through jsonb_set so two editors
      -- can't clobber each other.
      CREATE TABLE IF NOT EXISTS autosettings_config (
        server_id  uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        enabled    boolean NOT NULL DEFAULT false,
        dry_run    boolean NOT NULL DEFAULT true,
        timezone   text    NOT NULL DEFAULT 'UTC',
        profiles   jsonb   NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        modules    jsonb   NOT NULL DEFAULT '{}'::jsonb
      );

      -- Reusable Auto settings configurations. A template captures behaviour (profiles, player-rule
      -- modules, timezone) and deliberately NOT per-server state (enabled, dry-run) — applying one
      -- must never silently arm enforcement on a server that had it off. Referenced by NAME from a
      -- profile's applyTemplate action, so the name is unique case-insensitively.
      CREATE TABLE IF NOT EXISTS autosettings_templates (
        id              uuid PRIMARY KEY,
        name            text NOT NULL,
        config          jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by_name text NOT NULL,
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS autosettings_templates_name_key ON autosettings_templates (lower(name));

      -- Rotating server broadcast: the worker cycles these messages through the game's broadcast
      -- command on an interval. One row per server; no-ops until enabled with at least one message.
      CREATE TABLE IF NOT EXISTS broadcast_config (
        server_id    uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        enabled      boolean NOT NULL DEFAULT false,
        dry_run      boolean NOT NULL DEFAULT true,
        interval_sec integer NOT NULL DEFAULT 300,
        randomize    boolean NOT NULL DEFAULT false,
        messages     jsonb   NOT NULL DEFAULT '[]'::jsonb,
        updated_at   timestamptz NOT NULL DEFAULT now()
      );

      -- Staff-set DISPLAY name overrides for maps, per game. Cosmetic only — every code path keys
      -- off the raw map id; this table just changes what's shown in the UI / vote polls.
      CREATE TABLE IF NOT EXISTS map_names (
        game         text NOT NULL,
        map_id       text NOT NULL,
        display_name text NOT NULL,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (game, map_id)
      );

      -- Per-server map-vote config: an ordered list of scheduled pool profiles (JSON, resolved by
      -- @app/schedule), the vote surface + Discord channel, and the live-apply behaviour knobs.
      CREATE TABLE IF NOT EXISTS mapvote_config (
        server_id  uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        timezone   text  NOT NULL DEFAULT 'UTC',
        profiles   jsonb NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        enabled    boolean NOT NULL DEFAULT false,
        surface    text    NOT NULL DEFAULT 'native',
        channel_id text,
        poll_hours integer NOT NULL DEFAULT 2,
        reminders  jsonb NOT NULL DEFAULT '[]'::jsonb,
        -- live_apply: keep the winner queued continuously as votes come in, so an early match end
        -- still lands on what players picked. The delays mute the tracker right after a match
        -- (a fresh poll's first votes are noise) and hold the next vote until players load in.
        live_apply                      boolean NOT NULL DEFAULT true,
        post_match_apply_delay_seconds  integer NOT NULL DEFAULT 300,
        poll_reset_delay_seconds        integer NOT NULL DEFAULT 180,
        pause_below_players             integer NOT NULL DEFAULT 0,
        -- What a worker restart does to the vote: 'remember' keeps the persisted posture,
        -- 'paused' suits normally-quiet servers, 'active' stops a pause outliving its crash.
        startup_state text NOT NULL DEFAULT 'remember'
      );

      -- Map-vote runtime state, written by the worker (which owns all Discord I/O): the active
      -- poll, the latest parked tally (so viewers never hit Discord), staff one-shot requests
      -- (skip/reroll/start-now — honoured and cleared on the next pass, so buttons never block),
      -- and the pause bookkeeping that lets a resume restore the SAME vote.
      CREATE TABLE IF NOT EXISTS mapvote_state (
        server_id         uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        active_message_id text,
        active_channel_id text,
        options           jsonb NOT NULL DEFAULT '[]'::jsonb,
        profile           text,
        opened_at         timestamptz,
        last_match_end_at timestamptz,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        paused            boolean NOT NULL DEFAULT false,
        override_map_id   text,
        recent_maps       jsonb NOT NULL DEFAULT '[]'::jsonb,
        tallies           jsonb NOT NULL DEFAULT '[]'::jsonb,
        tallied_at        timestamptz,
        skip_next         boolean NOT NULL DEFAULT false,
        reroll            boolean NOT NULL DEFAULT false,
        pause_reason        text,
        saved_options       jsonb NOT NULL DEFAULT '[]'::jsonb,
        pause_notice_id     text,
        start_now           boolean NOT NULL DEFAULT false,
        resync_now          boolean NOT NULL DEFAULT false,
        send_message_layout text,
        live_applied_map_id text,
        reopen_at           timestamptz
      );

      -- One row per concluded vote: what was offered, how it voted, what was chosen and why.
      -- Kept forever (tiny) so map popularity can be judged from evidence rather than memory.
      CREATE TABLE IF NOT EXISTS mapvote_history (
        id           uuid PRIMARY KEY,
        server_id    uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        decided_at   timestamptz NOT NULL DEFAULT now(),
        profile      text,
        options      jsonb NOT NULL DEFAULT '[]'::jsonb,
        winner_id    text,
        winner_name  text,
        total_votes  integer NOT NULL DEFAULT 0,
        -- vote | override | skipped | no_votes | error — why this outcome, in one word.
        outcome      text NOT NULL DEFAULT 'vote',
        applied      boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS mapvote_history_server_idx ON mapvote_history (server_id, decided_at DESC);

      -- Who voted for what. Flattened out of the history JSON because the questions worth asking
      -- are per-person and per-map — "what does this player usually vote for", "who actually
      -- turns up" — and those want an index, not a scan through documents. discord_user_id joins
      -- to a person: external_links(provider='discord') → game player, users.discord_id → account.
      CREATE TABLE IF NOT EXISTS mapvote_ballots (
        id              uuid PRIMARY KEY,
        history_id      uuid NOT NULL REFERENCES mapvote_history(id) ON DELETE CASCADE,
        server_id       uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        decided_at      timestamptz NOT NULL DEFAULT now(),
        map_id          text NOT NULL,
        map_name        text NOT NULL DEFAULT '',
        discord_user_id text NOT NULL,
        discord_name    text NOT NULL DEFAULT '',
        -- denormalized: did the map this person picked end up being played? Saves joining back to
        -- the history row for the two questions that are always asked together.
        won             boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS mapvote_ballots_voter_idx ON mapvote_ballots (discord_user_id, decided_at DESC);
      CREATE INDEX IF NOT EXISTS mapvote_ballots_server_idx ON mapvote_ballots (server_id, decided_at DESC);
      -- one person gets one vote per poll per map, so a re-read of the same poll can't double-count.
      CREATE UNIQUE INDEX IF NOT EXISTS mapvote_ballots_unique ON mapvote_ballots (history_id, map_id, discord_user_id);

      -- Per-server Discord relay routing (category → channel) + immediate ping alerts + per-
      -- category options (mention role, team-kills-only, chat keyword filters). The bot token
      -- stays in the env; only what staff set from the panel lives here.
      CREATE TABLE IF NOT EXISTS discord_relay_config (
        server_id  uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        enabled    boolean NOT NULL DEFAULT false,
        categories jsonb   NOT NULL DEFAULT '["kills","admin","match"]'::jsonb,
        channels   jsonb   NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        alerts     jsonb NOT NULL DEFAULT '{}'::jsonb,
        category_options jsonb NOT NULL DEFAULT '{}'::jsonb
      );

      -- ---- app plumbing ----

      CREATE TABLE IF NOT EXISTS announcements (
        id             uuid PRIMARY KEY,
        title          text NOT NULL,
        body           text NOT NULL,
        published      boolean NOT NULL DEFAULT false,
        author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        -- published_at anchors "how long until they saw it"; nudged_at marks that this posting's
        -- one Discord reminder happened (cleared on re-post).
        published_at   timestamptz,
        nudged_at      timestamptz
      );
      CREATE INDEX IF NOT EXISTS announcements_published_idx ON announcements (published, created_at DESC);

      -- One receipt per (notice, staff member): read_at is the FIRST time the board rendered the
      -- posted notice for them; acknowledged_at is the explicit "✓ Acknowledge" click.
      CREATE TABLE IF NOT EXISTS announcement_reads (
        announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        read_at         timestamptz NOT NULL DEFAULT now(),
        acknowledged_at timestamptz,
        PRIMARY KEY (announcement_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS announcement_reads_user_idx ON announcement_reads (user_id);

      -- Discord nudge for unread staff notices: board-wide singleton config (the announcements
      -- board is instance-level, not per-server). The worker fires one reminder per posting once
      -- a notice has been up for after_hours and someone still hasn't seen it.
      CREATE TABLE IF NOT EXISTS announcement_nudge_config (
        singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        enabled     boolean NOT NULL DEFAULT false,
        channel_id  text NOT NULL DEFAULT '',
        after_hours int NOT NULL DEFAULT 48,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      -- Saved UI layouts (customizable widget arrangement). Scoped to the whole instance
      -- or to one user; per surface (admin / community / scoreboard).
      CREATE TABLE IF NOT EXISTS layouts (
        id         uuid PRIMARY KEY,
        scope_type text NOT NULL CHECK (scope_type IN ('instance','user')),
        scope_id   text NOT NULL DEFAULT '',
        surface    text NOT NULL,
        config     jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (scope_type, scope_id, surface)
      );

      -- Namespaced key/value storage for plugins (each plugin gets its own namespace).
      CREATE TABLE IF NOT EXISTS plugin_kv (
        namespace  text NOT NULL,
        key        text NOT NULL,
        value      jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (namespace, key)
      );

      -- Background-service health. Each process (worker, discord…) upserts a row per service it
      -- runs; the API reads them (classifying by freshness) alongside its own in-process services
      -- for the System view. One row per service name.
      CREATE TABLE IF NOT EXISTS service_heartbeats (
        name       text PRIMARY KEY,
        status     text NOT NULL,
        detail     jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      -- Editable message/reason presets behind the pickers (type freely OR pick a saved preset).
      CREATE TABLE IF NOT EXISTS message_templates (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind       text NOT NULL,
        title      text NOT NULL DEFAULT '',
        body       text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS message_templates_kind_idx ON message_templates (kind, sort_order);

      -- No starter presets. The library ships EMPTY and staff fill it with their own wording:
      -- a canned list is one more thing to delete before the panel says what a community actually
      -- says, and on a phone a long preset list pushed the fields under it off the screen.

      -- A slow, resumable pull of an existing CRCON instance's stored data. The expensive network
      -- extract happens once and lands in a durable NDJSON archive on the host (not the DB — a
      -- full pull of every profile would bloat Postgres); only the small job record lives here.
      -- api_key persists because a background job must resume across restarts; it is never
      -- returned by the API (read only by the worker via a dedicated accessor).
      CREATE TABLE IF NOT EXISTS crcon_import_job (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        server_id          uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        base_url           text NOT NULL,
        status             text NOT NULL DEFAULT 'running',
        cursor             jsonb NOT NULL DEFAULT '{}'::jsonb,
        counts             jsonb NOT NULL DEFAULT '{}'::jsonb,
        errors             jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_by_user_id uuid,
        created_by_name    text NOT NULL DEFAULT '',
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        api_key            text NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS crcon_import_job_server_idx ON crcon_import_job (server_id, created_at DESC);
    `,
  },
  {
    id: "002_feature_presets",
    sql: `
      -- Named, community-wide snapshots of ONE feature's behaviour config (broadcast rotation,
      -- map-vote setup, seeding ladder, …). The full editing complexity stays in each feature's
      -- own editor; a preset freezes that state under a name so applying it anywhere — an Auto
      -- settings profile, a toolbar button — is one line. Like Auto settings templates, a preset
      -- carries behaviour only, never the enabled/dry-run switches. Referenced by NAME from
      -- profiles, so names are unique case-insensitively per feature.
      CREATE TABLE IF NOT EXISTS feature_presets (
        id              uuid PRIMARY KEY,
        feature         text NOT NULL,
        name            text NOT NULL,
        config          jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by_name text NOT NULL,
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS feature_presets_name_key ON feature_presets (feature, lower(name));
    `,
  },
  {
    id: "003_enforcer_rule_scope",
    sql: `
      -- Event rules gain a server scope. NULL keeps the old meaning — the rule fires on events
      -- from every server — so existing rules carry on unchanged; a uuid pins the rule to one
      -- server (its events only). Deleting a server takes its scoped rules with it.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS server_id uuid REFERENCES servers(id) ON DELETE CASCADE;
    `,
  },
  {
    id: "004_watchlist_provenance",
    sql: `
      -- WHY a player is watched, WHO put them on the list and WHEN — moderation history, not just
      -- a boolean. updated_by/updated_at can't carry this: they are overwritten by any flag change
      -- (a VIP toggle would erase the watch author). Cleared when the player is unwatched; filled
      -- by the panel (staff types a reason) and by the CRCON import (the original reason/author).
      ALTER TABLE player_flags ADD COLUMN IF NOT EXISTS watch_reason text;
      ALTER TABLE player_flags ADD COLUMN IF NOT EXISTS watch_by     text;
      ALTER TABLE player_flags ADD COLUMN IF NOT EXISTS watch_at     timestamptz;
    `,
  },
  {
    id: "005_watch_history",
    sql: `
      -- Every watch a player has EVER had, kept forever — past reasons are how staff catch repeat
      -- offenders, so removal must close the record, never delete it. One row per watch spell:
      -- opened when the flag arms (reason/author/time; imports carry CRCON's originals), closed
      -- when it's removed (who removed it, when). player_flags still holds only the CURRENT watch.
      CREATE TABLE IF NOT EXISTS watch_history (
        id          uuid PRIMARY KEY,
        player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        reason      text,
        watched_by  text,
        watched_at  timestamptz NOT NULL,
        removed_by  text,
        removed_at  timestamptz
      );
      CREATE INDEX IF NOT EXISTS watch_history_player_idx ON watch_history (player_id, watched_at DESC);

      -- Backfill: players already watched when this table arrives get their current watch as the
      -- opening spell, so unwatching them later closes a record instead of losing the story.
      INSERT INTO watch_history (id, player_id, reason, watched_by, watched_at)
      SELECT gen_random_uuid(), player_id, watch_reason, watch_by, COALESCE(watch_at, updated_at, now())
      FROM player_flags WHERE watchlist;
    `,
  },
  {
    id: "006_vip_pause",
    sql: `
      -- VIP pause: a VIP timeout as a moderation action. The grant survives — its expiration keeps
      -- running (the lost time IS the punishment) and seeding rewards/manual grants still extend it
      -- — but while paused the VIP is removed from the game and nothing re-adds it. The sweep
      -- restores it when paused_until passes. All three are null when not paused.
      ALTER TABLE vips ADD COLUMN IF NOT EXISTS paused_until timestamptz;
      ALTER TABLE vips ADD COLUMN IF NOT EXISTS pause_reason text;
      ALTER TABLE vips ADD COLUMN IF NOT EXISTS paused_by    text;
    `,
  },
  {
    id: "007_vip_pause_mode",
    sql: `
      -- Two flavours of VIP pause. 'running' (the punishment): the expiration keeps ticking while
      -- paused — the lost time IS the penalty. 'banked': the meter FREEZES — on resume/lapse the
      -- expiration is pushed out by however long the pause lasted (paused_at is the anchor), so no
      -- VIP time is lost, they just couldn't use it. Both keep accumulating grants while paused.
      -- A banked-paused grant must not expire mid-freeze, so the expiry sweep skips those rows.
      ALTER TABLE vips ADD COLUMN IF NOT EXISTS pause_mode text;
      ALTER TABLE vips ADD COLUMN IF NOT EXISTS paused_at  timestamptz;
    `,
  },
  {
    id: "008_vip_presets",
    sql: `
      -- The duration buttons on the Edit VIP popup. They act as a calculator — each click ADDS the
      -- preset's days+hours to a running total, applied on confirm — so a preset is a duration, not
      -- a fixed choice. kind picks the tab: 'add' (granting VIP) or 'pause' (a VIP timeout). The
      -- list is community-editable (Administration -> VIP presets); these rows are just the starter
      -- set, so "Help skip queue" is whatever the community decides it should be.
      CREATE TABLE IF NOT EXISTS vip_presets (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind       text NOT NULL CHECK (kind IN ('add','pause')),
        label      text NOT NULL,
        days       integer NOT NULL DEFAULT 0,
        hours      integer NOT NULL DEFAULT 0,
        sort_order integer NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS vip_presets_kind_idx ON vip_presets (kind, sort_order);

      INSERT INTO vip_presets (kind, label, days, hours, sort_order) VALUES
        ('add',   'Help skip queue', 0,  2, 0),
        ('add',   '1 day',           1,  0, 1),
        ('add',   '1 week',          7,  0, 2),
        ('add',   '1 month',         30, 0, 3),
        ('pause', '1 day',           1,  0, 0),
        ('pause', '1 week',          7,  0, 1),
        ('pause', '1 month',         30, 0, 2);
    `,
  },
  {
    id: "009_discord_status_board",
    sql: `
      -- The live match board: ONE Discord message per server, edited in place forever. The message
      -- id lives in here because it is the only thing that makes "edit" possible across restarts —
      -- lose it and the worker would post a second board and the channel would drift into exactly
      -- the scroll of stale rounds the feature exists to avoid.
      ALTER TABLE discord_relay_config ADD COLUMN IF NOT EXISTS status_board jsonb NOT NULL DEFAULT '{}'::jsonb;
    `,
  },
  {
    id: "010_server_automation",
    sql: `
      -- Per-server automation switches, so a community migrating off CRCON can go active with one
      -- system at a time instead of all of them at once. Exceptions-only: {} = run everything,
      -- which is exactly what every existing row already does.
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS automation jsonb NOT NULL DEFAULT '{}'::jsonb;
    `,
  },
  {
    id: "011_mapvote_open_error",
    sql: `
      -- Why the last attempt to open a poll failed, surfaced to the control page. Without it a
      -- composition dead-end (pool too thin after exclusions) or a Discord error was a worker log
      -- line and an eternally blank "no poll is open" screen.
      ALTER TABLE mapvote_state ADD COLUMN IF NOT EXISTS last_open_error text;
    `,
  },
  {
    id: "012_map_family_overrides",
    sql: `
      -- Staff-set FAMILY overrides, alongside the display-name ones already in this table. The
      -- family is what "rest every variant of this map" and "one option per map" key off, and it
      -- was inferred from the map id by rules in code — so a map the game ships with an unexpected
      -- id grouped wrong until someone shipped a new build. Now it is data, and the catalogue page
      -- can fix a stray in a few clicks.
      ALTER TABLE map_names ADD COLUMN IF NOT EXISTS family text;
      -- A row may now carry either override on its own, so the name is no longer mandatory.
      ALTER TABLE map_names ALTER COLUMN display_name DROP NOT NULL;
    `,
  },
  {
    id: "013_user_prefs",
    sql: `
      -- Display preferences (theme, accent colour, density, landing view, remembered tabs) lived
      -- in each browser's localStorage, which meant "set the accent" was a per-device chore and a
      -- colour chosen on a desktop never reached the same person's phone — indistinguishable from
      -- the setting not working. They belong to the ACCOUNT: one JSON blob, read at sign-in.
      -- Deliberately schemaless — these are display choices with no server meaning, and pinning
      -- each one to a column would mean a migration every time the panel grows a toggle.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
    `,
  },
  {
    id: "014_audit_automated",
    sql: `
      -- Was this the APP acting, or a person? The staff pages need the split (the automation
      -- outnumbers the humans hundreds to one), and it was being inferred from actor_user_id IS
      -- NULL. That inference is wrong the moment an account is deleted: the FK is ON DELETE SET
      -- NULL, so a departed admin's actions — which the trail deliberately keeps, name and all —
      -- would silently reclassify as machinery and vanish from the staff record.
      -- The question is only answerable at WRITE time, so it is stored then.
      ALTER TABLE audit ADD COLUMN IF NOT EXISTS automated boolean NOT NULL DEFAULT false;
      -- Backfill: today, an actor-less row is the app's own. Rows belonging to users deleted
      -- BEFORE this migration are indistinguishable and stay counted as automation — the only
      -- history this cannot recover, and it stops accruing from here.
      UPDATE audit SET automated = true WHERE actor_user_id IS NULL;
      CREATE INDEX IF NOT EXISTS audit_automated_idx ON audit (automated, ts DESC);
    `,
  },
  {
    id: "015_map_set_library",
    sql: `
      -- Map sets and their timings were welded together AND trapped on one server.
      --
      -- A set lived inline in mapvote_config.profiles, so the same curated pool had to be rebuilt
      -- by hand on every server, and a change had to be repeated on every server. Its schedule was
      -- a field of the set, so "Friday teatime" could not be reused by a second set — the timing
      -- had no existence of its own. And the only starting points were five presets hardcoded in
      -- the source, which staff could copy but never edit or remove.
      --
      -- Both become community-wide named records. A server's vote setup is now an ordered list of
      -- PAIRINGS — this set, on that schedule — so the two vary independently and every server
      -- draws from the same library.

      CREATE TABLE IF NOT EXISTS map_sets (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name       text  NOT NULL,
        pool       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- Names are the link target (a pairing stores the name, not the id, so the stored config
      -- stays readable), which makes case-insensitive uniqueness a correctness requirement.
      CREATE UNIQUE INDEX IF NOT EXISTS map_sets_name_idx ON map_sets (lower(name));

      CREATE TABLE IF NOT EXISTS vote_schedules (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name       text  NOT NULL,
        spec       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS vote_schedules_name_idx ON vote_schedules (lower(name));

      -- ---- lift every server's inline profiles into the library ----
      -- Existing configuration is the thing being preserved here, so it runs BEFORE the starter
      -- seed and wins any name it shares with it: a community that already curated "friday" keeps
      -- theirs and never sees a second one.
      CREATE TABLE _mapset_lift AS
      SELECT c.server_id,
             p.ord,
             COALESCE(NULLIF(btrim(p.prof->>'name'), ''), 'map set ' || p.ord) AS prof_name,
             COALESCE(p.prof->'pool', '{}'::jsonb) AS pool,
             COALESCE(p.prof->'spec', '{}'::jsonb) AS spec
      FROM mapvote_config c
      CROSS JOIN LATERAL jsonb_array_elements(c.profiles) WITH ORDINALITY AS p(prof, ord);

      ALTER TABLE _mapset_lift ADD COLUMN set_name text;
      ALTER TABLE _mapset_lift ADD COLUMN sched_name text;

      -- Two servers with the same set name and the same maps are ONE library set — that dedupe is
      -- the whole point. Same name but genuinely different maps keeps both, numbered, because
      -- silently merging them would change what a server offers.
      UPDATE _mapset_lift m SET set_name = d.set_name
      FROM (
        SELECT prof_name, pool,
               CASE WHEN rn = 1 THEN prof_name ELSE prof_name || ' #' || rn END AS set_name
        FROM (
          SELECT prof_name, pool, dense_rank() OVER (PARTITION BY lower(prof_name) ORDER BY pool::text) AS rn
          FROM (SELECT DISTINCT prof_name, pool FROM _mapset_lift) u
        ) r
      ) d
      WHERE d.prof_name = m.prof_name AND d.pool = m.pool;

      -- A spec carrying nothing but a timezone says "always" — that is the ABSENCE of a schedule,
      -- not a schedule, so it stays null rather than littering the library with empty windows.
      UPDATE _mapset_lift m SET sched_name = d.sched_name
      FROM (
        SELECT prof_name, spec,
               CASE WHEN rn = 1 THEN prof_name ELSE prof_name || ' #' || rn END AS sched_name
        FROM (
          SELECT prof_name, spec, dense_rank() OVER (PARTITION BY lower(prof_name) ORDER BY spec::text) AS rn
          FROM (SELECT DISTINCT prof_name, spec FROM _mapset_lift WHERE spec - 'timezone' <> '{}'::jsonb) u
        ) r
      ) d
      WHERE d.prof_name = m.prof_name AND d.spec = m.spec;

      INSERT INTO map_sets (name, pool)
      SELECT DISTINCT set_name, pool FROM _mapset_lift
      ON CONFLICT DO NOTHING;

      INSERT INTO vote_schedules (name, spec)
      SELECT DISTINCT sched_name, spec FROM _mapset_lift WHERE sched_name IS NOT NULL
      ON CONFLICT DO NOTHING;

      -- profiles stops holding the settings and starts holding the pairings, in the same order —
      -- order is priority, and first-match-wins depends on it.
      UPDATE mapvote_config c
      SET profiles = COALESCE((
        SELECT jsonb_agg(jsonb_build_object('mapSet', m.set_name, 'schedule', m.sched_name) ORDER BY m.ord)
        FROM _mapset_lift m WHERE m.server_id = c.server_id
      ), '[]'::jsonb);

      DROP TABLE _mapset_lift;
    `,
  },
  {
    id: "016_map_set_library_seed",
    sql: SEED_LIBRARY_SQL,
  },
  {
    id: "017_admin_cam",
    sql: `
      -- Admin camera: who went into spectator, when, and for how long.
      --
      -- The game log already announced it and we already stored the line as evt.admin.camera, but
      -- as two unrelated events — so "how long was that admin in cam" could only be answered by
      -- eyeballing a log, and trimming old events erased the record entirely. Spectator is the
      -- one staff power with no target and no audit row, which makes a durable record of it the
      -- point rather than a nicety.
      --
      -- A session is a PAIR, closed by the matching exit, so exited_at and duration_sec stay null
      -- while somebody is still in cam — that is a live reading, not missing data.
      CREATE TABLE IF NOT EXISTS admin_cam_sessions (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        server_id    uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        -- ON DELETE SET NULL, not CASCADE: merging or deleting a player must not erase the record
        -- that somebody was watching. player_name is kept for exactly that reason.
        player_id    uuid REFERENCES players(id) ON DELETE SET NULL,
        player_name  text NOT NULL,
        entered_at   timestamptz NOT NULL,
        exited_at    timestamptz,
        duration_sec integer,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS admin_cam_sessions_server_idx ON admin_cam_sessions (server_id, entered_at DESC);
      CREATE INDEX IF NOT EXISTS admin_cam_sessions_player_idx ON admin_cam_sessions (player_id, entered_at DESC);
      -- At most one open session per (server, player): the pairing looks the open one up by this,
      -- and two would make "which one does this exit close" a coin toss.
      CREATE UNIQUE INDEX IF NOT EXISTS admin_cam_sessions_open_idx
        ON admin_cam_sessions (server_id, player_id) WHERE exited_at IS NULL;

      -- Telling players in game that an admin is watching. Off by default: it is a policy choice,
      -- and turning it on for a community that did not ask changes how their server feels.
      CREATE TABLE IF NOT EXISTS admin_cam_config (
        server_id      uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        notify_enabled boolean NOT NULL DEFAULT false,
        -- {admin} is substituted with the name from the log line. A blank message means "say
        -- nothing for this half", so announcing only the entry is one field left empty.
        enter_message  text NOT NULL DEFAULT 'An admin is now watching. {admin}',
        exit_message   text NOT NULL DEFAULT '',
        updated_at     timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "018_signatures",
    sql: `
      -- Signatures on what a player is shown.
      --
      -- A kick reason or an admin message arrives with no author and no next step: the player
      -- reads a sentence and has no idea who wrote it or where to take it up. Two optional lines
      -- fix that, and they are separate because they answer separate questions — one says WHO
      -- acted, the other says WHERE TO GO. A community may want either, both or neither, and the
      -- choice differs per action: a permanent ban is worth signing and pointing at an appeal, a
      -- routine "move to your objective" nudge is not.
      --
      -- Community-wide, not per-server: a signature is the community's voice, and having to keep
      -- three servers' wording in step by hand is the problem the map-set library just solved.
      -- One row, enforced by the CHECK on a boolean primary key.
      CREATE TABLE IF NOT EXISTS signature_config (
        id          boolean PRIMARY KEY DEFAULT true CHECK (id),
        -- {staff} is the acting staff member's PANEL name (their Discord nick, normally) — never
        -- their in-game alias, which is not who the community knows them as.
        staff_line  text  NOT NULL DEFAULT '- {staff}',
        -- Free text on purpose. It is usually a Discord invite, but "read the rules at ..." is the
        -- same shape of thing and a column called discord_link would have been wrong within a month.
        custom_line text  NOT NULL DEFAULT '',
        -- { "kick": { "staff": true, "custom": true }, ... } — per action, per half. An action
        -- that is absent wants neither, so the default of {} is "nothing is signed yet".
        actions     jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO signature_config (id) VALUES (true) ON CONFLICT DO NOTHING;
    `,
  },
  {
    id: "019_admin_cam_player_token",
    sql: `
      -- {admin} -> {player}, because it was never the admin's name.
      --
      -- The camera announcement is built from a line of GAME log, so the only name available is the
      -- in-game one. Signatures, which arrived a day later, use {staff} for the panel/Discord name
      -- of whoever acted. Two same-looking tokens meaning two different names in adjacent features
      -- is a trap, and the token that was misnamed is this one.
      --
      -- The old spelling is still honoured at substitution time (see fillPlayerToken) so nothing
      -- anybody already typed starts rendering a literal "{admin}" at players — but it is gone from
      -- the default, and gone from the UI, so it stops being learnable.
      ALTER TABLE admin_cam_config ALTER COLUMN enter_message SET DEFAULT 'An admin is now watching. {player}';
      UPDATE admin_cam_config SET enter_message = replace(enter_message, '{admin}', '{player}')
        WHERE enter_message LIKE '%{admin}%';
      UPDATE admin_cam_config SET exit_message = replace(exit_message, '{admin}', '{player}')
        WHERE exit_message LIKE '%{admin}%';
    `,
  },
  {
    id: "020_player_ban",
    sql: `
      -- What staff DECIDED, as opposed to what a game server is currently enforcing.
      --
      -- The game's own ban list stays the truth about enforcement, and \`GET /servers/:id/bans\`
      -- keeps reading it live. This table is the other half: the intent behind those bans, which
      -- nothing recorded. The Bans page derived it by replaying the last 500 audit entries and
      -- unioning the CRCON import — a replay that silently loses any ban older than 500 actions of
      -- any kind, sees nothing placed from the in-game console, and has two dialects to parse.
      --
      -- \`scope\` is a RULE, not a list of ids: {"mode":"all"} | {"mode":"except","serverIds":[…]}
      -- | {"mode":"servers","serverIds":[…]}. The first two cover a server added later, which is
      -- the whole reason the column is jsonb and not a join table. See apps/api/src/ban-scope.ts.
      --
      -- \`game\` rather than a server FK, because a rule spans servers and player ids do not cross
      -- games: a Hell Let Loose Steam64 means nothing to an HLL: Vietnam server.
      --
      -- Rows are never deleted. A lift sets lifted_at, so "banned, lifted, banned again" is three
      -- facts in order — the same reasoning as the watch history.
      CREATE TABLE IF NOT EXISTS player_ban (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game               text NOT NULL,
        player_id          text NOT NULL,
        player_name        text,
        kind               text NOT NULL CHECK (kind IN ('temp','perma')),
        reason             text NOT NULL,
        -- What the blacklist's named lists were actually for: a reason taxonomy, so "who is on the
        -- cheat list" is a filter rather than a page.
        category           text,
        scope              jsonb NOT NULL,
        -- NULL = permanent. A date, not a count of hours, so "until the end of the season" is
        -- expressible — the gap that made a blacklist record look like a different kind of thing.
        expires_at         timestamptz,
        created_by_user_id uuid,
        created_by_name    text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        lifted_at          timestamptz,
        lifted_by_name     text
      );
      -- The reconciler's question is "which bans are live", asked per tick.
      CREATE INDEX IF NOT EXISTS player_ban_active_idx ON player_ban (game, lifted_at, expires_at);
      -- The profile's question is "what is on this player's record", asked per page view.
      CREATE INDEX IF NOT EXISTS player_ban_player_idx ON player_ban (player_id, created_at DESC);
    `,
  },
  {
    id: "021_retire_blacklist",
    sql: `
      -- The blacklist is gone; the ban system is the one place that says who may not play.
      --
      -- A blacklist record was a note that never reached the game — the "apply as a live ban" step
      -- its page promised was never built — and in this community every blacklisted player carried
      -- a real permanent ban alongside, so the records were duplicates of bans the seed now reads
      -- straight off the game servers. Nothing to convert; see docs/ban-model.md.
      --
      -- Whoever held only the blacklist permission becomes a ban manager: the two pages answered
      -- the same question, and a grant that names a deleted capability would gate nothing forever.
      -- Duplicates are harmless — grants resolve by union, so two rows saying moderation.bans mean
      -- exactly what one does.
      UPDATE grants SET capability = 'moderation.bans' WHERE capability = 'moderation.blacklist';
      DROP TABLE IF EXISTS blacklist_records;
      DROP TABLE IF EXISTS blacklists;
    `,
  },
  {
    id: "022_economy",
    sql: `
      -- The community economy: the one subsystem whose subject is a DISCORD USER, not a player
      -- row and not a staff account.
      --
      -- Public members have no panel login (staff Discord sign-in is staff-only), and a person can
      -- hold a balance before they have linked any game account — or hold two game accounts, one
      -- per game, behind one balance. So the member key is the Discord id, the only identity every
      -- participant is guaranteed to have. Game identities attach through external_links exactly
      -- like every other provider.
      CREATE TABLE IF NOT EXISTS community_members (
        discord_id   text PRIMARY KEY,
        discord_name text,
        -- A CACHE of the ledger's sum, maintained in the same transaction as every ledger write.
        -- The ledger is the truth; this column exists so the members table never sums a million
        -- rows to draw a number. The CHECK is the "never below zero" rule in its final form: a
        -- debit that would overdraw fails in the store, whatever a caller forgot to check.
        balance      integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      );

      -- Append-only. Every balance is explainable as the sum of its rows; nothing edits, nothing
      -- deletes. A failed purchase is a debit row followed by a credit row that says so — visible
      -- history, not a silent rollback.
      CREATE TABLE IF NOT EXISTS economy_ledger (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        discord_id text NOT NULL REFERENCES community_members(discord_id) ON DELETE CASCADE,
        -- The APPLIED amount, after cap clamping — the row records what happened, not what was
        -- asked for. May be zero: a daily claim at the cap still consumes the day.
        delta      integer NOT NULL,
        reason     text NOT NULL,
        -- Idempotency: a unique reference for writes that must happen at most once — a purchase's
        -- transaction key, or claim:daily:<id>:<YYYY-MM-DD>. The unique index makes a Discord
        -- double-click or a same-day second claim a no-op at the only layer that can promise it.
        ref        text,
        -- Who caused it: the member themselves, a staff name, or 'system'.
        actor_name text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS economy_ledger_ref_key ON economy_ledger (ref) WHERE ref IS NOT NULL;
      CREATE INDEX IF NOT EXISTS economy_ledger_member_idx ON economy_ledger (discord_id, created_at DESC);

      -- One row of settings, same shape as signature_config: currency name, balance cap, claim
      -- bands, gifting rules and the shop offers live in one jsonb document the panel edits.
      -- Offers carry their own server SCOPE ({"mode":"all"} | {"mode":"servers","serverIds":[…]})
      -- so "sold per server" vs "sold community-wide" is configuration, never code.
      CREATE TABLE IF NOT EXISTS economy_config (
        id         boolean PRIMARY KEY DEFAULT true CHECK (id),
        config     jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO economy_config (id) VALUES (true) ON CONFLICT DO NOTHING;
    `,
  },
  {
    id: "023_discord_commands",
    sql: `
      -- The bot's ONE slash command, as configuration rather than code. Which word a community
      -- types is theirs to choose — "/staff" suits one and "/clan" another — and changing it was
      -- a code edit plus a redeploy plus a terminal, which is three too many.
      --
      -- One row, one jsonb document (the economy_config shape): { name, description, enabled }.
      -- Singular on purpose: everything the bot does is a button inside the panel that command
      -- opens. The interactions endpoint dispatches on the CONFIGURED name, so a rename takes
      -- effect the moment it is saved and re-registered.
      CREATE TABLE IF NOT EXISTS discord_commands (
        id         boolean PRIMARY KEY DEFAULT true CHECK (id),
        config     jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO discord_commands (id) VALUES (true) ON CONFLICT DO NOTHING;
    `,
  },
  {
    id: "024_app_config",
    sql: `
      -- The community's own clock.
      --
      -- Every scheduled thing here used to carry its own timezone, each defaulting to the string
      -- "UTC", so a community in New York set up map-vote windows in UTC, auto-settings profiles
      -- in UTC, and had the daily claim reset at 8pm their time. Nobody thinks in UTC; they think
      -- in the hours their servers are busy.
      --
      -- One IANA zone, set once. Schedules that leave their own zone blank inherit it, and the
      -- claim day is this zone's day. Stored rather than taken from a browser because the workers
      -- have no browser — a claim boundary has to be the same instant for everybody.
      CREATE TABLE IF NOT EXISTS app_config (
        id         boolean PRIMARY KEY DEFAULT true CHECK (id),
        config     jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO app_config (id) VALUES (true) ON CONFLICT DO NOTHING;
    `,
  },
  {
    id: "025_mapvote_tidy_channel",
    sql: `
      -- A vote channel that only ever grows.
      --
      -- Every match end posts a fresh poll, and the finished one stays: a six-option card, closed,
      -- forever. After a night of rounds the channel is a wall of dead ballots and the live vote —
      -- the only one anybody can act on — is somewhere above the fold. Discord's own "the winner
      -- was X" line is the part worth keeping; the spent ballot beneath it is not.
      --
      -- ON by default because a superseded poll has no function: it cannot be voted in, its result
      -- is announced separately, and the full tally (with who voted for what) is kept in the panel's
      -- vote history either way. Communities that would rather keep every ballot in the channel turn
      -- it off in Vote setup.
      ALTER TABLE mapvote_config ADD COLUMN IF NOT EXISTS tidy_channel boolean NOT NULL DEFAULT true;

      -- The ballot that was just closed, remembered only until the next one opens. Deleting it AT
      -- close would race Discord's own "the winner was X" line, which it posts against the poll a
      -- moment later and which is the part worth keeping; holding the id until the next vote opens
      -- means the result has long since landed and the channel keeps exactly one live ballot.
      ALTER TABLE mapvote_state ADD COLUMN IF NOT EXISTS last_closed_message_id text;
      ALTER TABLE mapvote_state ADD COLUMN IF NOT EXISTS last_closed_channel_id text;
    `,
  },
  {
    id: "026_mapvote_live_apply_note",
    sql: `
      -- Why the next map is NOT tracking the vote leader.
      --
      -- The worker already computes an explicit reason every pass ("nobody has voted yet",
      -- "settling after the last match (240s left)", "live apply is off"), and then threw it away:
      -- only the SUCCESSFUL apply was logged. So a vote that quietly never queues its leader looked
      -- from the panel exactly like one that was working — "Next map: whatever the rotation says",
      -- with nothing anywhere saying why. Staff had no way to tell a settle window from a
      -- misconfiguration without reading the worker's source.
      --
      -- Kept alongside last_open_error rather than in the log because the question is asked from the
      -- Vote tab, by people who do not have the worker's stdout.
      ALTER TABLE mapvote_state ADD COLUMN IF NOT EXISTS live_apply_note text;
    `,
  },
  {
    id: "027_map_sets_belong_to_a_game",
    sql: `
      -- A map set is a pool of MAP IDS, and a map id belongs to exactly one game.
      --
      -- The library being game-blind was right while there was one game: curate a pool once, use it
      -- on every server. A second game turns it into a trap — a WW2 set can be paired to a Vietnam
      -- server and nothing says no. The vote then composes Foy and Carentan for a server that has
      -- never heard of them, offers players maps that cannot be chosen, and the failure surfaces in
      -- Discord at vote time instead of in the editor where somebody could have fixed it.
      --
      -- Sets stay shared across SERVERS — that was always the point — but only across servers of the
      -- same game. Existing rows are WW2: this app ran nothing else until HLL: Vietnam.
      --
      -- Names remain ONE namespace rather than one per game, deliberately: a pairing stores the
      -- set's NAME so a server's stored config reads as English, and a name that meant two different
      -- sets depending on who was asking would make that link ambiguous.
      ALTER TABLE map_sets ADD COLUMN IF NOT EXISTS game text NOT NULL DEFAULT 'hll';
    `,
  },
  {
    id: "028_players_belong_to_a_game",
    sql: `
      -- A player row is ONE GAME'S ACCOUNT, and nothing recorded which one.
      --
      -- Invisible while there was one game. With two it is the difference between a VIP grant
      -- landing and silently doing nothing: HLL: Vietnam does not identify players by the same id as
      -- HLL, so a member's WW2 account and their Vietnam account are two different rows carrying two
      -- different ids, and the id from one means nothing to the other's server. The Discord VIP shop
      -- picked whichever of a member's linked accounts had been seen most recently and handed that
      -- one id to every server the offer covered — so a purchase reaching the Vietnam server sent it
      -- a WW2 id, which the server accepted and matched against nobody.
      --
      -- Stamped at creation from the server that saw them, and never changed after: an account
      -- cannot migrate between games. Existing rows are WW2 — this app ran nothing else until
      -- HLL: Vietnam.
      --
      -- platform_id stays the SOLE identity key, deliberately. Migration 041 un-forked players who
      -- had split into twin rows, and keying on (game, platform_id) would re-fork them to no
      -- purpose: the two games draw their ids from different namespaces, so they cannot collide.
      ALTER TABLE players ADD COLUMN IF NOT EXISTS game text NOT NULL DEFAULT 'hll';
      CREATE INDEX IF NOT EXISTS players_game_idx ON players (game);
    `,
  },
  {
    id: "029_refile_players_by_sighting",
    sql: `
      -- 028 stamped every existing player row 'hll', which was right for almost all of them and
      -- wrong for exactly the rows that made the column necessary: players already seen on an
      -- HLL: Vietnam server before the column existed. Their game is fixed at creation and never
      -- updated by later sightings, so left as 'hll' they would be wrong forever — every one of
      -- them told "no Vietnam account linked" by the VIP shop while standing on the Vietnam server.
      --
      -- The database already knows where each of them was seen: career stats, sessions and VIP
      -- grants all name the server, and the server names its game. But the evidence must be read
      -- with the ORIGINAL identity bug in mind. Before the EOS fix, a Steam player on the Vietnam
      -- server was keyed by their Steam64 — the WW2 namespace — which merged their Vietnam
      -- sightings into their WW2 row. Such a row must STAY 'hll': it is a real WW2 account, its
      -- Vietnam evidence is contamination from the bug, and flipping it would break the WW2 VIP
      -- grants it actually can carry. The corrected identity never keys a Vietnam account by a
      -- Steam64, so their real Vietnam row (EOS-keyed) appears on its own the next time they play.
      --
      -- So a row is re-filed to 'hllv' only when ALL THREE hold: it has Vietnam evidence, it has
      -- NO WW2 evidence, and its platform_id is not Steam64-shaped. Console and Epic players'
      -- Vietnam rows (always EOS-keyed, even under the bug) pass; merged Steam rows and every
      -- ordinary WW2 row do not.
      UPDATE players p SET game = 'hllv'
      WHERE p.game = 'hll'
        AND p.platform_id !~ '^765\\d{14}$'
        AND (
              EXISTS (SELECT 1 FROM player_stats    e JOIN servers s ON s.id = e.server_id
                      WHERE e.player_id = p.id AND s.game = 'hllv')
           OR EXISTS (SELECT 1 FROM player_sessions e JOIN servers s ON s.id = e.server_id
                      WHERE e.player_id = p.id AND s.game = 'hllv')
           -- vips.player_id is the game's own platform id, which pins the row to the game of the
           -- server holding the grant even when neither stats nor sessions exist yet.
           OR EXISTS (SELECT 1 FROM vips            e JOIN servers s ON s.id = e.server_id
                      WHERE e.player_id = p.platform_id AND s.game = 'hllv')
        )
        AND NOT EXISTS (SELECT 1 FROM player_stats    e JOIN servers s ON s.id = e.server_id
                        WHERE e.player_id = p.id AND s.game = 'hll')
        AND NOT EXISTS (SELECT 1 FROM player_sessions e JOIN servers s ON s.id = e.server_id
                        WHERE e.player_id = p.id AND s.game = 'hll')
        AND NOT EXISTS (SELECT 1 FROM vips            e JOIN servers s ON s.id = e.server_id
                        WHERE e.player_id = p.platform_id AND s.game = 'hll');
    `,
  },
  {
    id: "030_indexes_for_the_hot_reads",
    sql: `
      -- The directory's default view — everyone, most recently seen first — had no index behind
      -- its ORDER BY. Postgres therefore visited EVERY player row (each one also running the
      -- per-player stats subquery) to sort the lot and keep 100, on every page view of the
      -- Players tab. With the imported archive's player count that is the difference between a
      -- page and a pause. The index matches the query's exact order (DESC NULLS LAST, id
      -- tiebreak) so the planner can walk it and stop at the page size.
      CREATE INDEX IF NOT EXISTS players_last_seen_idx ON players (last_seen DESC NULLS LAST, id);

      -- A player's VIP grants, looked up by player. The UNIQUE(server_id, player_id) index
      -- serves "this server's list" but not "this player's grants" — player_id is its second
      -- column — so the profile had to fetch every grant in the community to show one person's.
      CREATE INDEX IF NOT EXISTS vips_player_idx ON vips (player_id);
    `,
  },
  {
    id: "031_match_settled_at",
    sql: `
      -- "Has this round's played/won been rolled onto careers" was tracked by appending the word
      -- ' settled' to the result column — the raw MATCH ENDED text the panel shows verbatim, so
      -- every finished round's detail page read "… ALLIED (2 - 3) settled" to staff. Bookkeeping
      -- gets its own column; result goes back to holding only what the game said.
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS settled_at timestamptz;
      UPDATE matches
         SET settled_at = COALESCE(ended_at, created_at),
             result = NULLIF(TRIM(REPLACE(result, ' settled', '')), '')
       WHERE result LIKE '% settled';
    `,
  },
  {
    id: "032_server_streamer_mode",
    sql: `
      -- Streamer mode: answer CRCON's public API names without a login, so a streamer's existing
      -- overlay tool works against this server unchanged (docs/streamer-mode.md). CRCON ships its
      -- public stats ON; we default OFF, because this is the only unauthenticated surface here and
      -- an existing install must not start publishing because it upgraded.
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS streamer_mode boolean NOT NULL DEFAULT false;
    `,
  },
  {
    id: "033_public_stats_identity",
    sql: `
      -- The public stats site (docs/public-stats.md) needs two names the panel never did:
      --   public_slug — the server's address on the site (/stats/<slug>). Staff know what
      --                 "Server 3" means; a player getting a link does not, so the address is a
      --                 word somebody can say out loud. NULL until staff publish the server.
      --   public_name — what the page CALLS it, separate from the staff-facing connection label.
      --                 Doubles as CRCON's short_name in get_public_info (streamer-mode gap 3).
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS public_slug text UNIQUE;
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS public_name text;

      -- CRCON's public API keys past rounds by an autoincrement INTEGER (Maps.id) and its clients
      -- hand that id straight back (get_map_scoreboard?map_id=<int>). Our match ids are UUIDs, so
      -- a strict client doing parseInt got NaN — streamer-mode gap 6. seq is the public alias:
      -- backfilled in start order so history reads chronologically, then sequence-fed for every
      -- round after. The UUID remains the identifier everywhere internal.
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS seq bigint;
      CREATE SEQUENCE IF NOT EXISTS matches_seq;
      UPDATE matches SET seq = numbered.rn
        FROM (SELECT id, row_number() OVER (ORDER BY started_at, id) AS rn FROM matches) AS numbered
       WHERE matches.id = numbered.id AND matches.seq IS NULL;
      SELECT setval('matches_seq', COALESCE((SELECT MAX(seq) FROM matches), 0) + 1, false);
      ALTER TABLE matches ALTER COLUMN seq SET DEFAULT nextval('matches_seq');
      ALTER TABLE matches ALTER COLUMN seq SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS matches_seq_idx ON matches (seq);
    `,
  },
  {
    id: "034_public_player_ids",
    sql: `
      -- Whether the public stats surface publishes a player's PLATFORM ID (Steam64 / EOS)
      -- alongside their name. CRCON's public scoreboard does; we make it a separate decision from
      -- publishing at all, because the two are not the same risk: a scoreboard of names can be
      -- taken down, while ids that have been crawled and indexed cannot be recalled.
      -- Default FALSE — the reversible direction. Staff turn it on per server when they want
      -- full CRCON parity for tools that join on the id. (035 flips this default; see there.)
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS public_player_ids boolean NOT NULL DEFAULT false;
    `,
  },
  {
    id: "035_publish_player_ids_by_default",
    sql: `
      -- CRCON parity wins: every published server carries player_id unless someone says otherwise.
      -- The ids are not novel exposure in practice — a player active on any other community is
      -- already on someone's CRCON stats page, since CRCON publishes them out of the box — and a
      -- consuming tool that cannot join on the id is most of the reason to run the API at all.
      -- The column stays: turning ids off for one server is still one click, which is why this is
      -- a changed DEFAULT rather than a dropped feature.
      ALTER TABLE servers ALTER COLUMN public_player_ids SET DEFAULT true;
      -- Rows that predate the flip. 034 shipped alongside 035 and no server was published under
      -- it, so there is no deliberate "off" here to overwrite.
      UPDATE servers SET public_player_ids = true;
    `,
  },
  {
    id: "036_autosettings_triggers",
    sql: `
      -- Event triggers: one-shot reactions to a player connecting, disconnecting or team-killing
      -- (welcome message after 30s, crash VIP on disconnect, N team-kills in a window). A jsonb
      -- list on the same auto-settings row as the profiles and player-rule modules, because it is
      -- the same idea — watch the server, act — and the worker already reads this row every tick.
      ALTER TABLE autosettings_config ADD COLUMN IF NOT EXISTS triggers jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    id: "037_triggers_live_in_the_rules_engine",
    sql: `
      -- 036 grew a SECOND event-trigger system beside the one the app already had: the Rules
      -- engine (enforcer_rules) is "when an event happens, act on that player", and that is where
      -- staff went looking for connect/disconnect triggers, delays and crash VIP. One idea, one
      -- home — the parallel list is dropped (it shipped hours earlier; nothing durable used it)
      -- and the rules gain the three capabilities it was built for:
      --   delay_sec         wait before acting (a welcome 30s in, a kick if they're still here);
      --   vip_minutes       the "vip" action's duration — crash VIP on a disconnect;
      --   require_role_ids  only fire for players linked to a community-Discord member holding
      --                     one of these roles (empty = everyone), the VIP panel's gate shape.
      ALTER TABLE autosettings_config DROP COLUMN IF EXISTS triggers;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS delay_sec integer NOT NULL DEFAULT 0;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS vip_minutes integer NOT NULL DEFAULT 10;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS require_role_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    id: "038_crash_vip_cooldown",
    sql: `
      -- Crash VIP had no rate limit. The grant is an absolute set (expires at now + vip_minutes,
      -- never additive), so it could not be stacked into hours — but nothing stopped a player from
      -- re-triggering it. With a 10-minute grant, disconnecting every 9 minutes rolled the expiry
      -- forward forever: a permanent queue skip, farmed. This is the frequency limit.
      --
      -- The grants are a TABLE rather than a map in the enforcer's memory because the cooldown is
      -- the farm defence, and an in-memory one resets on every deploy or restart — exactly the
      -- window someone farming it would learn to use. The kick/ban memory beside it can afford to
      -- be in-memory (missing it just grants a VIP someone was owed anyway); this cannot.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS vip_cooldown_minutes integer NOT NULL DEFAULT 60;

      -- One row per (rule, server, player): the last time this rule granted them a crash VIP.
      -- player_id is the raw game id, matching vips — the durable identity across name changes.
      -- Dropping a rule drops its cooldowns with it, so a rebuilt rule starts everyone clean.
      CREATE TABLE IF NOT EXISTS enforcer_vip_grants (
        rule_id    uuid NOT NULL REFERENCES enforcer_rules(id) ON DELETE CASCADE,
        server_id  uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        player_id  text NOT NULL,
        granted_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (rule_id, server_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS enforcer_vip_grants_granted_at_idx ON enforcer_vip_grants (granted_at);
    `,
  },
  {
    id: "039_split_bundled_capabilities",
    sql: `
      -- Eleven permissions each bundled several jobs, so the most dangerous member of a bundle set
      -- the floor for the whole thing: you could not let somebody tag players without also letting
      -- them rewrite player identities, or read the ban record without also letting them adopt the
      -- game's entire ban list. CAPABILITY_SPLITS in @app/access is the map and the reasoning.
      --
      -- This carries every existing grant across. For each stored grant of a bundled key the same
      -- user (or role) gets the same scope and level on each key it split into, so nobody loses
      -- access and nothing has to be re-granted by hand. Four keys KEPT their name
      -- (mapvote.config, server.config, moderation.bans, server.manage) and only gained siblings;
      -- their own rows are already right and are left alone.
      --
      -- The retired rows are then deleted rather than kept as aliases. An alias would quietly
      -- outrank the editor: unticking "Player tags" would revoke nothing, because the invisible old
      -- grant would still confer it. A permission that cannot be taken away is not a permission.

      WITH split(old_key, new_key) AS (VALUES
        ('player.flags','player.watchlist'), ('player.flags','player.tags'), ('player.flags','player.links'),
        ('maps.control','maps.next'), ('maps.control','maps.rotation'), ('maps.control','maps.names'),
        ('mapvote.config','mapvote.control'),
        ('autosettings.config','autosettings.profiles'), ('autosettings.config','autosettings.rules'), ('autosettings.config','autosettings.templates'),
        ('economy.manage','economy.config'), ('economy.manage','economy.shop'), ('economy.manage','economy.balances'),
        ('crcon.import','crcon.pull'), ('crcon.import','crcon.apply'),
        ('staff.analytics','audit.trail'), ('staff.analytics','staff.profiles'),
        ('discord.config','discord.relay'),
        ('moderation.bans','moderation.bans.sync'),
        ('server.manage','server.add')
      )
      INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level)
      SELECT gen_random_uuid(), g.user_id, s.new_key, g.scope_type, g.scope_id, g.level
      FROM grants g
      JOIN split s ON s.old_key = g.capability
      -- Idempotent, and never clobbers a grant somebody already made on the new key by hand.
      WHERE NOT EXISTS (
        SELECT 1 FROM grants x
        WHERE x.user_id = g.user_id AND x.capability = s.new_key
          AND x.scope_type = g.scope_type AND x.scope_id IS NOT DISTINCT FROM g.scope_id
      );

      -- Roles keep their grants as a jsonb array (roles are global-scope), so the same expansion has
      -- to happen inside the document. The LEFT JOIN does it: an entry naming a bundled key fans out
      -- into one row per new key, an entry naming anything else falls through unchanged. The four
      -- retained keys are listed mapping to THEMSELVES as well, so they survive the rebuild.
      WITH split(old_key, new_key) AS (VALUES
        ('player.flags','player.watchlist'), ('player.flags','player.tags'), ('player.flags','player.links'),
        ('maps.control','maps.next'), ('maps.control','maps.rotation'), ('maps.control','maps.names'),
        ('mapvote.config','mapvote.config'), ('mapvote.config','mapvote.control'),
        ('autosettings.config','autosettings.profiles'), ('autosettings.config','autosettings.rules'), ('autosettings.config','autosettings.templates'),
        ('economy.manage','economy.config'), ('economy.manage','economy.shop'), ('economy.manage','economy.balances'),
        ('crcon.import','crcon.pull'), ('crcon.import','crcon.apply'),
        ('staff.analytics','audit.trail'), ('staff.analytics','staff.profiles'),
        ('discord.config','discord.relay'),
        ('moderation.bans','moderation.bans'), ('moderation.bans','moderation.bans.sync'),
        ('server.manage','server.manage'), ('server.manage','server.add')
      ),
      expanded AS (
        SELECT r.id AS role_id,
               COALESCE(s.new_key, e.entry->>'capability') AS cap,
               e.entry->>'level' AS lvl
        FROM roles r
        CROSS JOIN LATERAL jsonb_array_elements(r.grants) AS e(entry)
        LEFT JOIN split s ON s.old_key = e.entry->>'capability'
      )
      UPDATE roles SET grants = agg.new_grants
      FROM (
        SELECT role_id, jsonb_agg(DISTINCT jsonb_build_object('capability', cap, 'level', lvl)) AS new_grants
        FROM expanded GROUP BY role_id
      ) agg
      WHERE roles.id = agg.role_id;

      -- Only the seven keys that no longer exist at all; the four that kept their name stay put.
      DELETE FROM grants WHERE capability IN (
        'player.flags','maps.control','autosettings.config','economy.manage','crcon.import','staff.analytics','discord.config'
      );
      UPDATE roles SET grants = COALESCE((
        SELECT jsonb_agg(e.entry) FROM jsonb_array_elements(grants) AS e(entry)
        WHERE e.entry->>'capability' NOT IN (
          'player.flags','maps.control','autosettings.config','economy.manage','crcon.import','staff.analytics','discord.config'
        )
      ), '[]'::jsonb);
    `,
  },
  {
    id: "040_servers_remember_their_env_slot",
    sql: `
      -- Which SERVER_<n>_* block in the environment seeded this server.
      --
      -- Env discovery recognised an already-known server by its host and port, which made the
      -- ADDRESS the server's identity. It is not: a host can move a server to a new ip, port and
      -- password and it is still the same server, with the same records, bans, stats and settings —
      -- only its "face" changed. Under the old rule, changing that face made the server unknown, so
      -- the next boot re-seeded the env entry as a SECOND, empty server while the real one sat
      -- unreachable beside it, holding all the history.
      --
      -- The slot number is the stable identity instead: SERVER_2 seeds one server, forever, wherever
      -- that server subsequently lives. Discovery adopts the slot onto servers it already matches by
      -- address, so an install that has never moved a server is stamped on its next boot and is
      -- protected from then on. NULL means "not from the env" — added through the panel, and no
      -- concern of discovery at all.
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS seed_slot integer;
      -- One slot seeds one server. Partial, because the many panel-added servers are all NULL and
      -- NULLs must not collide with each other.
      CREATE UNIQUE INDEX IF NOT EXISTS servers_seed_slot_key ON servers (seed_slot) WHERE seed_slot IS NOT NULL;
    `,
  },
  {
    id: "041_servers_remember_whether_they_answer",
    sql: `
      -- Whether the panel can actually reach this server.
      --
      -- The app dials every server constantly and threw the result away. When a host rotated one
      -- server's RCON password, every read and every write to it failed authentication for DAYS
      -- while the Connections screen showed it ACTIVE beside two healthy servers — the only trace
      -- was a WARN line in a container log nobody reads. It surfaced when a ban dialog happened to
      -- throw the error at somebody. A server that cannot be reached is the single most important
      -- fact about it, and it was the one fact the app declined to keep.
      --
      -- last_contact_at is the last time a connection SUCCEEDED; last_error/last_error_at are the
      -- most recent failure, cleared on the next success. Both together, rather than a single
      -- status: "failing now, but it worked an hour ago" and "failing now, and never once worked"
      -- are different problems, and only the pair can tell them apart.
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS last_contact_at timestamptz;
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS last_error      text;
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS last_error_at   timestamptz;
    `,
  },
  {
    id: "042_roster_snapshots_carry_the_score",
    sql: `
      -- The score at each sample, which turns the per-minute population series into a score
      -- TIMELINE — CRCON's \`cap_flips\` (a list of {ts, allied_score, axis_score}) and the one
      -- field of get_public_info that had no source.
      --
      -- On the existing sampler rather than a new table on purpose: it already runs once a minute
      -- per server and already holds the session read the score comes from, so this costs two
      -- columns and no extra RCON traffic. Null on every row written before this migration, which
      -- is honest — those samples genuinely did not record a score, and a zero would claim they did.
      ALTER TABLE roster_snapshots ADD COLUMN IF NOT EXISTS allied_score int;
      ALTER TABLE roster_snapshots ADD COLUMN IF NOT EXISTS axis_score   int;
    `,
  },
  {
    id: "043_the_public_api_stops_discarding_what_rcon_sends",
    sql: `
      -- Three fields CRCON publishes that we answered blank, every one of them ALREADY decoded by
      -- our own protocol layer (V2PlayerStats / V2PlayerInfo) and then dropped between the game
      -- read and this table. Nothing new is asked of RCON here; the wire already carries all of it.

      -- kills_and_assists / deaths_and_redeploys are the GAME's own per-player counters, which are
      -- not the kills/deaths beside them: the game's kill counter also moves on an assist and its
      -- death counter on a redeploy, which is why CRCON stores both pairs and names them apart
      -- (rcon/logs/loop.py sets kills_and_assists = current["kills"]).
      --
      -- The _prev columns hold the total from BEFORE the player's last reconnect. The game resets a
      -- player's counters when they rejoin mid-round, so the published figure is prev + current --
      -- CRCON's p_ fields do the same job. Without them a reconnect erases the player's round.
      ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS kills_and_assists         int NOT NULL DEFAULT 0;
      ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS kills_and_assists_prev    int NOT NULL DEFAULT 0;
      ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS deaths_and_redeploys      int NOT NULL DEFAULT 0;
      ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS deaths_and_redeploys_prev int NOT NULL DEFAULT 0;

      -- units: the (team, squad, role) legs a player held this round, appended when the triple
      -- CHANGES rather than once per sample. JSON because every number in it is the GAME's own, the
      -- same reason composition is JSON on roster_snapshots.
      ALTER TABLE player_match_stats ADD COLUMN IF NOT EXISTS units jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    id: "044_bulk_payouts_are_jobs_with_receipts",
    sql: `
      -- Bulk payout (docs/bulk-payout.md): paying N people is a JOB with per-person receipts,
      -- not a loop in a request handler. The job row is the summary; the items are the truth.
      -- Its safety properties: a duplicate key so the
      -- same payout cannot run twice, per-recipient before/after so "did Dave get his 30 days"
      -- has an answer, and continue-past-failure so one bad grant does not strand ninety-nine.
      CREATE TABLE IF NOT EXISTS payout_jobs (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        -- Where the candidates came from: linked | online | window | retry, with its parameters.
        source_type    text NOT NULL,
        source_ref     jsonb NOT NULL DEFAULT '{}'::jsonb,
        payout_type    text NOT NULL CHECK (payout_type IN ('currency','vip')),
        amount         int  NOT NULL CHECK (amount > 0),
        -- VIP target servers. Empty for currency, which is a community-wide balance.
        server_ids     jsonb NOT NULL DEFAULT '[]'::jsonb,
        audience       text NOT NULL DEFAULT 'linked',
        dry_run        boolean NOT NULL DEFAULT false,
        -- RUNNING -> COMPLETE | COMPLETE_WITH_FAILURES; INTERRUPTED when a restart orphaned it.
        -- An interrupted job's items say exactly who was reached; retry covers the rest.
        status         text NOT NULL,
        requested_by_user_id uuid,
        requested_by_name    text NOT NULL DEFAULT '',
        created_at     timestamptz NOT NULL DEFAULT now(),
        completed_at   timestamptz,
        total_count    int NOT NULL DEFAULT 0,
        success_count  int NOT NULL DEFAULT 0,
        failed_count   int NOT NULL DEFAULT 0,
        -- The duplicate key: same source, kind, amount, servers and people = same key. Checked
        -- before a real run so a double-click or a re-run after a restart is refused, never paid.
        duplicate_key  text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payout_jobs_created_idx ON payout_jobs (created_at DESC);
      CREATE INDEX IF NOT EXISTS payout_jobs_dupe_idx ON payout_jobs (duplicate_key) WHERE NOT dry_run;

      -- One row per person per job — written AS the run progresses, so a crash mid-run leaves a
      -- ledger of exactly who was reached rather than a mystery. detail carries the before/after
      -- (balance for currency; per-server expirations for VIP) as jsonb because its shape follows
      -- the payout type.
      CREATE TABLE IF NOT EXISTS payout_items (
        id           BIGSERIAL PRIMARY KEY,
        job_id       uuid NOT NULL REFERENCES payout_jobs(id) ON DELETE CASCADE,
        player_id    uuid,
        discord_id   text,
        display_name text NOT NULL DEFAULT '',
        status       text NOT NULL CHECK (status IN ('PASS','FAIL')),
        error        text NOT NULL DEFAULT '',
        detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS payout_items_job_idx ON payout_items (job_id, id);
    `,
  },
  {
    id: "045_payout_events_resolve_their_own_boundaries",
    sql: `
      -- Named payout windows (docs/bulk-payout.md, event windows). Each boundary is either a hard time
      -- ('at': the anchor IS the boundary) or the next match boundary at/after the anchor
      -- ('match_start_after' / 'match_end_after': "start with the first new round after 8pm",
      -- "end when the round being played at 11pm finishes"). Presence comes from player_sessions
      -- which records regardless, so this table only decides WHEN the window is — a sweep that
      -- runs late resolves the same boundaries it would have live. anchors are the CONFIGURED
      -- times; opened_at/closed_at are the RESOLVED boundaries, null until known.
      CREATE TABLE IF NOT EXISTS payout_events (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name          text NOT NULL,
        server_id     uuid NOT NULL,
        status        text NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled','open','closed','cancelled')),
        open_mode     text NOT NULL CHECK (open_mode IN ('at','match_start_after')),
        open_anchor   timestamptz NOT NULL,
        opened_at     timestamptz,
        close_mode    text NOT NULL CHECK (close_mode IN ('at','match_end_after')),
        close_anchor  timestamptz NOT NULL,
        closed_at     timestamptz,
        -- Present at least this long to count, minutes. Copied onto the payout as its default.
        min_minutes   int NOT NULL DEFAULT 0,
        -- The recipient list materialised AT CLOSE ([{playerId, name, minutes}]) so the event
        -- outlives session trimming — the plan's retention caveat. Null until closed.
        roster        jsonb,
        created_by    text NOT NULL DEFAULT '',
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS payout_events_created_idx ON payout_events (created_at DESC);
      -- The sweep's working set: everything not yet closed/cancelled.
      CREATE INDEX IF NOT EXISTS payout_events_pending_idx ON payout_events (server_id)
        WHERE status IN ('scheduled','open');
    `,
  },
  {
    id: "046_events_can_pin_a_map_vote_profile",
    sql: `
      -- An event may pin one of its server's map-vote profiles for as long as it is OPEN: while
      -- pinned, the vote composes from that profile's pool instead of whatever the schedule would
      -- have chosen. Stored as the profile NAME (profiles live inside the map-vote config jsonb
      -- and have no id of their own); a name that no longer exists simply stops pinning, which
      -- the resolver treats as "fall back to the schedule" rather than an error.
      ALTER TABLE payout_events ADD COLUMN IF NOT EXISTS map_vote_profile text;
    `,
  },
  {
    id: "047_a_round_remembers_which_game_it_was_played_on",
    sql: `
      -- A round's map name only means something against a game's catalogue, and the round asked
      -- its SERVER which game that was — i.e. whichever game the server runs TODAY. Switch a
      -- server from WW2 to Vietnam (or rebuild it the other way) and every round already on
      -- record starts being read against the wrong catalogue: wrong factions, wrong layer, a
      -- Vietnam map resolving to a placeholder or, worse, to a plausible WW2 one.
      --
      -- CRCON fixed exactly this in v12.1.1 (parse_recorded_layer): "Every row carries the game it
      -- belongs to, so historical records stay correct even after a server switches games." This
      -- is that row. Backfilled from the server's current game, which is the best answer available
      -- for rounds recorded before the column existed and the right one for every server that has
      -- never switched.
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS game text;
      UPDATE matches m SET game = s.game FROM servers s WHERE m.server_id = s.id AND m.game IS NULL;
    `,
  },
  {
    id: "048_a_roster_sample_remembers_which_game_it_was_taken_on",
    sql: `
      -- The same fault as 047, one table over. composition stores RAW ROLE NUMBERS, and a role
      -- number only means something against a game: 13 is "Commander" in HLL and "Mortar Support"
      -- in Vietnam, 5 is "Support" against "Specialist", 7 "Anti-Tank" against "Grenadier". The
      -- composition page labels a whole window using the descriptor of whatever game the server
      -- runs TODAY, so a server that changed games has its old samples relabelled into a
      -- vocabulary they were never counted in — and, worse, samples from both games folded into
      -- one distribution where the same number means two different roles.
      --
      -- Recording the game per sample makes that expressible: the fold can take only the samples
      -- that match the labels it is about to send.
      ALTER TABLE roster_snapshots ADD COLUMN IF NOT EXISTS game text;
      UPDATE roster_snapshots rs SET game = s.game FROM servers s
        WHERE rs.server_id = s.id AND rs.game IS NULL;
    `,
  },
  {
    id: "049_seeding_owns_its_weapon_rules",
    sql: `
      -- Seeding enforcement lived in two places: the Seeding automation (roles, rewards, phases)
      -- and a separate "Seeding rules" rule module (weapons), each with its own threshold, its own
      -- dry-run flag and its own escalation ladder. Two pages that both claim to govern the same
      -- window of the same evening is how one of them ends up configured and the other trusted.
      -- Weapons move into the seeding config: one page, one phase machine, one ladder.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS disallowed_weapon_classes jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS disallowed_weapons        jsonb NOT NULL DEFAULT '[]'::jsonb;

      -- Carry over what the retired module was configured with, so a community that had typed a
      -- weapon list does not silently lose it. The module stored free-text substrings; they land
      -- in disallowed_weapons and keep matching exactly as before (the class chips are additive).
      -- Nothing is auto-ENABLED here: the module also needed its own switch on, and whether weapon
      -- enforcement should run is now the seeding automation's switch — flipping that on for
      -- someone is a policy change no migration should make.
      INSERT INTO seeding_config (server_id, disallowed_weapons)
      SELECT ac.server_id,
             (SELECT coalesce(jsonb_agg(DISTINCT upper(btrim(tok))), '[]'::jsonb)
                FROM unnest(string_to_array(replace(ac.modules->'seeding_rules'->'config'->>'disallowedWeapons', E'\n', ','), ',')) AS tok
               WHERE btrim(tok) <> '')
        FROM autosettings_config ac
       WHERE coalesce(btrim(ac.modules->'seeding_rules'->'config'->>'disallowedWeapons'), '') <> ''
      ON CONFLICT (server_id) DO UPDATE SET disallowed_weapons = EXCLUDED.disallowed_weapons
        WHERE seeding_config.disallowed_weapons = '[]'::jsonb;
    `,
  },
  {
    id: "050_a_rule_can_escalate_instead_of_being_three_rules",
    sql: `
      -- A rule fired the same action forever, so "warn first, punish the second time, kick the
      -- third" meant three rules with staggered thresholds that had to be kept in step by hand —
      -- and drifted, because nothing said they belonged together. The follow-up actions live ON
      -- the rule: its own action is the first offence, these are the repeats.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS escalate_actions jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS escalate_reset_minutes integer NOT NULL DEFAULT 120;
    `,
  },
  {
    id: "051_seeding_can_name_the_one_overpowered_gun",
    sql: `
      -- The class chips ban whole families ("no artillery"), but some weapons are overpowered on
      -- a quiet server while the rest of their class is fine — that needs INDIVIDUAL weapon names,
      -- picked from the game's own kill-log weapon table rather than typed. And the commander's
      -- kill abilities (bombing run, strafing run, precision strike) are their own lever, not one
      -- more gun: staff reason "no commander strikes while seeding", so they get their own column
      -- instead of hiding inside a weapon list.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS disallowed_weapon_names        jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS disallowed_commander_abilities jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    id: "052_a_preset_remembers_which_game_it_was_saved_from",
    sql: `
      -- Same fault family as 047/048, in the presets: a seeding or map-vote preset is raw role
      -- numbers, weapon names and map ids — one game's vocabulary — but presets are community-wide
      -- and applied to any server. Save one from an HLL server, apply it to a Vietnam server, and
      -- role 13 stops meaning Commander and starts meaning Mortar Support: the automod enforces a
      -- policy nobody wrote. The preset records its source game so game-scoped applies can refuse.
      -- Existing rows stay NULL (unknown, allowed through) — refusing them would brick every
      -- preset saved before this column, and single-game installs were never at risk.
      ALTER TABLE feature_presets ADD COLUMN IF NOT EXISTS game text;
    `,
  },
  {
    id: "053_a_rule_decides_whether_it_is_worth_a_ping",
    sql: `
      -- The Discord "automation" alert was all-or-nothing: every player rule that fired pinged the
      -- same channel. That is one appetite applied to rules with wildly different firing rates —
      -- an idle-kick going off forty times a night is what makes somebody mute the channel, and
      -- muting it takes the twice-a-week temp bans with it. The choice belongs on the rule.
      --
      -- Backfilled TRUE: today every rule pings, and a migration that quietly silenced somebody's
      -- ban alerts would be discovered the hard way. Turning one off is now a decision, made once,
      -- on the rule that is being noisy.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS alert_enabled boolean NOT NULL DEFAULT true;
    `,
  },
  {
    id: "054_seeding_holds_the_line_at_the_middle_cap",
    sql: `
      -- CRCON's third seeding rule, the one the port missed: enforce the cap fight. Roles and
      -- weapons were carried over in 049; this is the rule that stops the winning team pushing
      -- into the 4th point while the server fills. Detection is CRCON's own (seeding_rules.py,
      -- v12.1.1): in WARFARE the team scores are caps held, so a team at max_caps whose player's
      -- offense score keeps climbing has that player standing in the enemy cap. Offensive mode's
      -- scores mean something else, so the rule stands down there rather than firing on garbage.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS cap_fight_enabled      boolean NOT NULL DEFAULT false;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS cap_fight_max_caps     integer NOT NULL DEFAULT 3;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS cap_fight_skip_warning boolean NOT NULL DEFAULT false;
    `,
  },
  {
    id: "055_rules_pick_their_own_alert_channel",
    sql: `
      -- Per-rule Discord alert destination. One shared "Player rules firing" channel meant every
      -- rule's ping competed for the same room — the noisy idle-kick rule got the channel muted
      -- and took the temp bans with it. NULL = the shared channel, exactly as before.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS alert_channel_id text;
    `,
  },
  {
    id: "056_rules_can_exempt_and_rehearse",
    sql: `
      -- Parity with the other three enforcement systems. Seeding and the rule modules have always
      -- carried immunity and a dry-run of their own; the rule engine — the one that can tempban,
      -- permaban and escalate — had neither, so it could not be told to leave staff alone and
      -- could only be rehearsed by putting the WHOLE server in observe mode.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS immune_tags     jsonb   NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS immune_role_ids jsonb   NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS dry_run         boolean NOT NULL DEFAULT false;
    `,
  },
  {
    id: "057_players_remember_their_level",
    sql: `
      -- The one thing about a player the app kept reading and never keeping. Level arrives on
      -- every roster read (the live view, the seeding runner, the stats sampler all parse it) and
      -- was thrown away each time, so the only enforcement surface that could act on it was the
      -- one holding a live roster in its hand. NULL = never seen on a roster yet, which is a
      -- different answer from level 0 and has to stay tellable apart.
      ALTER TABLE players ADD COLUMN IF NOT EXISTS level integer;
      -- …and the exemption it unlocks: the gate seeding and the rule modules have always had.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS immune_level integer NOT NULL DEFAULT 0;
    `,
  },
  {
    id: "058_welcome_vip_marker_survives_a_trim",
    sql: `
      -- plugin_kv is scratch and is aged out by write time — except this row, which records that a
      -- member's welcome VIP DAYS have already been paid. It has no expiry and no repair path, so
      -- a routine data trim with a cutoff older than someone's registration deleted the only thing
      -- standing between them and a second helping. The 'keep:' prefix marks a row the retention
      -- sweep never collects (PERMANENT_KV_PREFIX); the markers already banked are renamed onto it
      -- so nobody is paid twice for having registered before this shipped.
      UPDATE plugin_kv
         SET key = 'keep:' || key
       WHERE namespace = 'vip-registration'
         AND key LIKE 'daysBonus:%'
         AND key NOT LIKE 'keep:%';
    `,
  },
  {
    id: "059_events_post_themselves_to_discord",
    sql: `
      -- The self-sending events post: one community-wide row, same singleton shape as the
      -- announcement nudge beside it. last_posted_on is the once-a-day latch (a LOCAL date in the
      -- community zone, so it is a date string rather than a timestamp — "did Monday's post go
      -- out" is a question about Monday, not about an instant).
      CREATE TABLE IF NOT EXISTS event_post_config (
        singleton      boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        enabled        boolean NOT NULL DEFAULT false,
        channel_id     text    NOT NULL DEFAULT '',
        days_ahead     int     NOT NULL DEFAULT 14,
        weekday        int     NOT NULL DEFAULT 1,
        at_hour        int     NOT NULL DEFAULT 9,
        at_minute      int     NOT NULL DEFAULT 0,
        last_posted_on text,
        updated_at     timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO event_post_config (singleton) VALUES (true) ON CONFLICT DO NOTHING;
    `,
  },
  {
    id: "060_payout_base_amount_may_be_unused",
    sql: `
      -- A role-tiered payout where every tier carries its own amount never reads the base amount,
      -- so there is nothing to put in this column but zero. The CHECK dated from before tiers
      -- existed, when the amount WAS the payout and zero could only be a mistake; it now refuses
      -- the one shape a tiered payout is most naturally built in. Zero is still refused where the
      -- base actually pays somebody — that rule moved to where it can tell the difference
      -- (validateExecution), which a column constraint cannot.
      ALTER TABLE payout_jobs DROP CONSTRAINT IF EXISTS payout_jobs_amount_check;
      ALTER TABLE payout_jobs ADD CONSTRAINT payout_jobs_amount_check CHECK (amount >= 0);
    `,
  },
  {
    id: "061_xbox_ids_stop_wearing_a_steam_label",
    sql: `
      -- The Vietnam wire calls its companion-id field "steamId" for everyone, and the identity
      -- capture filed whatever it carried under provider 'steam' — including console players'
      -- Xbox XUIDs (16 digits in the 25332… range), which are not Steam ids and never were. The
      -- profile then printed an Xbox account id under a STEAM heading, and the cross-game account
      -- join, which matches on (provider, id), could never meet the same XUID filed correctly.
      -- The capture now decides the provider by shape; this refiles what it already wrote.
      -- (player_id, provider) is the primary key, so a player somehow holding a real 'xbox' row
      -- already keeps it and the mislabeled duplicate is dropped rather than collided with.
      UPDATE external_links el SET provider = 'xbox'
        WHERE el.provider = 'steam' AND el.external_id ~ '^25332\\d{11}$'
          AND NOT EXISTS (SELECT 1 FROM external_links x WHERE x.player_id = el.player_id AND x.provider = 'xbox');
      DELETE FROM external_links WHERE provider = 'steam' AND external_id ~ '^25332\\d{11}$';

      -- The reverse account lookup ("which rows carry THIS id, whatever namespace it was filed
      -- under") reads by external_id alone; the existing (provider, external_id) index cannot
      -- serve a lookup that skips its leading column.
      CREATE INDEX IF NOT EXISTS external_links_external_id_idx ON external_links (external_id);
    `,
  },
  {
    id: "062_the_scoreboard_labels_were_never_a_winner",
    sql: `
      -- The modern game ends a round with "MATCH ENDED \`Kharkov Warfare\` ALLIED (2 - 3) AXIS":
      -- BOTH sides appear, flanking the score as column labels, and no winner is named at all.
      -- The parser read the first side token as the winner, so every such round was recorded as
      -- an Allied win — a 122–0 "season" — and settled onto careers that way. The parser now
      -- reads the flanked shape correctly; this repairs what the old one wrote. The stored result
      -- text is the proof of shape, so only rounds that demonstrably carried both labels are
      -- touched — a legacy line naming one side really did name the winner, and stays.

      -- 1. A flanked line's score was also invisible to the old end-anchored regex; where the raw
      -- text still holds "(a - b)" and no sampled score survived, read it back.
      UPDATE matches SET
        allied_score = COALESCE(allied_score, (regexp_match(result, '\\((\\d+)\\s*[-–]\\s*(\\d+)\\)'))[1]::int),
        axis_score   = COALESCE(axis_score,   (regexp_match(result, '\\((\\d+)\\s*[-–]\\s*(\\d+)\\)'))[2]::int)
      WHERE ended_at IS NOT NULL AND result ~ '\\(\\d+\\s*[-–]\\s*\\d+\\)'
        AND (allied_score IS NULL OR axis_score IS NULL);

      -- 2. Re-derive the winner of every flanked round from its score (null when tied or unknown),
      -- flip the per-player won flags with it, and settle the difference back onto careers — a
      -- round already rolled onto player_stats credited a win to the wrong hundred people.
      WITH changed AS (
        SELECT id, winner AS old_winner,
               CASE WHEN allied_score IS NULL OR axis_score IS NULL THEN NULL
                    WHEN allied_score > axis_score THEN 'allies'
                    WHEN allied_score < axis_score THEN 'axis'
                    ELSE NULL END AS new_winner,
               settled_at
          FROM matches
         WHERE ended_at IS NOT NULL AND result IS NOT NULL
           AND ((result ~* '\\mALLI(ED|ES)\\M' AND result ~* '\\mAXIS\\M')
             OR (result ~* '\\m(US|SOUTH)\\M' AND result ~* '\\m(NVA|NORTH)\\M'))
      ), flips AS (
        SELECT * FROM changed WHERE new_winner IS DISTINCT FROM old_winner
      ), fixed_matches AS (
        UPDATE matches m SET winner = f.new_winner FROM flips f WHERE m.id = f.id
      ), delta AS (
        SELECT s.match_id, s.player_id, s.server_id, s.won AS old_won,
               CASE WHEN f.new_winner IS NULL OR s.side IS NULL THEN NULL
                    ELSE (s.side = f.new_winner) END AS new_won,
               f.settled_at
          FROM player_match_stats s JOIN flips f ON f.id = s.match_id
      ), fixed_rows AS (
        UPDATE player_match_stats s SET won = d.new_won, updated_at = now()
          FROM delta d
         WHERE s.match_id = d.match_id AND s.player_id = d.player_id
      )
      UPDATE player_stats ps
         SET matches_won = GREATEST(0, ps.matches_won + agg.diff), updated_at = now()
        FROM (
          SELECT d.player_id, d.server_id,
                 SUM((d.new_won IS TRUE)::int - (d.old_won IS TRUE)::int)::int AS diff
            FROM delta d
           WHERE d.settled_at IS NOT NULL
           GROUP BY d.player_id, d.server_id
        ) agg
       WHERE ps.player_id = agg.player_id AND ps.server_id = agg.server_id AND agg.diff <> 0;
    `,
  },
  {
    id: "063_a_watch_is_made_of_reasons",
    sql: `
      -- A watch used to be a boolean with ONE reason field: a second staff member's concern
      -- either overwrote the first or went unrecorded, and the only way to note something about
      -- an already-watched player was to remove the watch and re-add it. Reasons become rows:
      -- added independently, closed independently (never deleted), each with its own optional
      -- expiry, prior versions archived on the row when edited. player_flags.watchlist stays as
      -- the cache every consumer reads; the service layer keeps it in sync with "any active
      -- reason". watch_history keeps its spell-level story unchanged.
      CREATE TABLE IF NOT EXISTS watch_reasons (
        id         uuid PRIMARY KEY,
        player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        reason     text NOT NULL,
        added_by   text,
        added_at   timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz,
        removed_by text,
        removed_at timestamptz,
        edits      jsonb NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE INDEX IF NOT EXISTS watch_reasons_player_idx ON watch_reasons (player_id);

      -- Every currently-watched player's stored reason becomes their first reason row, carrying
      -- its original author and time, so no live watch arrives in the new world empty.
      INSERT INTO watch_reasons (id, player_id, reason, added_by, added_at)
      SELECT gen_random_uuid(), f.player_id, COALESCE(f.watch_reason, 'on the watchlist'),
             f.watch_by, COALESCE(f.watch_at, f.updated_at, now())
        FROM player_flags f
       WHERE f.watchlist
         AND NOT EXISTS (SELECT 1 FROM watch_reasons r WHERE r.player_id = f.player_id);
    `,
  },
  {
    id: "064_watch_curation_is_its_own_grant",
    sql: `
      -- Adding a concern and rewriting the watch RECORD are different trusts, split the same way
      -- the eleven bundles in 039 were: player.watchlist write now only adds reasons and edits
      -- its own; editing or removing OTHER staff's reasons — and lifting a watch — moves to
      -- player.watchlist.curate. Removal is curate-only even for your own rows, by request:
      -- what went into the record stays until someone trusted with the record says otherwise.

      -- "Your own" needs identity, not a display name: added_by is the name as it read that day,
      -- and names change. New rows carry the author's account id; old rows stay null, which
      -- reads as "not provably yours" — a curator can still edit them.
      ALTER TABLE watch_reasons ADD COLUMN IF NOT EXISTS added_by_user_id uuid;

      -- Nobody loses access on upgrade: every write-level watchlist grant fans out a curate twin
      -- at the same scope, and a 'none' veto fans out its veto, so a silencer keeps silencing.
      -- Read-level grants confer nothing curate-shaped and are left alone.
      INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level)
      SELECT gen_random_uuid(), g.user_id, 'player.watchlist.curate', g.scope_type, g.scope_id, g.level
        FROM grants g
       WHERE g.capability = 'player.watchlist' AND g.level IN ('write', 'none')
         AND NOT EXISTS (
           SELECT 1 FROM grants x
           WHERE x.user_id = g.user_id AND x.capability = 'player.watchlist.curate'
             AND x.scope_type = g.scope_type AND x.scope_id IS NOT DISTINCT FROM g.scope_id
         );

      -- Role documents the same way: a role that carried watchlist write gains the curate twin.
      UPDATE roles
         SET grants = grants || jsonb_build_array(jsonb_build_object('capability', 'player.watchlist.curate', 'level', 'write'))
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(grants) e WHERE e.value->>'capability' = 'player.watchlist' AND e.value->>'level' = 'write')
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(grants) e WHERE e.value->>'capability' = 'player.watchlist.curate');
    `,
  },
  {
    id: "065_asking_becomes_a_request",
    sql: `
      -- The ask level joins the grants vocabulary: between read and write, "may propose this as
      -- an approval request". The original CHECK predates it and would refuse the level at the
      -- door of the very feature it exists for.
      ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_level_check;
      ALTER TABLE grants ADD CONSTRAINT grants_level_check CHECK (level IN ('none','read','ask','write'));

      -- Approval requests: what an ask-level grant files instead of executing. A request is a
      -- BUNDLE of lines (one action on one server each) so "kick + temp ban + watch on three
      -- players" is one card to sign, not nine — and each line resolves on its own, stamped with
      -- who signed it, so whoever is awake picks off the lines they can and the rest wait.
      CREATE TABLE IF NOT EXISTS approval_requests (
        id                uuid PRIMARY KEY,
        requester_user_id uuid NOT NULL,
        requester_name    text NOT NULL,
        -- draft (being built) | open (filed, awaiting signatures) | resolved (every line decided)
        -- | expired (aged out) | withdrawn (requester pulled it back)
        status            text NOT NULL DEFAULT 'draft',
        note              text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        submitted_at      timestamptz,
        expires_at        timestamptz,
        resolved_at       timestamptz,
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests (status, submitted_at DESC);
      CREATE INDEX IF NOT EXISTS approval_requests_requester_idx ON approval_requests (requester_user_id, created_at DESC);

      -- One proposed action. payload is the exact body the execute path takes, validated at
      -- capture time by the same route that would have executed it; capability + server_id are
      -- what approving is gated on (write there, never the requester, no separate approver list).
      CREATE TABLE IF NOT EXISTS approval_lines (
        id                 uuid PRIMARY KEY,
        request_id         uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
        seq                int NOT NULL DEFAULT 0,
        server_id          uuid,
        capability         text NOT NULL,
        kind               text NOT NULL,
        payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
        player_id          text,
        player_name        text,
        -- pending | approved | denied | voided (request expired/withdrawn before a decision)
        state              text NOT NULL DEFAULT 'pending',
        decided_by_user_id uuid,
        decided_by_name    text,
        decided_at         timestamptz,
        deny_reason        text,
        -- approve-with-modification on numeric fields: {"hours": {"requested": 8, "granted": 4}}
        modified           jsonb,
        applied_at         timestamptz,
        -- the approval stood but the game refused (server unreachable…) — visible, never silent
        apply_error        text,
        created_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS approval_lines_request_idx ON approval_lines (request_id, seq);
    `,
  },
  {
    id: "066_asking_needs_no_grant",
    sql: `
      -- The short-lived 'ask' grant level is gone: lacking a permission IS the ask. Any signed-in
      -- user may propose any requestable action; whoever holds the write signs it. Grants stored
      -- at 'ask' while the level existed confer nothing now — scrub them rather than leaving rows
      -- the resolver no longer understands.
      DELETE FROM grants WHERE level = 'ask';
      UPDATE roles SET grants = COALESCE(
        (SELECT jsonb_agg(e.value) FROM jsonb_array_elements(grants) e WHERE e.value->>'level' <> 'ask'),
        '[]'::jsonb)
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(grants) e WHERE e.value->>'level' = 'ask');
      ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_level_check;
      ALTER TABLE grants ADD CONSTRAINT grants_level_check CHECK (level IN ('none','read','write'));
    `,
  },
  {
    id: "067_drafts_can_be_parked",
    sql: `
      -- "Save draft" parks the builder's cart: the draft keeps its lines and resumes later, but
      -- a parked draft confers NO request-view elevation — leaving the builder ends the widened
      -- view instead of leaving it live behind the requester's back. NULL = actively being built.
      ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS parked_at timestamptz;
    `,
  },
  {
    id: "068_seed_reward_points",
    sql: `
      -- The seed reward gains a second currency. VIP hours and community points are independent:
      -- either, both, or (with the reward switched off) neither. Zero is "not this one", so an
      -- existing install keeps paying exactly the VIP it paid yesterday until somebody sets a
      -- number here.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS reward_points integer NOT NULL DEFAULT 0;
    `,
  },
  {
    id: "069_seed_reward_currency_note",
    sql: `
      -- The currency footnote sent with a seed reward: one line for a seeder who is linked, one
      -- for a seeder who is not. Points land on a Discord account, so an unlinked seeder collected
      -- the VIP half and never heard about the rest — they could not ask about a reward nobody had
      -- told them existed. The DEFAULT carries the real text rather than an empty string: unlike
      -- the message columns above, these are added to rows that already exist and will never be
      -- through the defaults-merge in upsertConfig, so an empty default would leave every existing
      -- server silent forever.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS reward_linked_note text NOT NULL
        DEFAULT 'This server offers {currency} rewards for seeding — you''re linked and earned {reward_points}. Your total is {balance}.';
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS reward_unlinked_note text NOT NULL
        DEFAULT 'This server offers {currency} rewards for seeding — you''re unlinked and could have earned {reward_points}. Visit our Discord to link, it''s free.';
    `,
  },
  {
    id: "070_seed_cap_fight_notice",
    sql: `
      -- The cap-fight rule in the operator's own words, shown in the greeting's restriction list
      -- and used as the {violation} phrase in warns. It was a hardcoded sentence, which made it
      -- the one line of the greeting staff could not edit. Real text in the DEFAULT for the same
      -- reason as 069: existing rows never pass through upsertConfig's defaults-merge.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS cap_fight_notice text NOT NULL
        DEFAULT 'Attacking the next point while your team is winning';
    `,
  },
  {
    id: "071_economy_activity_index",
    sql: `
      -- The Economy Activity feed reads the ledger newest-first ACROSS members. The only order
      -- the table carried was per-member (discord_id, created_at DESC), which cannot serve a
      -- global ORDER BY created_at — on a ledger with years of claims that is a full sort per
      -- page view.
      CREATE INDEX IF NOT EXISTS economy_ledger_created_idx ON economy_ledger (created_at DESC, id DESC);
    `,
  },
  {
    id: "072_rules_absorb_player_modules",
    sql: `
      -- Rules is the ONE place server rule customization lives. The standalone player-rule
      -- modules (no-leader, min-level, role/weapon restrictions, name filter, no-solo-tank)
      -- became Rules-engine triggers, with each scenario's knobs stored on the rule itself.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS params jsonb;

      -- Carry every ENABLED module across as an equivalent rule, so a behaviour somebody armed
      -- does not silently stop when the tabs disappear. The translation is faithful where the
      -- models align (dry-run, immunity, warn message, re-check interval, the scenario's own
      -- knobs) and conservative where they do not: the module framework's counted
      -- warn/punish ladder becomes the rules ladder message -> punish (-> kick when the module
      -- said kickAfter). Disabled modules are NOT carried - an off switch is a decision too.
      -- The stored module blobs stay in autosettings_config.modules, unread, as the recovery
      -- record of what this migration translated.
      INSERT INTO enforcer_rules (id, name, enabled, server_id, event_kind, match, threshold, window_sec, action, reason, hours,
                                  delay_sec, vip_minutes, vip_cooldown_minutes, require_role_ids, escalate_actions, escalate_reset_minutes,
                                  alert_enabled, alert_channel_id, immune_tags, immune_role_ids, dry_run, immune_level, params)
      SELECT gen_random_uuid(), 'No squad leader', true, ac.server_id, 'app.state.no_leader', NULL, 1, GREATEST(30, COALESCE((m.v->'config'->>'warnIntervalSec')::int, 60)), 'message',
             NULLIF(m.v->'config'->>'warnMessage', ''), NULL, 0, 10, 60, '[]'::jsonb,
             CASE WHEN COALESCE((m.v->'config'->>'kickAfter')::boolean, false) THEN '["punish","kick"]'::jsonb ELSE '["punish"]'::jsonb END,
             120, true, NULL,
             CASE WHEN jsonb_typeof(m.v->'config'->'immuneTags') = 'array' THEN m.v->'config'->'immuneTags' ELSE '[]'::jsonb END,
             '[]'::jsonb,
             COALESCE((m.v->>'dryRun')::boolean, true),
             COALESCE((m.v->'config'->>'immuneLevel')::int, 0),
             jsonb_build_object('minSquadSize', COALESCE((m.v->'config'->>'minSquadSize')::int, 2), 'minPlayers', COALESCE((m.v->'config'->>'minPlayers')::int, 0))
      FROM autosettings_config ac, LATERAL (SELECT ac.modules->'no_leader' AS v) m
      WHERE ac.modules ? 'no_leader' AND COALESCE((m.v->>'enabled')::boolean, false);

      INSERT INTO enforcer_rules (id, name, enabled, server_id, event_kind, match, threshold, window_sec, action, reason, hours,
                                  delay_sec, vip_minutes, vip_cooldown_minutes, require_role_ids, escalate_actions, escalate_reset_minutes,
                                  alert_enabled, alert_channel_id, immune_tags, immune_role_ids, dry_run, immune_level, params)
      SELECT gen_random_uuid(), 'Minimum level', true, ac.server_id, 'app.state.low_level', NULL, 1, GREATEST(30, COALESCE((m.v->'config'->>'warnIntervalSec')::int, 60)), 'message',
             NULLIF(m.v->'config'->>'warnMessage', ''), NULL, 0, 10, 60, '[]'::jsonb,
             CASE WHEN COALESCE((m.v->'config'->>'kickAfter')::boolean, false) THEN '["punish","kick"]'::jsonb ELSE '["punish"]'::jsonb END,
             120, true, NULL,
             CASE WHEN jsonb_typeof(m.v->'config'->'immuneTags') = 'array' THEN m.v->'config'->'immuneTags' ELSE '[]'::jsonb END,
             '[]'::jsonb,
             COALESCE((m.v->>'dryRun')::boolean, true),
             COALESCE((m.v->'config'->>'immuneLevel')::int, 0),
             jsonb_build_object('minLevel', COALESCE((m.v->'config'->>'minLevel')::int, 1), 'minPlayers', COALESCE((m.v->'config'->>'minPlayers')::int, 0))
      FROM autosettings_config ac, LATERAL (SELECT ac.modules->'min_level' AS v) m
      WHERE ac.modules ? 'min_level' AND COALESCE((m.v->>'enabled')::boolean, false);

      INSERT INTO enforcer_rules (id, name, enabled, server_id, event_kind, match, threshold, window_sec, action, reason, hours,
                                  delay_sec, vip_minutes, vip_cooldown_minutes, require_role_ids, escalate_actions, escalate_reset_minutes,
                                  alert_enabled, alert_channel_id, immune_tags, immune_role_ids, dry_run, immune_level, params)
      SELECT gen_random_uuid(), 'Role restrictions', true, ac.server_id, 'app.state.bad_role', NULL, 1, GREATEST(30, COALESCE((m.v->'config'->>'warnIntervalSec')::int, 60)), 'message',
             NULLIF(m.v->'config'->>'warnMessage', ''), NULL, 0, 10, 60, '[]'::jsonb,
             CASE WHEN COALESCE((m.v->'config'->>'kickAfter')::boolean, false) THEN '["punish","kick"]'::jsonb ELSE '["punish"]'::jsonb END,
             120, true, NULL,
             CASE WHEN jsonb_typeof(m.v->'config'->'immuneTags') = 'array' THEN m.v->'config'->'immuneTags' ELSE '[]'::jsonb END,
             '[]'::jsonb,
             COALESCE((m.v->>'dryRun')::boolean, true),
             COALESCE((m.v->'config'->>'immuneLevel')::int, 0),
             jsonb_build_object('disallowedRoles', CASE WHEN jsonb_typeof(m.v->'config'->'disallowedRoles') = 'array' THEN m.v->'config'->'disallowedRoles' ELSE '[]'::jsonb END, 'allowedRoles', CASE WHEN jsonb_typeof(m.v->'config'->'allowedRoles') = 'array' THEN m.v->'config'->'allowedRoles' ELSE '[]'::jsonb END, 'minPlayers', COALESCE((m.v->'config'->>'minPlayers')::int, 0))
      FROM autosettings_config ac, LATERAL (SELECT ac.modules->'role_restrictions' AS v) m
      WHERE ac.modules ? 'role_restrictions' AND COALESCE((m.v->>'enabled')::boolean, false);

      INSERT INTO enforcer_rules (id, name, enabled, server_id, event_kind, match, threshold, window_sec, action, reason, hours,
                                  delay_sec, vip_minutes, vip_cooldown_minutes, require_role_ids, escalate_actions, escalate_reset_minutes,
                                  alert_enabled, alert_channel_id, immune_tags, immune_role_ids, dry_run, immune_level, params)
      SELECT gen_random_uuid(), 'Name filter', true, ac.server_id, 'app.state.bad_name', NULL, 1, GREATEST(30, COALESCE((m.v->'config'->>'warnIntervalSec')::int, 60)), 'message',
             NULLIF(m.v->'config'->>'warnMessage', ''), NULL, 0, 10, 60, '[]'::jsonb,
             CASE WHEN COALESCE((m.v->'config'->>'kickAfter')::boolean, false) THEN '["punish","kick"]'::jsonb ELSE '["punish"]'::jsonb END,
             120, true, NULL,
             CASE WHEN jsonb_typeof(m.v->'config'->'immuneTags') = 'array' THEN m.v->'config'->'immuneTags' ELSE '[]'::jsonb END,
             '[]'::jsonb,
             COALESCE((m.v->>'dryRun')::boolean, true),
             COALESCE((m.v->'config'->>'immuneLevel')::int, 0),
             jsonb_build_object('bannedSubstrings', COALESCE(m.v->'config'->>'bannedSubstrings', ''), 'blockUrls', COALESCE((m.v->'config'->>'blockUrls')::boolean, false), 'bannedPattern', COALESCE(m.v->'config'->>'bannedPattern', ''), 'minPlayers', COALESCE((m.v->'config'->>'minPlayers')::int, 0))
      FROM autosettings_config ac, LATERAL (SELECT ac.modules->'name_filter' AS v) m
      WHERE ac.modules ? 'name_filter' AND COALESCE((m.v->>'enabled')::boolean, false);

      INSERT INTO enforcer_rules (id, name, enabled, server_id, event_kind, match, threshold, window_sec, action, reason, hours,
                                  delay_sec, vip_minutes, vip_cooldown_minutes, require_role_ids, escalate_actions, escalate_reset_minutes,
                                  alert_enabled, alert_channel_id, immune_tags, immune_role_ids, dry_run, immune_level, params)
      SELECT gen_random_uuid(), 'No solo tank', true, ac.server_id, 'app.state.solo_tank', NULL, 1, GREATEST(30, COALESCE((m.v->'config'->>'warnIntervalSec')::int, 60)), 'message',
             NULLIF(m.v->'config'->>'warnMessage', ''), NULL, 0, 10, 60, '[]'::jsonb,
             CASE WHEN COALESCE((m.v->'config'->>'kickAfter')::boolean, false) THEN '["punish","kick"]'::jsonb ELSE '["punish"]'::jsonb END,
             120, true, NULL,
             CASE WHEN jsonb_typeof(m.v->'config'->'immuneTags') = 'array' THEN m.v->'config'->'immuneTags' ELSE '[]'::jsonb END,
             '[]'::jsonb,
             COALESCE((m.v->>'dryRun')::boolean, true),
             COALESCE((m.v->'config'->>'immuneLevel')::int, 0),
             jsonb_build_object('tankRoles', CASE WHEN jsonb_typeof(m.v->'config'->'tankRoles') = 'array' THEN m.v->'config'->'tankRoles' ELSE '[11,12]'::jsonb END, 'minCrew', COALESCE((m.v->'config'->>'minCrew')::int, 2), 'minPlayers', COALESCE((m.v->'config'->>'minPlayers')::int, 0))
      FROM autosettings_config ac, LATERAL (SELECT ac.modules->'no_solo_tank' AS v) m
      WHERE ac.modules ? 'no_solo_tank' AND COALESCE((m.v->>'enabled')::boolean, false);

      INSERT INTO enforcer_rules (id, name, enabled, server_id, event_kind, match, threshold, window_sec, action, reason, hours,
                                  delay_sec, vip_minutes, vip_cooldown_minutes, require_role_ids, escalate_actions, escalate_reset_minutes,
                                  alert_enabled, alert_channel_id, immune_tags, immune_role_ids, dry_run, immune_level, params)
      SELECT gen_random_uuid(), 'Weapon restrictions', true, ac.server_id, 'app.weapon.restricted', NULL, 1, 0, 'message',
             NULLIF(m.v->'config'->>'warnMessage', ''), NULL, 0, 10, 60, '[]'::jsonb,
             CASE WHEN COALESCE((m.v->'config'->>'kickAfter')::boolean, false) THEN '["punish","kick"]'::jsonb ELSE '["punish"]'::jsonb END,
             120, true, NULL,
             CASE WHEN jsonb_typeof(m.v->'config'->'immuneTags') = 'array' THEN m.v->'config'->'immuneTags' ELSE '[]'::jsonb END,
             '[]'::jsonb,
             COALESCE((m.v->>'dryRun')::boolean, true),
             COALESCE((m.v->'config'->>'immuneLevel')::int, 0),
             jsonb_build_object('disallowedWeapons', COALESCE(m.v->'config'->>'disallowedWeapons', ''), 'allowedWeapons', COALESCE(m.v->'config'->>'allowedWeapons', ''))
      FROM autosettings_config ac, LATERAL (SELECT ac.modules->'weapon_restrictions' AS v) m
      WHERE ac.modules ? 'weapon_restrictions' AND COALESCE((m.v->>'enabled')::boolean, false);
    `,
  },
  {
    id: "073_rule_active_hours",
    sql: `
      -- Native active hours on rules: a wall-clock window (overnight-aware, optional weekdays and
      -- timezone) gating when a rule may fire. NULL = always — every existing rule keeps exactly
      -- the behaviour it had. Replaces the retired profile moduleOverrides trick ("min level only
      -- at night") with a first-class field on the rule itself.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS active_hours jsonb;
    `,
  },
  {
    id: "074_rule_population_and_breaker",
    sql: `
      -- Population bounds on every rule, pairing with active hours: fire only between players_min
      -- and players_max on the server (0 = unbounded). The state triggers' per-rule minPlayers
      -- param moves up onto the rule so one knob serves event and state rules alike.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS players_min integer NOT NULL DEFAULT 0;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS players_max integer NOT NULL DEFAULT 0;
      UPDATE enforcer_rules
         SET players_min = GREATEST(players_min, COALESCE(NULLIF(params->>'minPlayers', '')::int, 0)),
             params = params - 'minPlayers'
       WHERE params ? 'minPlayers';

      -- The circuit breaker: a rule that ACTS on more than this many distinct players inside a
      -- minute disables itself and says so, instead of finishing the job a typo started. Default
      -- 10 for every rule, existing ones included — the valve exists precisely for rules written
      -- before anyone thought about their blast radius; 0 opts a rule out.
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS breaker_limit integer NOT NULL DEFAULT 10;
    `,
  },
  {
    id: "075_event_rotation_set",
    sql: `
      -- A library map set an event carries as its ROTATION lineup: when the event opens, the
      -- worker replaces the server's rotation with the set's explicit sequence — the same pairing
      -- map_vote_profile already makes for the vote. Nullable and unreferenced-by-FK on purpose:
      -- a deleted set leaves the event intact (the apply skips with an audit note), the same
      -- loose-name contract map_vote_profile chose.
      ALTER TABLE payout_events ADD COLUMN IF NOT EXISTS rotation_set_id uuid;
      -- When the worker finished (or terminally skipped) that apply — the durable latch that
      -- makes it happen exactly once per event however many sweeps race, and lets a server that
      -- was unreachable at open time be retried on the next sweep instead of missed forever.
      ALTER TABLE payout_events ADD COLUMN IF NOT EXISTS rotation_applied_at timestamptz;
    `,
  },
  {
    id: "076_match_class_kills",
    sql: `
      -- Per-player, per-weapon-class kills for one round — the raw material for the public
      -- records boards ("most machine-gun kills in a round", career armor kills). Written by the
      -- worker's rollup sweep, which folds a FINISHED round's kill events through the game's
      -- weapon classifier exactly once; nothing live writes here, so a row is always a settled
      -- fact about a settled round.
      CREATE TABLE IF NOT EXISTS player_match_class_kills (
        match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id uuid NOT NULL,
        server_id uuid NOT NULL,
        class_id text NOT NULL,
        kills int NOT NULL,
        PRIMARY KEY (match_id, player_id, class_id)
      );
      -- The records read: per server per class, biggest single-round counts first.
      CREATE INDEX IF NOT EXISTS idx_pmck_server_class ON player_match_class_kills (server_id, class_id, kills DESC);
      -- The sweep's own bookkeeping: when this round's rollup was written (or the round was found
      -- to have no kill log — stamped either way, so nothing is re-scanned forever). On the
      -- matches row rather than inferred from rollup rows, because "zero rows" and "never looked"
      -- must stay different answers.
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS class_rollup_at timestamptz;
      CREATE INDEX IF NOT EXISTS idx_matches_rollup_pending ON matches (server_id, started_at DESC) WHERE ended_at IS NOT NULL AND class_rollup_at IS NULL;
    `,
  },
  {
    id: "077_weapon_kills",
    sql: `
      -- 076 collapsed kills to weapon CLASSES at write time, which threw away the weapon — and
      -- "most kills with a weapon in one round" is the record people actually argue about. The
      -- rollup now keeps the WEAPON (class derived and stored beside it, since the class is a
      -- function of the game descriptor at fold time); every class read is a SUM over its
      -- weapons. The class table goes, and every rollup stamp is cleared so the sweep re-folds
      -- history into the weapon shape — it rebuilt the old table in hours and rebuilds this one
      -- the same way.
      DROP TABLE IF EXISTS player_match_class_kills;
      CREATE TABLE IF NOT EXISTS player_match_weapon_kills (
        match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id uuid NOT NULL,
        server_id uuid NOT NULL,
        weapon text NOT NULL,
        class_id text NOT NULL,
        kills int NOT NULL,
        PRIMARY KEY (match_id, player_id, weapon)
      );
      CREATE INDEX IF NOT EXISTS idx_pmwk_server_class ON player_match_weapon_kills (server_id, class_id);
      CREATE INDEX IF NOT EXISTS idx_pmwk_server_weapon ON player_match_weapon_kills (server_id, weapon);
      UPDATE matches SET class_rollup_at = NULL;
    `,
  },
  {
    id: "078_weapon_deaths",
    sql: `
      -- The victim side of the same rows: every kill in the log names the weapon that did it, so
      -- "who dies to artillery the most" is as recorded as "who kills with it" — it was only
      -- unfolded. One table keeps the pair symmetric: a row is one player's relationship with one
      -- weapon in one round, however that relationship went. Stamps cleared so the sweep re-folds
      -- history with the victim side filled in.
      ALTER TABLE player_match_weapon_kills ADD COLUMN IF NOT EXISTS deaths int NOT NULL DEFAULT 0;
      UPDATE matches SET class_rollup_at = NULL;
    `,
  },
  {
    id: "079_seeding_containment_zones",
    sql: `
      -- Seeding containment: keep the seed fight inside agreed tactical-map sectors, judged from
      -- the same live world positions the restricted live screen reads. Zones are per map family
      -- (contain_zones: zone key -> {allies, axis, shared} sector lists, "A1".."J10"); a side with
      -- no cells listed is unrestricted, a map with no entry enforces nothing, and everything runs
      -- through the existing warn -> punish -> kick ladder, only while the phase is "seeding".
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS contain_enabled     boolean NOT NULL DEFAULT false;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS contain_grace_sec   integer NOT NULL DEFAULT 60;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS contain_max_players integer NOT NULL DEFAULT 60;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS contain_notice      text    NOT NULL DEFAULT 'Leaving your team''s seeding area (watch the map)';
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS contain_zones       jsonb   NOT NULL DEFAULT '{}'::jsonb;
    `,
  },
  {
    id: "080_retire_autosettings_rules_grants",
    sql: `
      -- The capability-split migration (039) materialized autosettings.rules for every
      -- autosettings.config holder; 072 retired the key when the player-rule modules became
      -- Rules-engine triggers — and never touched the stored rows. The API refuses unknown keys
      -- on every grants write (the right rule, so a typo cannot mint a permission), which aimed
      -- it here: a role carrying the orphan could not be SAVED at all, so editing ANY of its
      -- permissions failed with "unknown capability: autosettings.rules".
      --
      -- Deleted, not translated. The rows have conferred nothing since 072 (no route checks the
      -- key), and the rules engine's own gate is admin.moderation — handing that out silently
      -- would widen every old holder's reach to the whole moderation surface. Anyone who needs
      -- the engine holds (or is granted) its real key, deliberately.
      -- retired-keys-cleaned: autosettings.rules
      DELETE FROM grants WHERE capability = 'autosettings.rules';
      UPDATE roles SET grants = COALESCE((
        SELECT jsonb_agg(e.entry) FROM jsonb_array_elements(grants) AS e(entry)
        WHERE e.entry->>'capability' <> 'autosettings.rules'
      ), '[]'::jsonb)
      WHERE grants @> '[{"capability":"autosettings.rules"}]'::jsonb;

      -- The same residue class, older: 021 translated moderation.blacklist -> moderation.bans on
      -- the grants TABLE and forgot the roles DOCUMENT, so a role saved before 021 still carries
      -- the dead key and wedges its editor the same way. Finished here the way 021 meant it —
      -- a blacklist holder becomes a ban manager — deduped in case the role held both.
      -- retired-keys-cleaned: moderation.blacklist
      UPDATE roles SET grants = (
        SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
          'capability', CASE WHEN e.entry->>'capability' = 'moderation.blacklist' THEN 'moderation.bans' ELSE e.entry->>'capability' END,
          'level', e.entry->>'level'
        )), '[]'::jsonb)
        FROM jsonb_array_elements(grants) AS e(entry)
      )
      WHERE grants @> '[{"capability":"moderation.blacklist"}]'::jsonb;
    `,
  },
  {
    id: "081_map_zone_sets",
    sql: `
      -- The community-wide zone-set library: named 10x10 sector paints (the tactical map's own
      -- A1-J10 grid), one paint per map family, per game — what the out-of-zone enforcer rules
      -- read, drawn by the same picker as the seeding areas. A library rather than per-rule or
      -- per-server storage for the map_sets reason: painting a map is work, and copies mean doing
      -- it again and keeping them in step by hand. zones is {mapKey: {allies, axis, shared}}.
      CREATE TABLE IF NOT EXISTS map_zone_sets (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL,
        game        text NOT NULL,
        zones       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS map_zone_sets_name_idx ON map_zone_sets (lower(name));
    `,
  },
  {
    id: "082_objective_points",
    sql: `
      -- Staff-taught objective locations, one row per (game, map family, grid slot): the name the
      -- community knows the option by (Vietnam's wire offers only digits) and the tactical-map
      -- cell it sits in ("E6" — the same A1-J10 vocabulary the zone paints use). Read by the
      -- panel's objectives picker (highlights) and the Discord sector walk (labels).
      CREATE TABLE IF NOT EXISTS objective_points (
        game        text NOT NULL,
        map_key     text NOT NULL,
        row_no      int  NOT NULL,
        idx         int  NOT NULL,
        name        text,
        sector      text,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (game, map_key, row_no, idx)
      );
    `,
  },
  {
    id: "083_objective_layout_expiries",
    sql: `
      -- The countdown behind "save this layout for the next N plays" on HLL: Vietnam. The game
      -- itself stores a layout FOREVER (docs/hll-vietnam.md p11 has no expiry), so the worker
      -- owns one: each new round of the map decrements plays_left, and at zero the worker sends
      -- RemoveSectorLayout — back to the server's own random picks. No row means "until cleared".
      CREATE TABLE IF NOT EXISTS objective_layout_expiries (
        server_id      text NOT NULL,
        map_id         text NOT NULL,
        plays_left     int  NOT NULL,
        -- the last match id counted (or the one already running at save time, which the game's
        -- no-restart save does not affect) — so one round is never counted twice.
        last_match_id  text,
        set_by         text NOT NULL DEFAULT '',
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (server_id, map_id)
      );
    `,
  },
  {
    id: "084_chat_filter",
    sql: `
      -- The dedicated in-game chat filter (CRCON's "profanities", grown up): one community-wide
      -- word list that (a) drives two managed enforcement rules and (b) can be pushed into each
      -- active server's native banned-words censor. One row, one jsonb document (the app_config
      -- shape) — see ChatFilterConfig in types.ts for the fields and why censor_applied exists
      -- (HLL's v2 wire cannot read the censor list back, so our record is the diff baseline).
      CREATE TABLE IF NOT EXISTS chat_filter (
        id         boolean PRIMARY KEY DEFAULT true CHECK (id),
        config     jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO chat_filter (id) VALUES (true) ON CONFLICT DO NOTHING;
    `,
  },
  {
    id: "085_mapvote_registered_only",
    sql: `
      -- Count only registered voters (linked Discord <-> game account). The knob that makes the
      -- combined Discord + in-game vote duplicate-proof: every counted ballot maps to one Discord
      -- identity, so one person voting on both surfaces counts once. Default off — existing votes
      -- keep counting everyone, exactly as before.
      ALTER TABLE mapvote_config ADD COLUMN IF NOT EXISTS registered_only boolean NOT NULL DEFAULT false;
    `,
  },
  {
    id: "086_mapvote_registered_only_split",
    sql: `
      -- The registered-only knob splits per SURFACE: the common posture is "anyone may click the
      -- Discord poll, but an in-game vote must come from a registered player", which one shared
      -- flag could not say. Both new gates inherit the old flag's value, so a community that had
      -- the protection on keeps it on both sides; the old column then retires — nothing reads it.
      ALTER TABLE mapvote_config ADD COLUMN IF NOT EXISTS registered_only_ingame boolean NOT NULL DEFAULT false;
      ALTER TABLE mapvote_config ADD COLUMN IF NOT EXISTS registered_only_discord boolean NOT NULL DEFAULT false;
      UPDATE mapvote_config SET registered_only_ingame = registered_only, registered_only_discord = registered_only;
      ALTER TABLE mapvote_config DROP COLUMN IF EXISTS registered_only;
    `,
  },
  {
    id: "087_player_triggers",
    sql: `
      -- Per-player triggers: "when THIS player connects/disconnects/kills/teamkills/chats, do X",
      -- fire-once (auto-disarm, kept as a receipt) or every time. The sibling of the server-wide
      -- Rules engine, deliberately separate: a rule watches a server for anyone doing something;
      -- a trigger watches ONE named player and follows them across servers (server_id NULL) or on
      -- one (server_id set). The action set is the moderation surface — message/kick/punish/
      -- tempban/permaban plus VIP hours and economy points — capability-gated at CREATION by the
      -- staff member's own grants, so a trigger can never do what its author could not do by hand.
      -- See PlayerTriggerRow in types.ts.
      CREATE TABLE IF NOT EXISTS player_triggers (
        id                 uuid PRIMARY KEY,
        player_id          uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        player_name        text,
        server_id          uuid REFERENCES servers(id) ON DELETE CASCADE,
        event              text NOT NULL,
        action             text NOT NULL,
        message            text,
        hours              integer NOT NULL DEFAULT 0,
        points             integer NOT NULL DEFAULT 0,
        fire_once          boolean NOT NULL DEFAULT true,
        enabled            boolean NOT NULL DEFAULT true,
        note               text,
        created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        created_by_name    text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        fired_count        integer NOT NULL DEFAULT 0,
        last_fired_at      timestamptz,
        disarmed_at        timestamptz
      );
      -- The hot path: every bus event asks "does this player have any armed trigger?". An index on
      -- (player_id) keyed where enabled AND not disarmed keeps that a cheap lookup even once the
      -- table has grown a long tail of spent one-shots.
      CREATE INDEX IF NOT EXISTS player_triggers_armed
        ON player_triggers (player_id) WHERE enabled AND disarmed_at IS NULL;
    `,
  },
  {
    id: "088_player_trigger_steps",
    sql: `
      -- A trigger grows from ONE action into an ordered list of steps, each with its own delay:
      -- "on connect: message now, grant 72h VIP now, kick in 60s" is one trigger, not three. The
      -- old single-action columns fold into steps[0] so nothing already armed changes behaviour.
      ALTER TABLE player_triggers ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb;
      UPDATE player_triggers
         SET steps = jsonb_build_array(jsonb_build_object(
               'action', action, 'message', message, 'hours', hours, 'points', points, 'delaySec', 0))
       WHERE steps = '[]'::jsonb;
      ALTER TABLE player_triggers
        DROP COLUMN IF EXISTS action,
        DROP COLUMN IF EXISTS message,
        DROP COLUMN IF EXISTS hours,
        DROP COLUMN IF EXISTS points;
    `,
  },
  {
    id: "089_server_retired",
    sql: `
      -- Staged retirement: a retired server keeps EVERY row it ever produced (careers, matches,
      -- events, VIP history — nothing cascades, nothing is touched) but stops existing anywhere
      -- except the Connections tab. The stamp, not a boolean, so the tab can say since when.
      -- The hard-delete stage is deliberately not built yet.
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS retired_at timestamptz;
    `,
  },
  {
    id: "090_server_decommissioned",
    sql: `
      -- Stage 2 of the lifecycle (retire → decommission → delete): a DECOMMISSIONED server is
      -- hidden from every staff surface INCLUDING the Connections tab — only the install's
      -- first-created account (the login that set the panel up) still sees it there. All data
      -- stays intact and retrievable until that same account performs the final delete.
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS decommissioned_at timestamptz;
    `,
  },
  {
    id: "091_seed_reward_bridge",
    sql: `
      -- The seed-reward bridge: extra servers a seed round also pays VIP on, each with its own
      -- hours ([{serverId, hours}]). Same-game targets pay by the shared platform id; other-game
      -- targets pay only seeders registered (linked) for that game, resolved through the Discord
      -- link the way the VIP shop resolves a purchase. See SeedBridgeTarget in types.ts.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS reward_bridge jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    id: "092_nudge_excused",
    sql: `
      -- Staff the unread-notice nudge never NAMES (away/on leave): user ids, editable on the same
      -- screen that turns the nudge on. Read receipts still record; only the reminder skips them.
      ALTER TABLE announcement_nudge_config ADD COLUMN IF NOT EXISTS excused_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    id: "093_server_nickname",
    sql: `
      -- Staff-facing alias for a server, shown across the panel's pickers and lists in place of
      -- the game's long browser name. Null = no alias. Panel-only: public/player surfaces keep
      -- the real name. See ServerRow.nickname.
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS nickname text;
    `,
  },
  {
    id: "094_match_morale",
    sql: `
      -- Conquest's scoreline (Update 21): each side starts with initial_morale and the round
      -- ends when one pool drains. Sampled off the live session like the score; null on rounds
      -- not scored in morale. See MatchRow.initialMorale.
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS initial_morale int;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS allied_morale int;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS axis_morale int;
    `,
  },
  {
    id: "095_mapvote_manual_hold",
    sql: `
      -- A staff manual map change parks the vote loop until this instant, so automation never
      -- fights a human's pick. See MapVoteStateRow.manualHoldUntil.
      ALTER TABLE mapvote_state ADD COLUMN IF NOT EXISTS manual_hold_until timestamptz;
    `,
  },
  {
    id: "096_seeding_contain_auto",
    sql: `
      -- Zero-setup containment: derive the fence from the round's own geometry when no zone is
      -- painted for the map. See SeedingConfigRow.containAutoEnabled.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS contain_auto_enabled boolean NOT NULL DEFAULT false;
    `,
  },
  {
    id: "097_seeding_pace",
    sql: `
      -- Offensive steamroll protection: per-point unlock minutes, judged from the calibrated
      -- round geometry during live rounds. See SeedingConfigRow.paceEnabled.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS pace_enabled boolean NOT NULL DEFAULT false;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS pace_unlock_minutes jsonb NOT NULL DEFAULT '[0,0,20,40,60]'::jsonb;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS pace_notice text NOT NULL DEFAULT '';
    `,
  },
  {
    id: "098_seed_last_cycle",
    sql: `
      -- The last FINISHED seed cycle, archived by the worker whenever it ends a cycle (rewarded
      -- or not), so a missed payout can be replayed by hand: { endedAt, rewarded, entries }.
      ALTER TABLE seeding_state ADD COLUMN IF NOT EXISTS last_cycle jsonb;
      -- Set by the API's "pay last seed"; consumed atomically by the worker's next tick.
      ALTER TABLE seeding_state ADD COLUMN IF NOT EXISTS pay_requested_at timestamptz;
    `,
  },
  {
    id: "099_mapvote_poll_lifetime",
    sql: `
      -- The Discord poll card's own timer is only a SAFETY NET: the vote closes the card itself when
      -- the match ends. At 2h it fired first whenever a vote outlived two hours (a long match, a
      -- quiet server sitting on one map), leaving Discord voters locked out of a vote the panel
      -- still showed as active. 24h outlasts any match; configs still on the old default follow.
      ALTER TABLE mapvote_config ALTER COLUMN poll_hours SET DEFAULT 24;
      UPDATE mapvote_config SET poll_hours = 24 WHERE poll_hours = 2;
    `,
  },
  {
    id: "100_map_layouts",
    sql: `
      -- Per-LAYER attack geometry, learned from where the two teams actually spawn (the layer id,
      -- not the map family, is what fixes which end each side attacks from). One vote per
      -- calibrated round, kept as counts so a round with mislabeled sides is outvoted, not trusted.
      CREATE TABLE IF NOT EXISTS map_layouts (
        map_id      text PRIMARY KEY,
        x_neg       integer NOT NULL DEFAULT 0,
        x_pos       integer NOT NULL DEFAULT 0,
        y_neg       integer NOT NULL DEFAULT 0,
        y_pos       integer NOT NULL DEFAULT 0,
        separation  integer NOT NULL DEFAULT 0,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS layout_learn_enabled boolean NOT NULL DEFAULT true;
    `,
  },
  {
    id: "101_map_layouts_round",
    sql: `
      -- The match a layer's last vote came from: one vote per MATCH survives a worker restart
      -- mid-round (the in-memory guard does not), so an update cannot double a round's weight.
      ALTER TABLE map_layouts ADD COLUMN IF NOT EXISTS last_round text;
    `,
  },
  {
    id: "102_server_former_names",
    sql: `
      -- Every name a server has gone by, so a message saved as "{vip_until:WW2}" still resolves
      -- after the server is renamed. A trigger rather than per-setter code: nickname, in-game
      -- name, public name and slug each change through a different path, and the next path
      -- someone adds is covered without remembering this. Newest first, de-duplicated, capped.
      -- jsonb, not text[]: the data port's contract is "no array columns" (it round-trips
      -- non-scalars as JSON), and a text[] here broke backup/restore of the servers table.
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS former_names jsonb NOT NULL DEFAULT '[]'::jsonb;
      CREATE OR REPLACE FUNCTION servers_remember_names() RETURNS trigger AS $fn$
      DECLARE olds text[] := ARRAY[]::text[];
      BEGIN
        IF OLD.name IS DISTINCT FROM NEW.name AND btrim(coalesce(OLD.name, '')) <> '' THEN olds := olds || btrim(OLD.name); END IF;
        IF OLD.nickname IS DISTINCT FROM NEW.nickname AND btrim(coalesce(OLD.nickname, '')) <> '' THEN olds := olds || btrim(OLD.nickname); END IF;
        IF OLD.public_name IS DISTINCT FROM NEW.public_name AND btrim(coalesce(OLD.public_name, '')) <> '' THEN olds := olds || btrim(OLD.public_name); END IF;
        IF OLD.public_slug IS DISTINCT FROM NEW.public_slug AND btrim(coalesce(OLD.public_slug, '')) <> '' THEN olds := olds || btrim(OLD.public_slug); END IF;
        IF coalesce(array_length(olds, 1), 0) > 0 THEN
          NEW.former_names := coalesce((
            SELECT jsonb_agg(n ORDER BY o) FROM (
              SELECT n, min(o) AS o
                FROM unnest(olds || ARRAY(SELECT jsonb_array_elements_text(coalesce(OLD.former_names, '[]'::jsonb))))
                     WITH ORDINALITY AS t(n, o)
               GROUP BY n ORDER BY min(o) LIMIT 20
            ) d
          ), '[]'::jsonb);
        END IF;
        RETURN NEW;
      END
      $fn$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS servers_remember_names ON servers;
      CREATE TRIGGER servers_remember_names BEFORE UPDATE ON servers
        FOR EACH ROW EXECUTE FUNCTION servers_remember_names();
    `,
  },
  {
    id: "103_player_trigger_edits",
    sql: `
      -- Player triggers can be re-edited after they are made; who last changed one, and when, is
      -- shown on the row — and a chain waiting out a delay stops if its trigger changed under it.
      ALTER TABLE player_triggers ADD COLUMN IF NOT EXISTS updated_at timestamptz;
      ALTER TABLE player_triggers ADD COLUMN IF NOT EXISTS updated_by_name text;
    `,
  },
  {
    id: "104_welcome_config",
    sql: `
      -- The live welcome message: a template the app fills and writes to the game's welcome text
      -- on a timer, only when the filled text changed. last_text is what the game was last given.
      CREATE TABLE IF NOT EXISTS welcome_config (
        server_id       uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        enabled         boolean NOT NULL DEFAULT false,
        template        text NOT NULL DEFAULT '',
        interval_sec    integer NOT NULL DEFAULT 300,
        last_text       text,
        last_written_at timestamptz,
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "105_game_rewards",
    sql: `
      -- Game rewards: per-server settings, a receipt per payout (the primary key IS the once-only
      -- guarantee), and the per-day log the consecutive-day streaks are counted from.
      CREATE TABLE IF NOT EXISTS game_rewards_config (
        server_id  uuid PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
        config     jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS game_reward_receipts (
        server_id  uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        player_id  text NOT NULL,
        ref        text NOT NULL,
        kind       text NOT NULL,
        detail     jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (server_id, ref, player_id)
      );
      CREATE TABLE IF NOT EXISTS game_reward_days (
        server_id uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        player_id text NOT NULL,
        kind      text NOT NULL,
        day       date NOT NULL,
        seconds   integer NOT NULL DEFAULT 0,
        PRIMARY KEY (server_id, player_id, kind, day)
      );
    `,
  },
  {
    id: "106_seeding_check_speed",
    sql: `
      -- How often the seeding loop checks the server, per server, set in the app (null = the
      -- install's default from the environment). Read every tick, so no restart is needed.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS check_sec integer;
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS chase_check_sec integer;
    `,
  },
  {
    id: "107_seed_repeat_window",
    sql: `
      -- The reward delay becomes a per-player repeat window: a seeder paid within it is thanked
      -- (this message) instead of paid again, and new seeders are still paid. Null = the default.
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS reward_repeat_message text;
      -- The old default was 30 minutes; the window's is an hour. A server left on the old default
      -- moves with it — one somebody set to anything else keeps what they chose.
      UPDATE seeding_config SET reward_delay_sec = 3600 WHERE reward_delay_sec = 1800;
    `,
  },
  {
    id: "108_autosettings_match_messages",
    sql: `
      -- Messages sent to everyone at set times after each match starts (Auto settings).
      ALTER TABLE autosettings_config ADD COLUMN IF NOT EXISTS match_messages jsonb NOT NULL DEFAULT '[]'::jsonb;
    `,
  },
  {
    // A standalone "VIP for players without it" list lived here briefly and was replaced by a
    // Rules trigger (app.state.no_vip) the same day. The id stays so an install that applied it
    // still boots (the migrator refuses an unknown applied id); it does nothing now.
    id: "109_auto_vip_rules",
    sql: `SELECT 1;`,
  },
  {
    // …and what the retired 109 created, on an install that ran it: unused, so dropped.
    id: "110_drop_auto_vip_rules",
    sql: `
      ALTER TABLE autosettings_config DROP COLUMN IF EXISTS vip_rules;
      DROP TABLE IF EXISTS auto_vip_ledger;
    `,
  },
  {
    // Rule conditions every rule can carry: a window of minutes into the match, counting the
    // threshold per match, a "only players tagged" gate, and a per-player firing cap.
    id: "111_rule_match_window_tags_cap",
    sql: `
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS match_minutes_min integer NOT NULL DEFAULT 0;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS match_minutes_max integer NOT NULL DEFAULT 0;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS count_per_match boolean NOT NULL DEFAULT false;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS require_tags jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS cap_count integer NOT NULL DEFAULT 0;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS cap_period text NOT NULL DEFAULT 'day';
    `,
  },
  {
    // Two rule actions that carry a value of their own: the tag an "add a tag" step puts on the
    // player, and the points a "grant points" rule pays.
    id: "112_rule_action_tag_points",
    sql: `
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS action_tag text;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS points integer NOT NULL DEFAULT 0;
    `,
  },
  {
    // What each roster rule saw on its last check of a server's roster, and the last reason the
    // enforcer held one of its firings back — the answer to "why isn't this rule firing", shown on
    // the rule's card. One row per (rule, server), overwritten in place.
    id: "113_rule_status",
    sql: `
      CREATE TABLE IF NOT EXISTS rule_status (
        rule_id     uuid NOT NULL REFERENCES enforcer_rules(id) ON DELETE CASCADE,
        server_id   uuid NOT NULL,
        checked_at  timestamptz,
        check_summary jsonb,
        skipped_at  timestamptz,
        skip_reason text,
        skip_player text,
        PRIMARY KEY (rule_id, server_id)
      );
    `,
  },
  {
    // duplicate_key names every recipient, so a payout to a whole role grows it past what a btree
    // entry may hold ("index row size 5688 exceeds btree version 4 maximum 2704" at 355 people) and
    // the job row itself was refused. Index a fixed-size md5 of the key instead; the stored key
    // stays readable and byte-identical to what existing jobs recorded.
    id: "114_payout_dupe_idx_md5",
    sql: `
      DROP INDEX IF EXISTS payout_jobs_dupe_idx;
      CREATE INDEX IF NOT EXISTS payout_jobs_dupe_idx ON payout_jobs (md5(duplicate_key)) WHERE NOT dry_run;
    `,
  },
  {
    // rule_status went out without a server FK, so a deleted server left a community-wide rule
    // showing a ghost "last checked … on a server" line forever. Its sibling enforcer_vip_grants
    // cascades on the server; this joins it, clearing any ghosts already standing first.
    id: "115_rule_status_server_fk",
    sql: `
      DELETE FROM rule_status WHERE server_id NOT IN (SELECT id FROM servers);
      ALTER TABLE rule_status ADD CONSTRAINT rule_status_server_fk
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;
    `,
  },
  {
    // Receipts written up front as PENDING and settled in place, so a run cut off part-way leaves
    // the people it never reached on the ledger — what its retry pays — instead of no row at all.
    id: "116_payout_items_pending",
    // Every CHECK on the status column goes, whatever it is called — the old one was declared
    // inline and named by Postgres, and if an install's name ever differed, a DROP by name would
    // leave it standing and every payout would fail on its first PENDING receipt.
    sql: `
      DO $$
      DECLARE c record;
      BEGIN
        FOR c IN SELECT conname FROM pg_constraint
                  WHERE conrelid = 'payout_items'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) ILIKE '%status%'
        LOOP
          EXECUTE format('ALTER TABLE payout_items DROP CONSTRAINT %I', c.conname);
        END LOOP;
      END $$;
      ALTER TABLE payout_items ADD CONSTRAINT payout_items_status_check CHECK (status IN ('PASS','FAIL','PENDING'));
    `,
  },
  {
    // A rule's "at most N times per player" counted its firings in the audit log — which the
    // Staff-activity retention trim deletes. A "points once, ever" milestone rule then paid every
    // player AGAIN after a trim. Capped firings now live here, out of the trim's reach, backfilled
    // from the audit rows still standing so nothing already paid is forgotten.
    id: "117_rule_firings",
    sql: `
      CREATE TABLE IF NOT EXISTS rule_firings (
        rule_id   uuid NOT NULL REFERENCES enforcer_rules(id) ON DELETE CASCADE,
        player_id uuid NOT NULL,
        fired_at  timestamptz NOT NULL DEFAULT now(),
        dry_run   boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS rule_firings_lookup_idx ON rule_firings (rule_id, player_id, dry_run, fired_at);
      INSERT INTO rule_firings (rule_id, player_id, fired_at, dry_run)
      SELECT r.id, a.target_id::uuid, a.ts, a.action = 'enforcer.dryrun'
        FROM audit a
        JOIN enforcer_rules r ON r.id::text = a.data->>'ruleId'
       WHERE r.cap_count > 0
         AND a.action LIKE 'enforcer.%' AND a.action <> 'enforcer.error'
         AND a.target_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    `,
  },
  {
    // The master switch for position-based seeding enforcement (positional cap fight, auto zones,
    // offensive pace). Off: seeding enforces the way CRCON does — score, roles, weapons, and any
    // zones painted by hand. Off for every server, including ones that had those rules on: live
    // positions and side labels at a round's start proved too stale to punish on.
    id: "118_seeding_positional_switch",
    sql: `
      ALTER TABLE seeding_config ADD COLUMN IF NOT EXISTS positional_enabled boolean NOT NULL DEFAULT false;
    `,
  },
  {
    // Map points: objective presets owners choose per server, map family and mode, applied ONLY
    // when somebody presses Change now in the map catalogue — plus the press in flight, and the
    // objective names learned from live reads that let the picker name a map that isn't up.
    //
    // Neither per-server table has a foreign key to servers, like objective_layout_expiries: a
    // data-port restore runs DELETE FROM servers, archives never carry presets, and a cascade would
    // wipe them (and an outstanding put-back) on every restore. servers.remove deletes both by hand.
    // jsonb throughout, never arrays — the data port's "no array columns" contract.
    id: "119_map_points",
    sql: `
      CREATE TABLE IF NOT EXISTS map_point_presets (
        server_id           text NOT NULL,
        -- the map FAMILY (zoneKeyOf) and the mode: "warfare", "offensive_us", … or "offensive".
        map_key             text NOT NULL,
        mode_key            text NOT NULL,
        -- exactly five: null = Random, else {"idx": 0-2, "name": the game's string or null}.
        picks               jsonb NOT NULL,
        updated_by          text NOT NULL DEFAULT '',
        updated_at          timestamptz NOT NULL DEFAULT now(),
        -- what became of the last press that used it — audit rows stay discreet, so this is the
        -- only place owners can see that a press expired, was replaced, or was refused.
        last_outcome        text,
        last_outcome_at     timestamptz,
        last_outcome_detail text,
        last_requested_by   text,
        PRIMARY KEY (server_id, map_key, mode_key)
      );

      -- At most one press in flight per server; the primary key IS the per-server lock. id is
      -- minted fresh on every insert, and every later write names it, so an actor holding a row
      -- that has since been replaced can never claim, move or delete the newer one.
      CREATE TABLE IF NOT EXISTS map_point_pending (
        server_id         text PRIMARY KEY,
        id                text NOT NULL,
        game              text NOT NULL,
        map_key           text NOT NULL,
        mode_key          text NOT NULL,
        -- the target layer as the server spelled it, and the session's map at press time.
        map_id            text NOT NULL,
        before_map_id     text,
        -- 'await_load' (WW2: apply once loaded) | 'arming' (Vietnam: written BEFORE the store, so
        -- a crash mid-press still leaves a record to put back) | 'armed' (Vietnam: stored, switched).
        phase             text NOT NULL,
        picks             jsonb NOT NULL,
        -- Vietnam: where the layout was stored, the indices stored, and what stood there before
        -- (null = nothing, so the put-back removes rather than restores).
        stored_map_id     text,
        stored_indices    jsonb,
        restore           jsonb,
        baseline_match_id text,
        requested_by      text NOT NULL DEFAULT '',
        requested_at      timestamptz NOT NULL DEFAULT now(),
        expires_at        timestamptz NOT NULL,
        claimed_at        timestamptz
      );

      -- The game names a map's objectives only while that map is playing; each live read is kept.
      -- map_id keeps the session's EXACT spelling (a Vietnam stored-layout MapId may depend on
      -- it); map_id_lc is the case-blind key every lookup uses. map_key is the caller's zoneKeyOf.
      CREATE TABLE IF NOT EXISTS objective_grids (
        game      text NOT NULL,
        map_id_lc text NOT NULL,
        map_id    text NOT NULL,
        map_key   text,
        rows      jsonb NOT NULL,
        seen_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (game, map_id_lc)
      );
    `,
  },
  {
    // Vietnam: the indices an EARLIER press stored under the same key, when a press carried its
    // row (and its restore). Both lists are ours to undo: when a store's answer is lost (a timeout
    // that landed anyway, an unreadable read-back) nobody can tell which one stands, and a
    // put-back judging by one list alone would leave the other stored for good.
    //
    // Its own migration rather than a line in 119: 119 was already pushed, and an install that
    // ran it would never see a column added there — every pending write would then fail.
    id: "120_map_points_carried",
    sql: `
      ALTER TABLE map_point_pending ADD COLUMN IF NOT EXISTS carried_indices jsonb;
    `,
  },
  {
    // The owner's on/off switch per objective preset: off keeps the picks, and the catalogue's
    // Change now ignores the preset until it is switched back on. Every existing preset is on.
    id: "121_map_points_enabled",
    sql: `
      ALTER TABLE map_point_presets ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    `,
  },
  {
    // Team switches stored before their teams were kept: every one says only "switched team".
    // The game's line is still in the row's dedupe key ("<unix>|TEAMSWITCH Bob (Allies > None)"),
    // so read the two teams back off it and name the side swaps the way ingest now does
    // (@app/games team-switch.ts, packages/ingest team-switches.ts): Unassigned ("None") sits
    // between the sides, so a swap is the join that lands on a side other than the one the player
    // was last on THIS ROUND, and each carries the side it came from and its count in the round.
    //
    // The player's name comes off the line too: the old parser cut it at the first bracket, so
    // "Bob (TTV)" was stored as "Bob" — and read under that name, his first join would have been a
    // swap off the real Bob's side. The stored name is corrected with it.
    //
    // One pass in order over every switch and round edge: a round is the stretch between match
    // starts/ends on a server, and never spans a three-hour gap in a player's switches (ingest's
    // ROUND_LOOKBACK_MS — a stretch with no edge on record, or its edges trimmed away, is not one
    // endless round). Within one second a leave goes before a join (the log stamps whole seconds,
    // and the poller has delivered it newest first). The side a player was last on is the last
    // side any earlier line of theirs this round named — carried forward with the
    // count-then-group trick, as Postgres has no IGNORE NULLS. Each line is parsed once
    // (MATERIALIZED): inlined, the regex ran some thirty times a row. Rows that already carry
    // their teams are read but never rewritten; imported rows with no line in their key stay as
    // they are.
    id: "122_team_switch_direction",
    sql: `
      WITH stream AS (
        SELECT id, ts, server_id, kind, actor_name, actor_player_id, data, dedupe_key,
          count(*) FILTER (WHERE kind <> 'evt.player.teamSwitched')
            OVER (PARTITION BY server_id ORDER BY ts, (kind = 'evt.player.teamSwitched'), id ROWS UNBOUNDED PRECEDING) AS round_no
        FROM evt
        WHERE kind IN ('evt.player.teamSwitched', 'evt.match.started', 'evt.match.ended')
      ),
      raw AS MATERIALIZED (
        SELECT id, ts, server_id, round_no, actor_name, actor_player_id, kept, m,
          CASE WHEN NOT kept AND m IS NOT NULL THEN NULLIF(btrim(regexp_replace(regexp_replace(regexp_replace(
            dedupe_key, '^\\d+\\|', ''), '^TEAMSWITCH\\s+', '', 'i'), '\\s*\\([^()>]*>[^()]*\\)\\s*$', '')), '') END AS line_name
        FROM (
          SELECT id, ts, server_id, round_no, actor_name, actor_player_id, dedupe_key,
            COALESCE(jsonb_typeof(data->'from') = 'string' AND jsonb_typeof(data->'to') = 'string', false) AS kept,
            CASE WHEN COALESCE(jsonb_typeof(data->'from') = 'string' AND jsonb_typeof(data->'to') = 'string', false)
              THEN ARRAY[data->>'from', data->>'to']
              ELSE regexp_match(dedupe_key, '^(?:\\d+\\|)?TEAMSWITCH\\s+\\S.*\\(([^()>]*)>([^()]*)\\)\\s*$', 'i')
            END AS m
          FROM stream
          WHERE kind = 'evt.player.teamSwitched'
        ) parsed
      ),
      steps AS (
        SELECT id, ts, server_id, round_no, kept, line_name, f, t,
          -- Whose round: the player's when the row is linked, else the name's (as ingest reads it).
          CASE WHEN actor_player_id IS NOT NULL THEN 'id:' || actor_player_id::text ELSE 'name:' || name END AS who,
          CASE WHEN lower(f) IN ('none', 'unassigned') THEN NULL ELSE f END AS from_side,
          CASE WHEN lower(t) IN ('none', 'unassigned') THEN NULL ELSE t END AS to_side
        FROM (
          SELECT id, ts, server_id, round_no, kept, line_name, actor_player_id,
            COALESCE(line_name, NULLIF(btrim(actor_name), '')) AS name,
            COALESCE(NULLIF(btrim(m[1]), ''), 'None') AS f,
            COALESCE(NULLIF(btrim(m[2]), ''), 'None') AS t
          FROM raw WHERE m IS NOT NULL
        ) x
        WHERE name IS NOT NULL
      ),
      ordered AS (
        SELECT steps.*,
          CASE WHEN from_side IS NOT NULL AND to_side IS NULL THEN 0
               WHEN from_side IS NULL AND to_side IS NOT NULL THEN 2
               ELSE 1 END AS rnk,
          COALESCE(to_side, from_side) AS line_side
        FROM steps
      ),
      gapped AS (
        SELECT ordered.*,
          CASE WHEN ts - lag(ts) OVER (PARTITION BY server_id, round_no, who ORDER BY ts, rnk, id) > interval '3 hours' THEN 1 ELSE 0 END AS gap
        FROM ordered
      ),
      segs AS (
        SELECT gapped.*,
          sum(gap) OVER (PARTITION BY server_id, round_no, who ORDER BY ts, rnk, id ROWS UNBOUNDED PRECEDING) AS seg
        FROM gapped
      ),
      counted AS (
        SELECT segs.*,
          count(line_side) OVER (PARTITION BY server_id, round_no, who, seg ORDER BY ts, rnk, id ROWS UNBOUNDED PRECEDING) AS c
        FROM segs
      ),
      carried AS (
        SELECT counted.*, max(line_side) OVER (PARTITION BY server_id, round_no, who, seg, c) AS after_side
        FROM counted
      ),
      judged AS (
        SELECT prev.*, COALESCE(from_side, before_side) AS came,
          (to_side IS NOT NULL AND COALESCE(from_side, before_side) IS NOT NULL
            AND lower(COALESCE(from_side, before_side)) <> lower(to_side)) AS swap
        FROM (
          SELECT carried.*, lag(after_side) OVER (PARTITION BY server_id, round_no, who, seg ORDER BY ts, rnk, id) AS before_side
          FROM carried
        ) prev
      ),
      numbered AS (
        SELECT judged.*,
          sum(CASE WHEN swap THEN 1 ELSE 0 END) OVER (PARTITION BY server_id, round_no, who, seg ORDER BY ts, rnk, id ROWS UNBOUNDED PRECEDING) AS swaps
        FROM judged
      )
      UPDATE evt e SET
        data = CASE
          WHEN n.swap THEN jsonb_build_object('from', n.f, 'to', n.t, 'swapFrom', n.came, 'swapCount', n.swaps, 'change', 'switched sides ' || n.came || ' → ' || n.to_side)
          WHEN n.to_side IS NOT NULL THEN jsonb_build_object('from', n.f, 'to', n.t, 'change', 'joined ' || n.to_side)
          WHEN n.from_side IS NOT NULL THEN jsonb_build_object('from', n.f, 'to', n.t, 'change', 'left ' || n.from_side)
          ELSE jsonb_build_object('from', n.f, 'to', n.t, 'change', 'unassigned')
        END,
        actor_name = COALESCE(n.line_name, e.actor_name)
      FROM numbered n
      WHERE e.id = n.id AND e.ts = n.ts AND e.kind = 'evt.player.teamSwitched' AND NOT n.kept;
    `,
  },
  {
    // Rule sections: named shelves ("Player level rules", "Group rules") the Rules page sorts
    // rules onto, so a long list reads by purpose. Purely organisational — a section changes
    // nothing a rule does. A rule sits on at most one; deleting a section puts its rules back on
    // no section rather than deleting them. Names are unique ignoring case, since a saved rules
    // setup carries its rules' sections by name.
    id: "123_rule_sections",
    sql: `
      CREATE TABLE IF NOT EXISTS rule_sections (
        id         uuid PRIMARY KEY,
        name       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS rule_sections_name_uidx ON rule_sections (lower(name));
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES rule_sections(id) ON DELETE SET NULL;
    `,
  },
  {
    // Group VIP perks. A player group may carry a perk — while a player is listed they hold
    // PERMANENT VIP on the servers it names, and whatever timed VIP they had freezes beneath it
    // (time granted meanwhile adds to that frozen balance); leaving gives the balance back plus a
    // severance span. The perk sits on the group (player_groups.vip_perk: game, server rule,
    // severance); the hold sits on the VIP row it governs (vips.group_hold: since when, the frozen
    // balance, the groups holding it). A held row's expiration is NULL like any permanent grant,
    // so every reader, sweep and reconciler treats it as the permanent VIP it is; only the perk's
    // own reconciler ends it. Both are nullable: no perk, no hold.
    id: "124_group_vip_perks",
    sql: `
      ALTER TABLE player_groups ADD COLUMN IF NOT EXISTS vip_perk jsonb;
      ALTER TABLE vips ADD COLUMN IF NOT EXISTS group_hold jsonb;
      CREATE INDEX IF NOT EXISTS vips_group_hold_idx ON vips (server_id) WHERE group_hold IS NOT NULL;
    `,
  },
  {
    // Group membership as a rule trigger. Every real change — a player newly added to a group, or
    // removed from one — is queued here by the same statement that makes it, whoever makes it (a
    // person on the Groups page, or later the Discord role sync in the worker), and the API's rule
    // engine drains the queue, firing the rules that watch that group. A queue rather than a bus
    // event because the worker's events only reach the API through Redis, and a membership change
    // must not depend on that. No foreign key: a change queued just before its group was deleted
    // still names the group it happened in. Rows live seconds — taking one deletes it.
    id: "125_player_group_events",
    sql: `
      CREATE TABLE IF NOT EXISTS player_group_events (
        id          uuid PRIMARY KEY,
        group_id    uuid NOT NULL,
        group_name  text NOT NULL,
        player_id   text NOT NULL,
        player_name text,
        kind        text NOT NULL CHECK (kind IN ('joined', 'left')),
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS player_group_events_created_idx ON player_group_events (created_at, id);
    `,
  },
  {
    // The schedule trigger's ledger: one row per (rule, occurrence) it has run — "2026-11" for the
    // 1st of every month, "2026-11-07" for a weekly Saturday. Inserting the row IS claiming the
    // run, so an occurrence runs once however many API processes look at the clock, and a restart
    // never repeats one. It dies with its rule; it travels in archives beside its rule, because a
    // restored rule without its ledger would run this month's grant a second time.
    id: "126_rule_occurrences",
    sql: `
      CREATE TABLE IF NOT EXISTS rule_occurrences (
        rule_id    uuid NOT NULL REFERENCES enforcer_rules(id) ON DELETE CASCADE,
        occurrence text NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (rule_id, occurrence)
      );
    `,
  },
  {
    // Discord role → player group sync. A group may name a role in the community Discord; the
    // worker keeps its membership in step — whoever holds the role (with a linked game account) is
    // listed, whoever the SYNC listed and no longer holds it is not. Each membership remembers who
    // added it, so the sync only ever removes its own: a member added by a person stays, whatever
    // roles they hold. Rows that predate this were all added by people.
    id: "127_group_discord_roles",
    sql: `
      ALTER TABLE player_groups ADD COLUMN IF NOT EXISTS discord_role_id text;
      ALTER TABLE player_group_members ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'panel';
    `,
  },
  {
    // A membership change can wait for its member: a console id nobody has seen on a server yet
    // could be either game, and a Steam64 with no profile has nothing a points or tag rule can
    // write to. Such a change goes back in the queue — taken again from `not_before`, for the rules
    // still waiting on it (`rule_ids`; NULL = every rule watching) — and a member's changes are
    // taken in order, so a removal never overtakes the join it follows.
    id: "128_group_event_waits",
    sql: `
      ALTER TABLE player_group_events ADD COLUMN IF NOT EXISTS not_before timestamptz NOT NULL DEFAULT now();
      ALTER TABLE player_group_events ADD COLUMN IF NOT EXISTS rule_ids text[];
      CREATE INDEX IF NOT EXISTS player_group_events_member_idx ON player_group_events (group_id, player_id, created_at, id);
    `,
  },
  {
    // Taking a membership change CLAIMS it instead of deleting it: the row stays queued while its
    // rules run, so a second API process cannot take the member's next change past it (a removal
    // overtaking the join it follows). Finished changes are deleted; a claim left by a taker that
    // died is dropped after an hour rather than handed out twice.
    id: "129_group_event_claims",
    sql: `
      ALTER TABLE player_group_events ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
    `,
  },
  {
    // A section's master switch. Off holds every rule filed under it; each rule's own switch is
    // left as it was, so switching the section back on brings back exactly what was on before.
    id: "130_rule_section_switch",
    sql: `
      ALTER TABLE rule_sections ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
    `,
  },
  {
    // A rule paused until a moment, with who and why. It switches itself back on when the moment
    // passes — nothing to remember to undo — and never writes the rule's own switch.
    id: "131_rule_pause",
    sql: `
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS paused_until timestamptz;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS pause_reason text;
      ALTER TABLE enforcer_rules ADD COLUMN IF NOT EXISTS paused_by text;
    `,
  },
  {
    // Version history: each save of a rule, a map vote map set or a vote schedule, as it was
    // before and after, so any save can be undone. No foreign key on purpose — a deleted record's
    // history is exactly what brings it back. `seq` orders saves made in the same instant.
    id: "132_config_versions",
    sql: `
      CREATE TABLE IF NOT EXISTS config_versions (
        id            uuid PRIMARY KEY,
        seq           bigint GENERATED ALWAYS AS IDENTITY,
        kind          text NOT NULL,
        target_id     text NOT NULL,
        target_name   text,
        change        text NOT NULL,
        before        jsonb,
        after         jsonb,
        actor_user_id uuid,
        actor_name    text,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS config_versions_target_idx ON config_versions (kind, target_id, seq DESC);
    `,
  },
  {
    // Clan tags (Players → Clans): who has worn a spelling, and each player's newest tag. The
    // alias history was indexed only per player, so every "who wears X" read the whole table —
    // names included, which far outnumber tags. Partial, so the indexes hold the clan rows alone.
    id: "133_clan_tag_lookup",
    sql: `
      CREATE INDEX IF NOT EXISTS player_aliases_clan_value_idx ON player_aliases (value) WHERE kind = 'clan';
      CREATE INDEX IF NOT EXISTS player_aliases_clan_player_idx ON player_aliases (player_id, last_seen DESC) WHERE kind = 'clan';
    `,
  },
  {
    // Layouts are learned from players walking OUT of their own end in a round's opening minutes
    // now, never from where team labels stand at the start of a round — both teams' labels show
    // on the HQ lines then (players swapping sides, or still unassigned from the last match), and
    // that is what the old votes were cast on. They are dropped so they cannot outvote the new
    // ones; each layer learns again in two rounds. Painted zones are untouched (seeding_config).
    id: "134_map_layouts_travel",
    sql: `
      DELETE FROM map_layouts;
    `,
  },
  {
    // A seeding area now judges a player only on the OTHER team's painted ground — the middle and
    // every empty square are free — so the stock rule wording, which every greeting prints under
    // "Not allowed while seeding:", told players not to leave their own area: off the middle, the
    // very fight the paint leaves room for. The default says what is enforced now, and configs
    // still on the old default follow; a server's own wording is left exactly as it was written.
    id: "135_contain_notice_wording",
    sql: `
      ALTER TABLE seeding_config ALTER COLUMN contain_notice SET DEFAULT 'Going onto the other team''s ground (watch the map)';
      UPDATE seeding_config SET contain_notice = 'Going onto the other team''s ground (watch the map)'
        WHERE contain_notice = 'Leaving your team''s seeding area (watch the map)';
    `,
  },
  {
    // One switch per job on the ground rules. The zones answer to contain_enabled alone (paint
    // where painted, the auto fence everywhere else, layouts learned), steamroll protection to
    // pace_enabled alone, and positional_enabled only holds the cap fight by position. Before,
    // the auto fence also needed contain_auto_enabled and positional_enabled, and the pace rule
    // positional_enabled. So nothing starts punishing on its own: a switch that would now enforce
    // MORE than it did is turned off, for the owner to turn back on knowing what it does.
    id: "136_one_switch_per_job",
    sql: `
      UPDATE seeding_config SET pace_enabled = false WHERE pace_enabled AND NOT positional_enabled;
      UPDATE seeding_config SET contain_enabled = false
        WHERE contain_enabled AND NOT (contain_auto_enabled AND positional_enabled);
    `,
  },
  {
    // CRCON stores never-expiring VIP as a date in the year 3000 (its seeding rewards stack days
    // onto it: 3000-01-04, 3000-02-07…), and the import and the VIP sync carried those in as DATED
    // grants. Dated, the permanent floor did not cover them, and automation dated them down to a
    // few days — then the expiry sweep took them off the game. They are permanent: every store
    // write now turns such a date into null (storedVipExpiration), and this turns the rows already
    // stored, each with an audit row under the app's own name so "why is this VIP permanent now"
    // has an answer on the player's history.
    //
    // And the VIP integrity scan now reads the WHOLE VIP history. It stopped at 20,000 rows, oldest
    // first — on a busy install that cut off the NEWEST rows, where every dismissal and every
    // add-back is, so both came straight back on the next recheck. This partial index is that read
    // in time order, touching only the rows the scan needs (the same predicate it queries with).
    id: "137_vip_year_3000_permanent",
    sql: `
      INSERT INTO audit (id, ts, actor_user_id, actor_name, action, target_type, target_id, target_name, server_id, summary, data, automated)
      SELECT gen_random_uuid(), now(), NULL, 'vip-integrity', 'vip.grant', 'player', v.player_id, v.player_name, v.server_id,
             'stored the VIP grant for ' || coalesce(v.player_name, v.player_id) || ' as permanent — its expiry ('
               || to_char(v.expiration AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ') was CRCON''s year-3000 "never expires"',
             jsonb_build_object('playerId', v.player_id, 'expiration', NULL, 'was', v.expiration, 'year3000', true),
             true
        FROM vips v WHERE v.expiration >= '2900-01-01T00:00:00Z';
      UPDATE vips SET expiration = NULL, updated_at = now() WHERE expiration >= '2900-01-01T00:00:00Z';
      CREATE INDEX IF NOT EXISTS audit_vip_timeline_idx ON audit (ts, id)
        WHERE action IN ('vip.grant', 'vip.revoke', 'vip.reduce', 'vip.expire', 'seed.reward', 'player.vipresume', 'vip.integrity_ignore', 'vip.group_hold', 'vip.group_release')
           OR (action IN ('game.reward', 'enforcer.vip') AND data->>'expiration' IS NOT NULL);
    `,
  },
  {
    // A round shorter than five minutes is not a game (MIN_MATCH_MS). They were showing up as
    // "0m" rounds — a start line the game writes on the end screen, closed a moment later with
    // the round before's score; a map loaded and switched away from at once — and each one
    // handed everyone on its scoreboard a played (a loss in their win rate) and, closed by a
    // whistle, a win; and while one sat open on the end screen the scoreboard sampler added
    // every player's whole last round to their career a second time.
    //
    // `scores_credited` is the sampler's new gate: a round's scores reach careers once it has
    // run five minutes. Every live round so far credited its scores as it went, so they are
    // marked credited; an imported round never touched careers (the import writes lines only).
    //
    // Then the short rounds already stored: what each gave careers is taken back — the played
    // and won a settle rolled on, and the scores a credited round's lines hold (the sampler
    // credited exactly those: each sample added only the rise over the line) — and they go,
    // their lines and rollups with them. Kills, deaths and time on the server stay: those
    // come from the kill stream and the clocks, never from a round. One audit row per server.
    id: "138_short_rounds_are_not_games",
    sql: `
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS scores_credited boolean NOT NULL DEFAULT false;
      UPDATE matches SET scores_credited = true WHERE settled_at IS NOT NULL OR ended_at IS NULL;

      CREATE TEMP TABLE short_rounds ON COMMIT DROP AS
        SELECT id, server_id, settled_at IS NOT NULL AS settled, scores_credited AS credited
        FROM matches WHERE ended_at IS NOT NULL AND ended_at - started_at < interval '300 seconds';

      WITH owed AS (
        SELECT l.player_id, l.server_id,
               count(*) FILTER (WHERE r.settled)::int AS played,
               count(*) FILTER (WHERE r.settled AND l.won)::int AS won,
               coalesce(sum(l.combat) FILTER (WHERE r.credited), 0)::bigint AS combat,
               coalesce(sum(l.offense) FILTER (WHERE r.credited), 0)::bigint AS offense,
               coalesce(sum(l.defense) FILTER (WHERE r.credited), 0)::bigint AS defense,
               coalesce(sum(l.support) FILTER (WHERE r.credited), 0)::bigint AS support,
               coalesce(sum(l.vehicle_kills) FILTER (WHERE r.credited), 0)::bigint AS vehicle_kills,
               coalesce(sum(l.vehicles_destroyed) FILTER (WHERE r.credited), 0)::bigint AS vehicles_destroyed
        FROM player_match_stats l JOIN short_rounds r ON r.id = l.match_id
        GROUP BY l.player_id, l.server_id
      )
      UPDATE player_stats ps SET
        matches_played = GREATEST(ps.matches_played - o.played, 0),
        matches_won = GREATEST(ps.matches_won - o.won, 0),
        combat = GREATEST(ps.combat - o.combat, 0),
        offense = GREATEST(ps.offense - o.offense, 0),
        defense = GREATEST(ps.defense - o.defense, 0),
        support = GREATEST(ps.support - o.support, 0),
        vehicle_kills = GREATEST(ps.vehicle_kills - o.vehicle_kills, 0),
        vehicles_destroyed = GREATEST(ps.vehicles_destroyed - o.vehicles_destroyed, 0),
        updated_at = now()
      FROM owed o WHERE ps.player_id = o.player_id AND ps.server_id = o.server_id;

      INSERT INTO audit (id, ts, actor_user_id, actor_name, action, target_type, target_id, target_name, server_id, summary, data, automated)
      SELECT gen_random_uuid(), now(), NULL, 'match history', 'app.short_rounds', 'server', r.server_id::text, s.name, r.server_id,
             'removed ' || count(*) || ' round' || CASE WHEN count(*) = 1 THEN '' ELSE 's' END
               || ' shorter than five minutes from the match history, and took back the games played, wins and scores they had added to player stats',
             jsonb_build_object('rounds', count(*)), true
      FROM short_rounds r LEFT JOIN servers s ON s.id = r.server_id
      GROUP BY r.server_id, s.name;

      DELETE FROM matches WHERE id IN (SELECT id FROM short_rounds);
    `,
  },
  {
    // The round's score timeline as CRCON's map recorder keeps it (rcon/logs/loop.py): cap flips
    // and, in Conquest, morale at each flip, both as [seconds since start, allied, axis], plus the
    // theoretical match length. The CRCON-compatible API publishes all three on every round. Arrays
    // rather than objects: the API builds each object in CRCON's own key order, which jsonb
    // would not keep. Existing rounds start empty, as CRCON's own rows did before it recorded them.
    id: "139_match_score_timeline",
    sql: `
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS cap_flips jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS morale_history jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_time int NOT NULL DEFAULT 0;
    `,
  },
  {
    // What CRCON records as a round starts (rcon/hooks.py handle_new_match_start): the layer id it
    // files the round under — its `map_name` everywhere a past round is published, and the id its
    // in-match recorder compares the live map with — whether that id was guessed from the match
    // log, and the initial_morale it starts with. Its own initial_morale column, because CRCON's
    // is set on rounds that are not scored in morale and ours never is. Null until the worker has
    // made the decision; rounds from before it are read by @app/maps crconMapNameFromRecord.
    id: "140_crcon_round_start",
    sql: `
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS crcon_map text;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS crcon_guessed boolean;
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS crcon_initial_morale int;
    `,
  },
  {
    // CRCON's record of a round's end (rcon/hooks.py record_map_end): a MATCH ENDED line read
    // within a minute ends the round only when the live layer is on the map the line names;
    // otherwise CRCON leaves the end unset, and the next MATCH START sets it to its own time.
    // True for that deferred case, false when the line's time stood, null when not decided.
    id: "141_crcon_round_end",
    sql: `
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS crcon_end_deferred boolean;
    `,
  },
  {
    // A round under MIN_MATCH_MS is no game for our own records, and matches.discardShort deletes
    // it. CRCON lists every round it saw start, so a copy of what its endpoints publish is kept
    // here: the round's public alias (seq) and its CRCON fields. Only the CRCON-compatible
    // endpoints read this table; nothing that counts games does.
    id: "142_crcon_short_rounds",
    sql: `
      CREATE TABLE IF NOT EXISTS crcon_short_rounds (
        seq                  bigint PRIMARY KEY,
        server_id            uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        game                 text,
        map                  text,
        crcon_map            text,
        crcon_guessed        boolean,
        crcon_initial_morale int,
        crcon_end_deferred   boolean,
        started_at           timestamptz NOT NULL,
        ended_at             timestamptz,
        cap_flips            jsonb NOT NULL DEFAULT '[]'::jsonb,
        morale_history       jsonb NOT NULL DEFAULT '[]'::jsonb,
        match_time           int NOT NULL DEFAULT 0,
        sector_layout        jsonb,
        allied_score         int,
        axis_score           int,
        result               text,
        created_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS crcon_short_rounds_server_started_idx ON crcon_short_rounds (server_id, started_at DESC);
    `,
  },
  {
    // CRCON's per-round player cache (MapInfo.player_stats, record_player_stats in
    // rcon/logs/loop.py): what its live scoreboards lay over each player's row and what its
    // stored scoreboard takes the score buckets, level and unit history from. Kept beside the round
    // rather than on it, so reading a match never drags a hundred players' histories along; a short
    // round's copy rides into crcon_short_rounds with the rest of what CRCON keeps of it.
    id: "143_crcon_player_stats",
    sql: `
      CREATE TABLE IF NOT EXISTS crcon_player_stats (
        match_id   uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
        players    jsonb NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE crcon_short_rounds ADD COLUMN IF NOT EXISTS player_stats jsonb;
    `,
  },
  {
    // Each player's score buckets through a round: the round report's score charts. One point a
    // minute while they change, from CRCON's player cache (the round's running total plus what a
    // reconnect banked), so a chart ends on the number the scoreboard shows. Flattened, five ints a
    // point: seconds since the round's start, then combat, offense, defense, support. Its own table,
    // so the reads that take every column of a scoreboard line never drag a round's history along.
    id: "144_match_score_series",
    sql: `
      CREATE TABLE IF NOT EXISTS match_score_series (
        match_id   uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        points     int[] NOT NULL DEFAULT '{}',
        PRIMARY KEY (match_id, player_id)
      );
    `,
  },
  {
    // The in-game ballot's counted voters, as the worker last read them for the vote whose message
    // id they carry: the public API's vote_status lists them, as CRCON lists its voters. Live state
    // like the rest of the row, so never exported.
    id: "145_mapvote_ingame_voters",
    sql: `ALTER TABLE mapvote_state ADD COLUMN IF NOT EXISTS ingame_voters jsonb;`,
  },
  {
    // A finished event staff decided not to pay. Without it the events list says "Awaiting
    // payment" forever, because a closed event cannot be cancelled: it is a record, and its report
    // stays readable. Who marked it rides beside it for the list; the audit trail has the rest.
    // Exported with the rest of payout_events, so a restore keeps the decision.
    id: "146_payout_event_no_payout",
    sql: `ALTER TABLE payout_events ADD COLUMN IF NOT EXISTS no_payout_at timestamptz,
                                    ADD COLUMN IF NOT EXISTS no_payout_by text;`,
  },
  {
    // A player trigger's event can now carry settings of its own, the way a rule's trigger does:
    // which weapons a "kills with a weapon" trigger listens for. '{}' for every trigger before it,
    // whose events need nothing.
    id: "147_player_trigger_params",
    sql: `ALTER TABLE player_triggers ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}'::jsonb;`,
  },
  {
    // The queue at each roster sample: players waiting to get in, and the VIP queue where its
    // counter can be believed. Recorded from here on. Samples taken before it have no queue and
    // keep none — an old sample's queue is unknown, not empty. Exported with the rest of the row.
    id: "148_roster_snapshot_queue",
    sql: `ALTER TABLE roster_snapshots ADD COLUMN IF NOT EXISTS queue_count integer,
                                       ADD COLUMN IF NOT EXISTS vip_queue_count integer;`,
  },
  {
    // The game log's guard against storing a line twice indexes a 16-byte hash of the line's key
    // instead of the key's full text, which is the whole log line over again. Measured on the
    // ingest path, that index falls from about 188 bytes a line to about 59: the biggest single
    // saving in the biggest table. The key itself stays on the row, unchanged (it orders the
    // lines inside one second and marks imported rows), so nothing that reads it changes. Built
    // once, during the update; every insert names the same expression in its ON CONFLICT.
    id: "149_evt_dedupe_hash",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS evt_dedupe_hash_uidx ON evt (server_id, (md5(dedupe_key)::uuid), ts);
      DROP INDEX IF EXISTS evt_dedupe_uidx;
    `,
  },
  {
    // Indexes no query can use, each one still written on every insert or update of its table:
    //  - player_stats (a row per player per server, updated on every batch of kills): the
    //    leaderboard adds each player's rows up before it sorts, so neither the five whole-table
    //    sort indexes nor six of the seven per-server ones can serve it, and the player index is
    //    the primary key's own first column. The primary key and one per-server index (the
    //    server filter) are all its reads use. Measured: the kill updates write 54% less.
    //  - roster_snapshots: a second (server_id, ts) index beside the unique one, identical.
    //  - matches: (server_id, started_at DESC) beside the unique (server_id, started_at), which
    //    Postgres reads backwards just as well.
    id: "150_drop_dead_indexes",
    sql: `
      DROP INDEX IF EXISTS player_stats_kills_idx;
      DROP INDEX IF EXISTS player_stats_support_idx;
      DROP INDEX IF EXISTS player_stats_defense_idx;
      DROP INDEX IF EXISTS player_stats_offense_idx;
      DROP INDEX IF EXISTS player_stats_sl_seconds_idx;
      DROP INDEX IF EXISTS player_stats_player_idx;
      DROP INDEX IF EXISTS player_stats_server_playtime_idx;
      DROP INDEX IF EXISTS player_stats_server_combat_idx;
      DROP INDEX IF EXISTS player_stats_server_support_idx;
      DROP INDEX IF EXISTS player_stats_server_defense_idx;
      DROP INDEX IF EXISTS player_stats_server_offense_idx;
      DROP INDEX IF EXISTS player_stats_server_sl_seconds_idx;
      DROP INDEX IF EXISTS roster_snapshots_server_ts_idx;
      DROP INDEX IF EXISTS matches_server_idx;
    `,
  },
  {
    // The score series packed (score-series-pack.ts): each number stored as its change since the
    // point before, usually one byte instead of four. A series is about 70% smaller, and so is the
    // row rewritten each minute a player's score moves. `points` stays for the rows written before
    // this, and readers take `packed` wherever it is set: the round being played moves over on its
    // next point, and finished rounds are left exactly as they are.
    id: "151_score_series_packed",
    sql: `ALTER TABLE match_score_series ADD COLUMN IF NOT EXISTS packed bytea;`,
  },
  {
    // A play session is at most a day from its connect (SESSION_MAX_SEC), and every way one closes
    // now stores it so. This caps the ones stored before — closed only by a connect weeks later,
    // swept up by the roster check's first pass over a backlog of stale opens, or kept open by
    // CRCON until a disconnect line months on (a live WW2 profile showed a 1,584-hour session, and
    // 1,589 hours of playtime with it) — and takes the extra time back off playtime, but only what
    // a session actually added. A session's length went into playtime when:
    //  - the panel's own connect or disconnect line closed it: that line sits exactly at its end;
    //  - the import folded it in: it ended no later than the newest connect or disconnect line
    //    imported from CRCON for that server, or — where no lines were imported — before the first
    //    line the panel recorded there. Imported lines all predate the panel's own record, so no
    //    session the panel closed itself can end before them.
    // The roster check's sessions never added any, nor did an imported one from after the panel's
    // own record began; those are only capped. Nothing comes off a server's playtime that does not
    // still hold the sessions' whole length. One audit row per server.
    id: "152_sessions_end_within_a_day",
    sql: `
      CREATE TEMP TABLE session_bounds ON COMMIT DROP AS
        SELECT sv.server_id,
               GREATEST(
                 (SELECT max(e.ts) FROM evt e WHERE e.kind = 'evt.player.connected' AND e.server_id = sv.server_id AND e.dedupe_key LIKE 'crcon:%'),
                 (SELECT max(e.ts) FROM evt e WHERE e.kind = 'evt.player.disconnected' AND e.server_id = sv.server_id AND e.dedupe_key LIKE 'crcon:%')
               ) AS imported_until,
               NULL::timestamptz AS local_from
        FROM (SELECT DISTINCT server_id FROM player_sessions
               WHERE duration_sec > 86400 OR disconnected_at > connected_at + interval '86400 seconds') sv;
      UPDATE session_bounds b SET local_from = (
        SELECT min(e.ts) FROM evt e WHERE e.server_id = b.server_id AND (e.dedupe_key IS NULL OR e.dedupe_key NOT LIKE 'crcon:%')
      ) WHERE b.imported_until IS NULL;

      CREATE TEMP TABLE long_play_sessions ON COMMIT DROP AS
        SELECT s.id, s.player_id, s.server_id, s.duration_sec,
               COALESCE(
                 EXISTS (SELECT 1 FROM evt e
                          WHERE e.actor_player_id = s.player_id AND e.ts = s.disconnected_at AND e.server_id = s.server_id
                            AND e.kind IN ('evt.player.connected', 'evt.player.disconnected')
                            AND (e.dedupe_key IS NULL OR e.dedupe_key NOT LIKE 'crcon:%'))
                 OR s.disconnected_at <= b.imported_until
                 OR s.disconnected_at < b.local_from,
               false) AS counted
        FROM player_sessions s JOIN session_bounds b ON b.server_id = s.server_id
        WHERE s.duration_sec > 86400 OR s.disconnected_at > s.connected_at + interval '86400 seconds';

      CREATE TEMP TABLE owed_playtime ON COMMIT DROP AS
        SELECT l.player_id, l.server_id, sum(GREATEST(l.duration_sec - 86400, 0))::bigint AS extra
        FROM long_play_sessions l
        JOIN player_stats ps ON ps.player_id = l.player_id AND ps.server_id = l.server_id
        WHERE l.counted
        GROUP BY l.player_id, l.server_id, ps.playtime_sec
        HAVING ps.playtime_sec >= sum(l.duration_sec);

      UPDATE player_stats ps SET playtime_sec = ps.playtime_sec - o.extra, updated_at = now()
      FROM owed_playtime o WHERE ps.player_id = o.player_id AND ps.server_id = o.server_id;

      INSERT INTO audit (id, ts, actor_user_id, actor_name, action, target_type, target_id, target_name, server_id, summary, data, automated)
      SELECT gen_random_uuid(), now(), NULL, 'session history', 'app.long_sessions', 'server', l.server_id::text, sv.name, l.server_id,
             'capped ' || count(*) || ' play session' || CASE WHEN count(*) = 1 THEN '' ELSE 's' END
               || ' longer than 24 hours at 24 hours from the connect'
               || CASE WHEN count(DISTINCT o.player_id) = 0 THEN ''
                       ELSE ', and took the ' || round(sum(GREATEST(l.duration_sec - 86400, 0)) FILTER (WHERE o.player_id IS NOT NULL) / 3600.0)
                            || ' extra hours they had added back off the playtime of ' || count(DISTINCT o.player_id)
                            || CASE WHEN count(DISTINCT o.player_id) = 1 THEN ' player' ELSE ' players' END
                  END,
             jsonb_build_object(
               'sessions', count(*),
               'players', count(DISTINCT o.player_id),
               'hours', round(coalesce(sum(GREATEST(l.duration_sec - 86400, 0)) FILTER (WHERE o.player_id IS NOT NULL), 0) / 3600.0)),
             true
      FROM long_play_sessions l
      LEFT JOIN owed_playtime o ON o.player_id = l.player_id AND o.server_id = l.server_id AND l.counted
      LEFT JOIN servers sv ON sv.id = l.server_id
      GROUP BY l.server_id, sv.name;

      UPDATE player_sessions s SET duration_sec = 86400, disconnected_at = s.connected_at + interval '86400 seconds'
      FROM long_play_sessions l WHERE s.id = l.id;
    `,
  },
  {
    // The install's own settings (Repository.installSettings): the deployment's, not the
    // community's — the key that signs logins, service credentials, the setup code. A secret is
    // sealed with ENCRYPTION_KEY like an RCON password. Never carried in a data archive.
    id: "153_install_settings",
    sql: `
      CREATE TABLE IF NOT EXISTS install_settings (
        key        text PRIMARY KEY,
        value      text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      );
    `,
  },
  {
    // The devices taking phone notifications (Repository.pushSubscriptions). Keyed by the address
    // the browser's push service gave it; they go with their account.
    id: "154_push_subscriptions",
    sql: `
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint   text PRIMARY KEY,
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        p256dh     text NOT NULL,
        auth       text NOT NULL,
        device     text NOT NULL DEFAULT '',
        origin     text NOT NULL DEFAULT '',
        epoch      integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
    `,
  },
  {
    // API tokens became a permission (api.tokens): making one takes it, and a token works only
    // while its maker holds it. Until now being signed in was enough for both.
    id: "155_api_tokens_permission",
    sql: `
      -- Nobody's working token stops on upgrade: an account holding one that hasn't run out gets
      -- the permission as a grant of its own, which can be taken away like any other. An owner
      -- (the '*' grant, their own or a role's) holds it already and gets nothing extra. Anyone
      -- else now needs it given before they can make a token.
      INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level)
      SELECT gen_random_uuid(), t.user_id, 'api.tokens', 'global', NULL, 'write'
        FROM (SELECT DISTINCT user_id FROM api_tokens WHERE expires_at IS NULL OR expires_at > now()) t
       WHERE NOT EXISTS (
               SELECT 1 FROM grants g
                WHERE g.user_id = t.user_id
                  AND (g.capability = 'api.tokens' OR (g.capability = '*' AND g.level = 'write')))
         AND NOT EXISTS (
               SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = t.user_id
                  AND r.grants @> '[{"capability":"*","level":"write"}]'::jsonb);
    `,
  },
  {
    // Three permissions split, each keeping its name for the part that stayed (CAPABILITY_SPLITS in
    // @app/access): the chat filter and the zone sets off the enforcer rules, the seed reward off
    // seeding, the Discord bot's setup and online access off user & role admin.
    id: "156_split_rules_seeding_user_admin",
    sql: `
      -- Nobody loses access on upgrade: every stored grant of the three gains the same scope and
      -- level on each new key — at every level, so a 'none' block keeps blocking. Idempotent, and
      -- never overwrites a grant made on a new key by hand.
      WITH split(old_key, new_key) AS (VALUES
        ('admin.moderation','moderation.chatfilter'), ('admin.moderation','moderation.zones'),
        ('seeding.config','seeding.rewards'),
        ('admin.users','discord.setup'), ('admin.users','admin.online')
      )
      INSERT INTO grants (id, user_id, capability, scope_type, scope_id, level)
      SELECT gen_random_uuid(), g.user_id, s.new_key, g.scope_type, g.scope_id, g.level
        FROM grants g
        JOIN split s ON s.old_key = g.capability
       WHERE NOT EXISTS (
               SELECT 1 FROM grants x
                WHERE x.user_id = g.user_id AND x.capability = s.new_key
                  AND x.scope_type = g.scope_type AND x.scope_id IS NOT DISTINCT FROM g.scope_id);

      -- Role documents the same way (roles are global-scope): an entry naming one of the three gains
      -- a sibling per new key at its level, unless the role already has an entry for that key.
      WITH split(old_key, new_key) AS (VALUES
        ('admin.moderation','moderation.chatfilter'), ('admin.moderation','moderation.zones'),
        ('seeding.config','seeding.rewards'),
        ('admin.users','discord.setup'), ('admin.users','admin.online')
      ),
      extra AS (
        SELECT r.id AS role_id, jsonb_agg(DISTINCT jsonb_build_object('capability', s.new_key, 'level', e.entry->>'level')) AS entries
          FROM roles r
          CROSS JOIN LATERAL jsonb_array_elements(r.grants) AS e(entry)
          JOIN split s ON s.old_key = e.entry->>'capability'
         WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.grants) x(entry) WHERE x.entry->>'capability' = s.new_key)
         GROUP BY r.id
      )
      UPDATE roles SET grants = roles.grants || extra.entries
        FROM extra
       WHERE roles.id = extra.role_id;
    `,
  },
  {
    id: "157_brand_images",
    sql: `
      -- The community's own images, uploaded in the panel: today the match board's corner badge.
      -- It shipped as a file inside the program, so every install's board wore one community's
      -- badge. One row per image, by what it is for.
      CREATE TABLE IF NOT EXISTS brand_images (
        key        text PRIMARY KEY,
        mime       text NOT NULL,
        bytes      bytea NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      );
    `,
  },
  {
    id: "158_audit_vip_grant_ref",
    sql: `
      -- The points history reads back what each VIP shop purchase landed as — the vip.grant rows that
      -- carry its ledger ref — to say when the days bought start and when the VIP now ends.
      CREATE INDEX IF NOT EXISTS audit_vip_grant_ref_idx ON audit ((data->>'ref')) WHERE action = 'vip.grant';
    `,
  },
];
