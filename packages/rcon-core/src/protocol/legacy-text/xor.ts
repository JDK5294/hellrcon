/**
 * The HLL legacy text RCON protocol XOR-encrypts every message with a repeating key the server
 * sends once, on connect. Encryption and decryption are the same operation (XOR is its own
 * inverse), and each message is keyed from index 0.
 */
export function xorCrypt(data: Buffer, key: Buffer): Buffer {
  if (key.length === 0) return Buffer.from(data);
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ key[i % key.length]!;
  return out;
}
