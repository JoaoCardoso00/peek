import { describe, expect, it, vi } from "vitest";
import { CandidateQueue, type IceCandidateTarget } from "../src/app/rtc";
import { iceServers } from "../src/lib/ice";
import { metaTags, originOf, roomMeta } from "../src/lib/meta";
import { safeName } from "../src/lib/names";

describe("roomMeta", () => {
  it("describes a live room with its thumbnail and cache-buster", () => {
    const meta = roomMeta(
      { hostName: "Joao", live: true, started: true, session: "k9", viewers: 3, hasThumb: true },
      "https://peek.example",
      "abc123"
    );
    expect(meta.title).toBe("Joao is sharing their screen");
    expect(meta.description).toBe("3 people watching. Tap to watch, no login needed.");
    expect(meta.image).toBe("https://peek.example/t/abc123/thumb.jpg?v=k9");
    expect(meta.themeColor).toBe("#da373c");
  });

  it("falls back to the banner when nothing is live", () => {
    const meta = roomMeta(null, "https://peek.example", "abc123");
    expect(meta.title).toBe("Someone's screen");
    expect(meta.image).toBe("https://peek.example/banner.png");
    expect(metaTags(meta).find((t) => t.property === "og:image")?.content).toBe(meta.image);
  });

  it("derives the origin from proxy headers or PUBLIC_URL", () => {
    const request = new Request("http://internal/s/x", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "peek.example" }
    });
    expect(originOf(request)).toBe("https://peek.example");
    expect(originOf(request, "https://custom.example/")).toBe("https://custom.example");
  });
});

describe("safeName", () => {
  it("strips control characters, trims, and caps length", () => {
    expect(safeName("  Jo\u0000ao  ", "x")).toBe("Joao");
    expect(safeName("", "Guest 1")).toBe("Guest 1");
    expect(safeName(42, "Guest 1")).toBe("Guest 1");
    expect(safeName("a".repeat(50), "x")).toHaveLength(32);
  });
});

describe("iceServers", () => {
  it("returns STUN only by default and adds a static TURN when configured", async () => {
    expect(await iceServers({})).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.l.google.com:19302" }
    ]);
    const withTurn = await iceServers({
      TURN_URL: "turn:a.example:3478, turns:a.example:5349",
      TURN_USERNAME: "u",
      TURN_CREDENTIAL: "p"
    });
    expect(withTurn[2]).toEqual({ urls: ["turn:a.example:3478", "turns:a.example:5349"], username: "u", credential: "p" });
  });

  it("fails closed when Cloudflare TURN usage cannot be verified", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => new Response("no", { status: 403 }));
    const servers = await iceServers(
      {
        CF_TURN_KEY_ID: "turn-key",
        CF_TURN_API_TOKEN: "turn-token",
        CF_ACCOUNT_ID: "a".repeat(32),
        CF_ANALYTICS_API_TOKEN: "analytics-token"
      },
      Date.UTC(2026, 7, 24),
      fetcher
    );
    expect(servers.every((server) => !String(server.urls).startsWith("turn"))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("mints two-hour TURN credentials below the cutoff and removes browser-blocked port 53", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/graphql")) {
        return Response.json({
          data: { viewer: { accounts: [{ usage: [{ sum: { egressBytes: 100_000_000_000 } }] }] } }
        });
      }
      expect(JSON.parse(String(init?.body))).toEqual({ ttl: 7200 });
      return Response.json({
        iceServers: [
          {
            urls: [
              "turn:turn.cloudflare.com:53?transport=udp",
              "turn:turn.cloudflare.com:3478?transport=udp",
              "turns:turn.cloudflare.com:5349?transport=tcp"
            ],
            username: "u",
            credential: "p"
          }
        ]
      });
    });
    const servers = await iceServers(
      {
        CF_TURN_KEY_ID: "turn-key",
        CF_TURN_API_TOKEN: "turn-token",
        CF_ACCOUNT_ID: "a".repeat(32),
        CF_ANALYTICS_API_TOKEN: "analytics-token"
      },
      Date.UTC(2026, 7, 24),
      fetcher
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(servers[2]).toEqual({
      urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"],
      username: "u",
      credential: "p"
    });
  });

  it("does not mint TURN credentials after 750 GB of egress", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetcher = vi.fn(async () =>
      Response.json({
        data: { viewer: { accounts: [{ usage: [{ sum: { egressBytes: 750_000_000_000 } }] }] } }
      })
    );
    const servers = await iceServers(
      {
        CF_TURN_KEY_ID: "turn-key",
        CF_TURN_API_TOKEN: "turn-token",
        CF_ACCOUNT_ID: "a".repeat(32),
        CF_ANALYTICS_API_TOKEN: "analytics-token"
      },
      Date.UTC(2026, 7, 24),
      fetcher
    );
    expect(servers).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe("CandidateQueue", () => {
  it("keeps trickled candidates that arrive before the offer", async () => {
    const added: RTCIceCandidateInit[] = [];
    const target: IceCandidateTarget = {
      remoteDescription: { type: "offer", sdp: "v=0" },
      addIceCandidate: async (candidate) => {
        if (candidate) added.push(candidate);
      }
    };
    const queue = new CandidateQueue();
    const candidate = { candidate: "candidate:1 1 udp 1 203.0.113.1 5000 typ srflx" };
    await queue.add(candidate);
    queue.attach(target);
    await queue.flush();
    expect(added).toEqual([candidate]);
  });
});
