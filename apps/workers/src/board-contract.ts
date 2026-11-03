/**
 * The board's data contract — what a render takes, with no drawing machinery attached.
 *
 * These shapes live apart from board-image.ts because of what importing THAT file costs: it loads
 * @napi-rs/canvas, and the native skia binding is ~33 MB of resident memory the moment the module
 * graph touches it. The actual drawing happens in a dedicated worker_thread (board-render-thread),
 * which rightly pays that cost — but the MAIN worker process was paying it too, at startup, on
 * every install, because index.ts imported board-image.js for one zero-filled constant and the
 * types around it. A process that never draws a board still carried the renderer.
 *
 * So the rule this file encodes: everything the main process needs to DESCRIBE a board is here,
 * import-free; everything that RASTERIZES one stays in board-image.ts, loaded only where drawing
 * actually happens. board-image.ts re-exports these shapes, so the thread and the tests see one
 * vocabulary. workers/test/board-contract.test.ts holds the import graph to this.
 */
import type { SessionInfo } from "@app/rcon-core";

/** One faction, as the game descriptor names it. */
export interface BoardSide { id: string; label: string; color?: string }

/** Everything one side did this round, already summed from the roster. */
export interface SideTotals {
  players: number; kills: number; deaths: number;
  combat: number; offense: number; defense: number; support: number;
}
export const EMPTY_TOTALS: SideTotals = { players: 0, kills: 0, deaths: 0, combat: 0, offense: 0, defense: 0, support: 0 };

/** A per-player standout — the cards along the bottom. */
export interface Leader { label: string; name: string; value: number; sideId: string | null }

export interface BoardImageInput {
  serverName: string;
  session: SessionInfo;
  /** [allies, axis] in descriptor order. */
  sides: BoardSide[];
  totals: Record<string, SideTotals>;
  leaders: Leader[];
  vips: number;
  at: Date;
  /** the round's map artwork (webp/png bytes) for the header, when we have it. */
  art?: Uint8Array | null;
  /** faction emblems, keyed by side id. */
  emblems?: Record<string, Uint8Array | null | undefined>;
  /** what to call each side on the scoreline ("UNITED STATES"), keyed by side id. */
  factionNames?: Record<string, string>;
  /** the game's own score icons, keyed by metric — the same glyphs the scoreboard uses in game. */
  icons?: Record<string, Uint8Array | null | undefined>;
  /** shown under the timer — the operator's own label for the box, when they set one. */
  region?: string | null;
  /** the community's badge for the header, when one is installed. */
  logo?: Uint8Array | null;
  /** the operator's own headline, printed instead of anything derived from the server name. */
  title?: string | null;
}
