import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/u.exec(header);
  return match?.[1] ?? null;
}

export function isAuthorized(header: string | string[] | undefined, expected: string): boolean {
  const supplied = bearerToken(header);
  if (supplied === null) return false;
  return timingSafeEqual(digest(supplied), digest(expected));
}
