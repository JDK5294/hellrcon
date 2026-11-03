"use client";
/**
 * The community clock, for the screens that schedule things.
 *
 * Every scheduled feature here used to carry its own time zone, each defaulting to the literal
 * string "UTC". That made "when does this run" a question you answered separately in three places,
 * in a zone nobody lives in. There is now one community zone (Users & roles → Community time zone);
 * this is how the schedule editors read it so they can default to it instead.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { setDisplayZone } from "./time";
import { readUserPrefs } from "./userPrefs";

/** Zones people actually run communities in, plus whatever the browser reports. Enough to pick
 *  from without shipping the whole IANA database into a dropdown. */
export const COMMON_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Sao_Paulo", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin",
  "Europe/Madrid", "Europe/Warsaw", "Europe/Helsinki", "Europe/Moscow", "Australia/Sydney",
  "Australia/Perth", "Asia/Tokyo", "Asia/Singapore", "Pacific/Auckland", "UTC",
];

/** This device's zone, or UTC when the runtime won't say. */
export function deviceZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/**
 * The community zone. Null while loading, so a form can wait rather than briefly showing "UTC"
 * and saving it if the user is quick — the flash IS the bug being fixed.
 */
export function useCommunityZone(): string | null {
  const [tz, setTz] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ config: { timezone: string } }>("/app-config")
      .then((r) => { if (alive) setTz(r.config.timezone || "UTC"); })
      .catch(() => { if (alive) setTz("UTC"); });
    return () => { alive = false; };
  }, []);
  return tz;
}

/** The option list for a zone picker: the community's first, then the device's, then the rest. */
export function zoneOptions(communityTz: string | null): string[] {
  return [...new Set([communityTz || "UTC", deviceZone(), ...COMMON_ZONES])];
}

/**
 * Resolve and apply the zone every timestamp is DISPLAYED in: the signed-in person's own
 * preference when they set one, else the community zone, else the device. Called at boot (with
 * the fetched community zone) and again whenever either setting changes, so the whole panel
 * reads one clock instead of whatever each device happens to be set to.
 */
export function applyDisplayZone(communityTz: string | null | undefined): void {
  setDisplayZone(readUserPrefs().timeZone || communityTz || null);
}
