/**
 * @app/schedule — a reusable "is this active now?" engine: timezone-aware windows
 * (day-of-week, month, dates, years, overnight time ranges) plus player-count conditions, and
 * first-match profile resolution. Shared by auto-settings, map-vote profiles, and player-count gates.
 * And its calendar half, "when does this happen?": recurrences (the 1st of every month, every
 * Saturday, the last Friday) answered as the latest moment at or before now — what a
 * once-per-moment runner such as a scheduled rule needs.
 */
export * from "./window.js";
export * from "./profile.js";
export * from "./recurrence.js";
