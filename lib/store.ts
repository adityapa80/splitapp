import { Redis } from "@upstash/redis";
import type { Group } from "./types";

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

export const storageMode: "redis" | "memory" = redis ? "redis" : "memory";

// In-memory fallback for local development. Survives hot reloads, not restarts.
type Entry = { v: unknown; exp?: number };
const g = globalThis as unknown as { __splitKv?: Map<string, Entry> };
const mem = (g.__splitKv ??= new Map());

function memGet(key: string): unknown {
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) {
    mem.delete(key);
    return null;
  }
  return e.v;
}

/** Minimal key-value API shared by Redis and the in-memory fallback. */
export const kv = {
  async get<T>(key: string): Promise<T | null> {
    if (redis) return (await redis.get<T>(key)) ?? null;
    const v = memGet(key);
    return v == null ? null : (structuredClone(v) as T);
  },
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (redis) {
      if (ttlSeconds) await redis.set(key, value, { ex: ttlSeconds });
      else await redis.set(key, value);
      return;
    }
    mem.set(key, { v: structuredClone(value), exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
  },
  async del(key: string): Promise<void> {
    if (redis) await redis.del(key);
    else mem.delete(key);
  },
  /** Increments a counter; the TTL starts when the counter is first created. */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    if (redis) {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, ttlSeconds);
      return n;
    }
    const cur = (memGet(key) as number | null) ?? 0;
    const existing = mem.get(key);
    const exp = cur && existing?.exp ? existing.exp : Date.now() + ttlSeconds * 1000;
    mem.set(key, { v: cur + 1, exp });
    return cur + 1;
  },
  async sadd(key: string, member: string): Promise<void> {
    if (redis) await redis.sadd(key, member);
    else mem.set(key, { v: [...new Set([...((memGet(key) as string[]) ?? []), member])] });
  },
  async srem(key: string, member: string): Promise<void> {
    if (redis) await redis.srem(key, member);
    else mem.set(key, { v: ((memGet(key) as string[]) ?? []).filter((m) => m !== member) });
  },
  async smembers(key: string): Promise<string[]> {
    if (redis) return await redis.smembers(key);
    return [...((memGet(key) as string[]) ?? [])];
  },
};

const groupKey = (id: string) => `group:${id}`;
const userGroupsKey = (email: string) => `user:${email}:groups`;

export function memberEmails(group: Group): Set<string> {
  return new Set(group.members.map((m) => m.email).filter((e): e is string => Boolean(e)));
}

export async function getGroup(id: string): Promise<Group | null> {
  return kv.get<Group>(groupKey(id));
}

/**
 * Saves a group and keeps the per-user index ("which groups is this email in")
 * in sync with the member list. Pass the emails from before the change.
 */
export async function saveGroup(group: Group, previousEmails: Set<string> = new Set()): Promise<void> {
  await kv.set(groupKey(group.id), group);
  const now = memberEmails(group);
  await Promise.all([
    ...[...now].filter((e) => !previousEmails.has(e)).map((e) => kv.sadd(userGroupsKey(e), group.id)),
    ...[...previousEmails].filter((e) => !now.has(e)).map((e) => kv.srem(userGroupsKey(e), group.id)),
  ]);
}

export async function listGroupsFor(email: string): Promise<Group[]> {
  const ids = await kv.smembers(userGroupsKey(email));
  const groups = await Promise.all(ids.map(getGroup));
  // Double-check membership in case the index is stale.
  return groups.filter((gr): gr is Group => Boolean(gr && memberEmails(gr).has(email)));
}

export function newId(len = 12): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
