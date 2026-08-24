export const ROOM_ID = /^[a-z0-9]{6,16}$/;
export const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
export const SESSION = /^[a-z0-9]{1,20}$/;

export function safeName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const name = value.replace(/\p{Cc}/gu, "").trim().slice(0, 32);
  return name.length > 0 ? name : fallback;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
