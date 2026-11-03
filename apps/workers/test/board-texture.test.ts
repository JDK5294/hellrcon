// The board's weathering. Nobody can assert that dirt looks like dirt, but the two rules the grit
// is built on are testable, and both are the kind of thing that fails silently in a picture: it
// must land only where the layout said it could, and it must be identical on every redraw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { hash32, rng, dirt, scuffs, bullets, spatter, type Rect } from "../dist/board-texture.js";

const W = 420, H = 320;
const ZONE: Rect = { x: 120, y: 90, w: 170, h: 80 };

/** Every pixel the drawing touched, as a bounding box — null when it drew nothing at all. */
function inked(draw: (ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => void): Rect | null {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  draw(ctx);
  const { data } = ctx.getImageData(0, 0, W, H);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3]! === 0) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function assertInside(box: Rect | null, zone: Rect, what: string): void {
  assert.ok(box, `${what} drew nothing`);
  assert.ok(box.x >= zone.x, `${what} ran off the left of its zone (${box.x} < ${zone.x})`);
  assert.ok(box.y >= zone.y, `${what} ran off the top of its zone (${box.y} < ${zone.y})`);
  assert.ok(box.x + box.w <= zone.x + zone.w, `${what} ran off the right of its zone`);
  assert.ok(box.y + box.h <= zone.y + zone.h, `${what} ran off the bottom of its zone`);
}

test("the PRNG is deterministic, and stays in range", () => {
  const a = Array.from({ length: 200 }, rng(hash32("purpleheartlane")));
  const b = Array.from({ length: 200 }, rng(hash32("purpleheartlane")));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, Array.from({ length: 200 }, rng(hash32("carentan"))));
  for (const v of a) assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
});

test("grit stays inside the region the layout gave it", () => {
  // Blur, shadows and the bullets' contact shadow all reach past the shape that cast them; the clip
  // is what keeps a round from appearing halfway across a total.
  assertInside(inked((ctx) => bullets(ctx, ZONE, "seed", { count: 6, size: 24 })), ZONE, "bullets");
  assertInside(inked((ctx) => spatter(ctx, ZONE, "seed", { clusters: 3, scale: 1.6 })), ZONE, "spatter");
  assertInside(inked((ctx) => dirt(ctx, ZONE, "seed", { count: 20 })), ZONE, "dirt");
  assertInside(inked((ctx) => scuffs(ctx, ZONE, "seed", { count: 30 })), ZONE, "scuffs");
});

test("a round is drawn whole — no half a cartridge sliced off by the clip", () => {
  // Placement insets by the reach of the round's shadow, so a zone with room for one gets an
  // intact object: what it inks must sit clear of every edge rather than running into it.
  const zone: Rect = { x: 120, y: 90, w: 200, h: 110 };
  const box = inked((ctx) => bullets(ctx, zone, "tight", { count: 6, size: 20 }));
  assert.ok(box);
  assert.ok(box.x > zone.x && box.y > zone.y, "a round is flush against the top or left edge");
  assert.ok(box.x + box.w < zone.x + zone.w && box.y + box.h < zone.y + zone.h, "a round is flush against the bottom or right edge");
});

test("the same seed lays down the same grit, a different seed does not", () => {
  const draw = (seed: string) => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d");
    dirt(ctx, ZONE, seed, { count: 14 });
    bullets(ctx, ZONE, seed, { count: 4, size: 20 });
    spatter(ctx, ZONE, seed, { clusters: 2 });
    return canvas.toBuffer("image/png");
  };
  assert.ok(draw("stmereeglise").equals(draw("stmereeglise")));
  assert.ok(!draw("stmereeglise").equals(draw("carentan")));
});
