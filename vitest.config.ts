import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // The test worker exposes just the Durable Object; the Start app needs a Vite build to run.
    cloudflareTest({ wrangler: { configPath: "./tests/wrangler.jsonc" } })
  ],
  test: {
    include: ["tests/*.test.ts"]
  }
});
