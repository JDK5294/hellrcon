/**
 * CRCON's wire, byte for byte: what its `RconJsonResponse` writes.
 *
 * CRCON serializes every API answer with orjson (3.12.0 in v12.3.0's lock file), and orjson is
 * not JSON.stringify. Three differences decide bytes on this surface, all read from orjson's
 * source and the float library it uses (zmij 1.0.23), never from memory:
 *
 *   - A Python float keeps its decimal point. `2.0` is `2.0`, `0.0` is `0.0`; JSON.stringify writes
 *     `2` and `0`. JavaScript has one number type, so a value that is a float on CRCON's side has
 *     to say so: wrap it in `pyFloat`. Exponent forms differ too (`1e+16` where JS writes the
 *     digits out, `1e-6` where JS writes `0.000001`), which `formatPyFloat` copies.
 *   - A Python dict keeps the order its keys were inserted in. A JavaScript object moves keys that
 *     look like array indexes ("123") to the front, so a dict keyed by DATA (player names, weapon
 *     names) is a `Map` here, which keeps every key where it was put.
 *   - Dates are Python datetimes: `2026-08-01T10:00:00+00:00` when they carry UTC, no offset at
 *     all when they are naive, and six digits of microseconds only when there are any.
 *
 * Strings need nothing: orjson escapes exactly what JSON.stringify escapes, the same way (`\b \t
 * \n \f \r`, `\"`, `\\`, other control characters as lowercase `\u00xx`, nothing else).
 */

/** A number that is a Python float on CRCON's side. */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export const pyFloat = (value: number): PyFloat => new PyFloat(value);

/**
 * A finite double as zmij's `format_finite` writes it (orjson's float writer): the shortest digits
 * that read back as the same double, in fixed notation while the leading digit's decimal exponent
 * is within -5..15 (whole values ending `.0`), otherwise `d.ddde+X` / `d.ddde-X`.
 * Non-finite values are `null`, as orjson writes them.
 */
export function formatPyFloat(x: number): string {
  if (!Number.isFinite(x)) return "null";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  // JavaScript's own shortest round-trip digits, re-laid out in zmij's notation.
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(x)));
  if (!m) return String(x);
  let digits = m[1]! + (m[2] ?? "");
  let point = m[1]!.length + (m[3] ? Number(m[3]) : 0);
  const lead = /^0*/.exec(digits)![0].length;
  digits = digits.slice(lead).replace(/0+$/, "");
  point -= lead;
  const exp = point - 1;
  const sign = x < 0 ? "-" : "";
  if (exp >= -5 && exp <= 15) {
    if (digits.length - 1 <= exp) return `${sign}${digits}${"0".repeat(exp - digits.length + 1)}.0`;
    if (exp >= 0) return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
    return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  }
  return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${exp >= 0 ? "+" : "-"}${Math.abs(exp)}`;
}

/** The exact value of a finite double as a fraction num / 2^shift. */
function exactParts(x: number): { num: bigint; shift: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const mantissa = exponent === 0 ? fraction : fraction | (1n << 52n);
  const e = (exponent === 0 ? 1 : exponent) - 1075; // x = mantissa * 2^e
  const num = negative ? -mantissa : mantissa;
  return e >= 0 ? { num: num << BigInt(e), shift: 0n } : { num, shift: BigInt(-e) };
}

/**
 * Python's `round(x, ndigits)` for a float: the decimal nearest to the double's EXACT value, ties
 * to even, read back as the nearest double. Not `Math.round(x * 100) / 100`: 1 kill over 8 deaths
 * is exactly 0.125, which Python rounds to 0.12 and Math.round to 0.13.
 */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const { num, shift } = exactParts(x);
  const scale = 10n ** BigInt(ndigits);
  const scaled = num * scale; // the value times 10^ndigits, over 2^shift
  const den = 1n << shift;
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  let q = abs / den;
  const r2 = (abs % den) * 2n;
  if (r2 > den || (r2 === den && q % 2n === 1n)) q += 1n;
  const n = Number(negative ? -q : q);
  // n / 10^ndigits as one correctly rounded division, which is what Python's strtod reads back.
  return n / Number(scale);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** A Python datetime spelled the way orjson writes it. `aware`: it carries UTC (`+00:00`). */
function pyDate(ms: number, aware: boolean): string {
  const d = new Date(ms);
  const base = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const micros = d.getUTCMilliseconds() * 1000;
  return `${base}${micros ? `.${pad(micros, 6)}` : ""}${aware ? "+00:00" : ""}`;
}

/** A UTC datetime (tzinfo set), e.g. `2026-08-01T10:00:00+00:00`. */
export const pyDateUtc = (ms: number): string => pyDate(ms, true);
/** A naive datetime, e.g. `2026-08-01T10:00:00.123000`: a TIMESTAMP column read back. */
export const pyDateNaive = (ms: number): string => pyDate(ms, false);

/**
 * Serialize like orjson. Plain numbers are Python ints when whole and floats when not; `PyFloat`
 * forces a float; a `Map` is a dict in its own key order; an object property set to `undefined`
 * is left out, as JSON.stringify leaves it out.
 */
export function pyDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof PyFloat) return formatPyFloat(value.value);
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) return "null";
      // A whole number is a Python int: its digits, however large (String(1e21) would say "1e+21").
      if (Number.isInteger(value)) return Number.isSafeInteger(value) ? String(value) : BigInt(value).toString();
      return formatPyFloat(value);
    case "bigint":
      return value.toString();
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      return "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => pyDumps(v)).join(",")}]`;
  const entries: [string, unknown][] = value instanceof Map
    ? [...value.entries()].map(([k, v]) => [String(k), v])
    : Object.entries(value as Record<string, unknown>);
  const body = entries
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}:${pyDumps(v)}`)
    .join(",");
  return `{${body}}`;
}

/** The whitespace int() skips around a number: ASCII's six, and str.isspace() beyond ASCII (it
 *  passes ASCII through untouched, so \x1c-\x1f are not skipped, though isspace() counts them). */
const INT_SPACE = "[\\t-\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
/** int(s) in base 10: Unicode decimal digits, single underscores between them, a sign. */
const PY_INT = new RegExp(`^${INT_SPACE}*([+-]?)(\\p{Nd}(?:_?\\p{Nd})*)${INT_SPACE}*$`, "u");
const ND = /\p{Nd}/u;

/** A Unicode decimal digit's value: its place in its run of ten (digits come in runs of ten). */
function digitValue(d: string): number {
  let cp = d.codePointAt(0)!;
  let n = 0;
  while (ND.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    n += 1;
  }
  return n % 10;
}

/** Python's int(s) for a str, every digit kept (Python's ints have no ceiling), or null where it
 *  raises ValueError. */
export function pyBigInt(s: string): bigint | null {
  const m = PY_INT.exec(s);
  if (!m) return null;
  const digits = [...m[2]!.replace(/_/g, "")].map(digitValue).join("");
  return BigInt(`${m[1] === "-" ? "-" : ""}${digits}`);
}

/** Python's int(s) for a str, or null where it raises ValueError. */
export function pyInt(s: string): number | null {
  const n = pyBigInt(s);
  return n === null ? null : Number(n);
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const hex = (cp: number, width: number): string => cp.toString(16).padStart(width, "0");

/** Python's repr() of a str (CPython's unicode_repr): its quote choice and its escapes. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${hex(cp, 2)}`;
    else if (cp < 0x7f || !NON_PRINTABLE.test(ch)) out += ch;
    else if (cp <= 0xff) out += `\\x${hex(cp, 2)}`;
    else if (cp <= 0xffff) out += `\\u${hex(cp, 4)}`;
    else out += `\\U${hex(cp, 8)}`;
  }
  return out + quote;
}

/**
 * `int(value)` for a request argument as Django hands it over (absent, one string, or a list for
 * a repeated key), as Python 3.12 answers: the int, or the repr() of the exception it raises —
 * which is what CRCON's views put in `error` when they catch it.
 */
export function pyIntArgument(value: unknown): { value: number } | { error: string } {
  if (typeof value === "string") {
    const n = pyInt(value);
    if (n !== null) return { value: n };
    // "%.200R": the literal's repr, cut at 200 characters.
    const literal = [...pyRepr(value)].slice(0, 200).join("");
    return { error: `ValueError(${pyRepr(`invalid literal for int() with base 10: ${literal}`)})` };
  }
  const type = value === undefined || value === null ? "NoneType" : Array.isArray(value) ? "list" : typeof value;
  return { error: `TypeError(${pyRepr(`int() argument must be a string, a bytes-like object or a real number, not '${type}'`)})` };
}

const utf8 = new TextEncoder();

/**
 * A dict as a Postgres jsonb column hands it back, which is how CRCON's dict columns reach its API:
 * keys ordered by their UTF-8 length, then byte for byte (and the last of a duplicate kept, as
 * an object already guarantees).
 */
export function jsonbOrdered<V>(dict: Record<string, V> | null | undefined): Map<string, V> {
  const entries = Object.entries(dict ?? {}).map(([k, v]) => ({ k, v, b: utf8.encode(k) }));
  entries.sort((x, y) => {
    if (x.b.length !== y.b.length) return x.b.length - y.b.length;
    for (let i = 0; i < x.b.length; i++) if (x.b[i] !== y.b[i]) return x.b[i]! - y.b[i]!;
    return 0;
  });
  return new Map(entries.map((e) => [e.k, e.v]));
}
