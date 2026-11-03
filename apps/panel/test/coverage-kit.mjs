/**
 * Walkthrough coverage, read off the real panel.
 *
 * Help promises a walkthrough for everything the panel lets someone do, and three browser tests hold
 * it to that (e2e-1, e2e-2, e2e-3). Every control — on every screen with its folded panels opened, in
 * the menu around them, in every dialog a button or a menu opens, and in what a choice brings out (a
 * trigger's own settings, an editor opened in the page) — must be ringed by a step, be of a kind one
 * walkthrough explains for every screen, or, for a setting, be named by a step about its panel or
 * dialog (`fields`, whose words say what it does).
 *
 * What they find uncovered is compared with KNOWN_GAPS: what is still to be written, so a gap filled
 * has to come off the list and a new one fails at once.
 */
import { writeFileSync } from "node:fs";
import { findWalkTarget } from "../lib/walkTarget.ts";
import { WALKTHROUGHS } from "../lib/walkthroughs.ts";
import { ROUTES } from "../lib/routes.ts";

const FIND = findWalkTarget.toString();
export const ALL_STEPS = WALKTHROUGHS.flatMap((w) => w.steps);
const ROUTE_IDS = new Set(ROUTES.map((r) => r.id));
/** The steps on these screens, by route id. A route the panel has not would find none, and leave its
 *  screen unexplained without a word, so it is refused. */
export const stepsOn = (routes) => {
  for (const r of routes) if (!ROUTE_IDS.has(r)) throw new Error(`no route "${r}"`);
  return ALL_STEPS.filter((s) => routes.includes(s.route));
};
const TITLES = [...new Set(ROUTES.map((r) => r.title.toLowerCase()))];
const TABS = [...new Set(ALL_STEPS.flatMap((s) => [s.target.tab, ...(s.before ?? []).map((a) => a.click?.tab)]).filter(Boolean))];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every folded panel on the screen opened, so what is inside it is seen. */
export async function unfold(page) {
  for (let i = 0; i < 3; i++) {
    const n = await page.evaluate(() => {
      const toggles = [...window.document.querySelectorAll(".panel.is-collapsed .panel-toggle")];
      toggles.forEach((t) => t.click());
      return toggles.length;
    });
    if (!n) break;
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(150);
  }
}

/**
 * What steps cover. `targets`: what they ring (a panel or a dialog alone rings nothing in it). `named`:
 * the settings each names, and where — its panel, its dialog, or what it rings.
 */
export function coverageOf(steps) {
  const targets = steps.flatMap((s) => [s.target, s.phone?.target, ...(s.before ?? []).map((a) => a.click ?? a.fill), ...(s.setup ?? [])])
    .filter(Boolean)
    .filter((t) => (!t.panel && !t.dialog) || t.button || t.field || t.setting || t.css || t.tab || t.nav);
  const areaOf = (t) => (t.panel ? { panel: t.panel, ...(t.dialog ? { dialog: true } : {}) } : t.dialog ? { dialog: true } : t);
  // Settings a step names in a dialog are named for that dialog alone, by what opens it
  // (namedForDialog): "the dialog on top" would name them in every dialog with a box of that name.
  const named = steps.filter((s) => s.fields?.length && !(s.target.dialog && !s.target.panel)).map((s) => ({ area: areaOf(s.target), fields: s.fields }));
  return { targets, named };
}

/** Whether a step's target names what `opener` names: the same, or a button by the start of its words. */
const names = (t, opener) => same(t, opener) || Boolean(t.button && opener.button && (t.panel ?? null) === (opener.panel ?? null)
  && (opener.button.startsWith(t.button) || t.button.startsWith(opener.button)));

/** The settings named for a whole dialog: by a step ringing what opens it, or opening it first. */
export function namedForDialog(steps, opener) {
  return steps.filter((s) => s.fields?.length && (names(s.target, opener) || (s.before ?? []).some((a) => a.click && names(a.click, opener))))
    .flatMap((s) => s.fields);
}

/** The settings named for every Download dialog: by the step that explains Download for every screen. */
export const namedForDownload = () => ALL_STEPS.filter((s) => s.fields?.length && /^Download\b/.test(s.target.button ?? "")).flatMap((s) => s.fields);

/** Press what a target names, as a person would; false when it is not on the screen. */
export async function press(page, target) {
  const el = (await page.evaluateHandle(([src, t]) => new Function(`return ${src}`)()(t), [FIND, target])).asElement();
  if (!el) return false;
  await el.click();
  return true;
}

/** Whether some step rings what `target` names — the way into what it opens is taught. */
export function ringed(page, steps, target) {
  return page.evaluate(([src, targets, t]) => {
    const find = new Function(`return ${src}`)();
    // What a target rings: every match ("a row's ⋯" is any row's), or the one its nth names.
    const all = (x) => (x.nth === undefined ? find(x, true) : [find(x)].filter(Boolean));
    // A ring around more than three controls (a whole table, a form) teaches none of them by
    // standing around them, as in uncovered.
    const many = (h) => new Set([...h.querySelectorAll('button, a[href], [role="button"], input:not([type="hidden"]), select, textarea')]
      .filter((x) => x.getClientRects().length > 0).map((x) => (x.textContent ?? "").replace(/\s+/g, " ").trim() || x.getAttribute("aria-label") || x.tagName)).size > 3;
    const el = find(t);
    if (!el) return false;
    return targets.some((x) => { try { return all(x).some((h) => h === el || (h.contains(el) && !many(h)) || el.contains(h)); } catch { return false; } });
  }, [FIND, coverageOf(steps).targets, target]);
}

const MENU = '.pa-dropdown, [role="menu"]';
/** The items of the menu on top, by their words. */
export function menuItems(page) {
  return page.evaluate((sel) => {
    const menu = [...window.document.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0).pop();
    return menu ? [...menu.querySelectorAll('button, a[href], [role="menuitem"]')].filter((el) => el.getClientRects().length > 0 && !el.disabled)
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()) : [];
  }, MENU);
}

/** Press the item of the menu on top with these words. */
export async function pressItem(page, item) {
  const el = (await page.evaluateHandle(([sel, item]) => {
    const menu = [...window.document.querySelectorAll(sel)].filter((m) => m.getClientRects().length > 0).pop();
    return menu && [...menu.querySelectorAll('button, a[href], [role="menuitem"]')].find((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim() === item);
  }, [MENU, item])).asElement();
  if (!el) return false;
  await el.click();
  return true;
}

const CHOICE = '[role="tab"], .seg-btn, label.toggle';
/** The choices of the dialog on top — its tabs, each button of a set of choices, each switch — by their words. */
export function dialogChoices(page) {
  return page.evaluate((sel) => {
    const d = [...window.document.querySelectorAll('[role="dialog"]')].filter((el) => el.getClientRects().length > 0).pop();
    return d ? [...d.querySelectorAll(sel)].filter((t) => t.getClientRects().length > 0).map((t) => (t.textContent ?? "").replace(/\s+/g, " ").trim()) : [];
  }, CHOICE);
}

/** Press the choice of the dialog on top with these words: a switch is turned the other way. */
export async function pressChoice(page, words) {
  const el = (await page.evaluateHandle(([sel, words]) => {
    const d = [...window.document.querySelectorAll('[role="dialog"]')].filter((x) => x.getClientRects().length > 0).pop();
    return d && [...d.querySelectorAll(sel)].find((t) => t.getClientRects().length > 0 && (t.textContent ?? "").replace(/\s+/g, " ").trim() === words);
  }, [CHOICE, words])).asElement();
  if (!el) return false;
  await el.click();
  await el.evaluate((x) => x.setAttribute("data-cover-pressed", ""));
  return true;
}

/**
 * The switches and sets of choices on a screen, outside any dialog or menu, by their words — what
 * each brings out is found by pressing it (pressScreenChoice): a switch's settings are left out
 * until it is on (SettingSwitch), and a choice can bring out its own.
 */
const SCREEN_CHOICE = "label.toggle, .seg-btn";
const OVER = '[role="dialog"], .pa-dropdown, [role="menu"]';
// One pressed or picked already (data-cover-pressed) is what is being looked behind, not another
// choice to make there.
export function screenChoices(page) {
  return page.evaluate(([sel, over]) => [...(window.document.querySelector("main") ?? window.document.body).querySelectorAll(sel)]
    .filter((el) => el.getClientRects().length > 0 && !el.closest(over) && !el.closest("[data-cover-pressed]") && !el.disabled && !el.querySelector("input:disabled"))
    .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()), [SCREEN_CHOICE, OVER]);
}

/** The lists on a screen, outside any dialog or menu — each by its name and its options' words. */
const LISTS = ([over]) => [...(window.document.querySelector("main") ?? window.document.body).querySelectorAll("select")]
  .filter((el) => el.getClientRects().length > 0 && !el.closest(over) && !el.closest("[data-cover-pressed]") && !el.disabled);
const LIST_NAME = (el) => {
  const words = (x) => (x?.textContent ?? "").replace(/\s+/g, " ").trim();
  const lab = el.closest("label");
  const copy = lab?.cloneNode(true);
  copy?.querySelectorAll("select, input, textarea, button, .hint").forEach((x) => x.remove());
  return words(copy) || el.getAttribute("aria-label") || el.title || "?";
};
export function screenLists(page) {
  return page.evaluate(([lists, name, over]) => new Function(`return ${lists}`)()([over])
    .map((el) => ({ name: new Function(`return ${name}`)()(el), options: [...el.options].filter((o) => !o.disabled).map((o) => (o.textContent ?? "").trim()) })),
  [LISTS.toString(), LIST_NAME.toString(), OVER]);
}

/**
 * Pick the option with these words in the nth of the screen's lists with this name, as a person
 * would, and return how to put the list back as it was. Null when the list is gone, or the option
 * is the one already picked, which picking would not change.
 */
export async function pickScreenOption(page, name, nth, words) {
  const handle = await page.evaluateHandle(([lists, nameOf, over, name, nth]) => new Function(`return ${lists}`)()([over])
    .filter((el) => new Function(`return ${nameOf}`)()(el) === name)[nth] ?? null, [LISTS.toString(), LIST_NAME.toString(), OVER, name, nth]);
  const el = handle.asElement?.();
  if (!el) return null;
  const set = (s, value) => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(s, value);
    s.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const was = await el.evaluate((s, [words, setSrc]) => {
    const option = [...s.options].find((o) => !o.disabled && (o.textContent ?? "").trim() === words);
    if (!option || option.selected) return null;
    const before = s.value;
    new Function(`return ${setSrc}`)()(s, option.value);
    s.setAttribute("data-cover-pressed", "");
    return before;
  }, [words, set.toString()]).catch(() => null);
  if (was === null) return null;
  return async () => {
    await el.evaluate((s, [was, setSrc]) => {
      s.removeAttribute("data-cover-pressed");
      if (s.isConnected && s.value !== was) new Function(`return ${setSrc}`)()(s, was);
    }, [was, set.toString()]).catch(() => {});
  };
}

/** Whether the screen crashed into its "could not be shown" card (components/ScreenBoundary). */
export function screenCrashed(page) {
  return page.getByText("This screen hit an error and could not be shown").count().then((n) => n > 0);
}

/**
 * Press the screen's nth choice with these words, and return how to put it back as it was: a switch
 * pressed again, or the choice of its set that was on before. Null when it is not on the screen, or
 * is the choice already on, which pressing would not change.
 */
export async function pressScreenChoice(page, words, nth) {
  const found = await page.evaluateHandle(([sel, over, words, nth]) => {
    const el = [...(window.document.querySelector("main") ?? window.document.body).querySelectorAll(sel)]
      .filter((x) => x.getClientRects().length > 0 && !x.closest(over) && !x.closest("[data-cover-pressed]") && !x.disabled && !x.querySelector("input:disabled")
        && (x.textContent ?? "").replace(/\s+/g, " ").trim() === words)[nth];
    // Gone as the screen redrew: an empty answer, not null, whose `el` cannot be read.
    if (!el) return { el: null, back: null };
    return { el, back: el.matches(".seg-btn") ? el.closest(".seg")?.querySelector(".seg-btn.active") ?? null : el };
  }, [SCREEN_CHOICE, OVER, words, nth]);
  const el = (await found.getProperty("el")).asElement?.();
  if (!el) return null;
  const back = (await found.getProperty("back")).asElement?.();
  if (back && await page.evaluate(([a, b]) => a === b && !a.matches("label.toggle"), [el, back])) return null;
  // One that cannot be pressed now (busy saving, or gone as the screen redraws) is passed over.
  if (!(await el.click({ timeout: 2000 }).then(() => true, () => false))) return null;
  await el.evaluate((x) => x.setAttribute("data-cover-pressed", "")).catch(() => {});
  return async () => {
    await el.evaluate((x) => x.removeAttribute("data-cover-pressed")).catch(() => {});
    if (!back) return;
    if (await page.evaluate((b) => b.isConnected, back)) await back.click({ timeout: 2000 }).catch(() => {});
  };
}

/** Do what brings a choice's settings out: `{ click: target }` presses it — once what it names is on
 *  the screen, as the step before may still be drawing it (a list read again, a dialog loading). */
export async function act(page, a) {
  await waitForTarget(page, a.click ?? a.fill);
  // A list is filled by picking the option with those words, as a step's `before` is (walk-stage).
  if (a.fill) {
    const el = (await page.evaluateHandle(([src, t]) => new Function(`return ${src}`)()(t), [FIND, a.fill])).asElement();
    if (!el) return false;
    const field = (await el.$("input, textarea, select")) ?? el;
    if (await field.evaluate((f) => f.tagName === "SELECT")) await field.selectOption({ label: a.value });
    else await field.fill(a.value);
    await page.waitForTimeout(200);
    return true;
  }
  const ok = await press(page, a.click);
  await page.waitForTimeout(200);
  return ok;
}

/** Wait for what a target names to be on the screen (a dialog loading, a menu sliding in); false
 *  when it never came. */
export function waitForTarget(page, target, timeout = 5000) {
  return page.waitForFunction(([src, t]) => Boolean(new Function(`return ${src}`)()(t)), [FIND, target], { timeout }).then(() => true, () => false);
}

/** Whether a dialog or a menu is open. */
export function overlayOpen(page) {
  return page.evaluate(() => [...window.document.querySelectorAll('[role="dialog"], .pa-dropdown, [role="menu"]')].some((el) => el.getClientRects().length > 0));
}

/** Whether a dialog is open. */
export function dialogOpen(page) {
  return page.evaluate(() => [...window.document.querySelectorAll('[role="dialog"]')].some((el) => el.getClientRects().length > 0));
}

/**
 * What in `scope` nothing covers, each said once as "where » what". `scope` is "main" (the screen),
 * "shell" (the menu and bars around it) or "dialog" (the dialog or menu on top). `reached`: a step
 * leads into this dialog, so what its foot asks — Save, Delete, Apply — is part of that step.
 */
export function uncovered(page, scope, cover, { help = false, dialogNamed = [], reached = false } = {}) {
  return page.evaluate(([src, scope, cover, tabs, titles, help, dialogNamed, reached]) => {
    const find = new Function(`return ${src}`)();
    const words = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const shown = (el) => el.getClientRects().length > 0 && window.getComputedStyle(el).visibility !== "hidden";
    // What a target rings: every match ("a row's ⋯" is any row's), or the one its nth names.
    const all = (t) => (t.nth === undefined ? find(t, true) : [find(t)].filter(Boolean));
    const hits = cover.targets.flatMap((t) => { try { return all(t); } catch { return []; } });
    const areas = cover.named.map((n) => ({ els: (() => { try { return all(n.area); } catch { return []; } })(), fields: n.fields }));
    const OPEN = '[role="dialog"], .pa-dropdown, [role="menu"]';
    const main = window.document.querySelector("main");
    let roots;
    if (scope === "dialog") roots = [...window.document.querySelectorAll(OPEN)].filter(shown).slice(-1);
    else if (scope === "shell") roots = [window.document.body];
    else roots = [main ?? window.document.body];
    const inShell = (el) => (!main || !main.contains(el)) && !el.closest(OPEN);
    const SEL = 'button, a[href], [role="button"], [role="tab"], [role="switch"], [role="menuitem"], summary, input:not([type="hidden"]), select, textarea';
    const groupOf = (el) => el.closest('.seg, [role="radiogroup"], [role="group"][aria-label], .swatches, .accent-swatches');
    // A setting's name: its card's title, the name its group carries, else its own label's words.
    const nameOf = (el, label) => {
      const title = el.closest(".setting-card")?.querySelector(".setting-title");
      if (title) return words(title);
      const g = groupOf(el);
      return (g && (g.getAttribute("aria-label") || words(g.querySelector("legend")))) || label;
    };
    // A label's own words: not the box's text, a list's options, a hint or the placeholders under it.
    const ownWords = (lab) => {
      const copy = lab.cloneNode(true);
      copy.querySelectorAll('input, select, textarea, button, details, .hint, [class*="hint"]').forEach((x) => x.remove());
      return words(copy);
    };
    const dialogOf = (el) => el.closest(OPEN);
    const labelOf = (el) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) || el.getAttribute("role") === "switch") {
        const lab = el.closest("label") || (el.id && window.document.querySelector(`label[for="${window.CSS.escape(el.id)}"]`));
        const t = lab ? ownWords(lab) : "";
        // In a table, a switch without words of its own is named by its column's heading.
        const td = el.closest("td");
        const head = td && td.closest("table")?.querySelector("thead tr")?.children[[...td.parentElement.children].indexOf(td)];
        return (t || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.title || words(head) || `?${el.name ?? ""}`).slice(0, 90);
      }
      return (words(el) || `[${el.getAttribute("aria-label") || el.title || ""}]`).slice(0, 70);
    };
    // A column's name, pressed to sort by it: a button in a header cell — not a box to tick or a
    // button with a name of its own (Live's tick-all, and the ⋯ of what to do to those ticked), nor
    // what a menu or a dialog drawn in the header holds.
    const columnName = (el, d) => {
      const th = el.closest("th");
      return Boolean(th) && (!d || d.contains(th)) && !["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && !el.getAttribute("aria-label");
    };
    const titleOf = (d) => (d ? (words(d.querySelector("h3, h2")) || d.getAttribute("aria-label") || "menu").slice(0, 60) : "");
    // Each control once: the key it is said by, and what explains it short of a step ringing it.
    const items = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll(SEL)) {
        if (!shown(el) || (scope === "shell" && !inShell(el))) continue;
        const label = labelOf(el);
        const part = el.closest('.panel, [role="region"][aria-label]');
        const panelTitle = part?.matches(".panel") ? part.querySelector(".panel-title") : null;
        const panel = panelTitle ? words(panelTitle) : part?.getAttribute("aria-label") ?? "";
        const d = dialogOf(el);
        // A row's control is one control on every row — but a dialog or menu opened from a row, and
        // drawn inside it (Live's roster holds its players' ⋯ and dialogs), is not the row's.
        const tr = el.closest("tr");
        const row = tr && (!d || d.contains(tr)) ? tr : null;
        const where = `${d ? `[${titleOf(d)}] ` : ""}${panel ? `${panel} » ` : ""}`;
        const field = ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) || el.getAttribute("role") === "switch" || el.hasAttribute("aria-pressed")
          || Boolean(groupOf(el)) || /^\d+[dhm]$/.test(label) || /^\+ \d/.test(label);
        // A set of choices that carries a name is one setting, said once by that name.
        const grouped = field && Boolean(groupOf(el)?.getAttribute("aria-label"));
        const key = `${where}${row ? `row ${[...row.children].findIndex((td) => td.contains(el))}:${el.tagName}.${typeof el.className === "string" ? el.className : ""}` : grouped ? nameOf(el, label) : label}`;
        // Explained once for every screen: a tab some step presses; folding a panel, Arrange panels,
        // Explanation; a column's name (columnName); a player's name; Download; a chart's keys;
        // ↑ ↓ ✕ arranging rows, copying an id, Refresh (or ↻), a placeholder or a saved preset under
        // a box; Clear filters under a list a filter emptied, and Try again under a read that
        // failed; a list's pages; a link to another screen; Help's own lists; Cancel and Close. A
        // row of chips is not among them: each is a setting or a filter of its own.
        const once = (help && !el.matches('[role="tab"]'))
          || (el.matches('[role="tab"]') && tabs.includes(label))
          || el.matches(".panel-toggle, .panel-toggle *") || /^⧉ Arrange panels/.test(label) || el.tagName === "SUMMARY"
          || columnName(el, d) || el.matches(".player-link, .player-link *") || /^Download\b/.test(label)
          || Boolean(el.closest(".viz-legend, .viz-legend-row, .pager, .preset-picker"))
          || /^All( \d+)?$/.test(label) || /^(Measured|Roles)\b.*[▾▴]$/.test(label)
          || /^[↑↓▲▼✕×]$/.test(label) || /⧉$/.test(label) || /^(↻ )?Refresh$|^↻$/.test(label) || /^\{[a-z_]+(:[^{}]+)?\}$/.test(label)
          || el.hasAttribute("data-goto") || (el.getAttribute("href") ?? "").startsWith("#/") || label.includes(" → ")
          || (!field && titles.includes(label.replace(/ ?[→›▸]$/, "").toLowerCase())) || label === "The full placeholder list"
          || /^(Cancel|Close|Clear filters|Try again)$/.test(label);
        // A dialog a step leads into: the buttons at its foot are what that step goes on to press.
        const foot = Boolean(d && reached && !field && el.closest(".pa-actions, .actions"));
        const name = field ? nameOf(el, label) : "";
        const isNamed = field && (
          (d && dialogNamed.some((f) => name.startsWith(f) || label.startsWith(f)))
          || areas.some((a) => a.els.some((x) => x.contains(el)) && a.fields.some((f) => name.startsWith(f) || label.startsWith(f))));
        // A choice once pressed is not said again in its new words — a switch says what it is set
        // to ("On", "Off"), and turned, it is the same switch — but still explains its set.
        const pressed = Boolean(el.closest("[data-cover-pressed]"));
        items.push({ el, d, key, once, foot, isNamed, pressed, said: `${where}${grouped ? name : `${field && name !== label ? `${name}: ` : ""}${label}`}` });
      }
    }
    // What a step rings covers what is inside it — but not a dialog opened over it (the roster's
    // table holds its players' dialogs, and ringing the table explains none of their settings), and
    // not when it rings more than three things to explain: a ring around a whole table or form
    // explains what its words say, and the rest are named in `fields` or rung on their own.
    const inside = new Map(hits.map((c) => [c, new Set(items.filter((it) => !it.once && it.el !== c && c.contains(it.el)).map((it) => it.key)).size]));
    const missing = new Map();
    const covered = new Set();
    for (const { el, d, key, once, foot, isNamed, pressed, said } of items) {
      // Explained once for every screen, it is not said, and it explains only itself: All, in a
      // named set of choices, does not explain the choices it lets go of.
      if (once) continue;
      const pointedAt = hits.some((c) => c === el || (inside.get(c) <= 3 && c.contains(el) && (!d || d.contains(c))) || (el.contains(c) && words(el).length < 80));
      if (pointedAt || foot || isNamed) covered.add(key);
      else if (!pressed && !missing.has(key)) missing.set(key, said);
    }
    return [...missing].filter(([k]) => !covered.has(k)).map(([, said]) => said);
  }, [FIND, scope, cover, TABS, TITLES, help, dialogNamed, reached]);
}

/**
 * A page about one thing, opened from a list, whose steps are those of the screens it is opened
 * from: a player's profile, and a watched player's; a staff member's; a round's.
 */
export const SUBJECT_PAGES = [
  ["/players/~p1", ["players.players", "live"]],
  ["/players/~p2", ["players.players", "live"]],
  ["/staff/~u2", ["admin.activity"]],
  ["/match/~m1", ["match"]],
];

/** Each button that opens a dialog or a menu: [screen, the routes its steps are on, the button]. */
export const DIALOGS = [
  ["/history/logs", ["history.logs"], { panel: "Game log", button: "Download" }],
  ["/players/clans", ["players.clans"], { panel: "Clans", button: "Rename" }],
  ["/players/vips", ["players.vips"], { panel: "Current VIPs", button: "Download" }],
  ["/players/vips", ["players.vips"], { panel: "Current VIPs", button: "Upload" }],
  ["/players/vips", ["players.vips"], { panel: "Current VIPs", button: "Revoke" }],
  ["/players/groups", ["players.groups"], { panel: "Player groups", button: "+ New group" }],
  ["/players/groups", ["players.groups"], { panel: "Player groups", button: "Rename" }],
  ["/players/groups", ["players.groups"], { panel: "Player groups", button: "Delete" }],
  ["/players/groups", ["players.groups"], { panel: "Player groups", button: "Download" }],
  ["/players/groups", ["players.groups"], { panel: "Player groups", button: "Upload" }],
  ["/players/triggers", ["players.triggers"], { panel: "All triggers", button: "Delete" }],
  ["/moderation/watched", ["moderation.watched"], { panel: "Watched players", button: "Download" }],
  ["/moderation/bans", ["moderation.bans"], { panel: "Bans", button: "Download" }],
  ["/moderation/bans", ["moderation.bans"], { panel: "Bans", button: "Upload" }],
  ["/moderation/bans", ["moderation.bans"], { panel: "Bans", button: "Ban a player" }],
  ["/moderation/bans", ["moderation.bans"], { panel: "Bans", button: "Sync from servers" }],
  ["/moderation/bans", ["moderation.bans"], { panel: "Bans", button: "Unban" }],
  ["/maps/vote", ["maps.vote"], { panel: "Map vote", button: "Start vote" }],
  ["/maps/vote", ["maps.vote"], { panel: "Map vote", button: "Re-read maps" }],
  ["/maps/rotation", ["maps.rotation"], { panel: "Edit rotation", button: "✕" }],
  ["/maps/rotation", ["maps.rotation"], { panel: "Objectives", button: "Set these objectives" }],
  ["/maps/catalogue", ["maps.catalogue"], { panel: "Every map", button: "Change now" }],
  ["/admin/activity", ["admin.activity"], { panel: "Trail", button: "Download" }],
  ["/admin/activity", ["admin.activity"], { panel: "Trail", css: "button.audit-action" }],
  ["/admin/connections", ["admin.connections"], { panel: "Connections", button: "Publish stats" }],
  ["/admin/connections", ["admin.connections"], { panel: "Connections", button: "Retire this server" }],
  ["/admin/connections", ["admin.connections"], { panel: "CRCON backup (full data pull)", button: "Wipe this server" }],
  ["/admin/admins", ["admin.admins"], { panel: "Console admins", button: "Remove" }],
  ["/admin/templates", ["admin.templates"], { panel: "Templates", button: "Delete" }],
  ["/admin/vippresets", ["admin.vippresets"], { panel: "VIP presets", button: "Delete" }],
  ["/players/~p1", ["players.players", "live"], { button: "+ Flag" }],
  ["/players/~p1", ["players.players", "live"], { button: "View on" }],
  ["/players/~p2", ["players.players", "live"], { panel: "Watchlist", button: "Remove" }],
  ["/players/~p2", ["players.players", "live"], { panel: "Watchlist", button: "Remove from watchlist" }],
  // What only shows with records to act on: a notice, a request, a vote under way, a template, a
  // role, an account, a CRCON pull's archive, a backup.
  ["/announcements", ["community"], { panel: "Notices", button: "Delete" }],
  ["/moderation/requests", ["moderation.requests"], { panel: "Waiting on you", button: "Approve all" }],
  ["/moderation/requests", ["moderation.requests"], { panel: "Waiting on you", button: "Deny" }],
  ["/maps/vote", ["maps.vote"], { panel: "Map vote", button: "New options" }],
  ["/maps/vote", ["maps.vote"], { panel: "Map vote", button: "Skip vote" }],
  ["/autosettings/settings", ["autosettings.settings"], { panel: "Templates", button: "✕" }],
  ["/autosettings/rules", ["autosettings.rules"], { panel: "Team play", button: "Delete" }],
  ["/autosettings/rules", ["autosettings.rules"], { panel: "Team play", button: "Remove" }],
  ...["Rename", "Delete"].map((button) => ["/admin/users", ["admin.users"], { panel: "Roles", button }]),
  ...["Reset password", "Sign out everywhere", "Delete"].map((button) => ["/admin/users", ["admin.users"], { panel: "Accounts", button }]),
  ["/admin/connections", ["admin.connections"], { panel: "CRCON backup (full data pull)", button: "Delete archive" }],
  ...["Restore", "Delete"].map((button) => ["/admin/backup", ["admin.backup"], { panel: "Full backup", button }]),
];

/**
 * Menus whose items each open a dialog: [screen, routes, the menu's button, set the screen up first].
 * A player's ⋯ on Live's roster, a profile's Actions, and Live's bulk actions with a player ticked.
 */
export const MENUS = [
  ["/live", ["live"], { css: '.player-actions button[aria-label="More"]' }, "roster"],
  ["/players/~p1", ["players.players", "live"], { button: "Actions" }],
  ["/players/~p2", ["players.players", "live"], { button: "Actions" }],
  ["/live", ["live"], { button: "Bulk actions for" }, "ticked"],
];

/**
 * What a button or a choice brings out in the page, for the choices test to look behind: [screen,
 * routes, what to do first]. An editor opened in the page (a trigger's, a new rule's, a profile's), a
 * duration or a date to give, each action a group can take, a payout split by role, the phone's
 * quick bar with room for one more button, which it starts without. What is chosen in it — each kind
 * an editor can be, each of its switches and lists — the test tries itself, as on every screen.
 */
const click = (t) => ({ click: t });
const ANALYTICS = ["server", "match", "player", "combat", "composition", "staff", "mapvote"];
export const REVEALS = [
  ["/players/triggers", ["players.triggers"], [click({ panel: "All triggers", button: "Edit" })]],
  ["/autosettings/rules", ["autosettings.rules"], [click({ button: "New rule" })]],
  ["/autosettings/settings", ["autosettings.settings"], [click({ panel: "Profiles", button: "Add profile" })]],
  ["/autosettings/settings", ["autosettings.settings"], [click({ panel: "Timed match messages", button: "Add a timed message" })]],
  ["/players/vips", ["players.vips"], [click({ panel: "Grant / extend VIP", button: "Until date" })]],
  ["/players/vips", ["players.vips"], [click({ panel: "Grant / extend VIP", button: "Add duration" })]],
  ["/admin/admins", ["admin.admins"], [click({ button: "Until date" })]],
  ["/admin/admins", ["admin.admins"], [click({ button: "Add duration" })]],
  ["/players/groups", ["players.groups"], [click({ panel: "Player groups", button: "Sync from a Discord role" })]],
  ["/players/groups", ["players.groups"], [click({ panel: "VIP perk", button: "Set up a VIP perk" })]],
  ...["Revoke VIP", "Grant console admin", "Remove console admin", "Temp ban", "Move to a team", "Send message", "Grant economy", "Until date", "For a duration"]
    .map((b) => ["/players/groups", ["players.groups"], [click({ panel: "Apply to the whole group", button: b })]]),
  ["/players/economy", ["players.economy"], [click({ panel: "Settings", field: "Member-to-member" })]],
  ["/players/economy", ["players.economy"], [click({ panel: "Settings", field: "Registration welcome" })]],
  ["/events/payouts", ["events.payouts"], [click({ panel: "New payout", button: "+ Split by role" })]],
  ["/maps/vote", ["maps.vote"], [click({ panel: "Map vote", button: "Force next map" })]],
  ["/maps/votesetup", ["maps.votesetup"], [click({ button: "Add a reminder" })]],
  ["/maps/catalogue", ["maps.catalogue"], [click({ button: "By family" })]],
  ["/maps/catalogue", ["maps.catalogue"], [click({ button: "Rename" })]],
  ["/maps/catalogue", ["maps.catalogue"], [click({ button: "Set family" })]],
  ["/autosettings/zones", ["autosettings.zones"], [click({ panel: "Zone sets", button: "Carentan spawn lines" })]],
  ["/discord/setup", ["discord.setup"], [click({ panel: "Community badges", button: "+ Add badge" })]],
  ["/discord/relay", ["discord.relay"], [click({ panel: "Match board badge", button: "Remove" })]],
  ["/history/admincam", ["history.admincam"], [click({ field: "Off" })]],
  ["/admin/connections", ["admin.connections"], [click({ button: "Add server" })]],
  ...["Admin action", "Connection", "Automation"].map((b) => ["/admin/connections", ["admin.connections"], [click({ panel: "Connections", button: b })]]),
  ["/admin/console", ["admin.console"], [click({ button: "+ Advanced" })]],
  ...ANALYTICS.map((a) => [`/analytics/${a}`, [`analytics.${a}`], [click({ button: "Custom…" })]]),
  ["/settings", ["settings"], [click({ panel: "Workspace", button: "Take Live off the bar" })]],
  // What a button unfolds in place: an editor, a form, a list or a picker.
  ["/dashboard", ["dashboard"], [click({ button: "Widgets" })]],
  ["/dashboard", ["dashboard"], [click({ button: "Edit layout" })]],
  ["/live", ["live"], [click({ panel: "Roster", button: "Allies" })]],
  ["/history/admincam", ["history.admincam"], [click({ panel: "Is it working?", button: "Check the last hour" })]],
  ["/announcements", ["community"], [click({ panel: "Notices", button: "Edit" })]],
  ["/players/directory", ["players.players"], [click({ panel: "Directory", button: "Filters" })]],
  ["/players/clans", ["players.clans"], [click({ panel: "Clans", button: "2 spellings" })]],
  ["/players/triggers", ["players.triggers"], [click({ panel: "All triggers", button: "Kestrel" })]],
  ["/players/vips", ["players.vips"], [click({ panel: "VIP integrity", button: "Scan all servers" })]],
  ["/players/economy", ["players.economy"], [click({ panel: "Activity", button: "Alice" })]],
  ["/events/schedule", ["events.schedule"], [click({ panel: "Scheduled events", button: "Edit" })]],
  ["/events/payouts", ["events.payouts"], [click({ panel: "New payout", button: "Preview recipients" })]],
  ["/events/payouts", ["events.payouts"], [click({ panel: "Payout history", button: "Receipts" })]],
  ["/maps/votesetup", ["maps.votesetup"], [click({ button: "Manage map sets" })]],
  ["/maps/votesetup", ["maps.votesetup"], [click({ button: "Manage map sets" }), { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "default" }, click({ panel: "Vote setup", button: "▸ Advanced" })]],
  ["/maps/votesetup", ["maps.votesetup"], [click({ button: "Manage map sets" }), { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "default" }, click({ panel: "Vote setup", css: ".setting-card > .row > button[aria-expanded]" })]],
  ["/maps/votesetup", ["maps.votesetup"], [click({ button: "Manage map sets" }), { fill: { panel: "Vote setup", css: 'select[aria-label="Manage map sets"]' }, value: "seeding" }, click({ panel: "Vote setup", css: ".mapset-maps-toggle" })]],
  ["/maps/votesetup", ["maps.votesetup"], [click({ button: "Manage schedules" })]],
  ["/maps/votesetup", ["maps.votesetup"], [click({ button: "Show me a sample vote" })]],
  ...["New section", "Recently deleted", "Select rules"].map((button) => ["/autosettings/rules", ["autosettings.rules"], [click({ button })]]),
  ["/autosettings/rules", ["autosettings.rules"], [click({ panel: "Team play", button: "Pause" })]],
  ["/autosettings/rules", ["autosettings.rules"], [click({ panel: "Team play", button: "Rename" })]],
  // The rules kept for another server, behind their own button under Other rules.
  ["/autosettings/rules", ["autosettings.rules"], [click({ panel: "Other rules", css: ".recent-list + .actions > button" })]],
  // View all is remembered, so the screen opens on it from here on: the list it shows, and a
  // rule's History, which only that list has.
  ["/autosettings/rules", ["autosettings.rules"], [click({ button: "View all" })]],
  ["/autosettings/rules", ["autosettings.rules"], [click({ panel: "Rules", button: "History" })]],
  ["/analytics/staff", ["analytics.staff"], [click({ button: "Measured" })]],
  ["/analytics/staff", ["analytics.staff"], [click({ button: "Roles" })]],
  ["/admin/activity", ["admin.activity"], [click({ button: "Roles" })]],
  ["/admin/users", ["admin.users"], [click({ panel: "Roles", button: "Edit" })]],
  ["/admin/users", ["admin.users"], [click({ panel: "Accounts", button: "Edit permissions" })]],
  // A member Discord manages, and one taken off it: what may be done differs with each.
  ...[1, 2].map((nth) => ["/admin/users", ["admin.users"], [click({ panel: "Accounts", button: "Edit permissions", nth })]]),
  ["/admin/users", ["admin.users"], [click({ panel: "Accounts", button: "Merge" })]],
  ["/admin/connections", ["admin.connections"], [click({ panel: "Connections", button: "View live" })]],
  ["/admin/connections", ["admin.connections"], [click({ panel: "Connections", button: "View live" }), click({ panel: "Connections", button: "Teams" }), click({ panel: "Connections", css: ".team-side-head" })]],
  ["/admin/console", ["admin.console"], [{ fill: { panel: "Send a command", field: "Command" }, value: "GetDisplayableCommands" }, click({ panel: "Send a command", button: "Send" })]],
  ["/admin/trim", ["admin.trim"], [click({ button: "Check sizes" })]],
  ["/admin/backup", ["admin.backup"], [click({ panel: "Export", button: "Select everything" })]],
  ["/settings", ["settings"], [click({ panel: "Workspace", button: "✕" })]],
  ["/settings", ["settings"], [click({ panel: "Appearance", css: ".swatches button.swatch" })]],
  ["/settings", ["settings"], [click({ panel: "API tokens", button: "Create token" })]],
  ["/players/~p2", ["players.players", "live"], [click({ panel: "Watchlist", button: "Edit" })]],
  // Two clans ticked, to be combined — by name, as a clan opened to its spellings (above) puts their
  // row between them; a message saved as a preset; every weapon and map counted.
  ["/players/clans", ["players.clans"], ["[ABC]", "ABC|"].map((name) => click({ panel: "Clans", css: `input[aria-label="Select ${name}"]` }))],
  ["/moderation/messages", ["moderation.messages"], [{ fill: { panel: "Message everyone", field: "Message" }, value: "Server restart in 10 minutes." }, click({ panel: "Message everyone", button: "+ Save as preset" })]],
  ...["combat", "match", "mapvote"].map((a) => [`/analytics/${a}`, [`analytics.${a}`], [click({ button: "Showing" })]]),
  // A server seeding pays on too.
  ["/autosettings/seeding", ["autosettings.seeding"], [click({ panel: "Seed reward", button: "Add a bridge server" })]],
];

/**
 * The reads the walkthrough stage answered with nothing, each once: a screen draws such an answer
 * as empty, so its rows and their buttons go unseen by these tests, and unpictured. Only a saved
 * layout (none, the panel's own) and the pages plugins add (none here) are rightly empty; writes
 * are answered as done.
 */
export const unansweredReads = (stub) => [...new Set(stub.unanswered.filter((r) => r.startsWith("GET ") && !/^GET \/api\/(layout\/|plugin-pages$)/.test(r)))].sort();

/**
 * With COVER_GAPS=<path>, each test writes what it found uncovered to <path>.<name>.json: how
 * KNOWN_GAPS is brought up to date once walkthroughs are written.
 */
export function recordGaps(name, missing) {
  if (process.env.COVER_GAPS) writeFileSync(`${process.env.COVER_GAPS}.${name}.json`, `${JSON.stringify(missing, null, 1)}\n`);
}

/**
 * What is still to be written, found where each test looks — said as `uncovered` says it, after the
 * place it was found: what the stage's records and the editors buttons unfold brought into view.
 */
export const KNOWN_GAPS = {
  screens: [
  ],
  dialogs: [
  ],
  choices: [
  ],
  // test/e2e-4: the panel in its other states, the overlays and modes around the screens, and the
  // panel as someone who may only look sees it.
  states: [
  ],
  overlays: [
  ],
  readOnly: [
  ],
};
