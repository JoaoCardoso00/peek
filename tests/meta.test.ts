import { describe, expect, it } from "vitest";
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
    expect(await iceServers({})).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
    const withTurn = await iceServers({
      TURN_URL: "turn:a.example:3478, turns:a.example:5349",
      TURN_USERNAME: "u",
      TURN_CREDENTIAL: "p"
    });
    expect(withTurn[1]).toEqual({ urls: ["turn:a.example:3478", "turns:a.example:5349"], username: "u", credential: "p" });
  });
});
