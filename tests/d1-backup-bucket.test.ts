import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The operational CLI is plain ESM and has no separate declaration file.
// @ts-expect-error JavaScript CLI exports are exercised directly by this test.
import * as backupBucketModule from "../scripts/verify-d1-backup-bucket.mjs";

const {
  D1_BACKUP_PREFIX,
  D1_BACKUP_RETENTION_RULE_ID,
  assertBackupBucketControlPlane,
  assertBackupBucketIsolation,
  d1BackupBucketPolicy,
  d1MigrationBackupBucketName,
  readRuntimeR2Bindings,
  verifyD1BackupBucket
} = backupBucketModule;

const bucketName = "edgemneme-d1-migration-backups";
const retentionDays = 90;
const environment = {
  CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token",
  D1_MIGRATION_BACKUP_R2_BUCKET: bucketName,
  D1_MIGRATION_BACKUP_RETENTION_DAYS: String(retentionDays)
};
const policy = d1BackupBucketPolicy(environment);
const runtimeBindings = [
  {
    configPath: "wrangler/.wrangler/memory-orchestrator.generated.jsonc",
    binding: "PROJECTIONS",
    bucketName: "edgemneme-projections"
  }
];
const validControlPlane = {
  bucket: { name: bucketName, jurisdiction: "default" },
  customDomains: { domains: [] },
  managedDomain: {
    bucketId: "abcdef0123456789abcdef0123456789",
    domain: "pub-abcdef0123456789abcdef0123456789.r2.dev",
    enabled: false
  },
  lifecycle: {
    rules: [
      {
        id: "default-abort-multipart-uploads",
        enabled: true,
        conditions: { prefix: "" },
        abortMultipartUploadsTransition: {
          condition: { type: "Age", maxAge: 604_800 }
        }
      },
      {
        id: D1_BACKUP_RETENTION_RULE_ID,
        enabled: true,
        conditions: { prefix: D1_BACKUP_PREFIX },
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: retentionDays * 86_400 }
        }
      }
    ]
  }
};

const temporaryDirectories: string[] = [];
const migrationWorkflow = readFileSync(
  join(process.cwd(), ".github", "workflows", "migrate-d1.yml"),
  "utf8"
);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("D1 migration backup bucket policy", () => {
  it("accepts a bounded exact retention policy", () => {
    expect(d1MigrationBackupBucketName({
      D1_MIGRATION_BACKUP_R2_BUCKET: bucketName
    })).toBe(bucketName);
    expect(policy).toEqual({
      bucketName,
      retentionDays,
      retentionSeconds: 7_776_000
    });
  });

  it("rejects malformed bucket names and unbounded retention", () => {
    expect(() =>
      d1BackupBucketPolicy({
        ...environment,
        D1_MIGRATION_BACKUP_R2_BUCKET: "Invalid_Backup_Bucket"
      })
    ).toThrow(/valid 3-63 character R2 bucket name/iu);
    expect(() =>
      d1BackupBucketPolicy({
        ...environment,
        D1_MIGRATION_BACKUP_RETENTION_DAYS: "29"
      })
    ).toThrow(/between 30 and 365/iu);
    expect(() =>
      d1BackupBucketPolicy({
        ...environment,
        D1_MIGRATION_BACKUP_RETENTION_DAYS: "366"
      })
    ).toThrow(/between 30 and 365/iu);
  });

  it("inventories both tracked and generated runtime R2 bindings", () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "edgemneme-d1-backup-test-"));
    temporaryDirectories.push(rootDirectory);
    const wranglerDirectory = join(rootDirectory, "wrangler");
    const generatedDirectory = join(wranglerDirectory, ".wrangler");
    mkdirSync(generatedDirectory, { recursive: true });
    writeFileSync(
      join(wranglerDirectory, "memory-gateway.jsonc"),
      JSON.stringify({
        r2_buckets: [{ binding: "PROJECTIONS", bucket_name: "edgemneme-projections" }]
      })
    );
    writeFileSync(
      join(generatedDirectory, "memory-orchestrator.generated.jsonc"),
      JSON.stringify({
        r2_buckets: [{ binding: "ARCHIVE", bucket_name: "edgemneme-runtime-archive" }]
      })
    );

    expect(readRuntimeR2Bindings(rootDirectory)).toEqual([
      {
        configPath: "wrangler/.wrangler/memory-orchestrator.generated.jsonc",
        binding: "ARCHIVE",
        bucketName: "edgemneme-runtime-archive"
      },
      {
        configPath: "wrangler/memory-gateway.jsonc",
        binding: "PROJECTIONS",
        bucketName: "edgemneme-projections"
      }
    ]);
  });

  it("fails closed when the generated migration config directory is missing or empty", () => {
    const missingDirectoryRoot = mkdtempSync(
      join(tmpdir(), "edgemneme-d1-backup-missing-test-")
    );
    temporaryDirectories.push(missingDirectoryRoot);
    mkdirSync(join(missingDirectoryRoot, "wrangler"));

    const emptyDirectoryRoot = mkdtempSync(
      join(tmpdir(), "edgemneme-d1-backup-empty-test-")
    );
    temporaryDirectories.push(emptyDirectoryRoot);
    mkdirSync(join(emptyDirectoryRoot, "wrangler", ".wrangler"), { recursive: true });

    expect(() => readRuntimeR2Bindings(missingDirectoryRoot)).toThrow(
      /generated memory-orchestrator migration config is missing/iu
    );
    expect(() => readRuntimeR2Bindings(emptyDirectoryRoot)).toThrow(
      /generated memory-orchestrator migration config is missing/iu
    );
  });

  it("rejects a backup bucket referenced by any runtime binding", () => {
    expect(() =>
      assertBackupBucketIsolation(bucketName, [
        ...runtimeBindings,
        {
          configPath: "wrangler/memory-gateway.jsonc",
          binding: "BACKUPS",
          bucketName
        }
      ])
    ).toThrow(/bound to a runtime Worker.*memory-gateway\.jsonc:BACKUPS/iu);
  });
});

describe("D1 migration backup bucket control-plane admission", () => {
  it("queries the exact private bucket and lifecycle endpoints with GET", async () => {
    const requests: Array<{ path: string; method: string; authorization: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("cf-r2-jurisdiction")).toBeNull();
      requests.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization")
      });
      const suffix = url.pathname.split(`/r2/buckets/${bucketName}`)[1];
      const result = suffix === ""
        ? validControlPlane.bucket
        : suffix === "/domains/custom"
          ? validControlPlane.customDomains
          : suffix === "/domains/managed"
            ? validControlPlane.managedDomain
            : suffix === "/lifecycle"
              ? validControlPlane.lifecycle
              : undefined;
      return Response.json({ success: true, result });
    }) as typeof fetch;

    await expect(
      verifyD1BackupBucket(environment, fetchImpl, { runtimeBindings })
    ).resolves.toEqual(policy);
    expect(requests).toEqual([
      {
        path: `/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucketName}`,
        method: "GET",
        authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`
      },
      {
        path: `/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucketName}/domains/custom`,
        method: "GET",
        authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`
      },
      {
        path: `/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucketName}/domains/managed`,
        method: "GET",
        authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`
      },
      {
        path: `/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucketName}/lifecycle`,
        method: "GET",
        authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`
      }
    ]);
  });

  it("rejects every public-access state", () => {
    expect(() =>
      assertBackupBucketControlPlane(policy, {
        ...validControlPlane,
        bucket: { name: bucketName, jurisdiction: "eu" }
      })
    ).toThrow(/was not returned exactly/iu);
    expect(() =>
      assertBackupBucketControlPlane(policy, {
        ...validControlPlane,
        customDomains: {
          domains: [{ domain: "backups.example.com", enabled: false }]
        }
      })
    ).toThrow(/custom domain registration/iu);
    expect(() =>
      assertBackupBucketControlPlane(policy, {
        ...validControlPlane,
        managedDomain: { ...validControlPlane.managedDomain, enabled: true }
      })
    ).toThrow(/r2\.dev access disabled/iu);
  });

  it("requires one exact enabled age-deletion rule", () => {
    expect(() =>
      assertBackupBucketControlPlane(policy, {
        ...validControlPlane,
        lifecycle: { rules: validControlPlane.lifecycle.rules.slice(0, 1) }
      })
    ).toThrow(/exactly one enabled object-deletion rule/iu);

    const wrongRetention = structuredClone(validControlPlane);
    wrongRetention.lifecycle.rules[1]!.deleteObjectsTransition!.condition.maxAge = 86_400;
    expect(() => assertBackupBucketControlPlane(policy, wrongRetention)).toThrow(
      /does not match the protected retention policy/iu
    );

    const conflictingRule = structuredClone(validControlPlane);
    conflictingRule.lifecycle.rules.push({
      id: "unexpected-delete-rule",
      enabled: true,
      conditions: { prefix: "" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 31_536_000 } }
    });
    expect(() => assertBackupBucketControlPlane(policy, conflictingRule)).toThrow(
      /exactly one enabled object-deletion rule/iu
    );
  });

  it("fails closed on a control-plane error", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/lifecycle")) {
        return Response.json({ success: false }, { status: 403 });
      }
      const result = url.pathname.endsWith("/domains/custom")
        ? validControlPlane.customDomains
        : url.pathname.endsWith("/domains/managed")
          ? validControlPlane.managedDomain
          : validControlPlane.bucket;
      return Response.json({ success: true, result });
    }) as typeof fetch;

    await expect(
      verifyD1BackupBucket(environment, fetchImpl, { runtimeBindings })
    ).rejects.toThrow(/R2 lifecycle query failed with HTTP 403/iu);
  });
});

describe("production D1 migration backup workflow", () => {
  it("retains exact recovery points only after backup-bucket admission", () => {
    const backup = workflowStep(
      migrationWorkflow,
      "Capture and verify private pre-migration backups"
    );
    const settings = workflowStep(
      migrationWorkflow,
      "Validate and mask production resource settings"
    );
    const memoryMigration = migrationWorkflow.indexOf(
      "      - name: Apply memory database migrations\n"
    );
    const backupStart = migrationWorkflow.indexOf(
      "      - name: Capture and verify private pre-migration backups\n"
    );

    expect(settings).toContain(
      "D1_MIGRATION_BACKUP_R2_BUCKET: ${{ vars.D1_MIGRATION_BACKUP_R2_BUCKET }}"
    );
    expect(settings).toContain(
      "D1_MIGRATION_BACKUP_RETENTION_DAYS: ${{ vars.D1_MIGRATION_BACKUP_RETENTION_DAYS }}"
    );
    expect(backup).toContain(
      "D1_MIGRATION_BACKUP_R2_BUCKET: ${{ vars.D1_MIGRATION_BACKUP_R2_BUCKET }}"
    );
    expect(backup).toContain(
      "D1_MIGRATION_BACKUP_RETENTION_DAYS: ${{ vars.D1_MIGRATION_BACKUP_RETENTION_DAYS }}"
    );
    const admissions = [
      ...backup.matchAll(/node scripts\/verify-d1-backup-bucket\.mjs/gu)
    ];
    expect(admissions).toHaveLength(2);
    expect(backup).not.toContain('backup_bucket="edgemneme-projections"');
    expect(backup).toContain('d1 time-travel info "$database" --json');
    expect(backup).toContain("capture_bookmark MEMORY_DB");
    expect(backup).toContain("capture_bookmark SEARCH_DB");
    expect(backup).toContain("d1 export MEMORY_DB --remote");
    expect(backup).not.toContain("d1 export SEARCH_DB");
    expect(backup).toContain("search_generations");
    expect(backup).toContain("memory_fts");
    expect(backup).toContain("memory_projection_heads");
    expect(backup).toContain("system/backups/d1-migrations/");
    expect(backup).toContain("wrangler r2 object put");
    expect(backup).toContain("wrangler r2 object get");
    expect(backup).toContain("cmp --silent");
    expect(backup).toContain("create-backup-manifest");
    expect(backup).toContain("verify-backup");
    expect(backup.indexOf('upload_and_verify "manifest.json"'))
      .toBeGreaterThan(backup.indexOf('upload_and_verify "memory-projection-heads.jsonl"'));
    expect(admissions[0]!.index!)
      .toBeLessThan(backup.indexOf("d1 export MEMORY_DB --remote"));
    expect(admissions[1]!.index!)
      .toBeLessThan(backup.indexOf("wrangler r2 object put"));
    expect(backupStart).toBeGreaterThan(-1);
    expect(backupStart).toBeLessThan(memoryMigration);
    expect(migrationWorkflow).not.toContain("actions/upload-artifact");
    expect(migrationWorkflow).not.toContain("time-travel restore");
  });
});

function workflowStep(source: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step ${name} was not found.`);
  }
  const next = source.indexOf("\n      - name: ", start + marker.length);
  return source.slice(start, next === -1 ? undefined : next);
}
