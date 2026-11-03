/**
 * The score series' stored form (match_score_series.packed).
 *
 * A series is five numbers a point: seconds since the round's start, then the combat, offense,
 * defense and support totals. Kept as plain integers that was twenty bytes a point, in a row
 * rewritten whole every minute of the round. Packed, each number is its change from the same
 * number one point earlier (the first point's change from zero), zigzag-encoded so a drop costs
 * what a rise does, written as a base-128 varint, low bits first. A minute of play is usually one
 * byte a number: five or six bytes a point.
 *
 * Arithmetic rather than bit operators throughout, so no total is ever cut to 32 bits.
 */

const zigzag = (n: number): number => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzigzag = (z: number): number => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

/** Pack a flattened series (five numbers a point). A trailing partial point is left out, as the
 *  readers have always left it out; a number that is not finite is stored as 0. */
export function packScoreSeries(flat: readonly number[]): Uint8Array {
  const out: number[] = [];
  const prev = [0, 0, 0, 0, 0];
  const whole = flat.length - (flat.length % 5);
  for (let i = 0; i < whole; i++) {
    const raw = flat[i]!;
    const v = Number.isFinite(raw) ? Math.round(raw) : 0;
    let z = zigzag(v - prev[i % 5]!);
    prev[i % 5] = v;
    while (z >= 128) {
      out.push((z % 128) + 128);
      z = Math.floor(z / 128);
    }
    out.push(z);
  }
  return Uint8Array.from(out);
}

/** The flattened series back out of its packed form. Bytes that end mid-number, or mid-point,
 *  give up the unfinished part and nothing else. */
export function unpackScoreSeries(bytes: Uint8Array): number[] {
  const flat: number[] = [];
  const prev = [0, 0, 0, 0, 0];
  let z = 0;
  let scale = 1;
  for (const b of bytes) {
    z += (b % 128) * scale;
    if (b >= 128) {
      scale *= 128;
      continue;
    }
    const k = flat.length % 5;
    prev[k] = prev[k]! + unzigzag(z);
    flat.push(prev[k]!);
    z = 0;
    scale = 1;
  }
  return flat.slice(0, flat.length - (flat.length % 5));
}
