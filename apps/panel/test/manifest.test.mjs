// The panel as a home-screen app (app/manifest.ts). Phones kept an installed panel upright: the
// panel never locks orientation, but nothing told the phone it may turn either. The manifest says
// it works both ways — and belongs to the panel only: a player saving the public stats page must
// keep that page, not get the staff sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
const SKIP = existsSync(join(OUT, "index.html")) ? false : "panel not built (out/ missing)";
const linksManifest = (page) => /<link[^>]*rel="manifest"[^>]*href="\/manifest\.webmanifest"/.test(readFileSync(join(OUT, page), "utf8"));

test("the installed panel may turn with the phone, full screen, starting at the panel", { skip: SKIP }, () => {
  const manifest = JSON.parse(readFileSync(join(OUT, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.orientation, "any", "both ways — the phone's own rotation lock decides");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(linksManifest("index.html"), "the panel's page points the phone at it");
});

test("the public stats page carries no manifest of the panel's", { skip: SKIP }, () => {
  assert.equal(linksManifest(join("stats", "index.html")), false, "a saved stats page must not open the staff sign-in");
});

// …but a manifest of its own, which the API serves (its start and scope depend on the hostname it
// is opened on). Without one a phone kept a saved stats page upright, as it once kept the panel.
test("the public stats page links its own manifest, the one that lets it turn with the phone", { skip: SKIP }, () => {
  const html = readFileSync(join(OUT, "stats", "index.html"), "utf8");
  assert.ok(/<link[^>]*rel="manifest"[^>]*href="\/api\/public\/webmanifest"/.test(html), "the stats site's own manifest");
});

/** [width, height] from a PNG's header, failing if the file is not a PNG at all. */
const pngSize = (rel) => {
  const b = readFileSync(join(OUT, rel.replace(/^\//, "")));
  assert.equal(b.toString("latin1", 1, 4), "PNG", `${rel} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

// Chrome (and Samsung Internet) install a site as an app only with icons of 192 and 512 px; with
// none, "Add to home screen" made a plain shortcut that opens in a browser tab.
test("the manifest has the icons Chrome installs an app from, each the size it claims", { skip: SKIP }, () => {
  const icons = JSON.parse(readFileSync(join(OUT, "manifest.webmanifest"), "utf8")).icons ?? [];
  const has = (px, purpose) => icons.some((i) => i.sizes === `${px}x${px}` && (i.purpose ?? "any").split(" ").includes(purpose));
  assert.ok(has(192, "any") && has(512, "any"), `a 192 and a 512 px icon: ${JSON.stringify(icons)}`);
  assert.ok(has(512, "maskable"), "and a maskable one, for launchers that crop icons to their own shape");
  for (const i of icons) {
    assert.equal(i.type, "image/png", `${i.src} says PNG`);
    assert.equal(pngSize(i.src).join("x"), i.sizes, `${i.src} is the size the manifest says`);
  }
});

test("an iPhone gets the panel's icon, and the public stats page gets none", { skip: SKIP }, () => {
  const tag = readFileSync(join(OUT, "index.html"), "utf8").match(/<link[^>]*rel="apple-touch-icon"[^>]*>/)?.[0];
  assert.ok(tag, "the panel names its home-screen icon");
  assert.deepEqual(pngSize(tag.match(/href="([^"]+)"/)[1]), [180, 180]);
  assert.ok(!/apple-touch-icon/.test(readFileSync(join(OUT, "stats", "index.html"), "utf8")), "a player saving the stats page gets no admin mark");
});

// The icons wore one community's badge, and the match board carried the same badge as a built-in
// file: every install shipped both. The icons are the program's own mark now (scripts/make-icons.mjs)
// and a community uploads its badge in the panel, so none of those pictures may ship again.
test("no community's badge ships with the panel, as its icons or anywhere else", { skip: SKIP }, () => {
  // The badge's files, by their SHA-256: the four icons drawn from it, and the badge itself.
  const BADGE = new Set([
    "b5feac8f5a83242e9abb37ab4df40bb37ce748b4849944705236fc1256749b9e",
    "1230bef3fb1a81300d15c482a93a3e5fb4765b6bd766b06e9a289ac625c7f48e",
    "0f7a316ee15ef57caeb19d5653290d362eef25fc38c5a7d7a5b63bd2047b4a76",
    "9096c7dfbb75ebe1ac5c6fd629da14e04f4e043851e1c6264e3ee64cd550d97f",
    "66c99cd24139d0aaa4103cd57baccd425e52dea597cb4ae8dd342695bfffb6c5",
  ]);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const images = walk(OUT).filter((f) => /\.(png|jpe?g|webp|gif|svg|ico)$/i.test(f));
  assert.ok(images.length > 4, "the walk found the shipped images");
  for (const f of images) {
    const sha = createHash("sha256").update(readFileSync(f)).digest("hex");
    assert.ok(!BADGE.has(sha), `${relative(OUT, f)} is the community's badge`);
  }
  assert.equal(existsSync(join(OUT, "brand")), false, "no brand folder: a community uploads its badge in the panel");
});

