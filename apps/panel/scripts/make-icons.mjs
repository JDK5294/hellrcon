/**
 * The installed app's icons: the brand mark (lib/brand.ts), the gradient square and white letter the
 * sidebar shows. They wore one community's badge once, which every install then carried; the
 * program's own mark is the only picture they take. Run it after changing the mark, and commit the
 * PNGs it writes to public/icons:
 *
 *   node --experimental-strip-types scripts/make-icons.mjs
 *
 * Chrome installs a site as an app (its own window, no browser bar) only when the manifest lists
 * icons of at least 192 and 512 px; anything less and "Add to home screen" makes a plain shortcut.
 * Android then crops the icon to the launcher's shape, which is what the full-bleed maskable one is
 * for, and an iPhone reads apple-touch-icon instead (it rounds the corners itself and shows
 * transparency as black, so that one is full-bleed too).
 *
 * Drawn on a canvas in Chromium (playwright-core is already here for the browser tests): the letter
 * in a real bold sans, centred on its ink, not on its line box. Chromium's own PNG is then re-packed (squeeze below): it compresses for speed, and a 512 px
 * gradient came out at a quarter of a megabyte where it needs thirty kilobytes.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { BRAND_MARK } from "../lib/brand.ts";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const OUT = join(PUBLIC, "icons");
/** The theme's default accent pair (globals.css --accent, --accent-2), the mark's 135° gradient. */
const FROM = "#64748b";
const TO = "#475569";
/**
 * Per file: its size; whether it is opaque (full-bleed) or keeps its own shape on transparency; and
 * the brand letter's ink height, as a fraction of the side. The maskable one keeps its letter inside
 * the middle 80%, all a launcher is sure to show; the transparent ones are the sidebar mark's
 * rounded square (8px corners on 28px).
 */
const ICONS = [
  { file: "icon-192.png", size: 192, opaque: false, cap: 0.42 },
  { file: "icon-512.png", size: 512, opaque: false, cap: 0.42 },
  { file: "icon-maskable-512.png", size: 512, opaque: true, cap: 0.34 },
  { file: "apple-touch-icon.png", size: 180, opaque: true, cap: 0.42 },
];

/** The PNG filter predictor for byte x of a row: a = left, b = above, c = above-left. */
function predict(f, a, b, c) {
  if (f === 1) return a;
  if (f === 2) return b;
  if (f === 3) return (a + b) >> 1;
  if (f === 4) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  return 0;
}

/**
 * Re-pack Chromium's 8-bit RGBA PNG: unfilter its rows, keep alpha only where there are corners to
 * see through, pick each row's filter by the smallest residuals, and deflate at the top level.
 */
function squeeze(png, keepAlpha) {
  let at = 8, w = 0, h = 0;
  const idat = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8), data = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("expected 8-bit RGBA, not interlaced"); }
    if (type === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0, i = 0; y < h; y++) {
    const f = raw[i++];
    for (let x = 0; x < w * 4; x++, i++) {
      const o = (y * w * 4) + x;
      rgba[o] = (raw[i] + predict(f, x >= 4 ? rgba[o - 4] : 0, y ? rgba[o - w * 4] : 0, x >= 4 && y ? rgba[o - w * 4 - 4] : 0)) & 255;
    }
  }
  const bpp = keepAlpha ? 4 : 3, stride = w * bpp;
  const px = Buffer.alloc(stride * h);
  for (let i = 0; i < w * h; i++) rgba.copy(px, i * bpp, i * 4, i * 4 + bpp);
  const rows = [];
  for (let y = 0; y < h; y++) {
    let best = null, bestCost = Infinity;
    for (let f = 0; f <= 4; f++) {
      const row = Buffer.alloc(stride + 1);
      row[0] = f;
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const o = y * stride + x;
        const v = (px[o] - predict(f, x >= bpp ? px[o - bpp] : 0, y ? px[o - stride] : 0, x >= bpp && y ? px[o - stride - bpp] : 0)) & 255;
        row[x + 1] = v;
        cost += v < 128 ? v : 256 - v;
      }
      if (cost < bestCost) { bestCost = cost; best = row; }
    }
    rows.push(best);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = keepAlpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const executablePath = [process.env.CHROMIUM, "/opt/pw-browsers/chromium"].find((p) => p && existsSync(p));
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  mkdirSync(OUT, { recursive: true });
  for (const icon of ICONS) {
    const png = await page.evaluate(async ({ size, opaque, cap, letter, from, to }) => {
      const canvas = window.document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext("2d");
      const grad = g.createLinearGradient(0, 0, size, size);
      grad.addColorStop(0, from);
      grad.addColorStop(1, to);
      g.fillStyle = grad;
      g.beginPath();
      g.roundRect(0, 0, size, size, opaque ? 0 : (8 / 28) * size);
      g.fill();
      // Scale the letter so its ink is `cap` of the size, then centre that ink.
      const font = (px) => `800 ${px}px "Segoe UI", Roboto, "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif`;
      g.font = font(100);
      const probe = g.measureText(letter);
      g.font = font((100 * cap * size) / (probe.actualBoundingBoxAscent + probe.actualBoundingBoxDescent));
      const m = g.measureText(letter);
      const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
      const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
      g.fillStyle = "#fff";
      g.fillText(letter, (size - w) / 2 + m.actualBoundingBoxLeft, (size - h) / 2 + m.actualBoundingBoxAscent);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { ...icon, letter: BRAND_MARK, from: FROM, to: TO });
    const bytes = squeeze(Buffer.from(png, "base64"), !icon.opaque);
    writeFileSync(join(OUT, icon.file), bytes);
    console.log(`wrote public/icons/${icon.file} (${icon.size}×${icon.size}, ${Math.round(bytes.length / 1024)} KB)`);
  }
} finally {
  await browser.close();
}
