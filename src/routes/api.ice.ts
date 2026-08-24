import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { iceServers, type IceEnv } from "../lib/ice";
import { ROOM_ID } from "../lib/names";

export const Route = createFileRoute("/api/ice")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const room = new URL(request.url).searchParams.get("room") ?? "";
        const iceEnv: IceEnv = env;
        let live = false;
        if (ROOM_ID.test(room)) {
          const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
          live = (await stub.snapshot()).live;
        }
        // Do not mint reusable TURN credentials for arbitrary requests. A
        // viewer refreshes this endpoint after receiving a live offer.
        const servers = await iceServers(live ? iceEnv : { STUN_URL: iceEnv.STUN_URL });
        return Response.json({ iceServers: servers }, { headers: { "Cache-Control": "no-store" } });
      }
    }
  }
});
