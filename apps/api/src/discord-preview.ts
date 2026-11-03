/**
 * The staff command, drawn for the panel (Help's Discord walkthrough): what the panel the command
 * opens in Discord shows THIS person. Its launcher lists the parts their permissions open, each
 * part's opening screen is drawn by the part itself, and a part that starts by picking a server can
 * draw that server's screen too — so Help can point at a real button instead of describing one.
 *
 * Drawn, and nothing else. A part's `open` is what its launcher button runs in Discord; a part that
 * picks a server draws its next screen through `serverScreen`, which changes nothing. No other
 * handler is ever called, no press is recorded, nothing is posted, and Discord is never asked
 * anything: the staff-role check Discord makes on every press is the one thing not shown.
 */
import type { DiscordModuleDef, DiscordModuleEvent, DiscordModuleResult, DiscordView } from "@app/plugin-sdk";
import { canAnywhere } from "@app/access";
import type { Principal } from "./auth.js";
import { isModalResult, renderLauncher, renderModuleView, type DiscordModuleRegistry } from "./discord-modules.js";

/** What a part adds for the drawing: the screen picking one of its servers shows (its `srv`). */
export interface StaffPartPreview {
  serverScreen?(ev: DiscordModuleEvent, serverKey: string): Promise<DiscordView>;
}

type Message = { content: string; components: unknown[] };

export interface StaffPanelPreview {
  /** The launcher, as the command's first reply draws it. */
  home: Message;
  /** Each part this person may open, by id: its label, its opening screen, and whether picking one
   *  of its servers draws a next screen. A door to a part missing here is one Discord refuses. */
  parts: Record<string, { label: string; message: Message; servers: boolean }>;
}

/** A part's code might be a plugin's: one that never answers must not hold the page. */
const DRAW_TIMEOUT_MS = 15_000;

const permitted = (registry: DiscordModuleRegistry, p: Principal): DiscordModuleDef[] =>
  registry.list().filter((m) => canAnywhere(p.grants, m.capability, m.capabilityLevel ?? "read"));

/** The press a drawing stands for. Its Discord id is no Discord id at all, so a part that keeps
 *  something per person in Discord (the Moderation cart) never takes the drawing for its owner. */
const eventFor = (p: Principal, extra: Partial<DiscordModuleEvent> = {}): DiscordModuleEvent => ({
  discordUserId: `panel:${p.user.id}`, discordUserName: p.name, action: "", state: "",
  staffUserId: p.user.id, staffName: p.name, roleIds: [], ...extra,
});

async function draw(def: DiscordModuleDef, screen: () => Promise<DiscordModuleResult> | DiscordModuleResult): Promise<Message> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("it took too long to answer")), DRAW_TIMEOUT_MS); });
    const result = await Promise.race([Promise.resolve().then(screen), late]);
    // A form opens over the panel in Discord; a drawing has nothing to open it over.
    if (isModalResult(result)) return renderModuleView(def.id, { content: `**${def.label}** asks for its details in a form first.` }, def.backTo);
    return renderModuleView(def.id, result, def.backTo);
  } catch (err) {
    return renderModuleView(def.id, { content: `⚠️ **${def.label}** could not be drawn: ${(err as Error).message}` }, def.backTo);
  } finally {
    clearTimeout(timer);
  }
}

/** The launcher and every part this person may open, each part's opening screen drawn by itself. */
export async function previewStaffPanel(registry: DiscordModuleRegistry, p: Principal): Promise<StaffPanelPreview> {
  const modules = permitted(registry, p);
  const parts = await Promise.all(modules.map(async (def) => [def.id, {
    label: def.label,
    message: await draw(def, () => def.open(eventFor(p))),
    servers: typeof (def as StaffPartPreview).serverScreen === "function",
  }] as const));
  return { home: renderLauncher(modules, 0), parts: Object.fromEntries(parts) };
}

/** One server's screen in a part that picks one, or null: no such part for this person, or one
 *  that picks no server. Which servers they may see is the part's to check, as it is in Discord. */
export async function previewServerScreen(registry: DiscordModuleRegistry, p: Principal, partId: string, serverKey: string): Promise<Message | null> {
  const def = permitted(registry, p).find((m) => m.id === partId);
  const screen = (def as StaffPartPreview | undefined)?.serverScreen;
  if (!def || !screen) return null;
  return draw(def, () => screen(eventFor(p, { action: "srv", selected: [serverKey] }), serverKey));
}
