import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TOKEN = "hostsecret_hostsecret_hostsecret";

async function hostRoom(room: string, name: string) {
  const response = await SELF.fetch(`https://peek.test/ws?room=${room}&role=host`, {
    headers: { Upgrade: "websocket" }
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const hosted = new Promise<void>((resolve) => {
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string" && JSON.parse(event.data).type === "hosted") resolve();
    });
  });
  ws.send(JSON.stringify({ type: "host", token: TOKEN, name, session: "sess1" }));
  await hosted;
  return ws;
}

describe("built app", () => {
  it("answers the health check", async () => {
    const response = await SELF.fetch("https://peek.test/health");
    expect(await response.json()).toEqual({ ok: true });
  });

  // Static files (/banner.png, /icon.svg) are answered by Cloudflare's asset layer before the
  // Worker runs, which SELF.fetch bypasses, so they are not asserted here.

  it("404s a malformed room id", async () => {
    const response = await SELF.fetch("https://peek.test/s/NOPE!");
    expect(response.status).toBe(404);
  });

  it("renders the private Discord room claim page", async () => {
    const response = await SELF.fetch("https://peek.test/claim/abc123");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Opening your room");
  });

  it("renders the landing page with Open Graph tags", async () => {
    const response = await SELF.fetch("https://peek.test/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('property="og:title"');
    expect(html).toContain("https://peek.test/banner.png");
  });

  it("renders a room page whose embed changes once the host is live", async () => {
    const before = await (await SELF.fetch("https://peek.test/s/embedroom")).text();
    expect(before).toContain("Someone&#x27;s screen");
    expect(before).toContain("#5865f2");

    const ws = await hostRoom("embedroom", "Joao");
    const after = await (await SELF.fetch("https://peek.test/s/embedroom")).text();
    expect(after).toContain("Joao is sharing their screen");
    expect(after).toContain("#da373c");
    expect(after).toContain("https://peek.test/banner.png"); // no thumbnail uploaded yet
    ws.close(1000, "done");
  });

  it("returns ICE servers", async () => {
    const response = await SELF.fetch("https://peek.test/api/ice");
    const body = (await response.json()) as { iceServers: Array<{ urls: string }> };
    expect(body.iceServers[0]?.urls).toContain("stun:");
  });

  it("redirects a missing thumbnail to the banner and stores an uploaded one", async () => {
    const missing = await SELF.fetch("https://peek.test/t/thumbroom/thumb.jpg", { redirect: "manual" });
    expect(missing.status).toBe(302);
    expect(missing.headers.get("location")).toBe("/banner.png");

    const ws = await hostRoom("thumbroom", "H");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const denied = await SELF.fetch("https://peek.test/t/thumbroom/thumb.jpg", {
      method: "PUT",
      headers: { "content-type": "image/jpeg", "x-peek-token": "wrongtoken_wrongtoken_wrong" },
      body: jpeg
    });
    expect(denied.status).toBe(403);
    const stored = await SELF.fetch("https://peek.test/t/thumbroom/thumb.jpg", {
      method: "PUT",
      headers: { "content-type": "image/jpeg", "x-peek-token": TOKEN },
      body: jpeg
    });
    expect(stored.status).toBe(204);

    const served = await SELF.fetch("https://peek.test/t/thumbroom/thumb.jpg");
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(jpeg);

    const page = await (await SELF.fetch("https://peek.test/s/thumbroom")).text();
    expect(page).toContain("https://peek.test/t/thumbroom/thumb.jpg?v=sess1");
    ws.close(1000, "done");
  });

  it("rejects bad room ids on the websocket entry", async () => {
    const response = await SELF.fetch("https://peek.test/ws?room=NOPE!&role=host", { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(400);
  });
});
