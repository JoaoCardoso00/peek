/** Thin WebSocket client for the room protocol. Reconnects with backoff until close() is called. */

export type Frame = Record<string, unknown> & { type: string };

export interface SignalOptions {
  url: string;
  onOpen: () => void;
  onFrame: (frame: Frame) => void;
  onClose?: () => void;
}

const PING_MS = 20_000;
const MIN_BACKOFF = 500;
const MAX_BACKOFF = 8_000;

export class Signal {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = MIN_BACKOFF;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: SignalOptions) {}

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = MIN_BACKOFF;
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_MS);
      this.options.onOpen();
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof frame === "object" && frame !== null && "type" in frame) {
        this.options.onFrame(frame as Frame);
      }
    };

    ws.onclose = () => {
      this.stopPing();
      if (this.ws === ws) this.ws = null;
      this.options.onClose?.();
      if (this.closed) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(MAX_BACKOFF, this.backoff * 2);
    };

    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  send(frame: Frame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

export function signalUrl(roomId: string, role: "host" | "viewer", name?: string, viewerKey?: string): string {
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", roomId);
  url.searchParams.set("role", role);
  if (name) url.searchParams.set("name", name);
  if (role === "viewer" && viewerKey) url.searchParams.set("viewer", viewerKey);
  return url.toString();
}
