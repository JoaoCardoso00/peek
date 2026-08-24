import { describe, expect, it } from "vitest";
import { discordRoomMessage, handleDiscordInteraction, verifyDiscordSignature } from "../src/lib/discord";
import type { RoomDO } from "../src/do/room";

describe("Discord interactions", () => {
  it("verifies Discord's Ed25519 request signature", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
    const body = JSON.stringify({ type: 1 });
    const timestamp = "1724457600";
    const signature = hex(
      new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body)))
    );
    const headers = new Headers({ "x-signature-ed25519": signature, "x-signature-timestamp": timestamp });

    expect(await verifyDiscordSignature(headers, body, publicKey)).toBe(true);
    expect(await verifyDiscordSignature(headers, `${body} `, publicKey)).toBe(false);
  });

  it("answers Discord's signed ping and rejects commands from another guild", async () => {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = hex(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
    const bindings = {
      DISCORD_PUBLIC_KEY: publicKey,
      DISCORD_GUILD_IDS: "friends, second-server",
      ROOMS: {} as DurableObjectNamespace<RoomDO>
    };

    const ping = await signedRequest({ type: 1 }, keys.privateKey);
    const pingResponse = await handleDiscordInteraction(ping, bindings, () => undefined);
    expect(await pingResponse.json()).toEqual({ type: 1 });

    const outsider = await signedRequest(
      {
        type: 2,
        id: "1",
        application_id: "2",
        token: "x",
        guild_id: "somewhere-else",
        channel_id: "3",
        data: { name: "share" }
      },
      keys.privateKey
    );
    const outsiderResponse = await handleDiscordInteraction(outsider, bindings, () => undefined);
    expect(await outsiderResponse.json()).toMatchObject({
      type: 4,
      data: { content: "This private Peek bot only works in its configured servers." }
    });

    const allowed = await signedRequest(
      {
        type: 2,
        id: "1",
        application_id: "2",
        token: "x",
        guild_id: "second-server",
        channel_id: "3",
        data: { name: "share" }
      },
      keys.privateKey
    );
    const allowedResponse = await handleDiscordInteraction(allowed, bindings, () => undefined);
    expect(await allowedResponse.json()).toMatchObject({
      type: 4,
      data: { content: "The Peek bot is missing its bot token or cannot see this channel." }
    });
  });

  it("builds live, waiting, and ended room cards", () => {
    const base = { hostName: "Ana", session: "s1", viewers: 0, hasThumb: false };
    const waiting = discordRoomMessage({ ...base, live: false, started: false }, "https://peek.example/s/abc123");
    const live = discordRoomMessage({ ...base, live: true, started: true, viewers: 2 }, "https://peek.example/s/abc123");
    const ended = discordRoomMessage({ ...base, live: false, started: true }, "https://peek.example/s/abc123");

    expect(waiting.embeds[0]!.title).toBe("Ana is getting ready to share");
    expect(live.embeds[0]!).toMatchObject({ title: "Ana is sharing their screen", description: "2 people watching" });
    expect(ended.embeds[0]!.title).toBe("Ana's stream ended");
  });
});

async function signedRequest(payload: unknown, privateKey: CryptoKey): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = "1724457600";
  const signature = hex(
    new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(timestamp + body)))
  );
  return new Request("https://peek.test/api/discord/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp
    },
    body
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
