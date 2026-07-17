import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE = /^v1=([0-9a-f]{64})$/;

export function signPhoneTurnRequest(rawBody: string, timestampSeconds: number, secret: string): string {
  if (Buffer.byteLength(secret) < 32) throw new Error("Phone-turn signing secret must be at least 32 bytes.");
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) throw new Error("Phone-turn timestamp is invalid.");
  return `v1=${createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex")}`;
}

export function verifyPhoneTurnRequest(input: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  secret: string;
  nowSeconds?: number;
  maximumSkewSeconds?: number;
}): boolean {
  if (Buffer.byteLength(input.secret) < 32) return false;
  const timestamp = Number(input.timestampHeader);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > (input.maximumSkewSeconds ?? 60)) return false;
  const supplied = input.signatureHeader?.match(SIGNATURE)?.[1];
  if (!supplied) return false;
  const expected = signPhoneTurnRequest(input.rawBody, timestamp, input.secret).slice(3);
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(supplied, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
