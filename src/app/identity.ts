/*
 * Everything about "who am I" lives in localStorage. There are no accounts.
 * A person owns a room if their browser holds the room's secret token.
 */

const ROOMS_KEY = "peek.rooms";
const HOME_KEY = "peek.home";
const NAME_KEY = "peek.name";

export interface Home {
  id: string;
  token: string;
}

function randomString(length: number, alphabet: string): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function readRooms(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ROOMS_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeRooms(rooms: Record<string, string>): void {
  localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
}

export function tokenFor(id: string): string | null {
  return readRooms()[id] ?? null;
}

export function claimRoom(id: string, token: string): void {
  const rooms = readRooms();
  rooms[id] = token;
  writeRooms(rooms);
  localStorage.setItem(HOME_KEY, id);
}

export function getHome(): Home | null {
  const id = localStorage.getItem(HOME_KEY);
  if (!id) return null;
  const token = tokenFor(id);
  return token ? { id, token } : null;
}

export function createHome(): Home {
  const home: Home = {
    id: randomString(10, "abcdefghijklmnopqrstuvwxyz0123456789"),
    token: randomString(32, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
  };
  const rooms = readRooms();
  rooms[home.id] = home.token;
  writeRooms(rooms);
  localStorage.setItem(HOME_KEY, home.id);
  return home;
}

export function getOrCreateHome(): Home {
  return getHome() ?? createHome();
}

export function getName(): string {
  return localStorage.getItem(NAME_KEY) ?? "";
}

export function setName(name: string): void {
  const trimmed = name.trim().slice(0, 32);
  if (trimmed) localStorage.setItem(NAME_KEY, trimmed);
  else localStorage.removeItem(NAME_KEY);
}

// ---- stream settings ----

export type Resolution = "720" | "1080" | "source";
export type Optimize = "auto" | "motion" | "detail";

export interface StreamSettings {
  resolution: Resolution;
  fps: 30 | 60;
  optimize: Optimize;
  audio: boolean;
}

const SETTINGS_KEY = "peek.settings";

export const DEFAULT_SETTINGS: StreamSettings = { resolution: "1080", fps: 60, optimize: "auto", audio: true };

export function getSettings(): StreamSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<StreamSettings> | null;
    return { ...DEFAULT_SETTINGS, ...(parsed ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(settings: StreamSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
