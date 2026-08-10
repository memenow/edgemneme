import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.worker.test.ts"],
    coverage: {
      provider: "istanbul",
      include: [
        "src/gateway/resources.ts",
        "src/contracts/repository-context.ts",
        "src/github/candidate-evidence-identity.ts",
        "src/github/candidate-persistence.ts",
        "src/github/client.ts",
        "src/github/link-pagination.ts",
        "src/github/sync-review-cursor.ts",
        "src/github/tree-manifest-sql.ts",
        "src/projection/cloudflare.ts",
        "src/projection/markdown.ts",
        "src/projection/snapshot.ts",
        "src/projection/validation.ts",
        "src/quality/model-analysis.ts",
        "src/quality/scope-options.ts",
        "src/quality/sensitive-content.ts",
        "src/search/chunking.ts",
        "src/search/cloudflare.ts",
        "src/search/current-head.ts",
        "src/search/exact.ts",
        "src/search/indexing.ts",
        "src/search/lexical.ts",
        "src/search/pipeline.ts",
        "src/search/planning.ts",
        "src/search/ranking.ts",
        "src/security/auth.ts",
        "src/security/canonical-json.ts",
        "src/security/page-token.ts",
        "src/storage/idempotency.ts",
        "src/storage/mutation-plan.ts",
        "src/storage/promotion-plan.ts",
        "src/storage/review-plan.ts",
        "src/workflows/quality.ts",
        "src/workflows/quality-provenance.ts",
        "src/workflows/recovery.ts"
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
  }
});
