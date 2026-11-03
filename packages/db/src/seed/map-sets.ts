/**
 * The starter map-set library.
 *
 * These five sets and their timings came from the old bot's configs and used to be a hardcoded preset list
 * the panel offered as a starting point: staff copied one into a server, and the original stayed
 * frozen in the source forever. They are seed rows now — inserted once by the migration and then
 * ordinary records anybody can rename, edit or delete. A community that wants none of them deletes
 * all five and nothing brings them back.
 *
 * The pools are authored MODE-FIRST (modeBuckets) so starting from one never lands staff on the
 * legacy-set convert callout. The old bot's day/night/wildcard counts translate as: each mode keeps its
 * total draw, night-only intent becomes a night ceiling, "wildcard" becomes a count with no
 * ceilings, and a legacy "day" bucket lists every non-night environment its curated pool actually
 * spans (day/morning/dusk/overcast) so nothing the old bot's set offered silently drops out — the engine
 * matches environments exactly, not by the old coarse day/night grouping. The legacy counts are
 * pinned to 0 so nothing lurks behind the buckets.
 *
 * Schedules are seeded SEPARATELY from the sets, and named for the window rather than the set,
 * because a timing is reusable on its own: "Overnight" is as good a fit for a low-population set as
 * for the night maps it shipped with.
 */
export interface SeedMapSet { name: string; pool: Record<string, unknown> }
export interface SeedVoteSchedule { name: string; spec: Record<string, unknown> }

export const SEED_MAP_SETS: SeedMapSet[] = [
  {
    "name": "dday",
    "pool": {
      "modeBuckets": [
        {
          "mode": "offensive",
          "count": 4,
          "limits": {
            "day": 3,
            "morning": 3,
            "night": 1
          }
        },
        {
          "mode": "warfare",
          "count": 2
        }
      ],
      "dayCount": 0,
      "nightCount": 0,
      "wildcardCount": 0,
      "duplicateMaps": true,
      "allowedMaps": [
        "omahabeach_warfare",
        "omahabeach_warfare_night",
        "omahabeach_offensive_ger",
        "omahabeach_offensive_us",
        "utahbeach_warfare",
        "utahbeach_warfare_night",
        "utahbeach_offensive_ger",
        "utahbeach_offensive_us",
        "junobeach_warfare_day",
        "junobeach_warfare_morning",
        "junobeach_warfare_night",
        "junobeach_offensiveger_day",
        "junobeach_offensiveger_morning",
        "junobeach_offensiveger_night",
        "junobeach_offensivecan_day",
        "junobeach_offensivecan_morning",
        "junobeach_offensivecan_night"
      ],
      "blacklistMaps": [
        "carentan_offensive_ger",
        "carentan_offensive_us",
        "driel_offensive_ger",
        "driel_offensive_us",
        "elalamein_offensive_CW",
        "elalamein_offensive_ger",
        "elsenbornridge_offensiveger_day",
        "elsenbornridge_offensiveger_morning",
        "elsenbornridge_offensiveger_night",
        "elsenbornridge_offensiveUS_day",
        "elsenbornridge_offensiveUS_morning",
        "elsenbornridge_offensiveUS_night",
        "foy_offensive_ger",
        "foy_offensive_us",
        "hill400_offensive_ger",
        "hill400_offensive_US",
        "hurtgenforest_offensive_ger",
        "hurtgenforest_offensive_US",
        "kharkov_offensive_ger",
        "kharkov_offensive_rus",
        "kursk_offensive_ger",
        "kursk_offensive_rus",
        "mortain_offensiveger_day",
        "mortain_offensiveger_dusk",
        "mortain_offensiveger_overcast",
        "mortain_offensiveUS_day",
        "mortain_offensiveUS_dusk",
        "mortain_offensiveUS_overcast",
        "PHL_L_1944_OffensiveGER",
        "PHL_L_1944_OffensiveUS",
        "REM_L_1945_OffensiveGER",
        "REM_L_1945_OffensiveUS",
        "stmereeglise_offensive_ger",
        "stmereeglise_offensive_us",
        "smolensk_offensiveGer_Day",
        "smolensk_offensiveGer_dusk",
        "smolensk_offensiveGer_night",
        "smolensk_offensiveRus_day",
        "smolensk_offensiveRus_dusk",
        "smolensk_offensiveRus_night",
        "stmariedumont_off_ger",
        "stmariedumont_off_us",
        "STA_L_1942_OffensiveGER",
        "STA_L_1942_OffensiveRUS",
        "tobruk_offensivebritish_day",
        "tobruk_offensivebritish_dusk",
        "tobruk_offensivebritish_morning",
        "tobruk_offensiveger_day",
        "tobruk_offensiveger_dusk",
        "tobruk_offensiveger_morning",
        "CAR_S_1944_Day_P_Skirmish",
        "CAR_S_1944_Dusk_P_Skirmish",
        "CAR_S_1944_Rain_P_Skirmish",
        "DRL_S_1944_P_Skirmish",
        "DRL_S_1944_Day_P_Skirmish",
        "DRL_S_1944_Night_P_Skirmish",
        "ELA_S_1942_P_Skirmish",
        "ELA_S_1942_Night_P_Skirmish",
        "elsenbornridge_skirmish_day",
        "elsenbornridge_skirmish_morning",
        "elsenbornridge_skirmish_night",
        "HIL_S_1944_Day_P_Skirmish",
        "HIL_S_1944_Dusk_P_Skirmish",
        "mortain_skirmish_day",
        "mortain_skirmish_dusk",
        "mortain_skirmish_overcast",
        "PHL_S_1944_Morning_P_Skirmish",
        "PHL_S_1944_Night_P_Skirmish",
        "PHL_S_1944_Rain_P_Skirmish",
        "REM_S_1945_P_Skirmish_Day",
        "REM_S_1945_P_Skirmish_Night",
        "SME_S_1944_Day_P_Skirmish",
        "SME_S_1944_Morning_P_Skirmish",
        "SME_S_1944_Night_P_Skirmish",
        "smolensk_skirmish_day",
        "smolensk_skirmish_dusk",
        "smolensk_skirmish_night",
        "SMDM_S_1944_Day_P_Skirmish",
        "SMDM_S_1944_Night_P_Skirmish",
        "SMDM_S_1944_Rain_P_Skirmish",
        "STA_S_1942_P_Skirmish_Dusk",
        "STA_S_1942_P_Skirmish_Overcast",
        "tobruk_skirmish_day",
        "tobruk_skirmish_dusk",
        "tobruk_skirmish_morning",
        "carentan_warfare",
        "carentan_warfare_night",
        "driel_warfare",
        "driel_warfare_night",
        "elalamein_warfare",
        "elalamein_warfare_night",
        "elsenbornridge_warfare_day",
        "elsenbornridge_warfare_morning",
        "elsenbornridge_warfare_night",
        "foy_warfare",
        "foy_warfare_night",
        "hill400_warfare",
        "hurtgenforest_warfare_V2",
        "hurtgenforest_warfare_V2_night",
        "kharkov_warfare",
        "kharkov_warfare_night",
        "kursk_warfare",
        "kursk_warfare_night",
        "mortain_warfare_day",
        "mortain_warfare_dusk",
        "mortain_warfare_overcast",
        "PHL_L_1944_Warfare",
        "PHL_L_1944_Warfare_Night",
        "REM_L_1945_Warfare",
        "REM_L_1945_WarfareNight",
        "stmereeglise_warfare",
        "stmereeglise_warfare_night",
        "smolensk_warfare_day",
        "smolensk_warfare_dusk",
        "smolensk_warfare_night",
        "stmariedumont_warfare",
        "stmariedumont_warfare_night",
        "STA_L_1942_Warfare",
        "STA_L_1942_Warfare_Night",
        "tobruk_warfare_day",
        "tobruk_warfare_dusk",
        "tobruk_warfare_morning"
      ],
      "enforceCount": 0
    }
  },
  {
    "name": "seeding",
    "pool": {
      "modeBuckets": [
        {
          "mode": "warfare",
          "count": 5,
          "limits": {
            "day": 5,
            "morning": 5,
            "dusk": 5,
            "overcast": 5
          }
        }
      ],
      "dayCount": 0,
      "nightCount": 0,
      "wildcardCount": 0,
      "duplicateMaps": false,
      "blacklistMaps": [
        "tobruk_offensiveger_dusk",
        "tobruk_offensivebritish_dusk",
        "tobruk_offensiveger_day",
        "tobruk_offensivebritish_day",
        "tobruk_offensiveger_morning",
        "tobruk_warfare_morning",
        "tobruk_warfare_dusk",
        "tobruk_offensivebritish_morning",
        "elalamein_offensive_CW",
        "elalamein_offensive_ger",
        "elalamein_warfare_night",
        "REM_L_1945_Warfare",
        "REM_L_1945_WarfareNight",
        "REM_L_1945_OffensiveUS",
        "REM_L_1945_OffensiveGER",
        "smolensk_warfare_day",
        "smolensk_warfare_dusk",
        "smolensk_warfare_night",
        "smolensk_offensiveGer_Day",
        "smolensk_offensiveRus_day",
        "smolensk_offensiveGer_dusk",
        "smolensk_offensiveRus_dusk",
        "smolensk_offensiveGer_night",
        "smolensk_offensiveRus_night",
        "smolensk_skirmish_day",
        "smolensk_skirmish_dusk",
        "smolensk_skirmish_night",
        "junobeach_warfare_morning",
        "junobeach_warfare_night",
        "junobeach_offensiveger_day",
        "junobeach_offensiveger_morning",
        "junobeach_offensiveger_night",
        "junobeach_offensivecan_day",
        "junobeach_offensivecan_morning",
        "junobeach_offensivecan_night"
      ],
      "enforceCount": 0,
      "excludePlayedMaps": 2
    }
  },
  {
    "name": "friday",
    "pool": {
      "modeBuckets": [
        {
          "mode": "warfare",
          "count": 4,
          "limits": {
            "night": 4
          }
        },
        {
          "mode": "offensive",
          "count": 2,
          "limits": {
            "night": 2
          }
        }
      ],
      "dayCount": 0,
      "nightCount": 0,
      "wildcardCount": 0,
      "duplicateMaps": false,
      "blacklistMaps": [
        "elsenbornridge_warfare_morning",
        "tobruk_warfare_morning",
        "carentan_warfare",
        "driel_warfare",
        "elalamein_warfare",
        "elsenbornridge_warfare_day",
        "foy_warfare",
        "hill400_warfare",
        "hurtgenforest_warfare_V2",
        "kharkov_warfare",
        "kursk_warfare",
        "mortain_warfare_day",
        "omahabeach_warfare",
        "PHL_L_1944_Warfare",
        "smolensk_warfare_day",
        "STA_L_1942_Warfare",
        "stmariedumont_warfare",
        "stmereeglise_warfare",
        "tobruk_warfare_day",
        "utahbeach_warfare",
        "mortain_warfare_overcast",
        "mortain_warfare_dusk",
        "smolensk_warfare_dusk",
        "tobruk_warfare_dusk",
        "smolensk_warfare_night",
        "elsenbornridge_offensiveger_morning",
        "elsenbornridge_offensiveUS_morning",
        "tobruk_offensiveger_morning",
        "tobruk_offensivebritish_morning",
        "carentan_offensive_ger",
        "carentan_offensive_us",
        "driel_offensive_ger",
        "driel_offensive_us",
        "elalamein_offensive_CW",
        "elalamein_offensive_ger",
        "elsenbornridge_offensiveger_day",
        "elsenbornridge_offensiveUS_day",
        "foy_offensive_ger",
        "foy_offensive_us",
        "hill400_offensive_ger",
        "hill400_offensive_US",
        "hurtgenforest_offensive_ger",
        "hurtgenforest_offensive_US",
        "kharkov_offensive_ger",
        "kharkov_offensive_rus",
        "kursk_offensive_ger",
        "kursk_offensive_rus",
        "mortain_offensiveger_day",
        "mortain_offensiveUS_day",
        "omahabeach_offensive_ger",
        "omahabeach_offensive_us",
        "PHL_L_1944_OffensiveGER",
        "PHL_L_1944_OffensiveUS",
        "smolensk_offensiveGer_Day",
        "smolensk_offensiveRus_day",
        "STA_L_1942_OffensiveGER",
        "STA_L_1942_OffensiveRUS",
        "stmariedumont_off_ger",
        "stmariedumont_off_us",
        "stmereeglise_offensive_ger",
        "stmereeglise_offensive_us",
        "tobruk_offensiveger_day",
        "tobruk_offensivebritish_day",
        "utahbeach_offensive_ger",
        "utahbeach_offensive_us",
        "mortain_offensiveger_overcast",
        "mortain_offensiveUS_overcast",
        "mortain_offensiveger_dusk",
        "mortain_offensiveUS_dusk",
        "smolensk_offensiveGer_dusk",
        "smolensk_offensiveRus_dusk",
        "tobruk_offensiveger_dusk",
        "tobruk_offensivebritish_dusk",
        "smolensk_offensiveGer_night",
        "smolensk_offensiveRus_night",
        "REM_L_1945_Warfare",
        "REM_L_1945_WarfareNight",
        "REM_L_1945_OffensiveUS",
        "REM_L_1945_OffensiveGER",
        "junobeach_warfare_morning",
        "junobeach_offensiveger_day",
        "junobeach_offensiveger_morning",
        "junobeach_offensivecan_day",
        "junobeach_offensivecan_morning"
      ],
      "excludePlayedMaps": 4
    }
  },
  {
    "name": "night",
    "pool": {
      "modeBuckets": [
        {
          "mode": "warfare",
          "count": 3,
          "limits": {
            "day": 3,
            "morning": 3,
            "dusk": 3,
            "overcast": 3
          }
        },
        {
          "mode": "offensive",
          "count": 3
        }
      ],
      "dayCount": 0,
      "nightCount": 0,
      "wildcardCount": 0,
      "duplicateMaps": false,
      "blacklistMaps": [
        "tobruk_offensiveger_dusk",
        "tobruk_offensivebritish_dusk",
        "tobruk_offensiveger_day",
        "tobruk_offensivebritish_day",
        "tobruk_offensiveger_morning",
        "tobruk_warfare_morning",
        "tobruk_warfare_day",
        "tobruk_warfare_dusk",
        "tobruk_offensivebritish_morning",
        "elalamein_offensive_CW",
        "elalamein_offensive_ger",
        "elalamein_warfare_night",
        "elalamein_warfare",
        "elsenbornridge_offensiveger_day",
        "elsenbornridge_offensiveUS_day",
        "elsenbornridge_warfare_day",
        "elsenbornridge_offensiveUS_morning",
        "elsenbornridge_offensiveger_morning",
        "elsenbornridge_warfare_morning",
        "driel_warfare",
        "driel_offensive_ger",
        "driel_offensive_us",
        "kursk_warfare",
        "kursk_offensive_ger",
        "kursk_offensive_rus",
        "hill400_warfare",
        "hill400_offensive_ger",
        "hill400_offensive_US",
        "STA_L_1942_Warfare",
        "STA_L_1942_Warfare_Night",
        "STA_L_1942_OffensiveGER",
        "STA_L_1942_OffensiveRUS",
        "REM_L_1945_Warfare",
        "REM_L_1945_WarfareNight",
        "REM_L_1945_OffensiveUS",
        "REM_L_1945_OffensiveGER",
        "mortain_warfare_day",
        "mortain_warfare_overcast",
        "mortain_warfare_dusk",
        "mortain_offensiveger_day",
        "mortain_offensiveUS_day",
        "mortain_offensiveger_overcast",
        "mortain_offensiveUS_overcast",
        "mortain_offensiveger_dusk",
        "mortain_offensiveUS_dusk",
        "junobeach_warfare_morning",
        "junobeach_warfare_night",
        "junobeach_offensiveger_morning",
        "junobeach_offensiveger_night",
        "junobeach_offensivecan_morning",
        "junobeach_offensivecan_night",
        "smolensk_warfare_day",
        "smolensk_warfare_dusk",
        "smolensk_warfare_night",
        "smolensk_offensiveGer_Day",
        "smolensk_offensiveRus_day",
        "smolensk_offensiveGer_dusk",
        "smolensk_offensiveRus_dusk",
        "smolensk_offensiveGer_night",
        "smolensk_offensiveRus_night",
        "smolensk_skirmish_day",
        "smolensk_skirmish_dusk",
        "smolensk_skirmish_night"
      ],
      "enforceCount": 0,
      "excludePlayedMaps": 2
    }
  },
  {
    "name": "default",
    "pool": {
      "modeBuckets": [
        {
          "mode": "warfare",
          "count": 4,
          "limits": {
            "day": 3,
            "morning": 3,
            "dusk": 3,
            "overcast": 3,
            "night": 1
          }
        },
        {
          "mode": "offensive",
          "count": 3
        }
      ],
      "dayCount": 0,
      "nightCount": 0,
      "wildcardCount": 0,
      "duplicateMaps": false,
      "blacklistMaps": [
        "tobruk_offensiveger_dusk",
        "tobruk_offensivebritish_dusk",
        "tobruk_offensiveger_day",
        "tobruk_offensivebritish_day",
        "tobruk_offensiveger_morning",
        "tobruk_warfare_morning",
        "tobruk_warfare_dusk",
        "tobruk_offensivebritish_morning",
        "REM_L_1945_Warfare",
        "REM_L_1945_WarfareNight",
        "REM_L_1945_OffensiveUS",
        "REM_L_1945_OffensiveGER",
        "smolensk_warfare_day",
        "smolensk_warfare_dusk",
        "smolensk_warfare_night",
        "smolensk_offensiveGer_Day",
        "smolensk_offensiveRus_day",
        "smolensk_offensiveGer_dusk",
        "smolensk_offensiveRus_dusk",
        "smolensk_offensiveGer_night",
        "smolensk_offensiveRus_night",
        "smolensk_skirmish_day",
        "smolensk_skirmish_dusk",
        "smolensk_skirmish_night",
        "junobeach_warfare_morning",
        "junobeach_offensiveger_morning",
        "junobeach_offensiveger_night",
        "junobeach_offensivecan_morning",
        "junobeach_offensivecan_night"
      ],
      "excludePlayedMaps": 4
    }
  }
];

export const SEED_VOTE_SCHEDULES: SeedVoteSchedule[] = [
  {
    "name": "D-Day (6 June)",
    "spec": {
      "dates": [
        "06-06"
      ],
      "start": "07:00",
      "end": "00:00"
    }
  },
  {
    "name": "Seeding (under 50)",
    "spec": {
      "playersBelow": 50
    }
  },
  {
    "name": "Friday teatime",
    "spec": {
      "daysOfWeek": [
        "fri"
      ],
      "start": "16:00",
      "end": "20:00"
    }
  },
  {
    "name": "Overnight",
    "spec": {
      "start": "00:00",
      "end": "07:00"
    }
  },
  {
    "name": "Daytime",
    "spec": {
      "start": "07:00",
      "end": "00:00"
    }
  }
];
