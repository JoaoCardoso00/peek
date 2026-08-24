// Optional vars. `wrangler types` only emits what's in wrangler.jsonc, so the optional ones are declared here.
// `env` from "cloudflare:workers" is typed as Cloudflare.Env; the global Env is what handlers receive.
interface PeekOptionalVars {
  PUBLIC_URL?: string;
  STUN_URL?: string;
  TURN_URL?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  CF_TURN_KEY_ID?: string;
  CF_TURN_API_TOKEN?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_GUILD_IDS?: string;
  // Kept for existing deployments while they migrate to DISCORD_GUILD_IDS.
  DISCORD_GUILD_ID?: string;
}

declare namespace Cloudflare {
  interface Env extends PeekOptionalVars {}
}

interface Env extends PeekOptionalVars {}
