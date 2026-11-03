/**
 * What one save changed, read as lines a person can scan: "Count: 2 → 3", "Maps: added Foy,
 * removed Kursk". Version history keeps each save's before and after; this turns the pair into the
 * sentence the history list shows, so nobody has to compare two blobs of settings by eye.
 *
 * Generic on purpose — rules, map sets and vote schedules are three different shapes — with labels
 * and value formatting supplied by the screen that knows the shape. Lists of plain values read as
 * what was added and removed (order alone changing says so); nested settings read by path.
 */
export interface DiffLine {
  /** dotted path into the record ("pool.modeBuckets.0.maps"). */
  path: string;
  /** the path in words ("Mode buckets › 1 › Maps"). */
  label: string;
  /** what happened to it ("2 → 3", "added foy; removed kursk", "(none) → \"hello\""). */
  text: string;
}

export interface DiffOptions {
  /** key → words, for the last segment of a path (and every segment on the way). */
  labels?: Record<string, string>;
  /** top-level keys that are never part of the story (a rule's own on/off switch, say). */
  ignore?: string[];
  /** how a value reads at a path; return undefined to fall back to the default. */
  format?: (path: string, value: unknown) => string | undefined;
}

const MAX_TEXT = 80;
const isPlain = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s;
}

function plain(v: unknown): string {
  if (empty(v)) return "(none)";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return clip(`“${v}”`);
  if (isPlain(v)) return String(v);
  return clip(JSON.stringify(v));
}

function same(a: unknown, b: unknown): boolean {
  if (empty(a) && empty(b)) return true;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => [k, sorted(v[k])]));
  return v;
}

/** Every change from `before` to `after`, in key order. Either side may be null (made / deleted). */
export function diffSnapshots(before: Record<string, unknown> | null, after: Record<string, unknown> | null, opts: DiffOptions = {}): DiffLine[] {
  const labels = opts.labels ?? {};
  const words = (path: string[]) => path.map((seg) => (/^\d+$/.test(seg) ? String(Number(seg) + 1) : labels[seg] ?? seg)).join(" › ");
  const fmt = (path: string, v: unknown) => opts.format?.(path, v) ?? plain(v);
  const out: DiffLine[] = [];
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (same(a, b)) return;
    const p = path.join(".");
    // Lists of plain values: what came and went, not two lists to compare by eye.
    if ((Array.isArray(a) || empty(a)) && (Array.isArray(b) || empty(b)) && [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].every(isPlain)) {
      const was = (Array.isArray(a) ? a : []) as unknown[];
      const now = (Array.isArray(b) ? b : []) as unknown[];
      const added = now.filter((x) => !was.includes(x));
      const removed = was.filter((x) => !now.includes(x));
      const bits: string[] = [];
      if (added.length) bits.push(`added ${added.map((x) => fmt(p, x)).join(", ")}`);
      if (removed.length) bits.push(`removed ${removed.map((x) => fmt(p, x)).join(", ")}`);
      out.push({ path: p, label: words(path), text: bits.length ? clip(bits.join("; ")) : "order changed" });
      return;
    }
    if ((isObject(a) || empty(a)) && (isObject(b) || empty(b)) && (isObject(a) || isObject(b))) {
      const x = isObject(a) ? a : {};
      const y = isObject(b) ? b : {};
      for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
        if (path.length === 0 && opts.ignore?.includes(k)) continue;
        walk(x[k], y[k], [...path, k]);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], [...path, String(i)]);
      return;
    }
    out.push({ path: p, label: words(path), text: `${fmt(p, a)} → ${fmt(p, b)}` });
  };
  walk(before ?? {}, after ?? {}, []);
  return out;
}
