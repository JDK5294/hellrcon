/**
 * A list as a file — Excel, CSV or JSON — made in the browser from the rows a screen holds (or
 * fetches for the purpose), so nothing new is asked of the API and no copy is kept anywhere.
 *
 * Excel comes first because the lists carry game ids. A Steam id is 17 digits, and Excel reads a
 * CSV's digits as a number and rounds it — 76561198012345678 shows as 7.65612E+16, and once saved
 * the id is gone. The workbook writes every id as text, and its times as real dates, so they sort.
 * JSON is for scripts: one object per row under code-style keys, times as the ISO instants they are.
 */

export type DownloadFormat = "xlsx" | "csv" | "json";

/** `plain`: the same said of a list with no game ids in it — the public stats page's, names only. */
export const FORMATS: readonly { id: DownloadFormat; label: string; blurb: string; plain: string }[] = [
  { id: "xlsx", label: "Excel (.xlsx)", blurb: "Opens in Excel, Numbers and Google Sheets, with every game id kept exact.", plain: "Opens in Excel, Numbers and Google Sheets." },
  { id: "csv", label: "CSV (.csv)", blurb: "Plain text for any spreadsheet or script. Excel rounds long game ids in it.", plain: "Plain text for any spreadsheet or script." },
  { id: "json", label: "JSON (.json)", blurb: "For scripts and bots: one object per row, times in UTC.", plain: "For scripts and bots: one object per row, times in UTC." },
];

export const isFormat = (v: unknown): v is DownloadFormat => FORMATS.some((f) => f.id === v);

/** A column: its key in JSON, its heading in a spreadsheet, and whether it holds ISO instants. */
export interface Column { key: string; label: string; time?: boolean }
export type Cell = string | number | boolean | null | undefined;
export interface Sheet {
  name: string; columns: Column[]; rows: Cell[][];
  /** Said once the file is saved — that rows were left out, say. */
  notice?: string;
}

/** The most rows one download reads: weeks of a busy game log, few enough that a phone builds the
 *  file without stalling. */
export const DOWNLOAD_MAX = 20_000;
/** The most rows one page of a list returns (the API's own ceiling). */
const PAGE = 500;

/**
 * Every row of a paged list, for a download: a page at a time, all on one snapshot — the anchor the
 * first page hands back, so rows arriving meanwhile cannot shift later pages — up to DOWNLOAD_MAX.
 * `capped` says rows were left out.
 */
export async function readAll<T>(page: (offset: number, limit: number, anchor?: string) => Promise<{ items: T[]; total?: number | null; anchor?: string }>): Promise<{ items: T[]; capped: boolean }> {
  const items: T[] = [];
  let anchor: string | undefined;
  let total: number | null | undefined;
  for (;;) {
    const r = await page(items.length, PAGE, anchor);
    anchor ??= r.anchor;
    total = r.total;
    items.push(...r.items);
    if (r.items.length < PAGE || items.length >= DOWNLOAD_MAX || (total != null && items.length >= total)) break;
  }
  return { items: items.slice(0, DOWNLOAD_MAX), capped: total != null ? total > DOWNLOAD_MAX : items.length > DOWNLOAD_MAX };
}

/** How a spreadsheet writes instants: the zone's name, and an ISO instant as the wall clock there
 *  ("YYYY-MM-DDTHH:MM", "" for junk) — in the panel, lib/time's display zone. */
export interface Clock { zone: string; wall: (iso: string) => string }

export function buildFile(sheet: Sheet, format: DownloadFormat, clock: Clock): Blob {
  if (format === "json") return new Blob([toJson(sheet)], { type: "application/json" });
  // The byte-order mark is how Excel knows the file is UTF-8 — without it every name with an
  // accent or a clan symbol arrives garbled.
  if (format === "csv") return new Blob(["\uFEFF", toCsv(sheet, clock)], { type: "text/csv;charset=utf-8" });
  return new Blob([toXlsx(sheet, clock)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** "vips-test-server-1": the parts of a file's name, lower case, safe on every system. */
export function fileStem(...parts: (string | null | undefined)[]): string {
  return parts
    .map((p) => (p ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40))
    .filter(Boolean)
    .join("-");
}

const heading = (c: Column, clock: Clock): string => (c.time ? `${c.label} (${clock.zone})` : c.label);

function text(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** The wall-clock form of an instant cell, "" when there is none. */
const wallOf = (v: Cell, clock: Clock): string => (typeof v === "string" && v ? clock.wall(v) : "");

// ---- JSON ----

export function toJson(sheet: Sheet): string {
  const rows = sheet.rows.map((row) => Object.fromEntries(sheet.columns.map((c, i) => [c.key, row[i] ?? null])));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

// ---- CSV ----

/**
 * A player's name is theirs to choose, and a spreadsheet runs a cell that starts like a formula
 * (=, +, -, @) as one — a name can carry a link or worse. Such a text cell is written with a
 * leading apostrophe, the usual guard; clan tags like "-=ABC=-" start that way too, so they wear it.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvField(v: string): string {
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(sheet: Sheet, clock: Clock): string {
  const cell = (v: Cell, c: Column): string => {
    if (c.time) return wallOf(v, clock).replace("T", " ");
    return typeof v === "string" && FORMULA_START.test(v) ? `'${v}` : text(v);
  };
  const lines = [sheet.columns.map((c) => csvField(heading(c, clock)))];
  for (const row of sheet.rows) lines.push(sheet.columns.map((c, i) => csvField(cell(row[i], c))));
  return lines.map((l) => `${l.join(",")}\r\n`).join("");
}

// ---- Excel ----

/** What XML 1.0 cannot carry at all (control characters, lone surrogates): Excel refuses the
 *  whole workbook over one, and a player's name can hold anything. */
const NOT_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;
const xml = (s: string): string =>
  s.replace(NOT_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 0 → A, 25 → Z, 26 → AA. */
function columnName(i: number): string {
  let name = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Days since 1899-12-30, Excel's own count, of a wall-clock time — null for none. Checked by
 *  shape first: Date.parse reads almost anything as some date, an empty one included. */
function excelSerial(wall: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wall)) return null;
  const ms = Date.parse(`${wall}:00Z`);
  return Number.isFinite(ms) ? ms / 86_400_000 + 25_569 : null;
}

// Styles, by index into cellXfs below: 1 a bold heading, 2 a date and time.
const textCell = (ref: string, s: string, style = 0): string =>
  `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xml(s.slice(0, 32_767))}</t></is></c>`;

function worksheet(sheet: Sheet, clock: Clock): string {
  const widths = sheet.columns.map((c) => (c.time ? 16 : heading(c, clock).length));
  const rows = [`<row r="1">${sheet.columns.map((c, i) => textCell(`${columnName(i)}1`, heading(c, clock), 1)).join("")}</row>`];
  sheet.rows.forEach((row, n) => {
    const cells = sheet.columns.map((c, i) => {
      const ref = `${columnName(i)}${n + 2}`;
      const v = row[i];
      if (c.time) {
        const serial = excelSerial(wallOf(v, clock));
        return serial === null ? "" : `<c r="${ref}" s="2"><v>${serial}</v></c>`;
      }
      const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : text(v);
      widths[i] = Math.max(widths[i]!, Math.min(s.length, 60));
      if (!s) return "";
      return typeof v === "number" ? `<c r="${ref}"><v>${s}</v></c>` : textCell(ref, s);
    });
    rows.push(`<row r="${n + 2}">${cells.join("")}</row>`);
  });
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(w, 6) + 2}" customWidth="1"/>`).join("");
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}">`
    // The heading row stays in view down a long list.
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<cols>${cols}</cols><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml";

/** A one-sheet workbook: the six parts Excel needs and nothing else. */
export function toXlsx(sheet: Sheet, clock: Clock): Uint8Array<ArrayBuffer> {
  // A sheet's name is at most 31 characters, none of []:*?/\ .
  const name = sheet.name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet1";
  const parts: [string, string][] = [
    ["[Content_Types].xml", `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="${SHEET_TYPE}.sheet.main+xml"/>`
      + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${SHEET_TYPE}.worksheet+xml"/>`
      + `<Override PartName="/xl/styles.xml" ContentType="${SHEET_TYPE}.styles+xml"/></Types>`],
    ["_rels/.rels", `${XML_HEAD}<Relationships xmlns="${REL_NS}">`
      + `<Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_REL}">`
      + `<sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${XML_HEAD}<Relationships xmlns="${REL_NS}">`
      + `<Relationship Id="rId1" Type="${DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${DOC_REL}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">`
      + `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>`
      + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
      + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
      + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
      + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
      + `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
      + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
      + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`
      + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ["xl/worksheets/sheet1.xml", worksheet(sheet, clock)],
  ];
  const enc = new TextEncoder();
  return zip(parts.map(([path, body]) => ({ path, data: enc.encode(body) })));
}

// ---- zip ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of stored (uncompressed) entries: all a workbook needs, with nothing to bundle. */
export function zip(files: { path: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const out: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true); // version needed: 2.0
    l.setUint16(12, 0x21, true); // 1980-01-01, the earliest date a zip can say
    l.setUint32(14, crc, true);
    l.setUint32(18, f.data.length, true);
    l.setUint32(22, f.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true);
    e.setUint16(6, 20, true);
    e.setUint16(14, 0x21, true);
    e.setUint32(16, crc, true);
    e.setUint32(20, f.data.length, true);
    e.setUint32(24, f.data.length, true);
    e.setUint16(28, name.length, true);
    e.setUint32(42, offset, true);
    entry.set(name, 46);
    out.push(local, f.data);
    directory.push(entry);
    offset += local.length + f.data.length;
  }
  const size = directory.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const z = new DataView(end.buffer);
  z.setUint32(0, 0x06054b50, true);
  z.setUint16(8, files.length, true);
  z.setUint16(10, files.length, true);
  z.setUint32(12, size, true);
  z.setUint32(16, offset, true);
  const all = new Uint8Array(offset + size + end.length);
  let at = 0;
  for (const part of [...out, ...directory, end]) { all.set(part, at); at += part.length; }
  return all;
}
