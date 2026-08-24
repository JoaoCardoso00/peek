import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useEffect } from "react";
import { getOrCreateHome } from "../app/identity";
import { landingMeta, metaTags, originOf } from "../lib/meta";

const getLanding = createServerFn({ method: "GET" }).handler(async () => {
  const { env } = await import("cloudflare:workers");
  return landingMeta(originOf(getRequest(), env.PUBLIC_URL));
});

export const Route = createFileRoute("/")({
  loader: () => getLanding(),
  head: ({ loaderData }) => ({ meta: loaderData ? metaTags(loaderData) : [] }),
  component: Landing
});

/** Everyone gets a personal link. The landing page just sends you to yours. */
function Landing() {
  const navigate = useNavigate();
  useEffect(() => {
    const home = getOrCreateHome();
    void navigate({ to: "/s/$id", params: { id: home.id }, replace: true });
  }, [navigate]);

  return (
    <main className="stage" data-state="loading">
      <div className="connecting">
        <span className="spinner" aria-hidden="true" />
        <span>Opening your link</span>
      </div>
    </main>
  );
}
