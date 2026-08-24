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
  /** Account Analytics credentials used by the fail-closed TURN spending guard. */
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_API_TOKEN?: string;
  /** May lower the cutoff, but cannot raise it above the safe default. */
  TURN_EGRESS_LIMIT_GB?: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const TURN_EGRESS_LIMIT_GB = 750;
const CF_TURN_TTL_SECONDS = 2 * 60 * 60;
const TURN_USAGE_WINDOW_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

interface TurnAnalyticsResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        usage?: Array<{ sum?: { egressBytes?: number } }>;
      }>;
    };
  };
  errors?: unknown[];
}

function normalize(value: unknown): IceServer[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.flatMap((value): IceServer[] => {
    if (typeof value !== "object" || value === null || !("urls" in value)) return [];
    const candidate = value as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = Array.isArray(candidate.urls)
      ? candidate.urls.filter((url): url is string => typeof url === "string")
      : typeof candidate.urls === "string"
        ? candidate.urls
        : null;
    if (!urls || (Array.isArray(urls) && urls.length === 0)) return [];
    if (candidate.username !== undefined && typeof candidate.username !== "string") return [];
    if (candidate.credential !== undefined && typeof candidate.credential !== "string") return [];
    return [{ urls, username: candidate.username, credential: candidate.credential }];
  });
}

function withoutBrowserBlockedPort(servers: IceServer[]): IceServer[] {
  return servers.flatMap((server) => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => !/:53(?:\?|$)/.test(url));
    return urls.length ? [{ ...server, urls }] : [];
  });
}

function configuredLimitBytes(env: IceEnv): number {
  const requested = Number(env.TURN_EGRESS_LIMIT_GB ?? TURN_EGRESS_LIMIT_GB);
  const gb = Number.isFinite(requested) && requested >= 0 ? Math.min(requested, TURN_EGRESS_LIMIT_GB) : TURN_EGRESS_LIMIT_GB;
  return gb * 1_000_000_000;
}

async function turnEgressBytes(env: IceEnv, now: number, fetcher: Fetcher): Promise<number | null> {
  const accountId = env.CF_ACCOUNT_ID ?? "";
  const apiToken = env.CF_ANALYTICS_API_TOKEN ?? "";
  if (!ACCOUNT_ID.test(accountId) || !apiToken) return null;

  const dateFrom = new Date(now - TURN_USAGE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const dateTo = new Date(now).toISOString().slice(0, 10);
  const query = `query TurnUsage {
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        usage: callsTurnUsageAdaptiveGroups(
          limit: 1000
          filter: { date_geq: "${dateFrom}", date_leq: "${dateTo}" }
        ) {
          dimensions { datetimeHour }
          sum { egressBytes }
        }
      }
    }
  }`;

  try {
    const response = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    if (!response.ok) return null;
    const body = (await response.json()) as TurnAnalyticsResponse;
    if (body.errors?.length) return null;
    const usage = body.data?.viewer?.accounts?.[0]?.usage;
    if (!usage) return null;
    return usage.reduce((total, row) => {
      const bytes = row.sum?.egressBytes;
      return total + (typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0);
    }, 0);
  } catch {
    return null;
  }
}

async function cloudflareTurn(keyId: string, apiToken: string, fetcher: Fetcher): Promise<IceServer[]> {
  const response = await fetcher(
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
  return withoutBrowserBlockedPort(normalize(body.iceServers));
}

export async function iceServers(env: IceEnv, now = Date.now(), fetcher: Fetcher = fetch): Promise<IceServer[]> {
  const servers: IceServer[] = env.STUN_URL
    ? [{ urls: env.STUN_URL }]
    : [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    const used = await turnEgressBytes(env, now, fetcher);
    const limit = configuredLimitBytes(env);
    if (used === null) {
      console.error(JSON.stringify({ message: "TURN disabled because usage could not be verified" }));
      return servers;
    }
    if (used >= limit) {
      console.warn(JSON.stringify({ message: "TURN egress cutoff reached", used, limit }));
      return servers;
    }
    servers.push(...(await cloudflareTurn(env.CF_TURN_KEY_ID, env.CF_TURN_API_TOKEN, fetcher)));
  } else if (env.TURN_URL) {
    const turn: IceServer = { urls: env.TURN_URL.split(",").map((u) => u.trim()) };
    if (env.TURN_USERNAME) turn.username = env.TURN_USERNAME;
    if (env.TURN_CREDENTIAL) turn.credential = env.TURN_CREDENTIAL;
    servers.push(turn);
  }
  return servers;
}
