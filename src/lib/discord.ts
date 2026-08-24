import type { RoomSnapshot } from "./meta";
import { safeName } from "./names";

const DISCORD_API = "https://discord.com/api/v10";
const EPHEMERAL = 1 << 6;

interface DiscordUser {
  username?: string;
  global_name?: string | null;
}

interface DiscordInteraction {
  id: string;
  application_id: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  data?: { name?: string };
  member?: { nick?: string | null; user?: DiscordUser };
  user?: DiscordUser;
}

export interface DiscordMessageRef {
  channelId: string;
  messageId: string;
  roomUrl: string;
}

interface DiscordBindings extends PeekOptionalVars {
  ROOMS: DurableObjectNamespace<import("../do/room").RoomDO>;
}

export async function handleDiscordInteraction(
  request: Request,
  bindings: DiscordBindings,
  background: (promise: Promise<unknown>) => void
): Promise<Response> {
  const body = await request.text();
  if (!bindings.DISCORD_PUBLIC_KEY) return new Response("Discord is not configured.", { status: 503 });
  if (!(await verifyDiscordSignature(request.headers, body, bindings.DISCORD_PUBLIC_KEY))) {
    return new Response("Bad request signature.", { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return new Response("Invalid JSON.", { status: 400 });
  }

  if (interaction.type === 1) return json({ type: 1 });
  if (interaction.type !== 2) return ephemeral("Peek does not handle this interaction type.");

  switch (interaction.data?.name) {
    case "share":
      return createShare(interaction, request, bindings, background);
    default:
      return ephemeral("Unknown Peek command.");
  }
}

async function createShare(
  interaction: DiscordInteraction,
  request: Request,
  bindings: DiscordBindings,
  background: (promise: Promise<unknown>) => void
): Promise<Response> {
  if (!bindings.DISCORD_GUILD_ID) {
    return ephemeral("The Peek bot is missing its Discord guild ID.");
  }
  if (interaction.guild_id !== bindings.DISCORD_GUILD_ID) {
    return ephemeral("This private Peek bot only works in its configured server.");
  }
  if (!bindings.DISCORD_BOT_TOKEN || !interaction.channel_id) {
    return ephemeral("The Peek bot is missing its bot token or cannot see this channel.");
  }

  const roomId = randomString(10, "abcdefghijklmnopqrstuvwxyz0123456789");
  const token = randomString(32, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-");
  const origin = publicOrigin(request, bindings.PUBLIC_URL);
  const roomUrl = `${origin}/s/${roomId}`;
  const claimUrl = `${origin}/claim/${roomId}#${token}`;
  const name = interactionName(interaction);
  const room = bindings.ROOMS.get(bindings.ROOMS.idFromName(roomId));
  const created = await room.createFromDiscord(token, name);
  if (!created) return ephemeral("Peek could not create the room. Run `/share` again.");

  background(publishRoom(interaction, bindings, roomId, roomUrl));

  return json({
    type: 4,
    data: {
      flags: EPHEMERAL,
      content: "Your room is in the channel. Open this on the computer you want to share from.",
      components: [actionRow(linkButton("Start sharing", claimUrl))],
      allowed_mentions: { parse: [] }
    }
  });
}

async function publishRoom(
  interaction: DiscordInteraction,
  bindings: DiscordBindings,
  roomId: string,
  roomUrl: string
): Promise<void> {
  const room = bindings.ROOMS.get(bindings.ROOMS.idFromName(roomId));
  try {
    const snapshot = await room.snapshot();
    const response = await fetch(`${DISCORD_API}/channels/${interaction.channel_id}/messages`, {
      method: "POST",
      headers: discordHeaders(bindings.DISCORD_BOT_TOKEN!),
      body: JSON.stringify(discordRoomMessage(snapshot, roomUrl))
    });
    if (!response.ok) throw new Error(`Discord message failed with ${response.status}`);
    const message = (await response.json()) as { id: string };
    await room.linkDiscordMessage({ channelId: interaction.channel_id!, messageId: message.id, roomUrl });
  } catch (error) {
    console.error("Could not publish Discord room", error);
    await editPrivateReply(
      interaction,
      "Peek created the room, but the bot could not post in this channel. Check View Channel, Send Messages, and Embed Links permissions."
    );
  }
}

async function editPrivateReply(interaction: DiscordInteraction, content: string): Promise<void> {
  await fetch(`${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, components: [], allowed_mentions: { parse: [] } })
  }).catch(() => undefined);
}

export function discordRoomMessage(snapshot: RoomSnapshot, roomUrl: string) {
  const title = snapshot.live
    ? `${snapshot.hostName} is sharing their screen`
    : snapshot.started
      ? `${snapshot.hostName}'s stream ended`
      : `${snapshot.hostName} is getting ready to share`;
  const description = snapshot.live
    ? snapshot.viewers === 1
      ? "1 person watching"
      : `${snapshot.viewers} people watching`
    : snapshot.started
      ? "They can start again from the same private link."
      : "Waiting for the stream to start.";
  const origin = new URL(roomUrl).origin;
  const image = snapshot.hasThumb
    ? `${origin}/t/${new URL(roomUrl).pathname.split("/").pop()}/thumb.jpg?v=${snapshot.session}`
    : `${origin}/banner.png`;

  return {
    embeds: [
      {
        title,
        description,
        url: roomUrl,
        color: snapshot.live ? 0xda373c : snapshot.started ? 0x4e5058 : 0x5865f2,
        image: { url: image },
        footer: { text: "peek" }
      }
    ],
    components: [actionRow(linkButton(snapshot.live ? "Watch stream" : "Open stream", roomUrl))],
    allowed_mentions: { parse: [] }
  };
}

export async function updateDiscordRoomMessage(
  ref: DiscordMessageRef,
  snapshot: RoomSnapshot,
  botToken: string
): Promise<"ok" | "gone" | "retry"> {
  const response = await fetch(`${DISCORD_API}/channels/${ref.channelId}/messages/${ref.messageId}`, {
    method: "PATCH",
    headers: discordHeaders(botToken),
    body: JSON.stringify(discordRoomMessage(snapshot, ref.roomUrl))
  });
  if (response.ok) return "ok";
  if (response.status === 403 || response.status === 404) return "gone";
  console.error("Discord room update failed", response.status, await response.text());
  return "retry";
}

export async function verifyDiscordSignature(headers: Headers, body: string, publicKeyHex: string): Promise<boolean> {
  const signature = headers.get("x-signature-ed25519");
  const timestamp = headers.get("x-signature-timestamp");
  if (!signature || !timestamp || !/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signature)) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey("raw", hexBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexBytes(signature),
      new TextEncoder().encode(timestamp + body)
    );
  } catch {
    return false;
  }
}

function interactionName(interaction: DiscordInteraction): string {
  const user = interaction.member?.user ?? interaction.user;
  return safeName(interaction.member?.nick ?? user?.global_name ?? user?.username, "Someone");
}

function publicOrigin(request: Request, configured?: string): string {
  return configured?.replace(/\/$/, "") ?? new URL(request.url).origin;
}

function discordHeaders(botToken: string): Record<string, string> {
  return { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" };
}

function actionRow(...components: unknown[]) {
  return { type: 1, components };
}

function linkButton(label: string, url: string) {
  return { type: 2, style: 5, label, url };
}

function ephemeral(content: string): Response {
  return json({ type: 4, data: { flags: EPHEMERAL, content, allowed_mentions: { parse: [] } } });
}

function json(value: unknown): Response {
  return Response.json(value, { headers: { "Cache-Control": "no-store" } });
}

function randomString(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let result = "";
  for (const byte of bytes) result += alphabet[byte % alphabet.length];
  return result;
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
