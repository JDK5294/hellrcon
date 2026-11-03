/**
 * HLL v2 binary RCON framing.
 *
 * Wire format (little-endian):
 *   header  = [magic uint32]? [requestId uint32] [bodyLen uint32]
 *   body    = XOR(JSON, xorkey)         // XOR is a no-op until the key is negotiated
 *
 * The header has two known modes — `magic` (current, prefixed with 0xDE450508) and
 * `legacy` (no magic). Supporting both is our multi-version RCON requirement in miniature.
 */

export const MAGIC_HEADER_VALUE = 0xde450508;

export type HeaderMode = "magic" | "legacy";

export function headerSize(mode: HeaderMode): number {
  return mode === "magic" ? 12 : 8;
}

export function packHeader(mode: HeaderMode, requestId: number, bodyLen: number): Buffer {
  if (mode === "magic") {
    const buf = Buffer.allocUnsafe(12);
    buf.writeUInt32LE(MAGIC_HEADER_VALUE, 0);
    buf.writeUInt32LE(requestId, 4);
    buf.writeUInt32LE(bodyLen, 8);
    return buf;
  }
  const buf = Buffer.allocUnsafe(8);
  buf.writeUInt32LE(requestId, 0);
  buf.writeUInt32LE(bodyLen, 4);
  return buf;
}

export interface ParsedHeader {
  requestId: number;
  bodyLen: number;
  magic?: number;
}

export function unpackHeader(mode: HeaderMode, buf: Buffer): ParsedHeader {
  if (buf.length < headerSize(mode)) {
    throw new Error(`Header too short: got ${buf.length}, need ${headerSize(mode)}`);
  }
  if (mode === "magic") {
    const magic = buf.readUInt32LE(0);
    if (magic !== MAGIC_HEADER_VALUE) {
      throw new Error(`Invalid magic value: 0x${magic.toString(16)} (expected 0x${MAGIC_HEADER_VALUE.toString(16)})`);
    }
    return { magic, requestId: buf.readUInt32LE(4), bodyLen: buf.readUInt32LE(8) };
  }
  return { requestId: buf.readUInt32LE(0), bodyLen: buf.readUInt32LE(4) };
}

/** XOR a payload with the negotiated key. Returns the payload unchanged if no key yet. */
export function xor(payload: Buffer, key: Buffer | null): Buffer {
  if (!key || key.length === 0) return payload;
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    out[i] = payload[i]! ^ key[i % key.length]!;
  }
  return out;
}
