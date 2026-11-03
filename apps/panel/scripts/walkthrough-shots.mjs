/**
 * The pictures in Help's walkthroughs (lib/walkthroughs): each step photographed on the real panel,
 * as someone holding just that walkthrough's permissions, with where the ring goes recorded beside
 * it — once on a computer's screen and once on a phone's, where the panel is laid out differently
 * and Help shows the phone's. Run it after building the panel whenever a walkthrough or a screen it
 * shows changes, and commit what it writes — public/walkthroughs/ and lib/walkthroughShots*.json:
 *
 *   pnpm --filter @app/panel build
 *   node --experimental-strip-types scripts/walkthrough-shots.mjs          # the pictures missing
 *   node --experimental-strip-types scripts/walkthrough-shots.mjs --all    # every picture again
 *
 * `--pc` or `--phone` takes just that screen's pictures.
 *
 * A picture already taken is kept unless --all is given: a screen's clock or a count changes the
 * bytes of every picture each run, and a pile of pictures that look the same is not worth a commit.
 * After changing a screen a walkthrough shows, take them all again.
 *
 * It stops, naming the step, when a step's control is not on its screen — the same check the
 * browser test makes (test/walk-stage.mjs sets each step up for both). Steps that show the same
 * thing share a picture (lib/walkthroughs stageKey), and a picture no step shows any more is
 * deleted, so the folders hold exactly what Help can show.
 *
 * WebP through Chromium's own encoder (a canvas), as playwright-core is already here for the
 * browser tests: a screen of text comes out at a fraction of the PNG's size.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startStub } from "../test/stub-api.mjs";
import { PC_SCREEN, PHONE_SCREEN, WALK_FIXTURES, bringIntoView, setStage, stageStep, visibleBox, walkGrants } from "../test/walk-stage.mjs";
import { WALKTHROUGHS, onPhone, stageKey } from "../lib/walkthroughs.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROMIUM = [process.env.CHROMIUM, "/opt/pw-browsers/chromium"].find((p) => p && existsSync(p));
/** The ring stands this far off the control, as the live spotlight's does. */
const PAD = 4;

/**
 * Each screen the pictures are taken on: the window, and the picture — this much around the
 * control, more when the control is bigger. A phone's picture is as wide as the phone, drawn at
 * twice the pixels so its words stay sharp on a phone's screen.
 */
const SCREENS = {
  pc: {
    context: PC_SCREEN, frame: { width: 960, height: 540 }, quality: 0.82,
    images: join(HERE, "..", "public", "walkthroughs"),
    manifest: join(HERE, "..", "lib", "walkthroughShots.json"),
    step: (s) => s,
  },
  phone: {
    context: PHONE_SCREEN, frame: { width: 390, height: 560 }, quality: 0.8,
    images: join(HERE, "..", "public", "walkthroughs", "phone"),
    manifest: join(HERE, "..", "lib", "walkthroughShotsPhone.json"),
    step: onPhone,
  },
};

if (!existsSync(join(HERE, "..", "out", "index.html"))) throw new Error("build the panel first: out/ is missing");

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
const encoder = await browser.newPage();
/** PNG bytes → WebP bytes, drawn through a canvas. */
async function webp(png, quality) {
  const url = await encoder.evaluate(async ([b64, q]) => {
    const img = new window.Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = window.document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", q);
  }, [png.toString("base64"), quality]);
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

/** A frame around the box, the box centred where the window allows, inside the window. */
function frameAround(box, view, frame) {
  const width = Math.min(view.width, Math.max(frame.width, Math.ceil(box.width) + 120));
  const height = Math.min(view.height, Math.max(frame.height, Math.ceil(box.height) + 120));
  const clamp = (v, size, max) => Math.max(0, Math.min(max - size, Math.round(v)));
  return {
    x: clamp(box.x + box.width / 2 - width / 2, width, view.width),
    y: clamp(box.y + box.height / 2 - height / 2, height, view.height),
    width, height,
  };
}

/** The ring around the box, kept inside the picture: a table wider than a phone is ringed to the
 *  picture's edges, not off them. */
function ringIn(box, clip) {
  const x0 = Math.max(0, box.x - clip.x - PAD), y0 = Math.max(0, box.y - clip.y - PAD);
  const x1 = Math.min(clip.width, box.x - clip.x + box.width + PAD), y1 = Math.min(clip.height, box.y - clip.y + box.height + PAD);
  return [x0, y0, x1 - x0, y1 - y0].map((v) => Math.round(v));
}

const ALL = process.argv.includes("--all");
const only = ["pc", "phone"].filter((s) => process.argv.includes(`--${s}`));
const failures = [];
/** What each screen's folder and list are to hold. */
const taken = [];
for (const [name, screen] of Object.entries(SCREENS)) {
  if (only.length && !only.includes(name)) continue;
  mkdirSync(screen.images, { recursive: true });
  const before = existsSync(screen.manifest) ? JSON.parse(readFileSync(screen.manifest, "utf8")) : {};
  const shots = {};
  taken.push({ name, screen, shots });
  let visit = 0;
  for (const walk of WALKTHROUGHS) {
    // The stage's records, and for a step about another state (its `stage`), that state's.
    const grants = walkGrants(walk);
    const overrides = { ...WALK_FIXTURES };
    const stub = await startStub({ grants, overrides });
    const context = await browser.newContext({ ...screen.context, colorScheme: "dark", reducedMotion: "reduce" });
    await context.addInitScript(() => window.localStorage.setItem("panel.token", "walkthrough"));
    const page = await context.newPage();
    try {
      for (const [n, step] of walk.steps.entries()) {
        // A step in Discord has no picture: Help draws the panel it is in, for whoever follows it.
        if (step.discord) continue;
        const key = stageKey(screen.step(step));
        if (shots[key]) continue;
        if (!ALL && before[key] && existsSync(join(screen.images, `${key}.webp`))) { shots[key] = before[key]; continue; }
        setStage(overrides, step, grants);
        const { el, why, menu } = await stageStep(page, stub.base, step, ++visit, { phone: name === "phone" });
        if (!el) { failures.push(`${name}: ${walk.id} step ${n + 1}: ${why}`); continue; }
        // In the middle of the window where it can be: a control at the window's edge would sit at
        // the edge of its picture. One too tall for that has its top in view, title and all, as the
        // spotlight shows it. What floats (a dialog, an open menu) stays where it is — but a control
        // below the fold of its own box (a tall dialog, a table wider than it) is scrolled into it.
        const fixed = await el.evaluate((e) => {
          for (let n = e; n; n = n.parentElement) if (window.getComputedStyle(n).position === "fixed") return true;
          return false;
        });
        if (!fixed) await bringIntoView(el);
        else await el.evaluate((e) => e.scrollIntoView({ block: "nearest", inline: "nearest" }));
        // A settled screen: fonts in, and nothing still fading in from the menu just opened.
        await page.evaluate(() => window.document.fonts.ready);
        await page.waitForTimeout(250);
        // Ringed where it can be seen: a table scrolled inside its panel, where it shows.
        const box = await visibleBox(el);
        if (!box) { failures.push(`${name}: ${walk.id} step ${n + 1}: the control has no size`); continue; }
        const clip = frameAround(box, screen.context.viewport, screen.frame);
        const bytes = await webp(await page.screenshot({ clip, type: "png" }), screen.quality);
        writeFileSync(join(screen.images, `${key}.webp`), bytes);
        shots[key] = {
          w: clip.width, h: clip.height, ring: ringIn(box, clip), v: createHash("sha1").update(bytes).digest("hex").slice(0, 8),
          // Ringed in the menu: the slideshow says to open it with ☰ first.
          ...(menu ? { menu: true } : {}),
        };
        console.log(`${name} ${walk.id} ${n + 1}  ${key}.webp  ${Math.round(bytes.length / 1024)} KiB`);
      }
    } finally {
      await context.close();
      await stub.close();
    }
  }
}
await browser.close();

for (const { name, screen, shots } of taken) {
  // Exactly what Help can show: a picture no step uses any more goes — once every step has its
  // picture. Until then what was taken is listed and kept, so the next run takes only the rest.
  if (!failures.length) {
    for (const f of readdirSync(screen.images)) {
      if (statSync(join(screen.images, f)).isDirectory()) continue;
      if (!shots[f.replace(/\.webp$/, "")]) { rmSync(join(screen.images, f)); console.log(`${name}: removed ${f}`); }
    }
  }
  const sorted = Object.fromEntries(Object.keys(shots).sort().map((k) => [k, shots[k]]));
  writeFileSync(screen.manifest, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`\n${name}: ${Object.keys(shots).length} pictures for ${WALKTHROUGHS.length} walkthroughs`);
}
if (failures.length) {
  console.error(`\n${failures.length} step(s) could not be photographed — their control is not on the screen:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
