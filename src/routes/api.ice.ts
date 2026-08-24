import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { iceServers } from "../lib/ice";

export const Route = createFileRoute("/api/ice")({
  server: {
    handlers: {
      GET: async () => {
        const servers = await iceServers(env);
        return Response.json({ iceServers: servers }, { headers: { "Cache-Control": "no-store" } });
      }
    }
  }
});
