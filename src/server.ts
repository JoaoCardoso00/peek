import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env, waitUntil } from "cloudflare:workers";
import { handleDiscordInteraction } from "./lib/discord";
import { ROOM_ID } from "./lib/names";

export { RoomDO } from "./do/room";

/**
 * Custom Worker entry. WebSocket upgrades go straight to the room's Durable
 * Object; everything else is handled by TanStack Start (pages + server routes).
 */
export default createServerEntry({
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return upgrade(request, url);
    if (url.pathname === "/api/discord/interactions" && request.method === "POST") {
      return handleDiscordInteraction(request, env, waitUntil);
    }
    return handler.fetch(request);
  }
});

function upgrade(request: Request, url: URL): Response | Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }
  const room = url.searchParams.get("room") ?? "";
  if (!ROOM_ID.test(room)) return new Response("Invalid room.", { status: 400 });
  const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
  return stub.fetch(request);
}
