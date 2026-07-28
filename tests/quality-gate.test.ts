import { describe, expect, it } from "vitest";
import {
  inspectCandidateContent,
  inspectMemoryModelInput,
  inspectMemoryModelValue,
  inspectModelInput,
  inspectPersistedValue,
  inspectSensitivePath
} from "../src/quality/sensitive-content";

describe("candidate sensitive-content gate", () => {
  it("accepts concise durable claims", () => {
    expect(
      inspectCandidateContent("The repository uses pnpm and Node.js 24.", {
        maxBytes: 4096
      })
    ).toEqual({ accepted: true });
  });

  it.each([
    ["GitHub token", ["ghp", "123456789012345678901234567890123456"].join("_")],
    ["generic secret", "API_KEY=not-a-real-but-secret-shaped-value-1234567890"],
    ["short assigned secret", "password=hunter2"],
    ["prefixed assigned secret", "DATABASE_PASSWORD=hunter2"],
    ["joined uppercase secret", "DATABASEPASSWORD=hunter2"],
    ["joined uppercase API key", "SERVICEAPIKEY=hunter2"],
    ["connection string", "postgresql://app:synthetic-password@db.example.test/main"],
    ["provider token", ["sk", "test", "abcdefghijklmnopqrstuvwxyz123456"].join("-")],
    ["AWS access key", ["AKIA", "ABCDEFGHIJKLMNOP"].join("")],
    ["bearer token", `Bearer ${"Ab3_".repeat(8)}`],
    ["email address", "operator@example.com"],
    ["US social security number", "123-45-6789"],
    ["payment card number", "4111 1111 1111 1111"],
    ["international phone number", "+1 (212) 555-0198"],
    ["labeled phone number", "联系电话：010-5555-0198"],
    ["unlabeled Chinese mobile number", "199-0000-0000"],
    ["unlabeled UK London number", "020 7946 0958"],
    ["unlabeled UK regional number", "0161 496 0123"],
    ["unlabeled UK five-digit area number", "01632 960123"],
    ["unlabeled UK mobile number", "07700 900123"],
    ["synthetic Chinese resident ID", "999999200001010011"],
    [
      "private key",
      ["-----BEGIN", "PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----"].join(" ")
    ]
  ])("rejects %s without retaining the body", (_label, content) => {
    const result = inspectCandidateContent(content, { maxBytes: 4096 });
    expect(result).toMatchObject({ accepted: false, disposition: "tombstone" });
    expect(JSON.stringify(result)).not.toContain(content);
  });

  it("rejects oversized bodies", () => {
    expect(inspectCandidateContent("x".repeat(100), { maxBytes: 32 })).toMatchObject({
      accepted: false,
      reason: "CONTENT_TOO_LARGE"
    });
  });

  it("rejects high-entropy opaque tokens while allowing commit hashes", () => {
    expect(
      inspectCandidateContent("xQ7_bV9+mN2/pR8=sT4-uW6_yZ3+aC5/dF1", {
        maxBytes: 4096
      })
    ).toMatchObject({
      accepted: false,
      detector: "high-entropy-token"
    });
    expect(
      inspectCandidateContent("Commit 0123456789abcdef0123456789abcdef01234567", {
        maxBytes: 4096
      })
    ).toEqual({ accepted: true });
  });

  it("validates structured PII before rejecting digit-shaped technical values", () => {
    for (const content of [
      "Invalid test card 4111 1111 1111 1112",
      "Numeric repository ID 123456789012345",
      "Numeric commit-like identifier 0123456789012345678901234567890123456789",
      "Grouped build identifier 123-4567-8901",
      "Synthetic resident ID with a bad checksum 999999200001010012",
      "Synthetic resident ID with an invalid date 999999200002300010",
      "Release timestamp 2026-07-28T12:00:00.000Z"
    ]) {
      expect(inspectCandidateContent(content, { maxBytes: 4096 })).toEqual({
        accepted: true
      });
    }
  });

  it.each([
    ["PII", "Find records for operator@example.com"],
    ["provider token", `Find ${["sk", "test", "abcdefghijklmnopqrstuvwxyz123456"].join("-")}`],
    [
      "prompt transcript",
      "System: You are a coding agent with access to private project memory."
    ],
    [
      "raw log",
      "2026-07-27T12:00:00.000Z INFO request started"
    ]
  ])("rejects transient model input containing %s", (_label, content) => {
    expect(inspectModelInput(content, { maxBytes: 4096 })).toMatchObject({
      accepted: false,
      disposition: "tombstone"
    });
  });

  it("allows concise searches about prompt and log code", () => {
    expect(
      inspectModelInput("Where is the prompt builder used by src/workflows/quality.ts?", {
        maxBytes: 4096
      })
    ).toEqual({ accepted: true });
    expect(
      inspectModelInput("What decision followed the production log retention incident?", {
        maxBytes: 4096
      })
    ).toEqual({ accepted: true });
  });

  it.each([
    [
      "prompt transcript",
      "System: You are a coding agent.\nUser: Inspect the repository.\nAssistant: Starting."
    ],
    [
      "raw log",
      "2026-07-28T08:00:00.000Z INFO request started\n2026-07-28T08:00:01.000Z WARN retry scheduled"
    ]
  ])("applies the shared memory-model gate to %s", (_label, content) => {
    expect(inspectCandidateContent(content, { maxBytes: 16 * 1024 })).toEqual({
      accepted: true
    });
    expect(inspectMemoryModelInput(content)).toMatchObject({
      accepted: false,
      disposition: "tombstone"
    });
  });

  it("inspects nested session metadata without rejecting ordinary values", () => {
    expect(
      inspectMemoryModelValue(
        {
          agent: { name: "codex", device: "development-machine" },
          worktree: { repository_ref: "refs/heads/feature" }
        },
        { maxBytes: 16 * 1024 }
      )
    ).toEqual({ accepted: true });
    expect(
      inspectMemoryModelValue(
        {
          agent: {
            transcript:
              "System: You are a coding agent.\nUser: Inspect all files.\nAssistant: Starting."
          }
        },
        { maxBytes: 16 * 1024 }
      )
    ).toMatchObject({
      accepted: false,
      detector: "prompt-transcript"
    });
  });

  it("allows ordinary evidence metadata through the shared memory-model gate", () => {
    expect(
      inspectMemoryModelValue(
        [
          {
            source_type: "repository_file",
            locator: "src/workflows/quality.ts",
            commit_sha: "0123456789abcdef0123456789abcdef01234567"
          }
        ],
        { maxBytes: 32 * 1024 }
      )
    ).toEqual({ accepted: true });
  });

  it.each([
    [
      "a secret",
      [{ source_type: "repository_file", locator: "API_KEY=synthetic-secret-value" }]
    ],
    [
      "PII",
      [{ source_type: "repository_file", locator: "mailto:operator@example.com" }]
    ],
    [
      "model-input overflow",
      Array.from({ length: 9 }, (_, index) => ({
        source_type: "repository_file",
        locator: `${index}/${"x".repeat(2_000)}`
      }))
    ]
  ])("rejects evidence metadata containing %s", (_label, evidence) => {
    expect(inspectMemoryModelValue(evidence, { maxBytes: 32 * 1024 })).toMatchObject({
      accepted: false,
      disposition: "tombstone"
    });
  });

  it("serializes structured persisted values before inspection", () => {
    expect(
      inspectPersistedValue({ note: "operator@example.com" }, { maxBytes: 4096 })
    ).toMatchObject({
      accepted: false,
      detector: "email-address"
    });
    expect(inspectPersistedValue("safe metadata", { maxBytes: 4096 })).toEqual({
      accepted: true
    });
    expect(
      inspectPersistedValue(
        { databasePassword: "synthetic-value", nested: { apiKey: "short-value" } },
        { maxBytes: 4096 }
      )
    ).toMatchObject({
      accepted: false,
      detector: "assigned-secret"
    });
  });

  it("fails closed when a persisted value cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(inspectPersistedValue(circular, { maxBytes: 4096 })).toMatchObject({
      accepted: false,
      reason: "CONTENT_TOO_LARGE"
    });
  });

  it.each([undefined, Symbol("metadata"), () => "metadata"])(
    "fails closed when JSON serialization does not produce a string",
    (value) => {
      expect(inspectPersistedValue(value, { maxBytes: 4096 })).toMatchObject({
        accepted: false,
        reason: "CONTENT_TOO_LARGE"
      });
      expect(inspectMemoryModelValue(value, { maxBytes: 4096 })).toMatchObject({
        accepted: false,
        reason: "CONTENT_TOO_LARGE"
      });
    }
  );

  it("hashes secret-shaped repository paths while allowing ordinary paths", () => {
    expect(inspectSensitivePath("config/PRODUCTION_DATABASE_PASSWORD.txt")).toMatchObject({
      accepted: false,
      detector: "sensitive-path"
    });
    expect(inspectSensitivePath("config/productionDatabasePassword.txt")).toMatchObject({
      accepted: false,
      detector: "sensitive-path"
    });
    expect(inspectSensitivePath("config/PRODUCTIONACCESSTOKEN.txt")).toMatchObject({
      accepted: false,
      detector: "sensitive-path"
    });
    expect(inspectSensitivePath("src/database/configuration.ts")).toEqual({
      accepted: true
    });
  });
});
