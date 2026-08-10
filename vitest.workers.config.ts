import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-07-25",
        compatibilityFlags: ["nodejs_compat"]
      }
    })
  ],
  test: {
    include: ["tests/**/*.worker.test.ts"]
  }
});
