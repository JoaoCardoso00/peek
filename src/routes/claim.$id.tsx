import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { claimRoom } from "../app/identity";
import { ROOM_ID, TOKEN } from "../lib/names";

export const Route = createFileRoute("/claim/$id")({
  beforeLoad: ({ params }) => {
    if (!ROOM_ID.test(params.id)) throw notFound();
  },
  component: ClaimRoom
});

function ClaimRoom() {
  const { id } = Route.useParams();
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (!TOKEN.test(token)) {
      setInvalid(true);
      return;
    }
    claimRoom(id, token);
    window.location.replace(`/s/${id}`);
  }, [id]);

  return (
    <main className="stage" data-state={invalid ? "error" : "loading"}>
      {invalid ? (
        <section className="panel">
          <h1>This start link is invalid</h1>
          <p className="lead">Run /share in Discord to make a new room.</p>
        </section>
      ) : (
        <div className="connecting">
          <span className="spinner" aria-hidden="true" />
          <span>Opening your room</span>
        </div>
      )}
    </main>
  );
}
