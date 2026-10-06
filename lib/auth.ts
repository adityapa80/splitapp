import { cookies } from "next/headers";
import { kv, newId } from "./store";

export const SESSION_COOKIE = "split_session";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days
const CODE_TTL = 60 * 10; // 10 minutes
const MAX_CODE_ATTEMPTS = 5;

interface PendingCode {
  hash: string;
  attempts: number;
  expiresAt: number;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Returns true if the action is allowed, false if `key` has hit `max` within the window. */
export async function rateLimit(key: string, max: number, windowSeconds: number): Promise<boolean> {
  return (await kv.incr(`rl:${key}`, windowSeconds)) <= max;
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

/** Creates a fresh 6-digit sign-in code for this email, replacing any earlier one. */
export async function createLoginCode(email: string): Promise<string> {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  const code = String(n).padStart(6, "0");
  await kv.set(`login:${email}`, { hash: await sha256(`${email}:${code}`), attempts: 0, expiresAt: Date.now() + CODE_TTL * 1000 } satisfies PendingCode, CODE_TTL);
  return code;
}

export async function verifyLoginCode(email: string, code: string): Promise<"ok" | "invalid" | "expired"> {
  const key = `login:${email}`;
  const pending = await kv.get<PendingCode>(key);
  if (!pending || pending.expiresAt < Date.now()) return "expired";
  if (pending.hash === (await sha256(`${email}:${code.trim()}`))) {
    await kv.del(key);
    return "ok";
  }
  pending.attempts += 1;
  // Too many wrong guesses: throw the code away so it can't be brute-forced.
  if (pending.attempts >= MAX_CODE_ATTEMPTS) await kv.del(key);
  // Keep the original expiry; wrong guesses must not extend the code's lifetime.
  else await kv.set(key, pending, Math.max(1, Math.ceil((pending.expiresAt - Date.now()) / 1000)));
  return "invalid";
}

export async function startSession(email: string): Promise<void> {
  const token = newId(40);
  await kv.set(`session:${token}`, { email }, SESSION_TTL);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await kv.del(`session:${token}`);
  jar.delete(SESSION_COOKIE);
}

/** The signed-in user's email, or null. Works in server components and route handlers. */
export async function currentUser(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9]{20,64}$/.test(token)) return null;
  const session = await kv.get<{ email: string }>(`session:${token}`);
  return session?.email ?? null;
}
