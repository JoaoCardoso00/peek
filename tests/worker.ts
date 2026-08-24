// Test-only Worker: the room Durable Object without the TanStack Start app around it.
import { ROOM_ID } from "../src/lib/names";

export { RoomDO } from "../src/do/room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    if (!ROOM_ID.test(room)) return new Response("bad room", { status: 400 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    if (url.pathname === "/ws") return stub.fetch(request);
    if (url.pathname === "/snapshot") return Response.json(await stub.snapshot());
    if (url.pathname === "/thumb" && request.method === "PUT") {
      const token = request.headers.get("x-peek-token") ?? "";
      return new Response(await stub.putThumb(token, await request.arrayBuffer()));
    }
    return new Response("not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
