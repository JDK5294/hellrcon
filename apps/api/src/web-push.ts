/**
 * Web Push: a notification to a phone or a computer, through the push service its browser came
 * with (Apple's, Google's, Mozilla's, Microsoft's). Nothing is installed for it — node:crypto does
 * the two things the protocol asks of whoever sends one:
 *
 *  - the message is encrypted for that one browser (RFC 8291, with the aes128gcm coding of
 *    RFC 8188), so the push service carries it without being able to read it;
 *  - each request is signed with this install's own key (VAPID, RFC 8292). A browser is handed the
 *    public half when it subscribes, and its push service delivers only what the private half signed.
 *
 * The key pair is made the first time it is needed and kept with the install's own settings,
 * sealed like the other install secrets: there is nothing to set up.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";
import type { Repository } from "@app/db";

/** Where one browser receives, as its PushSubscription reported it (the keys base64url). */
export interface PushTarget { endpoint: string; p256dh: string; auth: string }
/** This install's signing key pair, base64url: the 65-byte public point and the 32-byte private key. */
export interface VapidKeys { publicKey: string; privateKey: string }
/** What the service worker shows (public/sw.js): a title, a line or two, and where a tap goes. */
export interface PushMessage { title: string; body: string; url: string; tag?: string }

const VAPID_KEY = "push.vapid";

export function makeVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // A private key with leading zero bytes comes back shorter; a JWK wants all 32.
  const priv = ecdh.getPrivateKey();
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: Buffer.concat([Buffer.alloc(32 - priv.length), priv]).toString("base64url") };
}

/** The install's key pair, made once. */
export async function vapidKeys(repo: Pick<Repository, "installSettings">): Promise<VapidKeys> {
  return JSON.parse(await repo.installSettings.getOrCreate(VAPID_KEY, () => JSON.stringify(makeVapidKeys()), { secret: true })) as VapidKeys;
}

/** A subscription's keys as a browser hands them over: a point on P-256 and a 16-byte secret. */
export function validKeys(p256dh: string, auth: string): boolean {
  const point = Buffer.from(p256dh, "base64url");
  if (point.length !== 65 || point[0] !== 4 || Buffer.from(auth, "base64url").length !== 16) return false;
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(point);
    return true;
  } catch {
    return false;
  }
}

const hkdf = (ikm: Buffer, salt: Buffer, info: string | Buffer, length: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/**
 * The body of a push to one browser: RFC 8291's encryption, as one aes128gcm record. `fixed` takes
 * the RFC's own example key and salt, so its test vector can be checked byte for byte; a real push
 * makes both fresh.
 */
export function encryptFor(target: Pick<PushTarget, "p256dh" | "auth">, plaintext: Buffer, fixed?: { privateKey: Buffer; salt: Buffer }): Buffer {
  const uaPublic = Buffer.from(target.p256dh, "base64url");
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed?.salt ?? randomBytes(16);
  const ikm = hkdf(ecdh.computeSecret(uaPublic), Buffer.from(target.auth, "base64url"), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cipher = createCipheriv("aes-128-gcm", hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16), hkdf(ikm, salt, "Content-Encoding: nonce\0", 12));
  // One record, so it is the last one: the text, then the 0x02 that says so.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/**
 * The Authorization header for a push to `endpoint` (RFC 8292): a token for that push service,
 * signed with the install's key. `contact` is the address the panel was opened on — the push
 * services want one, and Apple's refuses a token without it.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, contact: string, now = Date.now()): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: contact })}`;
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url"), d: keys.privateKey },
  });
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

/** How a push went: delivered to the push service, a subscription the browser has dropped (forget
 *  it), or refused for some other reason (keep it — the next one may go). */
export type PushOutcome = { outcome: "sent" } | { outcome: "gone"; status: number } | { outcome: "failed"; status?: number; error: string };

/** Send one message to one browser. `ttl`: how long the push service keeps trying a phone that is
 *  off — a "joined" an hour late is noise, a request waiting for a signature is not. */
export async function sendPush(
  target: PushTarget & { origin: string }, message: PushMessage, keys: VapidKeys, opts: { ttl: number; urgency?: "normal" | "high" },
): Promise<PushOutcome> {
  try {
    const res = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidAuthorization(target.endpoint, keys, target.origin),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(opts.ttl),
        urgency: opts.urgency ?? "normal",
      },
      body: encryptFor(target, Buffer.from(JSON.stringify(message))),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => "");
    if (res.status === 404 || res.status === 410) return { outcome: "gone", status: res.status };
    if (!res.ok) return { outcome: "failed", status: res.status, error: text.slice(0, 200) || res.statusText };
    return { outcome: "sent" };
  } catch (err) {
    return { outcome: "failed", error: (err as Error).message };
  }
}
