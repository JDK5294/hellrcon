// Reads back a zip of stored entries — what lib/download.ts writes a workbook as — checking every
// entry's checksum against zlib's, so a test sees exactly the parts a spreadsheet program would.
import { crc32 } from "node:zlib";

export function unzipStored(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (v.getUint32(end, true) !== 0x06054b50) throw new Error("no end-of-directory record");
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error(`directory entry ${i} is not one`);
    const nameLen = v.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const size = v.getUint32(at + 20, true);
    if (v.getUint16(at + 10, true) !== 0) throw new Error(`${name} is compressed`);
    const local = v.getUint32(at + 42, true);
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error(`${name}: no local header where the directory says`);
    const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    if (crc32(data) !== v.getUint32(at + 16, true)) throw new Error(`${name}: checksum mismatch`);
    files.set(name, new TextDecoder().decode(data));
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return files;
}
