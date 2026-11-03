/**
 * Weathering for the match board.
 *
 * A scoreboard for a war game, drawn clean, is a spreadsheet with team colours on it. Everything in
 * this file is dirt: grime worked into the flat ground, scuffs across the panels, live rounds lying
 * across it, and blood.
 *
 * Two rules hold all of it together.
 *
 * Seeded. The board redraws every minute into the same Discord message, so grit that reshuffled on
 * each tick would crawl across the picture. Every function here takes a seed string — the server and
 * the map — and a round therefore wears the same dirt for its whole life, and gets new dirt when the
 * map changes.
 *
 * Placed, not sprayed. Each function takes the rectangle it may draw in, so the layout decides where
 * grit is allowed and how hard it lands — over a whole number, or only in the gaps between them.
 */
import { createCanvas, Path2D, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

/** A deterministic 32-bit hash of a string — the seed for a round's weathering. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Small deterministic PRNG. Same seed, same dirt, every redraw. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;

/** A region of the board the layout has declared free of anything worth reading. */
export interface Rect { x: number; y: number; w: number; h: number }

export interface DirtOpts {
  /** how many blotches; more is mottled, not darker. */
  count?: number;
  /** peak strength of one blotch. They overlap, so this stays low. */
  alpha?: number;
  /** the largest blotch, as a fraction of the region's shorter side. */
  scale?: number;
  /** fraction of blotches that darken instead of lightening. */
  shadow?: number;
  /** loose grit, as a multiple of `count`. Set to 0 for a surface that should only be stained. */
  specks?: number;
}

/** Hash of a lattice point, for value noise. Same point, same value, every call. */
function vhash(ix: number, iy: number, seed: number): number {
  let h = (seed ^ Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise: the four lattice corners, interpolated with a smoothstep. */
function noise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const fx = tx * tx * (3 - 2 * tx), fy = ty * ty * (3 - 2 * ty);
  const a = vhash(x0, y0, seed), b = vhash(x0 + 1, y0, seed);
  const c = vhash(x0, y0 + 1, seed), d = vhash(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

export interface MarbleOpts {
  /** the largest feature, in pixels. */
  scale?: number;
  /** strength of the overlay. */
  alpha?: number;
  /** how many octaves — more is finer detail riding on the same big shapes. */
  octaves?: number;
  /** above 1 narrows the veins and flattens everything between them. The "defined" knob. */
  contrast?: number;
  /** how far the light and dark ends travel from the base tone. The "marbled" knob. */
  gain?: number;
}

/**
 * Marbling: veined cloud, not soft haze.
 *
 * Blurred blobs give a surface weather but no structure — everything is a soft gradient and the eye
 * finds no edge to hold. This is ridged fractal noise instead: several octaves of value noise,
 * folded at the midpoint so each one contributes a sharp crease rather than a smooth hump, which is
 * what produces veins. Powers of two in frequency, halving in strength, so the big shapes carry and
 * the fine ones only break their edges up.
 *
 * Composited as overlay, so it modulates whatever it lies on rather than painting over it: the blue
 * half of the faction band marbles blue and the red half marbles red, from one grey texture.
 *
 * Generated at a third of the region's size and drawn back up smoothed — identical to the eye at
 * these frequencies for a ninth of the arithmetic — and the finished grey tile is memoized: the
 * noise loops are the most expensive arithmetic on the whole board, every input that shapes a tile
 * is in the key, and the same round asks for the same tile on every redraw. Bounded, so a
 * multi-server worker that ran for months cannot hoard canvases.
 */
const marbleTiles = new Map<string, Canvas>();
const MARBLE_TILES_MAX = 64;

export function marble(ctx: SKRSContext2D, r: Rect, seed: string, opts: MarbleOpts = {}): void {
  const { scale = 240, alpha = 0.55, octaves = 4, contrast = 1.6, gain = 1.15 } = opts;
  const step = 3;
  const bw = Math.max(2, Math.ceil(r.w / step)), bh = Math.max(2, Math.ceil(r.h / step));
  const key = `${seed}|${bw}x${bh}|${scale}|${octaves}|${contrast}|${gain}`;
  const cached = marbleTiles.get(key);
  if (cached) {
    drawMarble(ctx, r, cached, alpha);
    return;
  }
  const buf = createCanvas(bw, bh);
  const bctx = buf.getContext("2d");
  const img = bctx.createImageData(bw, bh);
  const s = hash32(`marble|${seed}`);
  const base = step / scale;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let v = 0, amp = 1, f = base, norm = 0;
      for (let o = 0; o < octaves; o++) {
        v += amp * Math.abs(noise2(x * f, y * f, s + o * 7919) * 2 - 1);
        norm += amp; amp *= 0.5; f *= 2;
      }
      const ridge = Math.pow(1 - v / norm, contrast);
      // Centred on mid-grey, which is the value overlay leaves alone: the texture pushes the surface
      // both ways from what it already is instead of tinting it one way.
      const px = Math.max(0, Math.min(255, Math.round(128 + (ridge - 0.42) * 255 * gain)));
      const i = (y * bw + x) * 4;
      img.data[i] = px; img.data[i + 1] = px; img.data[i + 2] = px; img.data[i + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);
  if (marbleTiles.size >= MARBLE_TILES_MAX) marbleTiles.clear();
  marbleTiles.set(key, buf);
  drawMarble(ctx, r, buf, alpha);
}

function drawMarble(ctx: SKRSContext2D, r: Rect, tile: Canvas, alpha: number): void {
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(tile, r.x, r.y, r.w, r.h);
  ctx.restore();
}

/**
 * Ground-in grime.
 *
 * On a near-black board there is almost nothing below the base tone, so dirt mostly has to be
 * LIGHTER than what it sits on — a warm dust that catches the light — with a minority of darker
 * blotches to stop the whole thing from simply glowing. Each blotch is squashed and rotated, so
 * none of them reads as the circle it started as.
 *
 * Two details do most of the work of not looking like a gradient. Sizes are drawn from a squared
 * distribution, so a region gets a couple of broad stains and a great many fine ones rather than a
 * uniform spread of middling blobs. And each blotch is blurred in proportion to its own size, so
 * the small ones stay sharp enough to read as marks instead of dissolving into the large ones.
 */
export function dirt(ctx: SKRSContext2D, r: Rect, seed: string, opts: DirtOpts = {}): void {
  const { count = 20, alpha = 0.18, scale = 0.5, shadow = 0.34, specks = 1.6 } = opts;
  const rand = rng(hash32(`dirt|${seed}`));
  const base = Math.min(r.w, r.h);
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  for (let i = 0; i < count; i++) {
    const dark = rand() < shadow;
    const rad = (0.05 + rand() * rand()) * base * scale;
    const a = alpha * (0.3 + rand() * 0.7) * (dark ? 1.2 : 1);
    const tint = dark ? "26,20,13" : "104,88,63";
    ctx.save();
    // The blur grows with the blotch but is CAPPED: skia's cost scales with radius × area, and an
    // uncapped 300px blur on a board-sized blotch is seconds of CPU for a shape that is already a
    // soft radial gradient. Past ~40px the extra softness is invisible at these alphas.
    ctx.filter = `blur(${Math.min(40, Math.max(3, rad * 0.34))}px)`;
    ctx.globalCompositeOperation = dark ? "multiply" : "screen";
    ctx.translate(r.x + rand() * r.w, r.y + rand() * r.h);
    ctx.rotate(rand() * Math.PI);
    ctx.scale(1, 0.35 + rand() * 0.75);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
    g.addColorStop(0, `rgba(${tint},${a})`);
    g.addColorStop(0.45, `rgba(${tint},${a * 0.45})`);
    g.addColorStop(1, `rgba(${tint},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-rad, -rad, rad * 2, rad * 2);
    ctx.restore();
  }
  // Loose grit: unblurred, a pixel or two across. Too small to see one of, and the thing you would
  // miss if they were not there.
  for (let i = 0; i < Math.round(count * specks); i++) {
    const dark = rand() < 0.6;
    const rad = 0.5 + rand() * rand() * 2.4;
    ctx.fillStyle = dark ? `rgba(0,0,0,${alpha * 1.6 * rand()})` : `rgba(190,172,138,${alpha * 1.1 * rand()})`;
    ctx.beginPath();
    ctx.ellipse(r.x + rand() * r.w, r.y + rand() * r.h, rad * (1 + rand()), rad, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Scratches and wear.
 *
 * Long, shallow, mostly along the grain, in both directions — a bright scrape where something took
 * the finish off, a dark one where it dug in. Cheap, and it is what stops a large flat panel from
 * looking freshly printed.
 */
export function scuffs(ctx: SKRSContext2D, r: Rect, seed: string, opts: { count?: number; alpha?: number } = {}): void {
  const { count = 14, alpha = 0.05 } = opts;
  const rand = rng(hash32(`scuff|${seed}`));
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const x0 = r.x + rand() * r.w, y0 = r.y + rand() * r.h;
    // Capped in pixels rather than as a fraction of the region: a scratch that runs a third of the
    // way across the whole board stops reading as wear and starts reading as a light leak.
    const len = Math.min(r.w * 0.4, 24 + rand() * rand() * 190);
    const ang = (rand() - 0.5) * 0.45 + (rand() < 0.14 ? Math.PI / 2 : 0);
    const x1 = x0 + Math.cos(ang) * len, y1 = y0 + Math.sin(ang) * len;
    const light = rand() < 0.5;
    const a = alpha * (0.35 + rand());
    ctx.strokeStyle = light ? `rgba(206,194,170,${a})` : `rgba(0,0,0,${a * 1.7})`;
    ctx.lineWidth = 0.6 + rand() * 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 + (rand() - 0.5) * 12, x1, y1);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * One live round: brass case, primer, shoulder, copper bullet.
 *
 * Drawn opaque, always — the caller fades the finished object, never the parts of it. Fading each
 * fill separately is what made the first version read as a pale smear: over a near-black board a
 * translucent dark tone contributes almost nothing, so only the highlights survived and the round
 * lost every edge that told you what it was. Composited whole, the shading stays internally
 * consistent and only its strength against the board changes.
 *
 * What makes it metal is contrast across the short axis, not the outline: a dark edge, a fast climb
 * to a narrow blown-out band well above centre, then a long fall to a dark bottom edge. Brass and
 * copper differ in hue AND in where that band sits, which is most of what separates the case from
 * the bullet at a glance.
 */
function bullet(ctx: SKRSContext2D, x: number, y: number, len: number, angle: number, rand: Rand): void {
  const w = len * 0.27;            // a whole cartridge is longer and thinner than the case alone
  const caseEnd = len * 0.03;      // where the straight case stops
  const neck = len * 0.16;         // and where the bullet is seated, past the shoulder
  const necked = w * 0.38;         // half-width at the neck
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // The contact shadow, softening with size the way a real one does with distance off the ground.
  ctx.save();
  ctx.filter = `blur(${Math.max(3, len * 0.08)}px)`;
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.beginPath();
  ctx.ellipse(len * 0.05, len * 0.1, len * 0.55, w * 0.68, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // The case: flat base, straight walls, then the shoulder pulling in to the neck.
  const caseBody = new Path2D();
  caseBody.moveTo(-len / 2, -w / 2);
  caseBody.lineTo(caseEnd, -w / 2);
  caseBody.lineTo(neck, -necked);
  caseBody.lineTo(neck, necked);
  caseBody.lineTo(caseEnd, w / 2);
  caseBody.lineTo(-len / 2, w / 2);
  caseBody.closePath();
  const brass = ctx.createLinearGradient(0, -w / 2, 0, w / 2);
  brass.addColorStop(0, "#2a1d07");
  brass.addColorStop(0.1, "#8a6a22");
  brass.addColorStop(0.3, "#f6e6a8");   // the hot band, above centre: the light is up and to the left
  brass.addColorStop(0.38, "#d9b558");
  brass.addColorStop(0.72, "#7c5a1c");
  brass.addColorStop(0.9, "#33240b");
  brass.addColorStop(1, "#181004");
  ctx.fillStyle = brass;
  ctx.fill(caseBody);

  // The bullet, seated at the neck and drawn back a hair so no seam shows between the two metals.
  const jacket = new Path2D();
  jacket.moveTo(neck - len * 0.01, -necked);
  jacket.quadraticCurveTo(len * 0.34, -necked * 0.93, len / 2, 0);
  jacket.quadraticCurveTo(len * 0.34, necked * 0.93, neck - len * 0.01, necked);
  jacket.closePath();
  const copper = ctx.createLinearGradient(0, -necked, 0, necked);
  copper.addColorStop(0, "#2c1206");
  copper.addColorStop(0.12, "#8f4a1c");
  copper.addColorStop(0.32, "#e9b184");   // copper's highlight is duller and warmer than brass'
  copper.addColorStop(0.42, "#c07a3c");
  copper.addColorStop(0.74, "#6d3512");
  copper.addColorStop(1, "#1d0c04");
  ctx.fillStyle = copper;
  ctx.fill(jacket);

  // The head: rim, extractor groove, and the primer sunk in the middle of the base.
  ctx.fillStyle = "rgba(255,238,190,0.30)";
  ctx.fillRect(-len / 2, -w / 2, w * 0.2, w);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(-len / 2 + w * 0.2, -w / 2, w * 0.13, w);
  ctx.save();
  ctx.clip(caseBody);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath();
  ctx.ellipse(-len / 2 + w * 0.1, 0, w * 0.055, w * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // The cannelure: the crimp groove ringing the bullet where the case grips it.
  ctx.save();
  ctx.clip(jacket);
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(neck + len * 0.045, -necked, len * 0.022, necked * 2);
  ctx.restore();

  // The specular streaks. Tapered with a gradient rather than laid down as a hard bar, which is the
  // difference between a lit cylinder and a strip of tape.
  const a = 0.4 + rand() * 0.25;
  const spec = (x0: number, x1: number, yy: number, hh: number, peak: string) => {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.35, peak);
    g.addColorStop(0.7, peak);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(x0, x1), yy, Math.abs(x1 - x0), hh);
  };
  ctx.save();
  ctx.clip(caseBody);
  spec(-len * 0.46, neck, -w * 0.3, w * 0.1, `rgba(255,252,236,${a})`);
  ctx.restore();
  ctx.save();
  ctx.clip(jacket);
  spec(neck, len * 0.46, -necked * 0.6, necked * 0.28, `rgba(255,235,208,${a * 0.75})`);
  ctx.restore();

  // A dark outline all the way round, so the round keeps an edge against whatever it lies on.
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = Math.max(0.8, len * 0.008);
  ctx.stroke(caseBody);
  ctx.stroke(jacket);
  ctx.restore();
}

export interface BulletOpts {
  /** how many. */
  count?: number;
  /** nominal length in pixels; each one varies either side of it. */
  size?: number;
  /**
   * Opacity of the whole object, shadow included.
   *
   * Below about a fifth, a round stops being litter on the floor and becomes a motif the board is
   * printed over — which is the only way something this large can sit across the data without
   * competing with it.
   */
  alpha?: number;
}

/**
 * Live rounds scattered through a region.
 *
 * Kept whole: a round is placed far enough inside the rectangle that the clip never slices one in
 * half, because half a cartridge reads as a smear rather than as an object.
 */
export function bullets(ctx: SKRSContext2D, r: Rect, seed: string, opts: BulletOpts = {}): void {
  const { count = 5, size = 22, alpha = 1 } = opts;
  const rand = rng(hash32(`ammo|${seed}`));
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.globalAlpha = alpha;
  // Each round is drawn opaque into its own small canvas and that canvas is faded onto the board.
  // Fading the fills individually — which is what setting globalAlpha and drawing straight to the
  // board does — loses the object: over near-black, a translucent dark edge contributes nothing, so
  // only the highlights survive and a cartridge becomes a pale smear with no silhouette. Composited
  // whole, the dark side darkens the board exactly as much as the bright side lightens it, and the
  // shading stays internally consistent at any opacity.
  const boxOf = (len: number) => Math.ceil(len * 1.5);   // the round, plus the reach of its shadow
  // One per cell of a rough grid, jittered inside it. Straight random placement clumps — three
  // rounds land on top of each other in one corner and half the region has none — and at this size
  // a clump reads as one unidentifiable shape rather than as ammunition.
  const cols = Math.max(1, Math.round(Math.sqrt((count * r.w) / Math.max(1, r.h))));
  const rows = Math.ceil(count / cols);
  const cw = r.w / cols, ch = r.h / rows;
  for (let i = 0; i < count; i++) {
    const len = size * (0.72 + rand() * 0.55);
    // The round reaches half its length in any direction once rotated, and the contact shadow reaches
    // further still — it is wider than the case, offset, and blurred. Inset by the shadow's reach,
    // not the body's, or the clip takes a bite out of every round near an edge. A zone too small to
    // hold one at all falls back to the middle and accepts the clip.
    const pad = Math.min(len * 0.72 + 14, r.w / 2, r.h / 2);
    const col = i % cols, row = Math.floor(i / cols);
    const cx = r.x + (col + 0.5) * cw + (rand() - 0.5) * cw * 0.7;
    const cy = r.y + (row + 0.5) * ch + (rand() - 0.5) * ch * 0.7;
    const x = Math.min(Math.max(cx, r.x + pad), r.x + r.w - pad);
    const y = Math.min(Math.max(cy, r.y + pad), r.y + r.h - pad);
    const box = boxOf(len);
    const off = createCanvas(box, box);
    bullet(off.getContext("2d"), box / 2, box / 2, len, rand() * Math.PI * 2, rand);
    ctx.drawImage(off, x - box / 2, y - box / 2);
  }
  ctx.restore();
}

/**
 * The colour of blood on a dark surface.
 *
 * Not the red of a paint tin. Blood is very dark and only barely red — a bright crimson droplet
 * reads as a plastic bead — and it dries browner from the edge inwards, so a field of it is a
 * spread of related dark tones rather than one flat colour. `t` walks fresh (near-black oxblood) to
 * dried (dark rust); big pools stay wetter in the middle, fine mist dries almost at once.
 */
function bloodTone(t: number, a: number): string {
  const r = Math.round(58 + t * 46);
  const g = Math.round(6 + t * 22);
  const b = Math.round(6 + t * 12);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * One droplet: a circle knocked out of round, then smoothed, because blood does not land in circles.
 *
 * The rim is drawn darker than the middle. A droplet dries from its edge, and that thin dark line is
 * most of what stops a group of these from reading as one soft red cloud.
 */
function droplet(ctx: SKRSContext2D, x: number, y: number, r: number, a: number, stretch: number, angle: number, rand: Rand): void {
  const pts: [number, number][] = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    const rr = r * (0.68 + rand() * 0.62);
    pts.push([Math.cos(th) * rr * stretch, Math.sin(th) * rr]);
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  // Through the midpoints, so the polygon reads as a shape and not as a cog.
  const mid = (i: number): [number, number] => {
    const p = pts[i % n]!, q = pts[(i + 1) % n]!;
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  };
  const [sx, sy] = mid(n - 1);
  ctx.moveTo(sx, sy);
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const [mx, my] = mid(i);
    ctx.quadraticCurveTo(p[0], p[1], mx, my);
  }
  ctx.closePath();
  // Small means dried: a speck of mist has no volume to stay wet with.
  const dry = Math.max(0, Math.min(1, 1 - r / 14)) * (0.55 + rand() * 0.45);
  ctx.fillStyle = bloodTone(dry, a);
  ctx.fill();
  if (r > 2) {
    ctx.strokeStyle = bloodTone(Math.min(1, dry + 0.5), Math.min(1, a * 1.25));
    ctx.lineWidth = Math.max(0.5, r * 0.16);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A run of blood pulling down out of a blob, with a bead at the end.
 *
 * Short and narrow, and it wanders. The first version ran a fifth of the board's height at a fixed
 * width in a dead straight line, which is not a run of blood — it is a red bar. A real one is only
 * a few times longer than it is wide, thins as it goes because it leaves most of itself behind on
 * the way down, and drifts off vertical.
 */
function drip(ctx: SKRSContext2D, x: number, y: number, width: number, length: number, a: number, rand: Rand): void {
  const endW = width * (0.16 + rand() * 0.22);
  const drift = (rand() - 0.5) * length * 0.34;      // gravity wins, but the surface is not flat
  const belly = (rand() - 0.5) * length * 0.2;
  ctx.beginPath();
  ctx.moveTo(x - width / 2, y);
  ctx.bezierCurveTo(
    x - width * 0.44 + belly, y + length * 0.4,
    x - endW * 0.5 + drift, y + length * 0.72,
    x - endW / 2 + drift, y + length,
  );
  ctx.lineTo(x + endW / 2 + drift, y + length);
  ctx.bezierCurveTo(
    x + endW * 0.5 + drift, y + length * 0.72,
    x + width * 0.44 + belly, y + length * 0.4,
    x + width / 2, y,
  );
  ctx.closePath();
  ctx.fillStyle = bloodTone(0.15, a);
  ctx.fill();
  // The bead it is hanging from, fatter than the run and the wettest part of it.
  ctx.beginPath();
  ctx.ellipse(x + drift, y + length, endW * 1.15, endW * 1.35, 0, 0, Math.PI * 2);
  ctx.fillStyle = bloodTone(0, a);
  ctx.fill();
}

export interface SpatterOpts {
  /** how many separate throws. */
  clusters?: number;
  /** opacity of the heaviest droplet in a cluster. */
  alpha?: number;
  /** droplet and throw size. */
  scale?: number;
  /** how many runs pull down out of a cluster, at most. Zero for a surface nothing runs down. */
  drips?: number;
  /**
   * Soak into what is underneath instead of lying on top of it.
   *
   * Over a photograph this is the only version that looks right — painted-on red reads as red paint.
   * Over the board's own near-black panels it would disappear, so those get the flat version.
   */
  stain?: boolean;
}

/**
 * Blood, thrown.
 *
 * Not a random sprinkle: each cluster has a direction and a source. A heavy blob where it landed,
 * then droplets thinning and shrinking along the throw, plus a couple of stretched flicks running
 * with it. That structure is the difference between spatter and polka dots.
 */
export function spatter(ctx: SKRSContext2D, r: Rect, seed: string, opts: SpatterOpts = {}): void {
  const { clusters = 2, alpha = 0.42, scale = 1, stain = false, drips = 2 } = opts;
  const rand = rng(hash32(`blood|${seed}`));
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  if (stain) ctx.globalCompositeOperation = "multiply";
  // Spread over a rough grid, the same as the brass: several throws placed at random pile onto one
  // another and leave the rest of the region clean, which is the opposite of what more blood means.
  const cols = Math.max(1, Math.round(Math.sqrt((clusters * r.w) / Math.max(1, r.h))));
  const rows = Math.ceil(clusters / cols);
  for (let c = 0; c < clusters; c++) {
    const col = c % cols, row = Math.floor(c / cols);
    const cx = r.x + ((col + 0.5) / cols + (rand() - 0.5) * 0.8 / cols) * r.w;
    const cy = r.y + ((row + 0.5) / rows + (rand() - 0.5) * 0.8 / rows) * r.h;
    const dir = rand() * Math.PI * 2;
    const a = alpha * (0.7 + rand() * 0.5);
    // Most throws are small and a few are not. Giving every cluster the same weight is what turned
    // a lot of blood into an even red wash: the eye needs a few heavy marks to read the rest as
    // spatter around them rather than as tint.
    const heft = 0.25 + rand() * rand() * 1.6;
    const reach = (55 + rand() * 75) * scale * (0.6 + heft * 0.5);
    const core = (4 + rand() * 7) * scale * heft;
    droplet(ctx, cx, cy, core, a, 1.15, dir, rand);
    // The mist around the impact: many, tiny, and close in. This is the part the eye reads as
    // "spatter" rather than as a red mark.
    const fine = 30 + Math.floor(rand() * 30);
    for (let i = 0; i < fine; i++) {
      const th = rand() * Math.PI * 2;
      const d = rand() * rand() * 44 * scale * (0.7 + heft * 0.4);
      droplet(ctx, cx + Math.cos(th) * d, cy + Math.sin(th) * d, (0.35 + rand() * 1.2) * scale, a * (0.4 + rand() * 0.55), 1, th, rand);
    }
    const drops = 12 + Math.floor(rand() * 14);
    for (let i = 0; i < drops; i++) {
      const t = rand();
      const spread = (rand() - 0.5) * 0.75;
      const d = t * reach;
      droplet(
        ctx,
        cx + Math.cos(dir + spread) * d,
        cy + Math.sin(dir + spread) * d,
        (0.8 + rand() * 2.8) * (1 - t * 0.55) * scale * (0.7 + heft * 0.4),
        a * (1 - t * 0.5),
        1 + t * 1.4,                      // the far droplets are the stretched ones
        dir + spread,
        rand,
      );
    }
    // Only a heavy mark has enough on the surface to run, and a run is a few times its own width —
    // not a bar down the board. Both of those are why the first version looked like red icicles.
    if (heft > 0.85) {
      for (let i = 0; i < drips; i++) {
        if (rand() < 0.45) continue;   // and even then, not every one of them runs
        const w = core * (0.3 + rand() * 0.45);
        drip(ctx, cx + (rand() - 0.5) * core * 1.4, cy + core * 0.5, w, w * (3.5 + rand() * 6), a * (0.8 + rand() * 0.3), rand);
      }
    }
  }
  ctx.restore();
}

/**
 * Film grain, tiled.
 *
 * Big soft gradients over a dark ground band once JPEG has had its say — you can count the steps. A
 * tile of noise laid over the top hides all of it. One 128px tile, drawn once and repeated: noise
 * generated per pixel across the whole board would cost far more for a result nobody could tell
 * apart.
 */
export function grain(ctx: SKRSContext2D, w: number, h: number, seed: number): void {
  const size = 128;
  const tile = createCanvas(size, size);
  const tctx = tile.getContext("2d");
  const img = tctx.createImageData(size, size);
  const rand = rng(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 118 + Math.floor(rand() * 74);
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return;
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
