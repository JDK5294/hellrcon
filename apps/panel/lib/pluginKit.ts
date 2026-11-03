"use client";
/**
 * What a plugin's page is handed: the panel's own React, its UI kit and the helpers its built-in
 * screens use, so a plugin page looks, behaves and signs in exactly like one of them.
 *
 * A page's code is an ES module whose default export is a React component (see PluginPage). It is
 * built against `react` and this kit as externals that read `globalThis.__hellrconPageKit`, set
 * here once before the first page loads — so the component runs on the panel's React instance,
 * inside the panel's tree, where its hooks, the navigation and the stylesheet all apply.
 *
 * This is the contract a plugin page builds against: grow it, never change what is here. Its
 * version says which shape it is.
 */
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { ApiError, api, getToken } from "./api";
import { canOnServer, hasCap, holdsOutright, isOwner } from "./access";
import { liveMapFamily, liveMapUrl, mapImageUrl, roleIconUrl, worldToFrac } from "./gameAssets";
import { useAppNav } from "./nav";
import { recallTab, rememberTab } from "./userPrefs";
import { ActionResult, Callout, EmptyState, Explanation, PageHeader, ScreenLoading, TabBar, Toggle } from "../components/ui";
import { NumField } from "../components/NumField";
import { seriesVar } from "../components/viz/palette";

export const PAGE_KIT_VERSION = 1;

const kit = {
  version: PAGE_KIT_VERSION,
  React,
  jsxRuntime,
  api,
  ApiError,
  getToken,
  access: { canOnServer, hasCap, holdsOutright, isOwner },
  gameAssets: { liveMapFamily, liveMapUrl, mapImageUrl, roleIconUrl, worldToFrac },
  nav: { useAppNav },
  prefs: { recallTab, rememberTab },
  ui: { ActionResult, Callout, EmptyState, Explanation, NumField, PageHeader, ScreenLoading, TabBar, Toggle },
  viz: { seriesVar },
};

export type PageKit = typeof kit;

/** Puts the kit where a page's code looks for it. Idempotent. */
export function installPageKit(): PageKit {
  (globalThis as { __hellrconPageKit?: PageKit }).__hellrconPageKit = kit;
  return kit;
}
