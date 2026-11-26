import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
  type ECDH,
} from "node:crypto";

/**
 * The browser side of Web Push, written from the RFCs rather than with the
 * library the transport uses, so the tests check what a browser and a push
 * service would accept.
 */

export interface FakeBrowser {
  /** The key pair the browser keeps for this subscription. */
  ecdh: ECDH;
  /** The auth secret the browser keeps for this subscription. */
  auth: Buffer;
  /** What `JSON.stringify(pushSubscription)` gives the app. */
  subscription: {
    endpoint: string;
    expirationTime: null;
    keys: { p256dh: string; auth: string };
  };
  /** The subscription as the contact's target. */
  destination: string;
}

/** A browser that has subscribed to push at `endpoint`. */
export function fakeBrowser(endpoint: string): FakeBrowser {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const subscription = {
    endpoint,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey("base64url"), auth: auth.toString("base64url") },
  };
  return { ecdh, auth, subscription, destination: JSON.stringify(subscription) };
}

/**
 * Decrypts a push message the way the browser does: RFC 8291 key derivation
 * over an RFC 8188 aes128gcm body. Throws if the body is not one record the
 * browser could read.
 */
export function decryptPushMessage(body: Uint8Array, browser: FakeBrowser): string {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const recordSize = buf.readUInt32BE(16);
  const idLength = buf[20]!;
  const serverKey = buf.subarray(21, 21 + idLength);
  const record = buf.subarray(21 + idLength);
  if (record.length > recordSize) throw new Error("more than one record");

  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
  const secret = browser.ecdh.computeSecret(serverKey);
  const ikm = hmac(
    hmac(browser.auth, secret),
    Buffer.concat([
      Buffer.from("WebPush: info\0"),
      browser.ecdh.getPublicKey(),
      serverKey,
      Buffer.from([1]),
    ]),
  );
  const prk = hmac(salt, ikm);
  const key = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);

  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(record.subarray(-16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  // The last record ends with a 0x02 delimiter, then zero padding.
  let end = padded.length - 1;
  while (padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("no last-record delimiter");
  return padded.subarray(0, end).toString("utf8");
}

/**
 * Reads a VAPID `Authorization` header as a push service does (RFC 8292):
 * whether the token is signed by `publicKey`, and what it claims.
 */
export function readVapidHeader(authorization: string, publicKey: string) {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization);
  if (!match) throw new Error(`not a VAPID header: ${authorization}`);
  const [, header, claims, signature, k] = match as unknown as string[];
  const point = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  const valid = verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature!, "base64url"),
  );
  return {
    valid,
    k,
    header: JSON.parse(Buffer.from(header!, "base64url").toString()),
    claims: JSON.parse(Buffer.from(claims!, "base64url").toString()),
  };
}
