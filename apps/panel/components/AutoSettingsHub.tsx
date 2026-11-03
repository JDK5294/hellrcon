"use client";
/**
 * Auto settings — the control point for everything the server does to itself. Three tabs:
 *   - Server settings: profiles that apply config by schedule or player count,
 *   - Rules: THE rule engine — event triggers (team kills, chat, joins…) and roster-state
 *     triggers (solo tank/helicopter, no squad leader, level, role, name) in one place,
 *   - Seeding.
 * The schema-driven "player-rule module" tabs that used to sit here were absorbed into Rules:
 * one engine, one page, one escalation/immunity model.
 */
import { useEffect, useState } from "react";
import { useAppNav } from "../lib/nav";
import { routeById } from "../lib/routes";
import { useServers } from "../lib/servers";
import { onDemand } from "../lib/onDemand";
import { Hub, ScreenLoading } from "./ui";

// Each tab's code is fetched the first time that tab opens.
const AutoSettings = onDemand(() => import("./AutoSettings"), "default", ScreenLoading);
const AutomationHistory = onDemand(() => import("./AutomationHistory"), "default", ScreenLoading);
const ChatFilter = onDemand(() => import("./ChatFilter"), "default", ScreenLoading);
const Enforcer = onDemand(() => import("./Enforcer"), "default", ScreenLoading);
const MapZones = onDemand(() => import("./MapZones"), "default", ScreenLoading);
const Seeding = onDemand(() => import("./Seeding"), "default", ScreenLoading);
const GameRewards = onDemand(() => import("./GameRewards"), "default", ScreenLoading);

interface Tab { id: string; label: string; blurb: string; show?: boolean; render: () => React.JSX.Element }

const TAB_IDS = ["settings", "rules", "chatfilter", "zones", "seeding", "gamerewards", "history"];

const KEY = "panel.autosettings.rule";

/**
 * The tabs describe themselves out of the ROUTE REGISTRY, not out of a string here. This hub
 * passes its own `subtitle` to `Hub` (it prefixes "Editing <server>"), which overrides the
 * header's normal registry lookup — so a second copy of each blurb lived here and drifted from
 * the one search, help and the landing-page picker read. One copy, in `routes.ts`.
 */
const blurbOf = (tabId: string): string => routeById(`autosettings.${tabId}`)?.blurb ?? "";

/**
 * Separate capabilities land on these tabs and none of them was checked: everyone who could reach
 * the destination got all of them, so a seeding-only grant opened on Server settings and the page
 * answered 403. Each tab is now shown to the grant its endpoints actually enforce — settings on
 * `autosettings.config`, the rule engine on `admin.moderation`, the chat filter and the zone sets
 * on their own (`moderation.chatfilter`, `moderation.zones`), seeding on `seeding.config`.
 */
export default function AutoSettingsHub({ canAuto = false, canSeedingView = false, canRules = false, canChatFilter = false, canZones = false, canGround = false }: {
  /** autosettings.config at read: opens the settings tabs, and edits them — a change made without
   *  write is sent for approval (everything a role can see, it can ask for). */
  canAuto?: boolean;
  /** seeding.config, the same way. */
  canSeedingView?: boolean;
  /** admin.moderation — the rule engine, a capability of its own — the same way. */
  canRules?: boolean;
  /** moderation.chatfilter — the word list and what it does, carved off the rule engine. */
  canChatFilter?: boolean;
  /** moderation.zones — drawing the zone sets. The rule engine's holders read them. */
  canZones?: boolean;
  /** the ground rules on Map zones: the page's own rules permission with seeding read — the same
   *  pair the API's seeding route answers those fields to. */
  canGround?: boolean;
}) {
  const { server } = useServers();
  const nav = useAppNav();
  const [active, setActive] = useState<string>("settings");

  // A deep link names its tab (#/autosettings/seeding) and must win over both the default and the
  // remembered tab. This hub manages `active` itself (Hub then ignores the URL entirely), so the
  // URL's say is applied here — otherwise every /autosettings/<tab> link and palette hit landed on
  // Server settings for anyone allowed to see it.
  useEffect(() => {
    if (nav.view === "autosettings" && nav.tab && TAB_IDS.includes(nav.tab)) setActive(nav.tab);
  }, [nav.view, nav.tab]);

  const all: Tab[] = [
    { id: "settings", label: "Server settings", blurb: blurbOf("settings"), show: canAuto, render: () => <AutoSettings canManage={canAuto} /> },
    { id: "rules", label: "Rules", blurb: blurbOf("rules"), show: canRules, render: () => <Enforcer canManage={canRules} /> },
    // The chat filter IS two managed rules plus the game's censor list, dressed as the word-list
    // screen a moderation team actually wants — and its own permission, so a chat moderator can
    // keep the list without writing auto-kick rules (what it does takes that action's own key).
    { id: "chatfilter", label: "Chat filter", blurb: blurbOf("chatfilter"), show: canChatFilter, render: () => <ChatFilter canManage={canChatFilter} /> },
    // The zone sets are their own permission; the rule engine's holders see them too (their zone
    // rules pick one), and the ground rules share the page, for those who can also read seeding.
    { id: "zones", label: "Map zones", blurb: blurbOf("zones"), show: canZones || canRules, render: () => <MapZones canManage={canZones} showGround={canGround} /> },
    { id: "seeding", label: "Seeding", blurb: blurbOf("seeding"), show: canSeedingView, render: () => <Seeding canManage={canSeedingView} /> },
    // Game rewards ride the settings capability (the endpoint's gate); paying VIP or points also
    // needs those permissions, which the save enforces.
    { id: "gamerewards", label: "Game rewards", blurb: blurbOf("gamerewards"), show: canAuto, render: () => <GameRewards canManage={canAuto} /> },
    // The firing history serves every family, so whoever may read ANY of them may read it —
    // the endpoint enforces the same union.
    { id: "history", label: "History", blurb: blurbOf("history"), show: canRules || canAuto || canSeedingView, render: () => <AutomationHistory /> },
  ];
  const tabs = all.filter((t) => t.show !== false);

  // Restore the last-opened tab. A stored per-module tab id ("mod:no_solo_tank") or the
  // short-lived merged "modules" tab are from when the player-rule modules lived here — both land
  // on Rules, which is where those scenarios are configured now.
  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(KEY) : null;
    if (!stored) return;
    if (stored.startsWith("mod:") || stored === "modules") {
      setActive("rules");
      try { localStorage.setItem(KEY, "rules"); } catch { /* ignore */ }
      return;
    }
    if (TAB_IDS.includes(stored)) setActive(stored);
  }, []);
  const pick = (id: string) => { setActive(id); try { localStorage.setItem(KEY, id); } catch { /* ignore */ } };

  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <Hub
      routeId="autosettings"
      subtitle={server && tab ? <>Editing <strong>{server.name}</strong> — {tab.blurb}</> : tab?.blurb}
      tabs={tabs.map((t) => ({ id: t.id, label: t.label, render: t.render }))}
      active={active}
      onChange={pick}
    />
  );
}
