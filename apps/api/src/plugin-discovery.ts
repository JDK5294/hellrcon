/**
 * Dynamic plugin discovery: load third-party plugins from a directory at startup, alongside
 * the built-in first-party ones. A self-hosted operator drops a plugin (a folder with a
 * `package.json` whose `main` is the entry, or a bare `.js`/`.mjs` file) into `PLUGINS_DIR`;
 * we import it and hand it to the same {@link PluginHost}. The host's capability scoping still
 * applies — a discovered plugin is no more privileged than a built-in one.
 *
 * This is intentionally trust-on-first-use for local files (the operator controls the
 * directory). It never reaches the network and never widens the capability contract.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginModule } from "@app/plugin-sdk";
import type { Logger } from "@app/shared";

/** A default export from `definePlugin`, or a module that is itself a PluginModule. */
function asPluginModule(imported: unknown): PluginModule | null {
  const candidate = (imported as { default?: unknown })?.default ?? imported;
  const m = candidate as Partial<PluginModule> | undefined;
  if (m && typeof m.activate === "function" && m.manifest && typeof m.manifest.id === "string") {
    return m as PluginModule;
  }
  return null;
}

/** Resolve a directory entry to an importable entry file, or null if it isn't a plugin. */
async function resolveEntry(dir: string, name: string): Promise<string | null> {
  const full = join(dir, name);
  const info = await stat(full).catch(() => null);
  if (!info) return null;
  if (info.isFile()) {
    return /\.(mjs|cjs|js)$/.test(name) ? full : null;
  }
  if (info.isDirectory()) {
    // Prefer package.json "main"; fall back to index.{js,mjs}.
    const pkgRaw = await readFile(join(full, "package.json"), "utf8").catch(() => null);
    if (pkgRaw) {
      try {
        const main = (JSON.parse(pkgRaw) as { main?: string }).main;
        if (main) return join(full, main);
      } catch {
        /* malformed package.json — fall through to index.* */
      }
    }
    for (const idx of ["index.js", "index.mjs"]) {
      if (await stat(join(full, idx)).then((s) => s.isFile(), () => false)) return join(full, idx);
    }
  }
  return null;
}

/**
 * Scan `dir` for plugins and return the loadable modules. Missing directory → empty list.
 * A single malformed plugin is logged and skipped; it never blocks the others or startup.
 */
export async function discoverPlugins(dir: string | undefined, log: Logger): Promise<PluginModule[]> {
  if (!dir) return [];
  const entries = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") log.warn("plugin dir not readable", { dir, err: err.message });
    return [] as string[];
  });

  const found: PluginModule[] = [];
  for (const name of entries.sort()) {
    const entry = await resolveEntry(dir, name);
    if (!entry) continue;
    try {
      const imported = await import(pathToFileURL(entry).href);
      const mod = asPluginModule(imported);
      if (!mod) {
        log.warn("skipped: not a plugin module (no manifest/activate)", { entry });
        continue;
      }
      found.push(mod);
      log.info("discovered plugin", { id: mod.manifest.id, version: mod.manifest.version, entry });
    } catch (err) {
      log.error("failed to import discovered plugin", { entry, err });
    }
  }
  return found;
}
