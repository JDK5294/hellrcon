/**
 * @app/maps — map placement + metadata + vote composition.
 *   - scheduleNextMap: force a next map by collapsing the rotation to the winner (the troubleshooted
 *     earlier bot's algorithm, kept verbatim).
 *   - HLL helpers: derive name/mode/environment/family from opaque rotation ids.
 *   - buildPoll: compose a map-vote poll (day/night/wildcard buckets, family de-dup, exclusions).
 *   - live-vote: what the in-game announcement says, and when to re-queue the leading option.
 */
export * from "./schedule.js";
export * from "./hll-maps.js";
export * from "./rotation.js";
export * from "./crcon-catalogue.js";
export * from "./crcon-layers.js";
export * from "./vote.js";
export * from "./profiles.js";
export * from "./coverage.js";
export * from "./winner.js";
export * from "./live-vote.js";
export * from "./current-map.js";
export * from "./sector-grid.js";
