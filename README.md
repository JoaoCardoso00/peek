# peek

Share your screen with one link. Two clicks for the person sharing, zero logins for everyone watching. This version uses a Discord guild allowlist for private groups.

## How it works

- Every browser gets a personal link (`/s/<id>`) on first visit. The secret that proves you own it lives in `localStorage`. No accounts.
- Click "Share your screen", pick a window in the browser's picker, and the link is on your clipboard. Paste it in Discord.
- The link carries Open Graph tags, so Discord shows "Name is sharing their screen", a live frame from the stream, and a viewer count. The `?v=` query string changes per session so Discord re-fetches the embed instead of showing a cached card.
- Viewers connect over WebRTC straight to the sharer's browser. Signaling goes through a Cloudflare Durable Object (one per room) over WebSockets. Media never touches a server unless a TURN relay is needed.
- Media: up to 1080p60, 8 Mbps per viewer, with tab or system audio when the browser supports it. Codec order prefers VP9 > H264 > AV1 > VP8.
- While live, "Change source" swaps the capture (other monitor, a window, a tab) without dropping viewers, and Settings adjusts resolution (720p/1080p/source), frame rate (30/60), motion vs. text optimization, and audio on/off. Settings persist per browser.

## Discord bot

`/share` does not ask for a link. It creates a new room, posts the public stream card in the channel, and gives the command user a private "Start sharing" button. That button opens Peek on the computer that will share and hands the room secret to that browser. The public card changes when the stream starts, the viewer count changes, and the stream ends.

The operating system's screen picker opens in the browser. Discord does not let a bot request screen capture on a user's behalf.

### Configure the private bot

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Copy its Application ID and Public Key.
2. Open Bot, create or reset the token, and keep it private. You can leave Public Bot disabled if you manage every server that will install Peek. Enable it if other server admins need to install the bot for you.
3. In Discord, enable Developer Mode under User Settings, Advanced. Right-click each allowed server and copy its Server ID.
4. Create the local configuration:

```sh
cp .dev.vars.example .dev.vars
```

Fill in all four values in `.dev.vars`. Put the allowed server IDs in one comma-separated value:

```dotenv
DISCORD_GUILD_IDS=123456789012345678,234567890123456789
```

Git ignores `.dev.vars`.

5. Run the registration script to print the install URL:

```sh
pnpm discord:register
```

Open the URL and add the bot to every allowed server. Run `pnpm discord:register` again after installation. The script replaces this app's guild commands in each allowlisted server. Rerun it whenever you add or remove a server ID. Removing an ID stops the Worker from accepting commands there, but you should also remove the bot from that server.

### Deploy to Cloudflare

Log in, add the private bot settings, and deploy:

```sh
pnpm exec wrangler login
pnpm exec wrangler secret put DISCORD_PUBLIC_KEY
pnpm exec wrangler secret put DISCORD_BOT_TOKEN
pnpm exec wrangler secret put DISCORD_GUILD_IDS
pnpm deploy
```

Use the values from `.dev.vars` when Wrangler prompts. Once deployment finishes, copy the deployed `https://...workers.dev` address.

Back in the Discord Developer Portal, open General Information and set the Interactions Endpoint URL to:

```text
https://YOUR_PEEK_DOMAIN/api/discord/interactions
```

Discord sends a signed ping to verify the endpoint. Run `/share` in an allowed server after it accepts the URL.

### Add TURN fallback

Direct WebRTC should handle most connections. TURN covers mobile carriers, university networks, and restrictive routers that cannot connect directly.

Create a Cloudflare Realtime TURN key, then add its key ID and API token:

```sh
pnpm exec wrangler secret put CF_TURN_KEY_ID
pnpm exec wrangler secret put CF_TURN_API_TOKEN
pnpm deploy
```

Peek requests short-lived TURN credentials automatically. The stream remains direct P2P whenever TURN is unnecessary.

## Stack

- TanStack Start (React) on Cloudflare Workers via `@cloudflare/vite-plugin`
- One Durable Object class, `RoomDO`, using the WebSocket Hibernation API
- Static assets from `public/`
- Tests run inside workerd through `@cloudflare/vitest-pool-workers`

## Develop

```sh
pnpm install
pnpm dev          # vite dev with the Worker and Durable Object running locally
pnpm test         # Durable Object signaling + meta tests, inside workerd
pnpm test:app     # the built app (run pnpm build first): SSR, embed tags, server routes, /ws
pnpm typecheck
pnpm check        # all of the above
```

`pnpm run types` regenerates `worker-configuration.d.ts` after changing `wrangler.jsonc`.

## Deploy

```sh
wrangler login
pnpm deploy
```

Optional variables (set in `wrangler.jsonc` `vars`, or as secrets with `wrangler secret put`):

| Name | Purpose |
| --- | --- |
| `PUBLIC_URL` | Force the origin used in embed image URLs (only needed behind an unusual proxy). |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Cloudflare Realtime TURN. `/api/ice` mints short-lived credentials. Make the token a secret. |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Any other TURN provider. `TURN_URL` can be a comma-separated list. |
| `STUN_URL` | Replace the default Google STUN server. |
| `DISCORD_PUBLIC_KEY` | Verifies that interactions came from Discord. |
| `DISCORD_BOT_TOKEN` | Posts and updates the public room card. |
| `DISCORD_GUILD_IDS` | Comma-separated allowlist of Discord server IDs. |
| `DISCORD_GUILD_ID` | Legacy single-server setting. It can be used alongside the allowlist during migration. |

Without TURN, viewers behind symmetric NATs (some mobile carriers, some university networks) will not connect. Cloudflare's TURN has a free tier that covers a friend group.

## Limits worth knowing

- The sharer uploads one copy of the stream per viewer. At 8 Mbps that is fine for 3 to 5 people; past that, the sharer's upload becomes the bottleneck. Swapping the mesh for an SFU (Cloudflare Realtime SFU or LiveKit) is the next step if that matters.
- Viewers see the sharer's IP unless a TURN relay is forced, which is how any peer-to-peer call works.
- Room ownership is the token in `localStorage`. Clearing site data means "Get a new link".
- Screen capture needs a desktop browser. Watching works on phones.
