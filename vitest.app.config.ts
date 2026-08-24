import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Runs the built Start app (pnpm build first) inside workerd: SSR, server routes, assets, and the /ws entry. */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./dist/server/wrangler.json" } })],
  test: {
    include: ["tests/app/**/*.test.ts"]
  }
});
