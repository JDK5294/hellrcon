/**
 * The live match board, drawn as a picture rather than described in an embed.
 *
 * A Discord embed is a fixed template — a coloured stripe, a title, and a grid of small label/value
 * pairs — and no arrangement of it looks like a scoreboard. The board this replaces was judged
 * against a rendered graphic, and rightly: the picture is the product. So the worker draws one and
 * posts it as the message's image, and the embed around it carries only what Discord needs to show
 * a caption.
 *
 * Everything here is layout. What the numbers MEAN is decided before they arrive (see
 * status-board.ts and rcon-core's session normalizer); this file is trusted only to place them.
 */
import { createCanvas, loadImage, GlobalFonts, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { vipQueueDepth, type SessionInfo } from "@app/rcon-core";
import { hash32, dirt, marble, scuffs, bullets, spatter, grain } from "./board-texture.js";
// The data contract lives apart, canvas-free, so the main process can describe a board without
// loading skia (see board-contract.ts). Re-exported whole: the render thread and the tests import
// everything from here, and the split must not fork the vocabulary.
import { EMPTY_TOTALS, type BoardImageInput } from "./board-contract.js";
export * from "./board-contract.js";

export const BOARD_W = 1600;
export const BOARD_H = 1062;

// ---- palette -------------------------------------------------------------------------------
const INK = "#ffffff";
const MUTED = "#93a1b3";
const DIM = "#6b7889";
const BG = "#0a0c10";
const CARD = "#121820";
const LINE = "#222c39";
const BLUE = "#2f6fd0";
const BLUE_INK = "#6aa9ff";
const RED = "#b03030";
const RED_INK = "#ff7a7a";
/** The edge a card wears when its side is ahead. Brighter than the fill it borders, and lit. */
const EDGE_BLUE = "#3c7ad8";
const EDGE_RED = "#c2413f";
const OK = "#3ddc84";

/** Prefer a real UI face; fall back through what the base image actually ships. */
function pickFamily(): string {
  const have = new Set(GlobalFonts.families.map((f) => f.family));
  for (const f of ["Noto Sans", "DejaVu Sans", "Liberation Sans", "FreeSans", "Arial"]) if (have.has(f)) return f;
  return "sans-serif";
}
let FAMILY: string | null = null;
const font = (weight: string, size: number) => `${weight} ${size}px ${(FAMILY ??= pickFamily())}`;

const fmt = (n: number) => n.toLocaleString("en-US");

/** Seconds → "H:MM:SS" / "MM:SS", the clock the panel shows. */
function clock(sec?: number): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h >= 1 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * A raised card: lit from above, shadowed below.
 *
 * Flat fills on a flat background is what made the first board read as a spreadsheet. Three cheap
 * things do all the work — a top-to-bottom gradient, a one-pixel highlight along the top edge, and
 * a soft shadow underneath — and together they put every card on its own plane.
 */
function panel(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, fill: string | [string, string] = CARD, stroke = LINE): void {
  const [top, bottom] = Array.isArray(fill) ? fill : [fill, fill];
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 7;
  roundRect(ctx, x, y, w, h, 10);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();

  // The lit top edge and a sheen falling away from the top-left corner. Clipped so both follow the
  // rounded corners instead of poking out of them.
  ctx.save();
  roundRect(ctx, x, y, w, h, 10);
  ctx.clip();
  const sheen = ctx.createLinearGradient(x, y, x + w * 0.8, y + h);
  sheen.addColorStop(0, "rgba(255,255,255,0.05)");
  sheen.addColorStop(0.45, "rgba(255,255,255,0.012)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + 10, y + 1); ctx.lineTo(x + w - 10, y + 1); ctx.stroke();
  // Grime on the card itself, seeded from where it sits: every card is dirty in its own way, the
  // same card is dirty the same way on every redraw, and none of it is under anything readable
  // because the card's text has not been drawn yet.
  dirt(ctx, { x, y, w, h }, `panel|${x}|${y}|${w}|${h}`, { count: 12, alpha: 0.2, scale: 0.8, specks: 2.2 });
  // Blood on the card, and this is the moment for it: the card's own text has not been drawn yet,
  // so everything laid down here ends up underneath the numbers. Sized off the card, or a sector
  // box the width of a word would take the same splash as a card the size of a hand.
  // Marbling on the plate itself, at the card's own scale, so a total does not sit on flat paint.
  marble(ctx, { x, y, w, h }, `panel|${x}|${y}|${w}|${h}`, { scale: 150, alpha: 0.42, contrast: 2, gain: 1.35 });
  const k = Math.min(1.7, Math.max(0.45, Math.min(w, h) / 110));
  spatter(ctx, { x, y, w, h }, `panel|blood|${x}|${y}|${w}|${h}`, {
    clusters: Math.max(1, Math.round((w * h) / 26000)), alpha: 0.44, scale: 1.5 * k, drips: 2,
  });
  ctx.restore();

  roundRect(ctx, x, y, w, h, 10);
  // A card carrying a side's colour gets that colour lit rather than merely drawn: the same thin
  // line, stroked twice, the first pass casting its own hue as a shadow. Enough to find the row's
  // rhythm across a phone screen; not enough to compete with the number inside it.
  if (stroke !== LINE) {
    ctx.save();
    ctx.strokeStyle = stroke; ctx.lineWidth = 2;
    ctx.shadowColor = stroke; ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke();
}

/** A soft coloured glow, for the things that should feel lit rather than printed. */
function glow(ctx: SKRSContext2D, cx: number, cy: number, r: number, colour: string): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, colour);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
}

/** Draw text shrunk to fit a width, so a long community name never runs off its panel. */
function fitText(ctx: SKRSContext2D, text: string, x: number, y: number, max: number, weight: string, size: number, min = 10): void {
  let s = size;
  ctx.font = font(weight, s);
  while (ctx.measureText(text).width > max && s > min) { s -= 2; ctx.font = font(weight, s); }
  ctx.fillText(text, x, y);
}

/**
 * The headline across the top of the board.
 *
 * An operator who has set one gets it verbatim — they typed the thing they wanted printed, so no
 * case is changed and nothing is cut off it. Without one the server's name has to be reduced,
 * because names carry their whole rulebook after a pipe — "…#1 | MIC'S MANDATORY!! | LVL50+ SL
 * ENCOURAGED, LVL 100+ COMMANDER ENFORCED" — and shrinking all of that to fit left the title
 * smaller than the labels beneath it. The guess is the part before the first separator.
 *
 * The panel's board-title placeholder (`headlineFrom` in apps/panel/components/Discord.tsx) mirrors
 * the no-title branch by hand — the two apps share no package — so a change here must be made there
 * too, or the settings screen starts lying about the fallback.
 */
export function headline(serverName: string, title?: string | null): string {
  const chosen = title?.trim();
  if (chosen) return chosen;
  const first = serverName.split(/\s*[|·]\s*/)[0]?.trim() || serverName.trim();
  return (first.length >= 3 ? first : serverName.trim()).toUpperCase();
}

/** A label over a value, centred in a box — the shape every card on the board is made of. */
function stat(ctx: SKRSContext2D, cx: number, y: number, label: string, value: string, valueSize = 46): void {
  ctx.textAlign = "center";
  ctx.fillStyle = MUTED; ctx.font = font("600", 17);
  ctx.fillText(label, cx, y);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.75)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
  ctx.fillStyle = INK; ctx.font = font("bold", valueSize);
  ctx.fillText(value, cx, y + valueSize + 6);
  ctx.restore();
}

async function decode(bytes?: Uint8Array | null) {
  if (!bytes || !bytes.length) return null;
  try { return await loadImage(Buffer.from(bytes)); } catch { return null; }
}

/**
 * The deterministic ground of the board: the blurred backdrop, the whole-board weathering, and the
 * header band with its artwork and blood — everything that depends only on the round, not on the
 * tick. Rendered once per round and reused, because this is where nearly all the drawing cost
 * lives: the board redraws every minute, but its dirt does not change until the map does.
 *
 * Keyed by seed (server + map). Bounded the same way the marble tiles are: a long-lived worker
 * accumulates one entry per round, and eight full boards is the most it may keep.
 */
const grounds = new Map<string, Canvas>();
const GROUNDS_MAX = 8;

function groundFor(seed: string, art: Awaited<ReturnType<typeof decode>>): Canvas {
  const key = `${seed}|${art ? "art" : "plain"}`;
  const hit = grounds.get(key);
  if (hit) return hit;
  const canvas = createCanvas(BOARD_W, BOARD_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  const M = 16;
  const W = BOARD_W - M * 2;
  const hH = 216;

  // ---- the whole board sits on the map ---------------------------------------------------------
  // Blurred to near-abstraction and pushed right down, so it is depth rather than decoration: the
  // cards have something to sit ON. A flat fill behind flat cards is what read as a spreadsheet.
  if (art) {
    ctx.save();
    ctx.filter = "blur(34px)";
    const scale = Math.max(BOARD_W / art.width, BOARD_H / art.height);
    const dw = art.width * scale, dh = art.height * scale;
    ctx.drawImage(art, (BOARD_W - dw) / 2, (BOARD_H - dh) / 2, dw, dh);
    ctx.filter = "none";
    ctx.fillStyle = "rgba(6,8,12,0.84)";
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
    // Vignette: bring the corners down so the eye lands in the middle.
    const v = ctx.createRadialGradient(BOARD_W / 2, BOARD_H * 0.42, 120, BOARD_W / 2, BOARD_H * 0.5, BOARD_W * 0.78);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.8)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
    ctx.restore();
  }
  // Grime over the whole ground, so the dark between the cards is never one flat tone.
  const whole = { x: 0, y: 0, w: BOARD_W, h: BOARD_H };
  dirt(ctx, whole, seed, { count: 34, alpha: 0.26, scale: 0.75 });
  marble(ctx, whole, seed, { scale: 340, alpha: 0.5, contrast: 1.8, gain: 1.15, octaves: 5 });
  scuffs(ctx, whole, seed, { count: 16, alpha: 0.05 });
  // Blood on the ground itself. It goes down here, before a single card is drawn, so what shows
  // through in the gutters is genuinely underneath them.
  spatter(ctx, whole, `${seed}|ground`, { clusters: 12, alpha: 0.5, scale: 2.3, drips: 3 });

  // ---- header band: the map the round is being played on -------------------------------------
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
  roundRect(ctx, M, M, W, hH, 12);
  ctx.fillStyle = "#11151b"; ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, M, M, W, hH, 12);
  ctx.clip();
  if (art) {
    // Sharp here, and much brighter than the backdrop — this band is the one place the map is
    // meant to be looked at. Anchored a third down: the horizon is the interesting part.
    const scale = Math.max(W / art.width, hH / art.height);
    const dw = art.width * scale, dh = art.height * scale;
    ctx.drawImage(art, M + (W - dw) / 2, M + (hH - dh) * 0.34, dw, dh);
    // Dark on the left so the title reads; the right stays open so the picture is visible.
    const g = ctx.createLinearGradient(M, 0, M + W, 0);
    g.addColorStop(0, "rgba(8,10,14,0.92)");
    g.addColorStop(0.5, "rgba(8,10,14,0.52)");
    g.addColorStop(1, "rgba(8,10,14,0.14)");
    ctx.fillStyle = g;
    ctx.fillRect(M, M, W, hH);
    // …and a touch from the bottom, so the map/mode line never fights the ground behind it.
    const gv = ctx.createLinearGradient(0, M + hH * 0.45, 0, M + hH);
    gv.addColorStop(0, "rgba(8,10,14,0)");
    gv.addColorStop(1, "rgba(8,10,14,0.72)");
    ctx.fillStyle = gv;
    ctx.fillRect(M, M, W, hH);
  }
  // Blood reads best on the one part of the board that is a photograph, so the header gets the
  // worst of it — thrown across the whole band and running down out of it.
  spatter(ctx, { x: M, y: M, w: W, h: hH }, `${seed}|head`, { clusters: 7, alpha: 0.66, scale: 2.4, drips: 3, stain: true });
  dirt(ctx, { x: M, y: M + hH - 70, w: W, h: 70 }, `${seed}|hem`, { count: 14, alpha: 0.24, scale: 0.9 });
  ctx.restore();
  if (grounds.size >= GROUNDS_MAX) grounds.clear();
  grounds.set(key, canvas);
  return canvas;
}

/**
 * Draw the board. Returns JPEG bytes ready to attach to a Discord message.
 *
 * Sections, top to bottom: the round over its own artwork; the two factions and the score; the
 * sectors as a front line; each side's totals; the players who stood out.
 */
export async function renderBoardImage(input: BoardImageInput): Promise<Buffer> {
  const { serverName, session: s, sides, totals, leaders, vips, at } = input;
  const [left, right] = sides;
  const leftId = left?.id ?? "allies", rightId = right?.id ?? "axis";
  const lt = totals[leftId] ?? EMPTY_TOTALS;
  const rt = totals[rightId] ?? EMPTY_TOTALS;
  const leftName = input.factionNames?.[leftId] ?? (left?.label ?? "Allies").toUpperCase();
  const rightName = input.factionNames?.[rightId] ?? (right?.label ?? "Axis").toUpperCase();

  const canvas = createCanvas(BOARD_W, BOARD_H);
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "alphabetic";

  const M = 16;              // outer margin
  const W = BOARD_W - M * 2; // usable width
  const hH = 216;            // header band height
  const art = await decode(input.art);
  // Everything grit-related is seeded from this: the same round wears the same dirt on every
  // redraw, which is also what lets the whole ground be drawn once and reused.
  const seed = `${serverName}|${s.mapId ?? s.mapName ?? ""}`;
  const whole = { x: 0, y: 0, w: BOARD_W, h: BOARD_H };
  ctx.drawImage(groundFor(seed, art), 0, 0);

  roundRect(ctx, M, M, W, hH, 12);
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();

  // LIVE, then the community, then the round.
  ctx.textAlign = "left";
  ctx.save();
  glow(ctx, M + 34, M + 42, 26, "rgba(61,220,132,0.35)");
  ctx.restore();
  ctx.beginPath(); ctx.arc(M + 34, M + 42, 11, 0, Math.PI * 2);
  ctx.fillStyle = OK; ctx.fill();
  ctx.fillStyle = OK; ctx.font = font("bold", 30);
  ctx.fillText("LIVE", M + 54, M + 52);

  const statBoxW = 300;
  const sbX = M + W - statBoxW - 14, sbY = M + 14, sbH = hH - 28;

  // The community's badge, if one is installed, between the headline and the stat box. Square, so a
  // round patch and a wordmark both sit correctly, and it takes its room out of the title's width
  // rather than overlapping it.
  const badge = await decode(input.logo);
  const badgeSize = badge ? hH - 44 : 0;
  const badgeX = sbX - 18 - badgeSize;
  if (badge) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.75)"; ctx.shadowBlur = 22; ctx.shadowOffsetY = 6;
    const k = Math.min(badgeSize / badge.width, badgeSize / badge.height);
    const bw = badge.width * k, bh = badge.height * k;
    ctx.drawImage(badge, badgeX + (badgeSize - bw) / 2, M + 22 + (badgeSize - bh) / 2, bw, bh);
    ctx.restore();
  }

  const titleMax = (badge ? badgeX - 22 : sbX - 22) - (M + 30);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.85)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 3;
  ctx.fillStyle = INK;
  // The community's name only — the rules that follow it in the server name would shrink the
  // headline below the size of its own labels.
  fitText(ctx, headline(serverName, input.title), M + 30, M + 132, titleMax, "bold", 62, 34);
  ctx.fillStyle = "#dbe4ef";
  fitText(ctx, [s.mapName, s.gameMode].filter(Boolean).join("   |   ").toUpperCase() || "—", M + 32, M + 186, titleMax, "500", 34, 20);
  ctx.restore();

  // The three numbers that are true of the server rather than the round.
  panel(ctx, sbX, sbY, statBoxW, sbH, ["rgba(20,26,35,0.92)", "rgba(8,11,16,0.92)"]);
  const rows: [string, string][] = [
    [`${s.playerCount ?? "—"} / ${s.maxPlayerCount ?? "—"}`, "PLAYERS"],
    [clock(s.remainingMatchTime), "REMAINING"],
    [input.region?.toUpperCase() || `${vips} VIP · ${queueText(s)}`, input.region ? "REGION" : "VIP · QUEUE"],
  ];
  rows.forEach(([value, label], i) => {
    const y = sbY + 22 + i * (sbH / 3);
    ctx.textAlign = "center";
    ctx.fillStyle = INK; ctx.font = font("bold", i === 2 && !input.region ? 30 : 38);
    ctx.fillText(value, sbX + statBoxW / 2, y + 34);
    ctx.fillStyle = MUTED; ctx.font = font("600", 15);
    ctx.fillText(label, sbX + statBoxW / 2, y + 56);
    if (i < 2) {
      ctx.beginPath(); ctx.moveTo(sbX + 24, y + 70); ctx.lineTo(sbX + statBoxW - 24, y + 70);
      ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
    }
  });

  // ---- the two factions and the score --------------------------------------------------------
  const fY = M + hH + 12, fH = 172;
  const half = W / 2;
  const lx = M + half * 0.62, rx = M + half + half * 0.38;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
  roundRect(ctx, M, fY, W, fH, 12); ctx.fillStyle = "#0d1117"; ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, M, fY, W, fH, 12); ctx.clip();
  // Each side's ground darkens away from its own emblem, so the two halves read as lit from the
  // outside in rather than as two flat rectangles meeting at a line.
  const gl = ctx.createLinearGradient(M, 0, M + half, 0);
  gl.addColorStop(0, "#17427f"); gl.addColorStop(1, "#0b1220");
  ctx.fillStyle = gl; ctx.fillRect(M, fY, half, fH);
  const gr = ctx.createLinearGradient(M + half, 0, M + W, 0);
  gr.addColorStop(0, "#180d10"); gr.addColorStop(1, "#711a1e");
  ctx.fillStyle = gr; ctx.fillRect(M + half, fY, half, fH);
  // A glow under each score, so the numbers sit in light instead of on paint.
  glow(ctx, lx, fY + fH * 0.55, 210, "rgba(60,130,240,0.30)");
  glow(ctx, rx, fY + fH * 0.55, 210, "rgba(220,60,60,0.28)");
  // The band is two big flat washes of colour; grime and a scorch of blood at the seam is what
  // keeps them from looking like paint chips.
  dirt(ctx, { x: M, y: fY, w: W, h: fH }, `${seed}|factions`, { count: 24, alpha: 0.22, scale: 0.9 });
  marble(ctx, { x: M, y: fY, w: W, h: fH }, `${seed}|factions`, { scale: 190, alpha: 0.85, contrast: 2.3, gain: 1.75, octaves: 5 });
  scuffs(ctx, { x: M, y: fY, w: W, h: fH }, `${seed}|factions`, { count: 12, alpha: 0.06 });
  spatter(ctx, { x: M, y: fY, w: W, h: fH }, `${seed}|seam`, { clusters: 5, alpha: 0.55, scale: 1.9, drips: 3 });
  // The seam: a slanted sliver of dark, the way a scoreboard's two halves actually meet.
  ctx.beginPath();
  ctx.moveTo(M + half + 26, fY - 2);
  ctx.lineTo(M + half - 26, fY + fH + 2);
  ctx.lineTo(M + half - 4, fY + fH + 2);
  ctx.lineTo(M + half + 48, fY - 2);
  ctx.closePath();
  ctx.fillStyle = "rgba(6,8,12,0.55)"; ctx.fill();
  // Lit top edge across the whole band.
  ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(M + 10, fY + 1); ctx.lineTo(M + W - 10, fY + 1); ctx.stroke();
  ctx.restore();
  roundRect(ctx, M, fY, W, fH, 12); ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();

  const emL = await decode(input.emblems?.[leftId]);
  const emR = await decode(input.emblems?.[rightId]);
  const emSize = 112;
  const emY = fY + (fH - emSize) / 2;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
  if (emL) ctx.drawImage(emL, M + 32, emY, emSize, emSize);
  if (emR) ctx.drawImage(emR, M + W - 32 - emSize, emY, emSize, emSize);
  ctx.restore();

  ctx.textAlign = "center";
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.8)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "#9dc4ff"; ctx.font = font("bold", 40);
  fitText(ctx, leftName, lx, fY + 62, half * 0.82, "bold", 40, 22);
  ctx.fillStyle = "#ffa0a0";
  fitText(ctx, rightName, rx, fY + 62, half * 0.82, "bold", 40, 22);
  ctx.shadowBlur = 20;
  ctx.fillStyle = INK; ctx.font = font("bold", 78);
  ctx.fillText(String(s.alliedScore ?? "—"), lx, fY + 146);
  ctx.fillText(String(s.axisScore ?? "—"), rx, fY + 146);
  ctx.restore();
  ctx.fillStyle = "rgba(215,225,238,0.75)"; ctx.font = font("600", 28);
  ctx.fillText("VS", M + half + 8, fY + 100);

  // ---- the front line ------------------------------------------------------------------------
  const sY = fY + fH + 12, sH = 214;
  panel(ctx, M, sY, W, sH, ["#141b25", "#0c1017"]);
  // The largest empty area on the board — a title and five small boxes on a field of nothing.
  ctx.save();
  roundRect(ctx, M, sY, W, sH, 10); ctx.clip();
  dirt(ctx, { x: M, y: sY, w: W, h: sH }, `${seed}|front`, { count: 30, alpha: 0.22, scale: 0.8 });
  marble(ctx, { x: M, y: sY, w: W, h: sH }, `${seed}|front`, { scale: 210, alpha: 0.72, contrast: 2.1, gain: 1.5, octaves: 5 });
  spatter(ctx, { x: M, y: sY, w: W, h: sH }, `${seed}|frontblood`, { clusters: 4, alpha: 0.46, scale: 1.6, drips: 3 });
  scuffs(ctx, { x: M, y: sY, w: W, h: sH }, `${seed}|front`, { count: 18, alpha: 0.055 });
  ctx.restore();
  ctx.textAlign = "center";
  ctx.fillStyle = "#d7dee8"; ctx.font = font("600", 26);
  ctx.fillText("FRONTLINE CONTROL", M + W / 2, sY + 38);

  const caps = 5;
  const alliedCaps = Math.max(0, Math.min(caps, Number(s.alliedScore ?? 0)));
  const axisCaps = Math.max(0, Math.min(caps, Number(s.axisScore ?? 0)));
  const readable = alliedCaps + axisCaps === caps; // warfare/offensive; anything else isn't sectors
  // The boxes decide the geometry and the rail follows them — sizing the rail first put the outer
  // two labels off the edge of their own panel.
  const edge = 26, capGap = 12;
  const bw = (W - edge * 2 - capGap * (caps - 1)) / caps;
  const centre = (i: number) => M + edge + bw / 2 + i * (bw + capGap);
  const nodeY = sY + 80;
  const boxY = nodeY + 28, boxH = 56;

  // The rail: blue behind the ground the allies hold, red behind the axis'.
  ctx.lineWidth = 6; ctx.lineCap = "round";
  for (let i = 0; i < caps - 1; i++) {
    ctx.beginPath(); ctx.moveTo(centre(i), nodeY); ctx.lineTo(centre(i + 1), nodeY);
    ctx.strokeStyle = !readable ? "#2b3543" : i + 1 < alliedCaps ? BLUE : i >= alliedCaps ? RED : "#8b97a6";
    ctx.stroke();
  }
  for (let i = 0; i < caps; i++) {
    const x = centre(i);
    const held = !readable ? null : i < alliedCaps ? "allies" : "axis";
    const col = held === "allies" ? BLUE : held === "axis" ? RED : "#4a5666";
    ctx.beginPath(); ctx.arc(x, nodeY, 17, 0, Math.PI * 2);
    ctx.fillStyle = "#0a0d12"; ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, nodeY, 7, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();

    const by = boxY;
    panel(ctx, x - bw / 2, by, bw, boxH, ["rgba(24,31,42,0.95)", "rgba(11,15,21,0.95)"], col === "#4a5666" ? LINE : col);
    ctx.fillStyle = "#c8d2de"; ctx.font = font("600", 16);
    ctx.fillText(`SECTOR ${i + 1}`, x, by + 24);
    ctx.fillStyle = held === "allies" ? BLUE_INK : held === "axis" ? RED_INK : DIM;
    ctx.font = font("600", 14);
    fitText(ctx, held === "allies" ? leftName : held === "axis" ? rightName : "—", x, by + 44, bw - 20, "600", 14);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = alliedCaps > axisCaps ? BLUE_INK : axisCaps > alliedCaps ? RED_INK : MUTED;
  ctx.font = font("600", 19);
  ctx.fillText(frontlineCaption(readable, alliedCaps, axisCaps, leftName, rightName), M + W / 2, sY + sH - 16);

  // ---- totals ---------------------------------------------------------------------------------
  const tY = sY + sH + 12, tH = 168;
  const totalCards: { key: string; label: string; l: number; r: number }[] = [
    { key: "kills", label: "TOTAL KILLS", l: lt.kills, r: rt.kills },
    { key: "combat", label: "TOTAL COMBAT", l: lt.combat, r: rt.combat },
    { key: "offense", label: "TOTAL OFFENSE", l: lt.offense, r: rt.offense },
    { key: "defense", label: "TOTAL DEFENSE", l: lt.defense, r: rt.defense },
    { key: "support", label: "TOTAL SUPPORT", l: lt.support, r: rt.support },
  ];
  const icons: Record<string, Awaited<ReturnType<typeof decode>>> = {};
  for (const c of totalCards) icons[c.key] = await decode(input.icons?.[c.key]);
  const gap = 12, cw = (W - gap * (totalCards.length - 1)) / totalCards.length;
  totalCards.forEach((c, i) => {
    const x = M + i * (cw + gap);
    const leads = c.l === c.r ? null : c.l > c.r ? "l" : "r";
    panel(ctx, x, tY, cw, tH, ["#18202b", "#0e131a"], leads === "l" ? EDGE_BLUE : leads === "r" ? EDGE_RED : LINE);
    // A bar of the leader's colour along the top edge: the row gets a rhythm you can read from
    // across the room, before any of the numbers resolve.
    if (leads) {
      ctx.save();
      roundRect(ctx, x, tY, cw, tH, 10); ctx.clip();
      const ac = ctx.createLinearGradient(x, tY, x + cw, tY);
      const col = leads === "l" ? BLUE : RED;
      ac.addColorStop(0, "rgba(0,0,0,0)"); ac.addColorStop(0.5, col); ac.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = ac; ctx.fillRect(x, tY, cw, 3);
      ctx.restore();
    }
    // The game's own score glyph, dimmed so it reads as a mark rather than a picture.
    const icon = icons[c.key];
    if (icon) {
      ctx.save();
      ctx.globalAlpha = 0.42;
      ctx.drawImage(icon, x + 14, tY + 14, 30, 30);
      ctx.restore();
    }
    stat(ctx, x + cw / 2, tY + 34, c.label, fmt(c.l + c.r), 48);
    // The split under each total: who actually put it there.
    const midY = tY + tH - 46;
    ctx.beginPath(); ctx.moveTo(x + cw / 2, midY - 4); ctx.lineTo(x + cw / 2, midY + 34);
    ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = font("600", 15);
    ctx.fillStyle = BLUE_INK; ctx.fillText(shortSide(leftName), x + cw * 0.26, midY + 10);
    ctx.fillStyle = RED_INK; ctx.fillText(shortSide(rightName), x + cw * 0.74, midY + 10);
    ctx.font = font("bold", 22);
    ctx.fillStyle = "#a9c6f2"; ctx.fillText(fmt(c.l), x + cw * 0.26, midY + 34);
    ctx.fillStyle = "#f0aeae"; ctx.fillText(fmt(c.r), x + cw * 0.74, midY + 34);
  });

  // ---- who stood out ---------------------------------------------------------------------------
  const lY = tY + tH + 12, lH = 176;
  const shown = leaders.slice(0, 5);
  if (shown.length) {
    const lw = (W - gap * (shown.length - 1)) / shown.length;
    shown.forEach((ld, i) => {
      const x = M + i * (lw + gap);
      const axis = ld.sideId === rightId;
      // A leader whose team could not be resolved gets the neutral border — painting them blue
      // would be an assertion the data never made.
      panel(ctx, x, lY, lw, lH, ["#18202b", "#0e131a"], ld.sideId == null ? LINE : axis ? EDGE_RED : EDGE_BLUE);
      ctx.textAlign = "center";
      ctx.fillStyle = MUTED; ctx.font = font("600", 17);
      ctx.fillText(ld.label, x + lw / 2, lY + 34);
      // The name follows the border's rule: an unresolved team wears neutral ink, not allied blue.
      ctx.fillStyle = ld.sideId == null ? "#d7dee8" : axis ? RED_INK : BLUE_INK;
      fitText(ctx, ld.name || "—", x + lw / 2, lY + 74, lw - 24, "600", 24);
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.75)"; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
      ctx.fillStyle = INK; ctx.font = font("bold", 52);
      ctx.fillText(fmt(ld.value), x + lw / 2, lY + 136);
      ctx.restore();
    });
  }

  // ---- footer ---------------------------------------------------------------------------------
  const fbY = lY + lH + 10;
  ctx.textAlign = "left";
  ctx.fillStyle = DIM; ctx.font = font("600", 18);
  ctx.fillText("UPDATES AUTOMATICALLY", M + 4, fbY + 22);
  ctx.textAlign = "right";
  ctx.fillText(`LAST UPDATE  ${at.toISOString().slice(11, 16)} UTC`, M + W - 4, fbY + 22);

  // Live rounds, big and faint, lying across the whole board.
  //
  // Small and solid they were litter in the gutters, which meant they only ever appeared in the few
  // narrow strips the layout had left over. At this size they are a motif the board is printed over
  // instead: large enough to read as ammunition, transparent enough to cross a total without
  // competing with it.
  bullets(ctx, whole, `${seed}|ammo`, { count: 12, size: 180, alpha: 0.13 });

  // A last pass over everything, cards included, so nothing on the board looks factory-fresh: a few
  // very wide grime blotches, wear across the whole face, then grain.
  dirt(ctx, whole, `${seed}|worn`, { count: 22, alpha: 0.1, scale: 1.15, specks: 2.4 });
  scuffs(ctx, whole, `${seed}|worn`, { count: 20, alpha: 0.04 });
  // Heavier in the corners, which is where dirt collects on anything that has been handled.
  for (const [cx, cy] of [[0, 0], [BOARD_W - 300, 0], [0, BOARD_H - 220], [BOARD_W - 300, BOARD_H - 220]]) {
    dirt(ctx, { x: cx!, y: cy!, w: 300, h: 220 }, `${seed}|corner${cx}${cy}`, { count: 10, alpha: 0.17, scale: 1.1, specks: 2 });
  }
  grain(ctx, BOARD_W, BOARD_H, hash32(seed));

  // JPEG, not PNG: the board is mostly photograph and it is re-sent on every tick — roughly half a
  // megabyte a minute per server adds up to hundreds of megabytes a day. 85 is the point where the
  // encoder stops spending bytes on differences nobody can see at Discord's display size.
  return canvas.toBuffer("image/jpeg", 85);
}

/** "1/6" or "—", the general queue against its own maximum. */
function queueText(s: SessionInfo): string {
  if (s.queueCount == null) return "—";
  const vip = vipQueueDepth(s);
  return `${s.queueCount}${s.maxQueueCount ? `/${s.maxQueueCount}` : ""}${vip ? ` +${vip}` : ""}`;
}

/** "ALLIES LEAD BY 1 SECTOR" — the sentence the picture is already making. */
function frontlineCaption(readable: boolean, a: number, x: number, leftName: string, rightName: string): string {
  if (!readable) return "SECTORS ARE NOT REPORTED FOR THIS MODE";
  if (a === x) return "THE FRONT IS EVEN";
  const by = Math.abs(a - x);
  return `${a > x ? leftName : rightName} LEAD BY ${by} SECTOR${by === 1 ? "" : "S"}`;
}

/** Faction names are long; the split under a total has room for a short one. */
function shortSide(name: string): string {
  const words = name.split(/\s+/);
  return words.length > 1 ? words.map((w) => w[0]).join("") : name.slice(0, 3);
}
