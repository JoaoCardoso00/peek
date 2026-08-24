import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { MAX_THUMB_BYTES } from "../do/room";
import { ROOM_ID, TOKEN } from "../lib/names";

/**
 * GET  /t/:id/thumb.jpg  latest frame of the stream (this is the Discord embed image)
 * PUT  /t/:id/thumb.jpg  host uploads a new frame, authenticated with x-peek-token
 */
export const Route = createFileRoute("/t/$id/thumb.jpg")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!ROOM_ID.test(params.id)) return new Response("not found", { status: 404 });
        const stub = env.ROOMS.get(env.ROOMS.idFromName(params.id));
        const thumb = await stub.getThumb();
        if (!thumb) {
          return new Response(null, { status: 302, headers: { Location: "/banner.png" } });
        }
        return new Response(thumb, {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" }
        });
      },
      PUT: async ({ request, params }) => {
        const token = request.headers.get("x-peek-token") ?? "";
        if (!ROOM_ID.test(params.id) || !TOKEN.test(token)) return new Response("bad request", { status: 400 });
        if (!(request.headers.get("content-type") ?? "").startsWith("image/jpeg")) {
          return new Response("jpeg only", { status: 415 });
        }
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (declared > MAX_THUMB_BYTES) return new Response("too large", { status: 413 });
        const bytes = await request.arrayBuffer();
        const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
        if (bytes.byteLength === 0 || head[0] !== 0xff || head[1] !== 0xd8) {
          return new Response("not a jpeg", { status: 415 });
        }
        const stub = env.ROOMS.get(env.ROOMS.idFromName(params.id));
        const result = await stub.putThumb(token, bytes);
        if (result === "forbidden") return new Response("forbidden", { status: 403 });
        if (result === "too-large") return new Response("too large", { status: 413 });
        if (result === "not-live") return new Response("not live", { status: 409 });
        return new Response(null, { status: 204 });
      }
    }
  }
});
