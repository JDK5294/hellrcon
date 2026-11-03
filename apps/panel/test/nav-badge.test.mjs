// The sidebar's unread-announcements count must read as an alert — measured against the REAL
// built stylesheet, in both themes and in both sidebar states.
//
// This exists because the badge went quiet without anyone touching it. It was painted with
// `--accent`, and `--accent` is a user preference: the slate-accent change swapped the default
// from a saturated blue to slate-500, and the badge became the same grey family as the muted
// label beside it. Nothing about announcements changed, no test failed, and the only signal that
// a staff member had unread notices stopped looking like a signal.
//
// So the rule this pins is not "the badge is red". It is "the badge does not inherit a token the
// user can turn down": it must stay clearly distinct from the sidebar surface AND from the muted
// text it sits next to, whatever the appearance settings say.
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

/** The sidebar entry exactly as app/page.tsx emits it when there are unread announcements. */
const NAV_HTML = `
  <div class="sidebar">
    <nav>
      <div class="nav-entry">
        <button class="nav-item">
          <span class="ico">C</span>
          <span class="nav-label">Community</span>
          <span class="nav-count" aria-label="3 new announcements">3</span>
        </button>
      </div>
    </nav>
  </div>`;

/** sRGB → relative luminance, then the WCAG contrast ratio. */
function contrast(a, b) {
  const lum = ([r, g, b2]) => {
    const f = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/**
 * How far from grey a colour is, 0..1.
 *
 * Contrast ratio is luminance only, so it cannot tell red from grey at the same brightness — and
 * "another grey chip" was precisely the bug. Chroma can: the slate that shipped sits at 0.15,
 * every status token clears 0.4.
 */
const chroma = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);

async function inspect() {
  const { chromium } = await import("playwright-core");
  const sheets = await Promise.all(
    readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).map((f) => readFile(join(CSS_DIR, f), "utf8")),
  );
  assert.ok(sheets.length > 0, "built stylesheet found in out/");

  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const out = {};
    for (const theme of ["dark", "light"]) {
      for (const collapsed of [false, true]) {
        await page.setContent(
          `<style>${sheets.join("\n")}</style>` +
          `<div class="app-shell${collapsed ? " collapsed" : ""}">${NAV_HTML}</div>`,
        );
        await page.evaluate((t) => window.document.documentElement.setAttribute("data-theme", t), theme);
        out[`${theme}${collapsed ? "-rail" : ""}`] = await page.evaluate(() => {
          const badge = window.document.querySelector(".nav-count");
          const item = window.document.querySelector(".nav-item");
          const bar = window.document.querySelector(".sidebar");
          const label = window.document.querySelector(".nav-label");
          const cs = window.getComputedStyle(badge);
          const b = badge.getBoundingClientRect();
          const i = item.getBoundingClientRect();
          return {
            bg: cs.backgroundColor,
            fg: cs.color,
            surface: window.getComputedStyle(bar).backgroundColor,
            muted: window.getComputedStyle(label).color,
            visible: b.width > 0 && b.height > 0,
            // Inside the button, not spilling out of it — the rail case moved it to a corner.
            within: b.left >= i.left - 0.5 && b.right <= i.right + 0.5 && b.top >= i.top - 0.5 && b.bottom <= i.bottom + 0.5,
          };
        });
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}

test("the unread badge stands out from the sidebar in both themes", { skip: SKIP }, async () => {
  const seen = await inspect();
  for (const [where, m] of Object.entries(seen)) {
    assert.ok(m.visible, `${where}: the badge did not render at all`);
    // Against the sidebar it sits on. Slate-on-slate measured ~1.5; a real alert clears 3.
    const vsSurface = contrast(rgb(m.bg), rgb(m.surface));
    assert.ok(vsSurface >= 2.5, `${where}: badge ${m.bg} is only ${vsSurface.toFixed(2)}:1 against the sidebar ${m.surface} — it will not read as an alert`);
    // And it has to be a COLOUR, not another grey. The badge that shipped was slate at 0.15
    // chroma sitting beside slate-grey muted text — legible, and completely unremarkable.
    const c = chroma(rgb(m.bg));
    assert.ok(c >= 0.35, `${where}: badge ${m.bg} has chroma ${c.toFixed(2)} — that is a grey chip, not an alert`);
    assert.ok(c > chroma(rgb(m.muted)) * 2, `${where}: badge ${m.bg} is no more saturated than the muted label ${m.muted} beside it`);
    // The number itself has to be legible on the badge.
    const text = contrast(rgb(m.fg), rgb(m.bg));
    assert.ok(text >= 3, `${where}: the count ${m.fg} is only ${text.toFixed(2)}:1 on ${m.bg}`);
  }
});

test("the unread badge survives an accent the user has turned all the way down", { skip: SKIP }, async () => {
  // The whole point: appearance settings recolour the app through --accent, and a notification
  // must not be one of the things they can switch off. Pin the accent to the sidebar's own
  // surface — the most hostile setting available — and the badge must still be visible.
  const { chromium } = await import("playwright-core");
  const sheets = await Promise.all(
    readdirSync(CSS_DIR).filter((f) => f.endsWith(".css")).map((f) => readFile(join(CSS_DIR, f), "utf8")),
  );
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${sheets.join("\n")}</style><div class="app-shell">${NAV_HTML}</div>`);
    const m = await page.evaluate(() => {
      const root = window.document.documentElement;
      root.setAttribute("data-theme", "dark");
      // The sidebar surface, chosen as an accent — the badge would vanish entirely if it followed.
      root.style.setProperty("--accent", "#12151c");
      const badge = window.document.querySelector(".nav-count");
      return {
        bg: window.getComputedStyle(badge).backgroundColor,
        surface: window.getComputedStyle(window.document.querySelector(".sidebar")).backgroundColor,
      };
    });
    const ratio = contrast(rgb(m.bg), rgb(m.surface));
    assert.ok(ratio >= 2.5, `a custom accent drained the unread badge: ${m.bg} on ${m.surface} is ${ratio.toFixed(2)}:1`);
    assert.ok(chroma(rgb(m.bg)) >= 0.35, `a custom accent greyed the unread badge out: ${m.bg}`);
  } finally {
    await browser.close();
  }
});

test("collapsed to a rail, the badge stays on the icon instead of widening the row", { skip: SKIP }, async () => {
  const seen = await inspect();
  for (const where of ["dark-rail", "light-rail"]) {
    assert.ok(seen[where].within, `${where}: the badge escaped the nav item's box`);
  }
});
