export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceEnv {
  STUN_URL?: string;
  TURN_URL?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  /** Cloudflare Realtime TURN key id + API token. When set, short-lived TURN creds are minted per request. */
  CF_TURN_KEY_ID?: string;
  CF_TURN_API_TOKEN?: string;
}

const CF_TURN_TTL_SECONDS = 6 * 60 * 60;
const CF_CACHE_MS = 30 * 60 * 1000;

let cached: { servers: IceServer[]; expires: number } | null = null;

function normalize(value: unknown): IceServer[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.filter((s): s is IceServer => typeof s === "object" && s !== null && "urls" in s);
}

async function cloudflareTurn(keyId: string, apiToken: string, now: number): Promise<IceServer[]> {
  if (cached && cached.expires > now) return cached.servers;
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: CF_TURN_TTL_SECONDS })
    }
  );
  if (!response.ok) {
    console.error(`Cloudflare TURN credential request failed: ${response.status}`);
    return [];
  }
  const body = (await response.json()) as { iceServers?: unknown };
  const servers = normalize(body.iceServers);
  cached = { servers, expires: now + CF_CACHE_MS };
  return servers;
}

export async function iceServers(env: IceEnv, now = Date.now()): Promise<IceServer[]> {
  const servers: IceServer[] = env.STUN_URL
    ? [{ urls: env.STUN_URL }]
    : [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    servers.push(...(await cloudflareTurn(env.CF_TURN_KEY_ID, env.CF_TURN_API_TOKEN, now)));
  } else if (env.TURN_URL) {
    const turn: IceServer = { urls: env.TURN_URL.split(",").map((u) => u.trim()) };
    if (env.TURN_USERNAME) turn.username = env.TURN_USERNAME;
    if (env.TURN_CREDENTIAL) turn.credential = env.TURN_CREDENTIAL;
    servers.push(turn);
  }
  return servers;
}
