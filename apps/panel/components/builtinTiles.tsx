"use client";
/**
 * Built-in dashboard tile registry: widget id → a first-party React component. Tiles listed here
 * are rendered by the panel (they need real React — e.g. the active-server context) instead of the
 * declarative block system. A tile not in this map falls back to its declarative `view` blocks.
 */
import type { FC } from "react";
import ServerSettingsCard from "./cards/ServerSettingsCard";
import VipsWatchedCard from "./cards/VipsWatchedCard";
import RecentActivityCard from "./cards/RecentActivityCard";
import TeamActivityCard from "./cards/TeamActivityCard";
import ModeratorsCard from "./cards/ModeratorsCard";
import RulesCard from "./cards/RulesCard";
import MapRotationCard from "./cards/MapRotationCard";

export const BUILTIN_TILES: Record<string, FC> = {
  "dash-server-settings": ServerSettingsCard,
  "dash-vips-watched": VipsWatchedCard,
  "dash-recent": RecentActivityCard,
  "dash-team-activity": TeamActivityCard,
  "dash-moderators": ModeratorsCard,
  "dash-rules": RulesCard,
  "dash-maprotation": MapRotationCard,
};
