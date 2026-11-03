/**
 * The permissions plugins add to Roles, beside the core catalogue.
 *
 * A plugin declares them in its manifest (`<plugin id>.<key>` in a grant) and they are granted like
 * any other: the role editor lists them, a grant naming one is accepted, and one marked outright
 * gets the outright treatment — counted only when held on the account itself everywhere, and handed
 * out only by someone who holds it so. They exist while the plugin is loaded: a grant row naming a
 * plugin that is gone stays in the database and confers nothing, and comes back to life with it.
 * Until then it is kept exactly as stored — a save that re-sends it goes through, nothing new can
 * name it, and the outright guards judge it as outright, since nothing here knows what it opens.
 *
 * Module-level, like the route table: one API process runs one plugin runtime, and every check that
 * reads this (grant validation, the outright guards) is a plain function called from a route. The
 * runtime clears it before loading, so a process that builds a second runtime (the test suites do)
 * sees that runtime's plugins and nobody else's.
 *
 * None of these is in any role preset: a preset is a fixed list of the core catalogue, and a
 * plugin's permission is given to a role by name.
 */
import { CAPABILITY_CATALOG, type CapabilityDef } from "@app/access";
import type { PluginManifest } from "@app/plugin-sdk";

export interface PluginPermission extends CapabilityDef {
  pluginId: string;
  outright: boolean;
}

const registered = new Map<string, PluginPermission>();

/** Adds a manifest's permissions. Throws, adding none of them, when one clashes. */
export function registerPluginPermissions(m: PluginManifest): void {
  const defs = (m.permissions ?? []).map((p): PluginPermission => ({
    key: `${m.id}.${p.key}`,
    label: p.label,
    description: p.description,
    group: p.group?.trim() || m.name,
    // A plugin's permission covers the whole community: per-server grants of it are not offered.
    scoped: false,
    levels: p.levels ?? ["read", "write"],
    pluginId: m.id,
    outright: p.outright === true,
  }));
  for (const d of defs) {
    if (CAPABILITY_CATALOG.some((c) => c.key === d.key)) throw new Error(`plugin ${m.id}: the permission ${d.key} is already the panel's own`);
    const other = registered.get(d.key);
    if (other && other.pluginId !== m.id) throw new Error(`plugin ${m.id}: the permission ${d.key} is already plugin ${other.pluginId}'s`);
  }
  unregisterPluginPermissions(m.id);
  for (const d of defs) registered.set(d.key, d);
}

export function unregisterPluginPermissions(pluginId: string): void {
  for (const [key, d] of registered) if (d.pluginId === pluginId) registered.delete(key);
}

/** Forgets every plugin's permissions — the runtime's first step. */
export function resetPluginPermissions(): void {
  registered.clear();
}

export function pluginPermission(key: string): PluginPermission | undefined {
  return registered.get(key);
}

/** The core catalogue, then each plugin's permissions in the order they were added. */
export function capabilityCatalog(): CapabilityDef[] {
  return [
    ...CAPABILITY_CATALOG,
    ...[...registered.values()].map(({ pluginId: _p, outright: _o, ...def }) => def),
  ];
}

export function capabilityDef(key: string): CapabilityDef | undefined {
  return CAPABILITY_CATALOG.find((c) => c.key === key) ?? registered.get(key);
}

/** A permission in a grant row that nothing loaded declares — most often a plugin's, while that
 *  plugin isn't running. */
export function isUnknownCapability(key: string): boolean {
  return key !== "*" && !capabilityDef(key);
}

/** The loaded plugins' outright permissions, with the levels each can be held at, strongest first. */
export function outrightPluginPowers(): { capability: string; level: "read" | "write" }[] {
  return [...registered.values()].filter((d) => d.outright).flatMap((d) => [
    ...(d.levels?.includes("write") ? [{ capability: d.key, level: "write" as const }] : []),
    ...(d.levels?.includes("read") ? [{ capability: d.key, level: "read" as const }] : []),
  ]);
}
