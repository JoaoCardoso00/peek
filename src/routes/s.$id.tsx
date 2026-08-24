import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Stage } from "../app/Stage";
import { metaTags, originOf, roomMeta, type PageMeta } from "../lib/meta";
import { ROOM_ID } from "../lib/names";

const getRoomPage = createServerFn({ method: "GET" })
  .validator((id: string) => {
    if (!ROOM_ID.test(id)) throw notFound();
    return id;
  })
  .handler(async ({ data: id }): Promise<PageMeta> => {
    const { env } = await import("cloudflare:workers");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
    const snapshot = await stub.snapshot();
    return roomMeta(snapshot, originOf(getRequest(), env.PUBLIC_URL), id);
  });

export const Route = createFileRoute("/s/$id")({
  loader: ({ params }) => getRoomPage({ data: params.id }),
  head: ({ loaderData }) => ({ meta: loaderData ? metaTags(loaderData) : [] }),
  component: RoomPage,
  notFoundComponent: () => (
    <main className="stage" data-state="error">
      <section className="panel">
        <h1>That link doesn't look right</h1>
        <p className="lead">Check the link you were sent, or make your own at the home page.</p>
      </section>
    </main>
  )
});

function RoomPage() {
  const { id } = Route.useParams();
  return <Stage roomId={id} />;
}
