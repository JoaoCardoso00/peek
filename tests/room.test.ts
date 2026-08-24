import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type Frame = Record<string, unknown> & { type: string };

const TOKEN = "hostsecret_hostsecret_hostsecret";

/** Opens a WebSocket to the test worker and gives back a tiny inbox to await frames. */
async function open(room: string, role: "host" | "viewer", name?: string, viewerKey?: string) {
  const url = new URL("https://peek.test/ws");
  url.searchParams.set("room", room);
  url.searchParams.set("role", role);
  if (name) url.searchParams.set("name", name);
  if (role === "viewer" && viewerKey) url.searchParams.set("viewer", viewerKey);
  const response = await SELF.fetch(url, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();

  const inbox: Frame[] = [];
  const waiters: Array<(f: Frame) => void> = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || event.data === "pong") return;
    const frame = JSON.parse(event.data) as Frame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else inbox.push(frame);
  });

  const next = (): Promise<Frame> => {
    const queued = inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), 2000);
      waiters.push((f) => {
        clearTimeout(timer);
        resolve(f);
      });
    });
  };
  const until = async (type: string): Promise<Frame> => {
    for (;;) {
      const frame = await next();
      if (frame.type === type) return frame;
    }
  };
  const send = (frame: Frame) => ws.send(JSON.stringify(frame));
  return { ws, next, until, send };
}

async function snapshot(room: string) {
  const response = await SELF.fetch(`https://peek.test/snapshot?room=${room}`);
  return (await response.json()) as { hostName: string; live: boolean; viewers: number; hasThumb: boolean };
}

describe("room signaling", () => {
  it("rejects a non-websocket request", async () => {
    const response = await SELF.fetch("https://peek.test/ws?room=abc123&role=host");
    expect(response.status).toBe(426);
  });

  it("tells an early viewer to wait, then flips to live when the host arrives", async () => {
    const room = "waitroom1";
    const viewer = await open(room, "viewer", "Ana");
    const state = await viewer.until("state");
    expect(state.live).toBe(false);
    expect(state.you).toBeTypeOf("string");
    expect(await snapshot(room)).toMatchObject({ live: false, viewers: 1 });

    const host = await open(room, "host");
    host.send({ type: "host", token: TOKEN, name: "Joao", session: "abc" });
    const hosted = await host.until("hosted");
    expect((hosted.viewers as Array<{ name: string }>).map((v) => v.name)).toEqual(["Ana"]);

    const live = await viewer.until("state");
    expect(live).toMatchObject({ live: true, hostName: "Joao", session: "abc" });
    expect(await snapshot(room)).toMatchObject({ live: true, hostName: "Joao", viewers: 1 });
  });

  it("relays SDP and ICE between the host and one viewer, and only that viewer", async () => {
    const room = "relayroom";
    const host = await open(room, "host");
    host.send({ type: "host", token: TOKEN, name: "Host", session: "s1" });
    await host.until("hosted");

    const a = await open(room, "viewer", "A");
    const aState = await a.until("state");
    const b = await open(room, "viewer", "B");
    await b.until("state");
    const joinedA = await host.until("viewer-joined");
    expect(joinedA.id).toBe(aState.you);
    await host.until("viewer-joined");

    host.send({ type: "signal", to: aState.you, data: { sdp: { type: "offer", sdp: "v=0" } } });
    const offer = await a.until("signal");
    expect(offer.from).toBe("host");
    expect(offer.data).toEqual({ sdp: { type: "offer", sdp: "v=0" } });

    a.send({ type: "signal", data: { candidate: { candidate: "cand", sdpMid: "0" } } });
    const cand = await host.until("signal");
    expect(cand.from).toBe(aState.you);

    // B must never see A's offer. Give it a moment to prove nothing shows up.
    b.send({ type: "name", name: "Bee" });
    let names: string[] = [];
    while (!names.includes("Bee")) {
      const frame = await b.until("viewers");
      names = (frame.viewers as Array<{ name: string }>).map((v) => v.name).sort();
    }
    expect(names).toEqual(["A", "Bee"]);
  });

  it("counts tabs from the same browser once while signaling every connection", async () => {
    const room = "sametabs";
    const viewerKey = "same_browser_viewer_123";
    const first = await open(room, "viewer", "Ana", viewerKey);
    const second = await open(room, "viewer", "Ana", viewerKey);
    expect(await first.until("state")).toMatchObject({ you: viewerKey });
    expect(await second.until("state")).toMatchObject({ you: viewerKey });
    expect(await snapshot(room)).toMatchObject({ viewers: 1 });

    const host = await open(room, "host");
    host.send({ type: "host", token: TOKEN, name: "Host", session: "tabs" });
    const hosted = await host.until("hosted");
    expect(hosted.viewers).toEqual([{ id: viewerKey, name: "Ana" }]);
    const connections = hosted.connections as Array<{ id: string; name: string }>;
    expect(connections).toHaveLength(2);
    expect(new Set(connections.map(({ id }) => id)).size).toBe(2);
  });

  it("refuses a second host with the wrong token, and hands over to the same token in a new tab", async () => {
    const room = "ownership";
    const host = await open(room, "host");
    host.send({ type: "host", token: TOKEN, name: "Owner", session: "s1" });
    await host.until("hosted");

    const impostor = await open(room, "host");
    impostor.send({ type: "host", token: "someoneelse_someoneelse_x", name: "Nope", session: "s2" });
    const refused = await impostor.until("error");
    expect(refused.code).toBe("taken");
    expect(await snapshot(room)).toMatchObject({ live: true, hostName: "Owner" });

    const newTab = await open(room, "host");
    newTab.send({ type: "host", token: TOKEN, name: "Owner", session: "s3" });
    const replaced = await host.until("error");
    expect(replaced.code).toBe("replaced");
    await newTab.until("hosted");
    expect(await snapshot(room)).toMatchObject({ live: true });
  });

  it("ends the stream for viewers when the host disconnects", async () => {
    const room = "byebye";
    const host = await open(room, "host");
    host.send({ type: "host", token: TOKEN, name: "H", session: "s1" });
    await host.until("hosted");
    const viewer = await open(room, "viewer");
    await viewer.until("state");
    await host.until("viewer-joined");

    host.ws.close(1000, "done");
    const ended = await viewer.until("ended");
    expect(ended.type).toBe("ended");
    expect(await snapshot(room)).toMatchObject({ live: false, viewers: 1 });
  });

  it("stores a thumbnail only for the live owner", async () => {
    const room = "thumbroom";
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const put = (token: string) =>
      SELF.fetch(`https://peek.test/thumb?room=${room}`, {
        method: "PUT",
        headers: { "x-peek-token": token },
        body: jpeg
      }).then((r) => r.text());

    expect(await put(TOKEN)).toBe("forbidden"); // nobody owns the room yet

    const host = await open(room, "host");
    host.send({ type: "host", token: TOKEN, name: "H", session: "s1" });
    await host.until("hosted");
    expect(await put("wrongtoken_wrongtoken_wrong")).toBe("forbidden");
    expect(await put(TOKEN)).toBe("ok");
    expect(await snapshot(room)).toMatchObject({ hasThumb: true });

    host.send({ type: "stop" });
    await new Promise((r) => setTimeout(r, 50));
    expect(await put(TOKEN)).toBe("not-live");
  });
});
