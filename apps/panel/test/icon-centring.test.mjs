// Icon buttons must centre their glyph — measured against the REAL built stylesheet.
//
// This test exists because the ⋯ overflow button shipped off-centre twice. The first fix replaced
// the glyph (a font-metrics theory); the second was "verified" against a hand-written copy of the
// CSS, which silently omitted the rule that actually caused it. The bug lives in the cascade, not
// in any one rule, so nothing short of the compiled stylesheet can see it:
//
//   `button { padding: 8px 14px }` in globals.css applies to EVERY button. A fixed-size icon box
//   that forgets `padding: 0` gets a content box smaller than its own glyph, and a grid row track
//   starts at the content box's top edge and overflows the bottom — so `place-items: center`
//   centres the glyph in the track, and the track itself sits high. The glyph rides ~3px low.
//
// So: load out/'s stylesheet verbatim, render the exact markup the components emit, and compare
// the glyph's centre to the button's. Copying CSS into this file would defeat the entire point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CSS_DIR = join(here, "..", "out", "_next", "static", "css");
const CHROMIUM = [process.env.CHROMIUM, "/opt/pw-browsers/chromium", process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium")]
  .filter(Boolean)
  .find((p) => existsSync(p));
const SKIP = !CHROMIUM
  ? "no Chromium binary (set CHROMIUM=/path/to/chromium)"
  : !existsSync(CSS_DIR)
    ? "panel not built (out/ missing)"
    : false;

/** The overflow glyph, byte-identical to `DOTS` in components/PlayerActions.tsx. */
const DOTS = `<svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="currentColor" aria-hidden>
  <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
</svg>`;

// Every fixed-size icon control a player row or profile can render, as its component emits it.
// `geometric` marks the ones whose glyph is an SVG, so its box is exact and its centre can be
// measured outright. A text glyph's rect is font metrics — ascent and descent are not symmetric,
// so measuring one would assert about the font, not about the layout. Those cases are still held
// to the padding rule, which is the thing that actually goes wrong.
const CASES = [
  { name: "⋯ overflow button (row)", geometric: true, html: `<button type="button" class="ico-btn">${DOTS}</button>` },
  { name: "⋯ overflow button (profile)", geometric: true, html: `<button type="button" class="ico-btn pa-more">${DOTS}</button>` },
  { name: "watchlist toggle", html: `<button type="button" class="ico-btn">👁</button>` },
  { name: "VIP marker", html: `<span class="ico-btn vip on">★</span>` },
  { name: "status chip (button)", html: `<button type="button" class="status-chip">💬</button>` },
  { name: "status chip (static)", html: `<span class="status-chip">★</span>` },
  { name: "server badge", html: `<button type="button" class="server-badge on">2</button>` },
  { name: "server number", html: `<span class="ss-icon ss-no">2</span>` },
];

async function measure() {
  const { chromium } = await import("playwright-core");
  const sheets = await Promise.all(
    readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).map((f) => readFile(join(CSS_DIR, f), "utf8")),
  );
  assert.ok(sheets.length > 0, "built stylesheet found in out/");

  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<style>${sheets.join("\n")}</style>` +
        // `.player-actions` is the real parent; the wrappers keep each case on its own line so the
        // measurements can't interfere with one another.
        CASES.map((c, i) => `<div class="player-actions" data-case="${i}">${c.html}</div>`).join("<hr>"),
    );
    return await page.evaluate(() =>
      [...window.document.querySelectorAll("[data-case]")].map((wrap) => {
        const box = wrap.firstElementChild;
        const glyph = box.firstElementChild;
        const b = box.getBoundingClientRect();
        const g = glyph?.getBoundingClientRect();
        const style = window.getComputedStyle(box);
        return {
          dy: g ? g.top + g.height / 2 - (b.top + b.height / 2) : null,
          dx: g ? g.left + g.width / 2 - (b.left + b.width / 2) : null,
          glyphHeight: g?.height ?? null,
          width: b.width,
          height: b.height,
          padding: style.padding,
          contentHeight: box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        };
      }),
    );
  } finally {
    await browser.close();
  }
}

test("icon buttons centre their glyph against the real built CSS", { skip: SKIP }, async () => {
  const seen = await measure();
  const geometric = seen.filter((_, i) => CASES[i].geometric);
  assert.ok(geometric.length > 0, "at least one SVG-glyph case to measure");
  for (const [i, m] of seen.entries()) {
    if (!CASES[i].geometric) continue;
    const who = CASES[i].name;
    // Half a pixel is the most a correctly-centred box can be off by, from rounding an odd
    // leftover. The bug this guards against was 3.27px, so the threshold has room to spare.
    assert.ok(Math.abs(m.dy) <= 0.5, `${who}: glyph sits ${m.dy.toFixed(2)}px off the vertical centre (${JSON.stringify(m)})`);
    assert.ok(Math.abs(m.dx) <= 0.5, `${who}: glyph sits ${m.dx.toFixed(2)}px off the horizontal centre (${JSON.stringify(m)})`);
    assert.ok(
      m.contentHeight >= m.glyphHeight,
      `${who}: content box is ${m.contentHeight}px but the glyph is ${m.glyphHeight}px — the grid track will overflow downward`,
    );
  }
});

test("fixed-size icon boxes reset the global button padding", { skip: SKIP }, async () => {
  // The centring assertion above is the symptom; this is the cause, named — and it covers the
  // text-glyph boxes too, which are just as exposed but can't be measured against a font.
  const seen = await measure();
  for (const [i, m] of seen.entries()) {
    assert.equal(m.padding, "0px", `${CASES[i].name}: inherits the global button padding (${m.padding})`);
  }
});
