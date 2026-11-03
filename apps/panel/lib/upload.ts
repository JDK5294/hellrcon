/**
 * Reading a list back in — the other half of lib/download.ts. A file downloaded from a list (Excel,
 * CSV or JSON), or a copy someone edited and saved in Excel or Google Sheets, becomes a table of
 * headings and cells; the list's own upload then finds its columns by name and plans each row
 * before anything changes.
 *
 * Excel saves its workbooks compressed, which the browser undoes itself (DecompressionStream), so
 * nothing here needs a library either. Times come back in the zone a column's heading names — the
 * one the file was written in — so a list made by someone in another zone still reads right.
 */
import { effectiveZone, wallToIsoIn } from "./time.ts";

export type UploadCell = string | number | boolean | null;
export interface Table { headers: string[]; rows: UploadCell[][] }

/** Read a picked file. What it is comes from its first bytes, not its name: a zip is a workbook. */
export async function readTable(bytes: Uint8Array): Promise<Table> {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readXlsx(bytes);
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  if (/^\s*[[{]/.test(text)) return readJson(text);
  return toTable(parseCsv(text));
}

/** The first non-empty row is the heading row; every row is padded to its width. */
function toTable(grid: UploadCell[][]): Table {
  const rows = grid.filter((r) => r.some((c) => c !== null && c !== ""));
  if (!rows.length) throw new Error("The file is empty.");
  const headers = rows[0]!.map((h) => (h === null ? "" : String(h).trim()));
  return { headers, rows: rows.slice(1).map((r) => headers.map((_, i) => r[i] ?? null)) };
}

// ---- JSON: what the JSON download writes, one object per row ----

function readJson(text: string): Table {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("The file is not valid JSON."); }
  if (!Array.isArray(data)) throw new Error("A JSON list is an array of rows — this file is something else.");
  const headers: string[] = [];
  for (const row of data) {
    if (row && typeof row === "object" && !Array.isArray(row)) for (const k of Object.keys(row)) if (!headers.includes(k)) headers.push(k);
  }
  const cell = (v: unknown): UploadCell => (v === null || v === undefined ? null : typeof v === "number" || typeof v === "boolean" ? v : String(v));
  return { headers, rows: data.map((row) => headers.map((k) => cell((row as Record<string, unknown> | null)?.[k]))) };
}

// ---- CSV ----

/**
 * RFC 4180, with the comma, semicolon or tab a spreadsheet in another language saves with (read off
 * the heading line). The apostrophe the download puts before a cell that starts like a formula is
 * taken off again, so a name comes back as it was.
 */
export function parseCsv(text: string): string[][] {
  const head = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/)).replace(/"[^"]*"/g, "");
  const counts = [",", ";", "\t"].map((d) => [d, head.split(d).length] as const);
  const sep = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => { row.push(field.replace(/^'(?=[=+\-@\t\r])/, "")); field = ""; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) endField();
    else if (ch === "\n" || ch === "\r") {
      endField(); out.push(row); row = [];
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else field += ch;
  }
  if (field !== "" || row.length) { endField(); out.push(row); }
  return out;
}

// ---- Excel ----

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m);
const attrs = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1]!, unxml(m[2]!)]));
/** Every run of text in an element: a plain string, or the pieces of a formatted one. */
const texts = (xml: string): string => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1]!)).join("");

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The files in a zip, by path: stored ones as they are, compressed ones unpacked. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("The file is not a workbook Excel can open.");
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(at + 10, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const local = v.getUint32(at + 42, true);
    const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, await inflateRaw(data));
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return files;
}

/** "AB12" → 27: the column a cell reference names. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function readXlsx(bytes: Uint8Array): Promise<Table> {
  const files = await unzip(bytes);
  const read = (path: string) => { const f = files.get(path); return f ? new TextDecoder().decode(f) : ""; };
  // The first sheet, wherever the workbook says it is.
  const first = /<sheet\s[^>]*>/.exec(read("xl/workbook.xml"))?.[0];
  const rid = first ? attrs(first)["r:id"] : undefined;
  const rel = [...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s[^>]*>/g)].map((m) => attrs(m[0])).find((a) => a.Id === rid);
  const target = rel?.Target ? (rel.Target.startsWith("/") ? rel.Target.slice(1) : `xl/${rel.Target}`) : "xl/worksheets/sheet1.xml";
  const sheet = read(target) || read("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("The workbook has no sheet to read.");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  const grid: UploadCell[][] = [];
  let next = 0;
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(attrs(rm[1]!).r) || next + 1;
    next = r;
    const row: UploadCell[] = [];
    let col = 0;
    for (const cm of rm[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cm[1]!);
      const body = cm[2] ?? "";
      col = a.r ? columnIndex(a.r) : col;
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      row[col] = a.t === "s" ? shared[Number(v)] ?? null
        : a.t === "inlineStr" ? texts(body)
        : a.t === "str" ? (v === undefined ? null : unxml(v))
        : a.t === "b" ? v === "1"
        : a.t === "e" || v === undefined ? null
        : Number(v);
      col++;
    }
    grid[r - 1] = row;
  }
  return toTable(Array.from(grid, (row) => row ?? []));
}

// ---- finding the columns ----

/** A column found by its key (a JSON download) or its heading (Excel, CSV); `zone` is the one a
 *  time column's heading names — "Expires (America/New_York)". */
export interface Found { index: number; zone?: string }

export function findColumn(table: Table, key: string, label: string): Found | null {
  const want = [key.toLowerCase(), label.toLowerCase()];
  for (let i = 0; i < table.headers.length; i++) {
    const m = /^(.*?)\s*(?:\(([^()]+)\))?$/.exec(table.headers[i]!) ?? [];
    const name = (m[1] ?? "").trim().toLowerCase();
    if (want.includes(name) || want.includes(table.headers[i]!.toLowerCase())) return { index: i, ...(m[2] ? { zone: m[2].trim() } : {}) };
  }
  return null;
}

export const cellText = (v: UploadCell | undefined): string => (v === null || v === undefined ? "" : String(v).trim());

/**
 * A time cell as an ISO instant: null for an empty one, undefined for one that cannot be read. A
 * workbook's real dates are Excel's day counts; text is an instant ("…Z"), or a wall-clock time
 * ("2026-10-23 11:45", a date alone meaning its midnight) read in the column's zone.
 */
export function cellTime(v: UploadCell | undefined, zone?: string): string | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  const tz = zone || effectiveZone();
  if (typeof v === "number") {
    const ms = Math.round((v - 25_569) * 86_400_000);
    return Number.isFinite(ms) ? wallToIsoIn(new Date(ms).toISOString().slice(0, 16), tz) ?? undefined : undefined;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return new Date(Date.parse(s)).toISOString();
  const wall = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(s);
  if (wall && s.length <= 19) return wallToIsoIn(`${wall[1]}T${wall[2] ?? "00:00"}`, tz) ?? undefined;
  return undefined;
}
