import { DurableObject } from "cloudflare:workers";
import { updateDiscordRoomMessage, type DiscordMessageRef } from "../lib/discord";
import type { RoomSnapshot } from "../lib/meta";
import { SESSION, TOKEN, hashToken, safeName, sameHash } from "../lib/names";

/*
 * One Durable Object per room. Holds the host's WebSocket, every viewer's
 * WebSocket, and the small amount of state the page and the Discord embed need.
 *
 * Wire protocol. Every frame is one JSON object with a `type`.
 *
 * Connect:  GET /ws?room=<id>&role=host
 *           GET /ws?room=<id>&role=viewer&name=<optional>&viewer=<stable-browser-id>
 *
 * host   -> server : { type: "host", token, name, session }
 * both   -> server : { type: "signal", to?, data }      data = { sdp } | { candidate }
 * both   -> server : { type: "name", name }
 * host   -> server : { type: "stop" }
 * both   -> server : "ping"                              answered with "pong" without waking the object
 *
 * server -> host   : { type: "hosted", viewers: Viewer[], connections: ViewerConnection[] }
 * server -> host   : { type: "viewer-joined", id, name }
 * server -> host   : { type: "viewer-left", id }
 * server -> viewer : { type: "state", live, hostName, session, viewers: Viewer[], you }
 * server -> viewer : { type: "ended" }
 * server -> all    : { type: "viewers", viewers: Viewer[] }
 * server -> all    : { type: "signal", from, data }
 * server -> all    : { type: "error", code, message }
 */

export interface Viewer {
  id: string;
  name: string;
}

interface RoomState {
  tokenHash: string | null;
  hostName: string;
  live: boolean;
  session: string;
  startedAt: number | null;
}

type HostAttachment = { role: "host"; verified: boolean };
type ViewerAttachment = { role: "viewer"; id: string; viewerKey?: string; name: string };
type Attachment = HostAttachment | ViewerAttachment;

interface ViewerConnection {
  id: string;
  name: string;
}

const DEFAULT_STATE: RoomState = {
  tokenHash: null,
  hostName: "Someone",
  live: false,
  session: "0",
  startedAt: null
};

export const MAX_VIEWERS = 50;
/** Durable Object storage caps a single value at 128 KiB. */
export const MAX_THUMB_BYTES = 120_000;
const IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FRAME = 64 * 1024;
const DISCORD_SYNC_DELAY_MS = 750;
const VIEWER_KEY = /^[A-Za-z0-9_-]{16,64}$/;

export class RoomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---- state helpers ----

  private async state(): Promise<RoomState> {
    return (await this.ctx.storage.get<RoomState>("state")) ?? { ...DEFAULT_STATE };
  }

  private async save(state: RoomState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  private hostSocket(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets("host")) {
      const att = this.attachment(ws);
      if (att?.role === "host" && att.verified) return ws;
    }
    return null;
  }

  private viewerSockets(): Array<{ ws: WebSocket; att: ViewerAttachment }> {
    const out: Array<{ ws: WebSocket; att: ViewerAttachment }> = [];
    for (const ws of this.ctx.getWebSockets("viewer")) {
      const att = this.attachment(ws);
      if (att?.role === "viewer") out.push({ ws, att });
    }
    return out;
  }

  private viewers(): Viewer[] {
    const unique = new Map<string, Viewer>();
    for (const { att } of this.viewerSockets()) {
      const viewerKey = att.viewerKey ?? att.id;
      if (!unique.has(viewerKey)) unique.set(viewerKey, { id: viewerKey, name: att.name });
    }
    return [...unique.values()];
  }

  private viewerConnections(): ViewerConnection[] {
    return this.viewerSockets().map(({ att }) => ({ id: att.id, name: att.name }));
  }

  private send(ws: WebSocket, frame: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // Socket already gone. The close handler cleans up.
    }
  }

  private stateFrame(state: RoomState, you: string) {
    return {
      type: "state",
      live: state.live,
      hostName: state.hostName,
      session: state.session,
      viewers: this.viewers(),
      you
    };
  }

  private broadcastViewers(): void {
    const frame = { type: "viewers", viewers: this.viewers() };
    const host = this.hostSocket();
    if (host) this.send(host, frame);
    for (const { ws } of this.viewerSockets()) this.send(ws, frame);
    this.discordChanged();
  }

  private async endStream(state: RoomState): Promise<void> {
    if (!state.live) return;
    state.live = false;
    await this.save(state);
    for (const { ws } of this.viewerSockets()) this.send(ws, { type: "ended" });
    this.discordChanged();
  }

  // ---- RPC used by the Worker ----

  async snapshot(): Promise<RoomSnapshot> {
    const state = await this.state();
    const hasThumb = (await this.ctx.storage.get<ArrayBuffer>("thumb")) !== undefined;
    return {
      hostName: state.hostName,
      live: state.live,
      started: state.startedAt !== null,
      session: state.session,
      viewers: this.viewers().length,
      hasThumb
    };
  }

  async createFromDiscord(token: string, name: string): Promise<boolean> {
    if (!TOKEN.test(token)) return false;
    const state = await this.state();
    if (state.tokenHash !== null) return false;
    state.tokenHash = await hashToken(token);
    state.hostName = safeName(name, "Someone");
    await this.save(state);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
    return true;
  }

  async linkDiscordMessage(ref: DiscordMessageRef): Promise<void> {
    const refs = (await this.ctx.storage.get<DiscordMessageRef[]>("discordMessages")) ?? [];
    const withoutDuplicate = refs.filter((item) => item.messageId !== ref.messageId);
    await this.ctx.storage.put("discordMessages", [...withoutDuplicate, ref].slice(-5));
    await this.scheduleDiscordSync();
  }

  async putThumb(token: string, bytes: ArrayBuffer): Promise<"ok" | "forbidden" | "too-large" | "not-live"> {
    if (bytes.byteLength > MAX_THUMB_BYTES) return "too-large";
    const state = await this.state();
    if (!state.tokenHash || !TOKEN.test(token)) return "forbidden";
    if (!sameHash(state.tokenHash, await hashToken(token))) return "forbidden";
    if (!state.live) return "not-live";
    await this.ctx.storage.put("thumb", bytes);
    const syncedSession = await this.ctx.storage.get<string>("discordThumbSession");
    if (syncedSession !== state.session) {
      await this.ctx.storage.put("discordThumbSession", state.session);
      this.discordChanged();
    }
    return "ok";
  }

  async getThumb(): Promise<ArrayBuffer | null> {
    return (await this.ctx.storage.get<ArrayBuffer>("thumb")) ?? null;
  }

  // ---- WebSocket lifecycle ----

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "viewer") {
      return new Response("role must be host or viewer", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (role === "host") {
      server.serializeAttachment({ role: "host", verified: false } satisfies HostAttachment);
      this.ctx.acceptWebSocket(server, ["host"]);
      return new Response(null, { status: 101, webSocket: client });
    }

    const existing = this.viewerSockets();
    const id = crypto.randomUUID();
    const requestedViewerKey = url.searchParams.get("viewer") ?? "";
    const viewerKey = VIEWER_KEY.test(requestedViewerKey) ? requestedViewerKey : id;
    const sameViewer = existing.find(({ att }) => (att.viewerKey ?? att.id) === viewerKey);
    const att: ViewerAttachment = {
      role: "viewer",
      id,
      viewerKey,
      name: safeName(url.searchParams.get("name"), sameViewer?.att.name ?? `Guest ${this.viewers().length + 1}`)
    };
    server.serializeAttachment(att);
    this.ctx.acceptWebSocket(server, ["viewer"]);

    if (existing.length >= MAX_VIEWERS) {
      this.send(server, { type: "error", code: "full", message: "This stream is full." });
      server.close(1008, "full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const state = await this.state();
    this.send(server, this.stateFrame(state, viewerKey));
    const host = this.hostSocket();
    if (host) this.send(host, { type: "viewer-joined", id: att.id, name: att.name });
    this.broadcastViewers();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (message.length > MAX_FRAME) return ws.close(1009, "frame too large");
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return this.send(ws, { type: "error", code: "bad-json", message: "Frames must be JSON." });
    }
    if (typeof frame !== "object" || frame === null) return;
    const att = this.attachment(ws);
    if (!att) return;
    await this.handle(ws, att, frame as Record<string, unknown>);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  async alarm(): Promise<void> {
    if (await this.ctx.storage.get<boolean>("discordSyncDue")) {
      await this.ctx.storage.delete("discordSyncDue");
      await this.syncDiscordMessages();
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
      return;
    }
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
    }
  }

  private discordChanged(): void {
    this.ctx.waitUntil(this.scheduleDiscordSync());
  }

  private async scheduleDiscordSync(): Promise<void> {
    const refs = await this.ctx.storage.get<DiscordMessageRef[]>("discordMessages");
    if (!refs?.length || !this.env.DISCORD_BOT_TOKEN) return;
    await this.ctx.storage.put("discordSyncDue", true);
    await this.ctx.storage.setAlarm(Date.now() + DISCORD_SYNC_DELAY_MS);
  }

  private async syncDiscordMessages(): Promise<void> {
    const token = this.env.DISCORD_BOT_TOKEN;
    const refs = (await this.ctx.storage.get<DiscordMessageRef[]>("discordMessages")) ?? [];
    if (!token || refs.length === 0) return;
    const snapshot = await this.snapshot();
    const results = await Promise.all(refs.map((ref) => updateDiscordRoomMessage(ref, snapshot, token)));
    const kept = refs.filter((_, index) => results[index] !== "gone");
    if (kept.length !== refs.length) await this.ctx.storage.put("discordMessages", kept);
  }

  private async leave(ws: WebSocket): Promise<void> {
    const att = this.attachment(ws);
    if (!att) return;
    if (att.role === "host") {
      if (!att.verified) return;
      ws.serializeAttachment({ role: "host", verified: false } satisfies HostAttachment);
      await this.endStream(await this.state());
      return;
    }
    // The closed socket is already gone from getWebSockets(), so lists are fresh.
    const host = this.hostSocket();
    if (host) this.send(host, { type: "viewer-left", id: att.id });
    this.broadcastViewers();
  }

  private async handle(ws: WebSocket, att: Attachment, frame: Record<string, unknown>): Promise<void> {
    switch (frame.type) {
      case "host": {
        if (att.role !== "host") return;
        const token = String(frame.token ?? "");
        if (!TOKEN.test(token)) {
          return this.send(ws, { type: "error", code: "bad-request", message: "Invalid token." });
        }
        const state = await this.state();
        const hash = await hashToken(token);
        if (state.tokenHash === null) {
          state.tokenHash = hash;
        } else if (!sameHash(state.tokenHash, hash)) {
          return this.send(ws, { type: "error", code: "taken", message: "Someone else owns this link." });
        }
        const previous = this.hostSocket();
        if (previous && previous !== ws) {
          // The newer tab wins. Demote the old socket first so its close handler doesn't end the new stream.
          previous.serializeAttachment({ role: "host", verified: false } satisfies HostAttachment);
          this.send(previous, { type: "error", code: "replaced", message: "You started sharing from another tab." });
          previous.close(1000, "replaced");
        }
        ws.serializeAttachment({ role: "host", verified: true } satisfies HostAttachment);
        state.hostName = safeName(frame.name, state.hostName);
        const session = String(frame.session ?? "");
        state.session = SESSION.test(session) ? session : Date.now().toString(36);
        await this.ctx.storage.delete(["thumb", "discordThumbSession"]);
        state.live = true;
        state.startedAt = Date.now();
        await this.save(state);
        await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS);
        this.send(ws, { type: "hosted", viewers: this.viewers(), connections: this.viewerConnections() });
        for (const viewer of this.viewerSockets()) {
          this.send(viewer.ws, this.stateFrame(state, viewer.att.viewerKey ?? viewer.att.id));
        }
        this.discordChanged();
        return;
      }
      case "signal": {
        if (att.role === "host") {
          if (!att.verified) return;
          const to = String(frame.to ?? "");
          const target = this.viewerSockets().find((v) => v.att.id === to);
          if (target) this.send(target.ws, { type: "signal", from: "host", data: frame.data });
        } else {
          const host = this.hostSocket();
          if (host) this.send(host, { type: "signal", from: att.id, data: frame.data });
        }
        return;
      }
      case "name": {
        if (att.role === "host") {
          if (!att.verified) return;
          const state = await this.state();
          state.hostName = safeName(frame.name, state.hostName);
          await this.save(state);
          for (const viewer of this.viewerSockets()) {
            this.send(viewer.ws, this.stateFrame(state, viewer.att.viewerKey ?? viewer.att.id));
          }
          this.discordChanged();
        } else {
          const name = safeName(frame.name, att.name);
          const viewerKey = att.viewerKey ?? att.id;
          for (const viewer of this.viewerSockets()) {
            if ((viewer.att.viewerKey ?? viewer.att.id) === viewerKey) {
              viewer.ws.serializeAttachment({ ...viewer.att, name } satisfies ViewerAttachment);
            }
          }
          this.broadcastViewers();
        }
        return;
      }
      case "stop": {
        if (att.role === "host" && att.verified) await this.endStream(await this.state());
        return;
      }
      default:
        return this.send(ws, { type: "error", code: "unknown", message: "Unknown frame." });
    }
  }
}
