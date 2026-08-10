import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { inspectCandidateContent } from "../src/quality/sensitive-content";
import { sha256 } from "../src/security/crypto";
import {
  consolidateSession,
  finishConsolidation,
  processCandidateSubmission
} from "../src/workflows/quality";

const PROJECT_ID = "project-1";
const CONSOLIDATION_ID = "consolidation-1";
const SESSION_ID = "session-1";
const LEASE_OWNER = "workflow-instance-1";

describe("quality workflow consolidation SQL", () => {
  it("recovers an exact lease claim when the D1 response is lost after commit", async () => {
    let responseLost = false;
    const fixture = createFixture({
      afterClaimBatchCommit() {
        responseLost = true;
        throw new Error("Synthetic claim response loss.");
      }
    });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expect(responseLost).toBe(true);
    expectConsolidationArtifacts(fixture.database, 1);
    expect(
      fixture.database
        .prepare(
          `SELECT status, lease_owner, lease_claim_id, lease_operation_id, lease_epoch
           FROM session_consolidations`
        )
        .get()
    ).toEqual({
      status: "complete",
      lease_owner: null,
      lease_claim_id: null,
      lease_operation_id: null,
      lease_epoch: 1
    });
  });

  it("does not enter AI when an ambiguous renewal leaves only the old near-expiry lease", async () => {
    let renewalAttempted = false;
    const fixture = createFixture({
      beforeRenewalRun(database) {
        renewalAttempted = true;
        database
          .prepare(
            `UPDATE session_consolidations
             SET lease_expires_at = ?
             WHERE consolidation_id = ?`
          )
          .run(
            new Date(Date.now() + 60_000).toISOString(),
            CONSOLIDATION_ID
          );
        throw new Error("Synthetic renewal response loss before commit.");
      }
    });

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(renewalAttempted).toBe(true);
    expect(fixture.aiRun).not.toHaveBeenCalled();
    expectConsolidationArtifacts(fixture.database, 0);
    expect(
      fixture.database
        .prepare("SELECT status, lease_claim_id FROM session_consolidations")
        .get()
    ).toEqual({ status: "failed", lease_claim_id: null });
  });

  it("continues only when an ambiguous renewal committed its exact expiry target", async () => {
    let responseLost = false;
    const fixture = createFixture({
      afterRenewalRun() {
        responseLost = true;
        throw new Error("Synthetic renewal response loss after commit.");
      }
    });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expect(responseLost).toBe(true);
    expect(fixture.aiRun).toHaveBeenCalledOnce();
    expectConsolidationArtifacts(fixture.database, 1);
    expect(
      fixture.database
        .prepare("SELECT status, lease_claim_id FROM session_consolidations")
        .get()
    ).toEqual({ status: "complete", lease_claim_id: null });
  });

  it("recovers an exact receipt when the D1 response is lost after batch commit", async () => {
    let responseLost = false;
    const fixture = createFixture({
      afterConsolidationBatchCommit() {
        responseLost = true;
        throw new Error("Synthetic batch response loss.");
      }
    });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expect(responseLost).toBe(true);
    expectConsolidationArtifacts(fixture.database, 1);
    expect(
      fixture.database
        .prepare(
          `SELECT suggestion_count, lease_epoch
           FROM consolidation_batch_receipts`
        )
        .get()
    ).toEqual({ suggestion_count: 1, lease_epoch: 1 });
    expect(
      fixture.database
        .prepare("SELECT status, lease_operation_id FROM session_consolidations")
        .get()
    ).toEqual({ status: "complete", lease_operation_id: null });
    const receiptLease = fixture.database
      .prepare(
        `SELECT lease_owner, lease_claim_id, lease_epoch
         FROM consolidation_batch_receipts`
      )
      .get() as {
        lease_owner: string;
        lease_claim_id: string;
        lease_epoch: number;
      };
    await expect(
      finishConsolidation(
        fixture.env.MEMORY_DB,
        PROJECT_ID,
        CONSOLIDATION_ID,
        {
          owner: receiptLease.lease_owner,
          claimId: receiptLease.lease_claim_id,
          epoch: receiptLease.lease_epoch
        },
        [0]
      )
    ).resolves.toBeUndefined();
  });

  it("renews the active lease before reading a historical batch receipt", async () => {
    let renewalCount = 0;
    const receiptReadRenewalCounts: number[] = [];
    const fixture = createFixture({
      observeRenewalRun() {
        renewalCount += 1;
      },
      observeReceiptRead() {
        receiptReadRenewalCounts.push(renewalCount);
      }
    });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );
    fixture.database.prepare(
      `UPDATE session_consolidations
       SET status = 'failed', lease_owner = NULL, lease_claim_id = NULL,
           lease_expires_at = NULL, lease_operation_id = NULL`
    ).run();
    const renewalsBeforeRetry = renewalCount;
    const readsBeforeRetry = receiptReadRenewalCounts.length;

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expect(receiptReadRenewalCounts.slice(readsBeforeRetry)[0]).toBeGreaterThan(
      renewalsBeforeRetry
    );
    expect(fixture.aiRun).toHaveBeenCalledOnce();
  });

  it("refuses to finish an invalidated historical receipt post-state", async () => {
    const fixture = createFixture();

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );
    const receiptLease = fixture.database.prepare(
      `SELECT lease_owner, lease_claim_id, lease_epoch
       FROM consolidation_batch_receipts`
    ).get() as {
      lease_owner: string;
      lease_claim_id: string;
      lease_epoch: number;
    };
    fixture.database.prepare(
      `UPDATE session_consolidations
       SET status = 'running', lease_owner = ?, lease_claim_id = ?, lease_epoch = ?,
           lease_expires_at = '2099-08-01T00:20:00.000Z', lease_operation_id = NULL,
           receipt_post_state_valid = 0`
    ).run(
      receiptLease.lease_owner,
      receiptLease.lease_claim_id,
      receiptLease.lease_epoch
    );

    await expect(
      finishConsolidation(
        fixture.env.MEMORY_DB,
        PROJECT_ID,
        CONSOLIDATION_ID,
        {
          owner: receiptLease.lease_owner,
          claimId: receiptLease.lease_claim_id,
          epoch: receiptLease.lease_epoch
        },
        [0]
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });
    expect(
      fixture.database.prepare("SELECT status FROM session_consolidations").get()
    ).toEqual({ status: "running" });
  });

  it("rolls back before-commit response loss and commits exactly once on retry", async () => {
    let responseLost = false;
    const fixture = createFixture({
      afterConsolidationBatchStatement(_database, statementIndex) {
        if (!responseLost && statementIndex === 2) {
          responseLost = true;
          throw new Error("Synthetic pre-commit response loss.");
        }
      }
    });

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(responseLost).toBe(true);
    expectConsolidationArtifacts(fixture.database, 0);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM consolidation_batch_receipts")
        .get()
    ).toEqual({ count: 0 });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expectConsolidationArtifacts(fixture.database, 1);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM consolidation_batch_receipts")
        .get()
    ).toEqual({ count: 1 });
  });

  it("rolls back a same-hash race loser and records a zero-output retry receipt", async () => {
    const competingContent = "The SQLite-backed winner.";
    const competingContentSha = await sha256(competingContent);
    const fixture = createFixture({
      beforeConsolidationBatch(database) {
        database
          .prepare(
            `INSERT INTO observations
             (observation_id, project_id, session_id, principal_id, candidate_version,
              status, content, content_sha256, evidence_json, created_at)
             VALUES ('competing-candidate', ?, ?, 'principal-1', 1,
                     'pending_review', ?, ?, '[]', ?)`
          )
          .run(
            PROJECT_ID,
            SESSION_ID,
            competingContent,
            competingContentSha,
            "2026-07-27T00:00:00Z"
          );
      }
    });

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expectConsolidationArtifacts(fixture.database, 0);
    expect(
      fixture.database
        .prepare(
          `SELECT observation_id, source_consolidation_id
           FROM observations WHERE content_sha256 = ?`
        )
        .get(competingContentSha)
    ).toEqual({
      observation_id: "competing-candidate",
      source_consolidation_id: null
    });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM consolidation_batch_receipts")
        .get()
    ).toEqual({ count: 0 });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expectConsolidationArtifacts(fixture.database, 0);
    expect(
      fixture.database
        .prepare(
          `SELECT receipt.suggestion_count, consolidation.status
           FROM consolidation_batch_receipts AS receipt
           JOIN session_consolidations AS consolidation
             ON consolidation.project_id = receipt.project_id
            AND consolidation.consolidation_id = receipt.consolidation_id`
        )
        .get()
    ).toEqual({ suggestion_count: 0, status: "noop" });
  });

  it("rolls back the persist batch when the lease expires after witness acquisition", async () => {
    let crossedExpiry = false;
    const fixture = createFixture({
      afterConsolidationBatchStatement(database, statementIndex) {
        if (statementIndex !== 0 || crossedExpiry) {
          return;
        }
        crossedExpiry = true;
        database
          .prepare(
            `UPDATE session_consolidations
             SET lease_expires_at = '1970-01-01T00:00:00.000Z'`
          )
          .run();
      }
    });

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(crossedExpiry).toBe(true);
    expectConsolidationArtifacts(fixture.database, 0);
    expect(
      fixture.database
        .prepare(
          `SELECT status, lease_owner, lease_expires_at, lease_operation_id
           FROM session_consolidations`
        )
        .get()
    ).toEqual({
      status: "failed",
      lease_owner: null,
      lease_expires_at: null,
      lease_operation_id: null
    });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expectConsolidationArtifacts(fixture.database, 1);
    expect(
      fixture.database
        .prepare("SELECT status, lease_epoch, lease_operation_id FROM session_consolidations")
        .get()
    ).toEqual({ status: "complete", lease_epoch: 2, lease_operation_id: null });
  });

  it("commits no artifacts when the witness acquisition changes zero rows", async () => {
    const fixture = createFixture({
      beforeConsolidationBatch(database) {
        database
          .prepare(
            `UPDATE session_consolidations
             SET lease_expires_at = '1970-01-01T00:00:00.000Z'`
          )
          .run();
      }
    });

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expectConsolidationArtifacts(fixture.database, 0);
    expect(
      fixture.database
        .prepare(
          `SELECT status, lease_owner, lease_expires_at, lease_operation_id
           FROM session_consolidations`
        )
        .get()
    ).toEqual({
      status: "failed",
      lease_owner: null,
      lease_expires_at: null,
      lease_operation_id: null
    });
  });

  it("executes the slot-owned batch atomically against SQLite", async () => {
    const fixture = createFixture();

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );
    fixture.database
      .prepare(
        `UPDATE session_consolidations
         SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL`
      )
      .run();
    fixture.suggestion.content = "Changed retry content must not replace the winner.";
    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expect(fixture.database.prepare("SELECT content FROM observations").get()).toEqual({
      content: "The SQLite-backed winner."
    });
    for (const table of [
      "observations",
      "consolidation_outputs",
      "evidence",
      "observation_evidence",
      "review_requests"
    ]) {
      expect(
        fixture.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
      ).toEqual({ count: 1 });
    }
    expect(
      fixture.database
        .prepare(
          `SELECT repository_id, repository_ref, repository_authority
           FROM evidence`
        )
        .get()
    ).toEqual({
      repository_id: "repository-1",
      repository_ref: "refs/heads/main",
      repository_authority: "agent_supplied"
    });
    const output = fixture.database
      .prepare(
        `SELECT candidate_id FROM consolidation_outputs
         WHERE project_id = ? AND consolidation_id = ? AND output_order = 0`
      )
      .get(PROJECT_ID, CONSOLIDATION_ID) as { candidate_id: string };
    const analysis = JSON.parse(
      String(
        fixture.database
          .prepare("SELECT analysis_json FROM observations WHERE observation_id = ?")
          .get(output.candidate_id)?.analysis_json
      )
    ) as {
      persistent_value: boolean;
      consolidation_source_ids: string[];
      evidence_source_ids: string[];
    };
    const linkedEvidenceIds = fixture.database
      .prepare(
        `SELECT evidence_id FROM observation_evidence
         WHERE project_id = ? AND observation_id = ? ORDER BY evidence_id ASC`
      )
      .all(PROJECT_ID, output.candidate_id)
      .map((row) => String(row.evidence_id));
    expect(analysis).toMatchObject({
      persistent_value: true,
      consolidation_source_ids: ["session-summary"]
    });
    expect(analysis.evidence_source_ids).toEqual(linkedEvidenceIds);
    expect(analysis.evidence_source_ids).not.toContain("session-summary");
  });

  it("reuses the actual ID of matching preexisting summary evidence", async () => {
    const fixture = createFixture();
    fixture.database
      .prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, repository_id,
          repository_ref, repository_authority, excerpt_hash, sensitivity_status,
          recorded_at)
         VALUES (?, ?, 'session_summary', ?, 'repository-1', 'refs/heads/main',
                 'agent_supplied', 'source-sha', 'clear', ?)`
      )
      .run(
        "preexisting-summary-evidence",
        PROJECT_ID,
        `memory://sessions/${SESSION_ID}/summary`,
        "2026-07-26T00:00:00Z"
      );

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    const output = fixture.database
      .prepare("SELECT candidate_id FROM consolidation_outputs WHERE output_order = 0")
      .get() as { candidate_id: string };
    const analysis = JSON.parse(
      String(
        fixture.database
          .prepare("SELECT analysis_json FROM observations WHERE observation_id = ?")
          .get(output.candidate_id)?.analysis_json
      )
    ) as { evidence_source_ids: string[] };
    expect(analysis.evidence_source_ids).toEqual(["preexisting-summary-evidence"]);
    expect(
      fixture.database
        .prepare(
          "SELECT evidence_id FROM observation_evidence WHERE observation_id = ?"
        )
        .all(output.candidate_id)
    ).toEqual([{ evidence_id: "preexisting-summary-evidence" }]);
  });

  it.each([
    ["mismatched provenance", "mismatched-summary-evidence", "refs/heads/feature"],
    ["an oversized ID", "x".repeat(513), "refs/heads/main"]
  ])("fails closed when preexisting summary evidence has %s", async (
    _reason,
    evidenceId,
    repositoryRef
  ) => {
    const fixture = createFixture();
    fixture.database
      .prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, repository_id,
          repository_ref, repository_authority, excerpt_hash, sensitivity_status,
          recorded_at)
         VALUES (?, ?, 'session_summary', ?, 'repository-1', ?,
                 'agent_supplied', 'source-sha', 'clear', ?)`
      )
      .run(
        evidenceId,
        PROJECT_ID,
        `memory://sessions/${SESSION_ID}/summary`,
        repositoryRef,
        "2026-07-26T00:00:00Z"
      );

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(
      fixture.database
        .prepare("SELECT status FROM session_consolidations")
        .get()
    ).toEqual({ status: "failed" });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM observations
           WHERE source_consolidation_id = ?`
        )
        .get(CONSOLIDATION_ID)
    ).toEqual({ count: 0 });
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM consolidation_outputs").get()
    ).toEqual({ count: 0 });
    expect(
      fixture.database.prepare("SELECT COUNT(*) AS count FROM review_requests").get()
    ).toEqual({ count: 0 });
  });

  it("rolls back when a different summary evidence ID wins the preflight race", async () => {
    const fixture = createFixture({
      beforeConsolidationBatch(database) {
        database
          .prepare(
            `INSERT INTO evidence
             (evidence_id, project_id, source_type, locator, repository_id,
              repository_ref, repository_authority, excerpt_hash, sensitivity_status,
              recorded_at)
             VALUES ('racing-summary-evidence', ?, 'session_summary', ?,
                     'repository-1', 'refs/heads/main', 'agent_supplied',
                     'source-sha', 'clear', ?)`
          )
          .run(
            PROJECT_ID,
            `memory://sessions/${SESSION_ID}/summary`,
            "2026-07-26T00:00:00Z"
          );
      }
    });

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(
      fixture.database
        .prepare(
          `SELECT evidence_id FROM evidence
           WHERE source_type = 'session_summary' AND excerpt_hash = 'source-sha'`
        )
        .get()
    ).toEqual({ evidence_id: "racing-summary-evidence" });
    for (const table of [
      "observations",
      "consolidation_outputs",
      "observation_evidence",
      "review_requests"
    ]) {
      expect(
        fixture.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
      ).toEqual({ count: 0 });
    }
  });

  it("rolls back when same-ID summary evidence becomes a tombstone before the batch", async () => {
    const expectedEvidenceId = await sha256(
      `${PROJECT_ID}\nsession_summary\nmemory://sessions/${SESSION_ID}/summary\nsource-sha`
    );
    const fixture = createFixture({
      beforeConsolidationBatch(database) {
        database
          .prepare(
            `INSERT INTO evidence
             (evidence_id, project_id, source_type, locator, commit_sha, repository_id,
              repository_ref, repository_path, repository_authority, excerpt_hash,
              sensitivity_status, recorded_at)
             VALUES (?, ?, 'session_summary', ?, NULL, 'repository-1',
                     'refs/heads/main', NULL, 'agent_supplied', 'source-sha',
                     'tombstone', ?)`
          )
          .run(
            expectedEvidenceId,
            PROJECT_ID,
            `memory://sessions/${SESSION_ID}/summary`,
            "2026-07-26T00:00:00Z"
          );
      }
    });

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(
      fixture.database
        .prepare("SELECT evidence_id, sensitivity_status FROM evidence")
        .get()
    ).toEqual({ evidence_id: expectedEvidenceId, sensitivity_status: "tombstone" });
    expectConsolidationArtifacts(fixture.database, 0);
  });

  it("rolls back when cited candidate evidence becomes a tombstone before the batch", async () => {
    const fixture = createFixture({
      beforeConsolidationBatch(database) {
        database
          .prepare("UPDATE evidence SET sensitivity_status = 'tombstone' WHERE evidence_id = ?")
          .run("evidence-a");
      }
    });
    fixture.database.prepare("DELETE FROM consolidation_inputs").run();
    addCandidateInput(fixture.database, {
      inputOrder: 0,
      sourceId: "source-a",
      evidence: [{ evidenceId: "evidence-a", sensitivityStatus: "clear" }]
    });
    fixture.suggestion.evidenceSourceIds = ["source-a"];

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(
      fixture.database
        .prepare("SELECT sensitivity_status FROM evidence WHERE evidence_id = ?")
        .get("evidence-a")
    ).toEqual({ sensitivity_status: "tombstone" });
    expectConsolidationArtifacts(fixture.database, 0);
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM observation_evidence
           WHERE observation_id <> 'source-a'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it("normalizes summary and candidate citations to the same clear linked evidence set", async () => {
    const fixture = createFixture();
    addCandidateInput(fixture.database, {
      inputOrder: 1,
      sourceId: "source-a",
      evidence: [
        { evidenceId: "evidence-b", sensitivityStatus: "clear" },
        { evidenceId: "evidence-a", sensitivityStatus: "clear" },
        { evidenceId: "evidence-tombstone", sensitivityStatus: "tombstone" }
      ]
    });
    addCandidateInput(fixture.database, {
      inputOrder: 2,
      sourceId: "source-b",
      evidence: [{ evidenceId: "evidence-a", sensitivityStatus: "clear" }]
    });
    fixture.suggestion.evidenceSourceIds = [
      "session-summary",
      "source-a",
      "source-b"
    ];

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    const output = fixture.database
      .prepare("SELECT candidate_id FROM consolidation_outputs WHERE output_order = 0")
      .get() as { candidate_id: string };
    const analysis = JSON.parse(
      String(
        fixture.database
          .prepare("SELECT analysis_json FROM observations WHERE observation_id = ?")
          .get(output.candidate_id)?.analysis_json
      )
    ) as {
      persistent_value: boolean;
      consolidation_source_ids: string[];
      evidence_source_ids: string[];
    };
    const linkedEvidenceIds = fixture.database
      .prepare(
        `SELECT evidence_id FROM observation_evidence
         WHERE observation_id = ? ORDER BY evidence_id ASC`
      )
      .all(output.candidate_id)
      .map((row) => String(row.evidence_id));
    expect(analysis).toMatchObject({
      persistent_value: true,
      consolidation_source_ids: ["session-summary", "source-a", "source-b"]
    });
    expect(analysis.evidence_source_ids).toEqual(linkedEvidenceIds);
    expect(linkedEvidenceIds).toHaveLength(3);
    expect(linkedEvidenceIds).toContain("evidence-a");
    expect(linkedEvidenceIds).toContain("evidence-b");
    expect(linkedEvidenceIds).not.toContain("evidence-tombstone");
  });

  it.each([
    [0, false],
    [50, true],
    [51, false]
  ])(
    "persists a consolidation output only when %i actual clear evidence IDs fit the review contract",
    async (evidenceCount, shouldPersist) => {
      const fixture = createFixture();
      fixture.database.prepare("DELETE FROM consolidation_inputs").run();
      addCandidateInput(fixture.database, {
        inputOrder: 0,
        sourceId: "source-many",
        evidence: Array.from({ length: evidenceCount }, (_, index) => ({
          evidenceId: `evidence-${String(index).padStart(2, "0")}`,
          sensitivityStatus: "clear" as const
        }))
      });
      fixture.suggestion.evidenceSourceIds = ["source-many"];

      await consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      );

      expect(
        fixture.database.prepare("SELECT COUNT(*) AS count FROM consolidation_outputs").get()
      ).toEqual({ count: shouldPersist ? 1 : 0 });
      if (shouldPersist) {
        const output = fixture.database
          .prepare("SELECT candidate_id FROM consolidation_outputs")
          .get() as { candidate_id: string };
        const analysis = JSON.parse(
          String(
            fixture.database
              .prepare("SELECT analysis_json FROM observations WHERE observation_id = ?")
              .get(output.candidate_id)?.analysis_json
          )
        ) as { evidence_source_ids: string[] };
        expect(analysis.evidence_source_ids).toHaveLength(50);
        expect(
          fixture.database
            .prepare(
              "SELECT COUNT(*) AS count FROM observation_evidence WHERE observation_id = ?"
            )
            .get(output.candidate_id)
        ).toEqual({ count: 50 });
      } else {
        expect(
          fixture.database
            .prepare(
              `SELECT COUNT(*) AS count FROM observations
               WHERE source_consolidation_id = ?`
            )
            .get(CONSOLIDATION_ID)
        ).toEqual({ count: 0 });
        expect(
          fixture.database.prepare("SELECT COUNT(*) AS count FROM review_requests").get()
        ).toEqual({ count: 0 });
      }
    }
  );

  it.each([
    [
      "a legacy prompt transcript",
      "System: You are a coding agent.\nUser: Read every file.\nAssistant: Starting now."
    ],
    [
      "a legacy raw log",
      "2026-07-28T08:00:00.000Z INFO request started\n2026-07-28T08:00:01.000Z ERROR request failed"
    ]
  ])("blocks %s before AI without advancing the queued candidate", async (_label, content) => {
    const fixture = createFixture();
    const candidateId = "legacy-sensitive-candidate";
    fixture.database
      .prepare(
        `INSERT INTO observations
         (observation_id, project_id, session_id, principal_id, candidate_version,
          status, content, content_sha256, evidence_json, created_at)
         VALUES (?, ?, ?, ?, 1, 'queued', ?, 'legacy-content-sha', '[{"legacy":true}]', ?)`
      )
      .run(
        candidateId,
        PROJECT_ID,
        SESSION_ID,
        "principal-1",
        content,
        "2026-07-27T00:00:00Z"
      );
    expect(inspectCandidateContent(content, { maxBytes: 16 * 1024 })).toEqual({
      accepted: true
    });
    const ai = { run: vi.fn() };

    await expect(
      processCandidateSubmission(
        {
          MEMORY_DB: sqliteD1(fixture.database),
          AI: ai
        } as unknown as Parameters<typeof processCandidateSubmission>[0],
        PROJECT_ID,
        candidateId
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(ai.run).not.toHaveBeenCalled();
    expect(
      fixture.database
        .prepare(
          `SELECT status, content, content_sha256, evidence_json, kind, memory_class,
                  scope, scope_id, valid_from, valid_until, analysis_json,
                  review_reason, reviewed_content
           FROM observations WHERE observation_id = ?`
        )
        .get(candidateId)
    ).toEqual({
      status: "queued",
      content,
      content_sha256: "legacy-content-sha",
      evidence_json: '[{"legacy":true}]',
      kind: null,
      memory_class: null,
      scope: null,
      scope_id: null,
      valid_from: null,
      valid_until: null,
      analysis_json: null,
      review_reason: null,
      reviewed_content: null
    });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM review_requests WHERE candidate_id = ?")
        .get(candidateId)
    ).toEqual({ count: 0 });
  });
});

function createFixture(options: {
  beforeConsolidationBatch?: (database: DatabaseSync) => void;
  afterConsolidationBatchStatement?: (
    database: DatabaseSync,
    statementIndex: number
  ) => void;
  afterConsolidationBatchCommit?: (database: DatabaseSync) => void;
  afterClaimBatchCommit?: (database: DatabaseSync) => void;
  beforeRenewalRun?: (database: DatabaseSync) => void;
  afterRenewalRun?: (database: DatabaseSync) => void;
  observeRenewalRun?: (database: DatabaseSync) => void;
  observeReceiptRead?: (database: DatabaseSync) => void;
} = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE repositories (
      repository_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      status TEXT NOT NULL,
      repository_id TEXT,
      repository_ref TEXT
    );
    CREATE TABLE session_consolidations (
      consolidation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed', 'noop')),
      input_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_claim_id TEXT,
      lease_expires_at TEXT,
      lease_operation_id TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 0,
      receipt_post_state_valid INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE consolidation_inputs (
      project_id TEXT NOT NULL,
      consolidation_id TEXT NOT NULL,
      input_order INTEGER NOT NULL,
      input_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL
    );
    CREATE TABLE observations (
      observation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT,
      principal_id TEXT,
      candidate_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'queued', 'pending_review', 'approved', 'rejected', 'request_changes',
          'rejected_sensitive', 'promoted', 'noop',
          'consolidation_evidence_provenance_conflict'
        )
      ),
      content TEXT,
      content_sha256 TEXT,
      evidence_json TEXT NOT NULL,
      kind TEXT,
      memory_class TEXT,
      scope TEXT,
      scope_id TEXT,
      valid_from TEXT,
      valid_until TEXT,
      analysis_json TEXT,
      review_reason TEXT,
      reviewed_content TEXT,
      source_consolidation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE (project_id, observation_id)
    );
    CREATE TABLE consolidation_outputs (
      project_id TEXT NOT NULL,
      consolidation_id TEXT NOT NULL,
      output_order INTEGER NOT NULL,
      candidate_id TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, consolidation_id, output_order),
      UNIQUE (project_id, candidate_id)
    );
    CREATE TABLE consolidation_batch_receipts (
      project_id TEXT NOT NULL,
      consolidation_id TEXT NOT NULL,
      batch_index INTEGER NOT NULL,
      lease_owner TEXT NOT NULL,
      lease_claim_id TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL,
      lease_operation_id TEXT NOT NULL,
      batch_input_digest TEXT NOT NULL,
      model_result_digest TEXT NOT NULL,
      output_manifest_json TEXT NOT NULL,
      output_manifest_digest TEXT NOT NULL,
      suggestion_count INTEGER NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (project_id, consolidation_id, batch_index)
    );
    CREATE TABLE evidence (
      evidence_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      locator TEXT NOT NULL,
      commit_sha TEXT,
      repository_id TEXT,
      repository_ref TEXT,
      repository_path TEXT,
      repository_authority TEXT,
      excerpt_hash TEXT NOT NULL,
      sensitivity_status TEXT NOT NULL CHECK (
        sensitivity_status IN ('clear', 'quarantined', 'tombstone')
      ),
      recorded_at TEXT NOT NULL,
      UNIQUE (project_id, source_type, locator, excerpt_hash)
    );
    CREATE TRIGGER evidence_identity_immutable
    BEFORE UPDATE OF evidence_id, commit_sha ON evidence
    WHEN NEW.evidence_id IS NOT OLD.evidence_id
      OR NEW.commit_sha IS NOT OLD.commit_sha
    BEGIN
      SELECT RAISE(ABORT, 'evidence identity is immutable');
    END;
    CREATE TRIGGER evidence_repository_context_immutable
    BEFORE UPDATE OF repository_id, repository_ref, repository_path,
      repository_authority ON evidence
    WHEN NEW.repository_id IS NOT OLD.repository_id
      OR NEW.repository_ref IS NOT OLD.repository_ref
      OR NEW.repository_path IS NOT OLD.repository_path
      OR NEW.repository_authority IS NOT OLD.repository_authority
    BEGIN
      SELECT RAISE(ABORT, 'evidence repository context is immutable');
    END;
    CREATE TABLE observation_evidence (
      project_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, observation_id, evidence_id)
    );
    CREATE TABLE review_requests (
      review_request_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      candidate_id TEXT,
      status TEXT NOT NULL,
      required_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, candidate_id)
    );
    CREATE TRIGGER consolidation_batch_receipts_insert_guard
    BEFORE INSERT ON consolidation_batch_receipts
    WHEN NOT EXISTS (
        SELECT 1
        FROM session_consolidations AS consolidation
        WHERE consolidation.project_id = NEW.project_id
          AND consolidation.consolidation_id = NEW.consolidation_id
          AND consolidation.status = 'running'
          AND consolidation.lease_owner = NEW.lease_owner
          AND consolidation.lease_claim_id = NEW.lease_claim_id
          AND consolidation.lease_epoch = NEW.lease_epoch
          AND consolidation.lease_operation_id = NEW.lease_operation_id
          AND consolidation.lease_expires_at IS NOT NULL
          AND consolidation.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      OR EXISTS (
        SELECT 1
        FROM json_each(NEW.output_manifest_json) AS entry
        WHERE NOT EXISTS (
            SELECT 1
            FROM consolidation_outputs AS output
            JOIN observations AS candidate
              ON candidate.project_id = output.project_id
             AND candidate.observation_id = output.candidate_id
            WHERE output.project_id = NEW.project_id
              AND output.consolidation_id = NEW.consolidation_id
              AND output.output_order = json_extract(entry.value, '$.output_order')
              AND output.candidate_id = json_extract(entry.value, '$.candidate_id')
              AND candidate.source_consolidation_id = NEW.consolidation_id
              AND candidate.content_sha256 = json_extract(entry.value, '$.content_sha256')
          )
      )
      OR EXISTS (
        SELECT 1
        FROM json_each(NEW.output_manifest_json) AS entry
        JOIN consolidation_outputs AS output
          ON output.project_id = NEW.project_id
         AND output.consolidation_id = NEW.consolidation_id
         AND output.output_order = json_extract(entry.value, '$.output_order')
         AND output.candidate_id = json_extract(entry.value, '$.candidate_id')
        WHERE NOT EXISTS (
            SELECT 1 FROM review_requests AS review
            WHERE review.project_id = NEW.project_id
              AND review.candidate_id = output.candidate_id
          )
          OR (
            SELECT COUNT(*)
            FROM observation_evidence AS linked
            WHERE linked.project_id = NEW.project_id
              AND linked.observation_id = output.candidate_id
          ) <> json_array_length(json_extract(entry.value, '$.evidence_ids'))
          OR EXISTS (
            SELECT 1
            FROM json_each(json_extract(entry.value, '$.evidence_ids')) AS expected
            WHERE NOT EXISTS (
              SELECT 1 FROM observation_evidence AS linked
              WHERE linked.project_id = NEW.project_id
                AND linked.observation_id = output.candidate_id
                AND linked.evidence_id = expected.value
            )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM consolidation_outputs AS output
        JOIN observations AS candidate
          ON candidate.project_id = output.project_id
         AND candidate.observation_id = output.candidate_id
        WHERE output.project_id = NEW.project_id
          AND output.consolidation_id = NEW.consolidation_id
          AND output.output_order BETWEEN NEW.batch_index * 10 AND NEW.batch_index * 10 + 9
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(NEW.output_manifest_json) AS entry
            WHERE json_extract(entry.value, '$.output_order') = output.output_order
              AND json_extract(entry.value, '$.candidate_id') = output.candidate_id
              AND json_extract(entry.value, '$.content_sha256') = candidate.content_sha256
          )
      )
    BEGIN
      SELECT RAISE(ABORT, 'consolidation batch receipt final state is invalid');
    END;
  `);
  database
    .prepare("INSERT INTO repositories VALUES (?, ?)")
    .run("repository-1", PROJECT_ID);
  database
    .prepare("INSERT INTO sessions VALUES (?, ?, ?, 'closed', ?, ?)")
    .run(
      SESSION_ID,
      PROJECT_ID,
      "principal-1",
      "repository-1",
      "refs/heads/main"
    );
  database
    .prepare(
      `INSERT INTO session_consolidations
       (consolidation_id, project_id, session_id, status, input_digest, updated_at,
        lease_owner, lease_claim_id, lease_expires_at, lease_operation_id, lease_epoch)
       VALUES (?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL, 0)`
    )
    .run(
      CONSOLIDATION_ID,
      PROJECT_ID,
      SESSION_ID,
      "input-digest",
      "2026-07-27T00:00:00Z"
    );
  database
    .prepare("INSERT INTO consolidation_inputs VALUES (?, ?, 0, 'summary', ?, ?, ?)")
    .run(
      PROJECT_ID,
      CONSOLIDATION_ID,
      "session-summary",
      "D1 is authoritative.",
      "source-sha"
    );

  const suggestion = {
    content: "The SQLite-backed winner.",
    evidenceSourceIds: ["session-summary"]
  };
  const aiRun = vi.fn(async (_model: unknown, input: unknown) => {
      const prompt = modelPrompt(input);
      const projectOption = prompt.scope_options.find(
        (option) => option.scope === "project"
      );
      if (projectOption === undefined) {
        throw new Error("The test model could not select a project scope option.");
      }
      return modelFunctionResponse("consolidation_suggestions", {
        suggestions: [
          {
            content: suggestion.content,
            kind: "decision",
            memory_class: "semantic",
            scope_option_id: projectOption.option_id,
            evidence_source_ids: suggestion.evidenceSourceIds,
            confidence: 0.99
          }
        ]
      });
  });
  const ai = { run: aiRun };
  return {
    database,
    suggestion,
    env: {
      MEMORY_DB: sqliteD1(
        database,
        () => options.beforeConsolidationBatch?.(database),
        (statementIndex) =>
          options.afterConsolidationBatchStatement?.(database, statementIndex),
        () => options.afterConsolidationBatchCommit?.(database),
        () => options.afterClaimBatchCommit?.(database),
        () => options.beforeRenewalRun?.(database),
        () => options.afterRenewalRun?.(database),
        () => options.observeRenewalRun?.(database),
        () => options.observeReceiptRead?.(database)
      ),
      AI: ai
    } as unknown as Parameters<
      typeof consolidateSession
    >[0],
    aiRun
  };
}

function expectConsolidationArtifacts(database: DatabaseSync, expectedCount: number): void {
  for (const table of ["consolidation_outputs", "review_requests"]) {
    expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
      count: expectedCount
    });
  }
  expect(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM observations
         WHERE source_consolidation_id = ?`
      )
      .get(CONSOLIDATION_ID)
  ).toEqual({ count: expectedCount });
}

function addCandidateInput(
  database: DatabaseSync,
  input: {
    inputOrder: number;
    sourceId: string;
    evidence: Array<{
      evidenceId: string;
      sensitivityStatus: "clear" | "tombstone";
    }>;
  }
): void {
  database
    .prepare(
      `INSERT INTO observations
       (observation_id, project_id, session_id, principal_id, candidate_version,
        status, content, content_sha256, evidence_json, created_at)
       VALUES (?, ?, ?, 'principal-1', 1, 'pending_review', ?, ?, '[]', ?)`
    )
    .run(
      input.sourceId,
      PROJECT_ID,
      SESSION_ID,
      `Frozen candidate ${input.sourceId}.`,
      `sha-${input.sourceId}`,
      "2026-07-27T00:00:00Z"
    );
  database
    .prepare("INSERT INTO consolidation_inputs VALUES (?, ?, ?, 'candidate', ?, ?, ?)")
    .run(
      PROJECT_ID,
      CONSOLIDATION_ID,
      input.inputOrder,
      input.sourceId,
      `Frozen candidate ${input.sourceId}.`,
      `sha-${input.sourceId}`
    );
  for (const evidence of input.evidence) {
    database
      .prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, repository_id,
          repository_ref, repository_authority, excerpt_hash, sensitivity_status,
          recorded_at)
         VALUES (?, ?, 'agent_submission', ?, 'repository-1', 'refs/heads/main',
                 'agent_supplied', ?, ?, ?)
         ON CONFLICT(evidence_id) DO NOTHING`
      )
      .run(
        evidence.evidenceId,
        PROJECT_ID,
        `memory://candidates/${evidence.evidenceId}`,
        `excerpt-${evidence.evidenceId}`,
        evidence.sensitivityStatus,
        "2026-07-27T00:00:00Z"
      );
    database
      .prepare(
        `INSERT INTO observation_evidence
         (project_id, observation_id, evidence_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, observation_id, evidence_id) DO NOTHING`
      )
      .run(
        PROJECT_ID,
        input.sourceId,
        evidence.evidenceId,
        "2026-07-27T00:00:00Z"
      );
  }
}

function modelPrompt(input: unknown): {
  scope_options: Array<{ option_id: string; scope: string }>;
} {
  if (
    typeof input !== "object" ||
    input === null ||
    !("messages" in input) ||
    !Array.isArray(input.messages)
  ) {
    throw new Error("The AI request is invalid.");
  }
  const content = input.messages.at(-1)?.content;
  if (typeof content !== "string") {
    throw new Error("The AI prompt is invalid.");
  }
  return JSON.parse(content) as {
    scope_options: Array<{ option_id: string; scope: string }>;
  };
}

function modelFunctionResponse(name: string, value: unknown): Record<string, unknown> {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: "function",
              function: { name, arguments: JSON.stringify(value) }
            }
          ]
        }
      }
    ]
  };
}

function sqliteD1(
  database: DatabaseSync,
  beforeBatch?: () => void,
  afterBatchStatement?: (statementIndex: number) => void,
  afterBatchCommit?: () => void,
  afterSessionBatchCommit?: () => void,
  beforeRenewalRun?: () => void,
  afterRenewalRun?: () => void,
  observeRenewalRun?: () => void,
  observeReceiptRead?: () => void
): D1Database {
  const prepare = (sql: string) => {
    let bindings: SQLInputValue[] = [];
    const statement = {
      sql,
      bind(...values: unknown[]) {
        bindings = values as SQLInputValue[];
        return statement;
      },
      async first<T>() {
        if (
          sql.includes(
            "SELECT lease_owner, lease_claim_id, lease_epoch, lease_operation_id"
          )
        ) {
          observeReceiptRead?.();
        }
        return (database.prepare(sql).get(...bindings) ?? null) as T | null;
      },
      async all<T>() {
        return { results: database.prepare(sql).all(...bindings) as T[] };
      },
      async run<T>() {
        if (sql.includes("SET lease_expires_at = ?")) {
          const renewalHook = beforeRenewalRun;
          beforeRenewalRun = undefined;
          renewalHook?.();
        }
        const changes = Number(database.prepare(sql).run(...bindings).changes);
        if (sql.includes("SET lease_expires_at = ?")) {
          const renewalHook = afterRenewalRun;
          afterRenewalRun = undefined;
          renewalHook?.();
          observeRenewalRun?.();
        }
        return d1Result(changes) as T;
      }
    };
    return statement;
  };
  const executeBatch = async (
    statements: ReturnType<typeof prepare>[],
    invokeHook: boolean
  ) => {
    const isConsolidationBatch =
      invokeHook &&
      statements.some((statement) =>
        /\bINSERT\s+INTO\s+consolidation_batch_receipts\b/iu.test(statement.sql)
      );
    if (isConsolidationBatch) {
      expect(statements.length).toBeLessThan(1_000);
      expect(
        Math.max(
          ...statements.map(
            (statement) => statement.sql.match(/\?/gu)?.length ?? 0
          )
        )
      ).toBeLessThan(100);
      const batchHook = beforeBatch;
      beforeBatch = undefined;
      batchHook?.();
    }
    database.exec("BEGIN IMMEDIATE");
    const results = [];
    try {
      for (const [statementIndex, statement] of statements.entries()) {
        results.push(
          /^\s*SELECT\b/iu.test(statement.sql)
            ? await statement.all()
            : await statement.run()
        );
        if (isConsolidationBatch) {
          afterBatchStatement?.(statementIndex);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (isConsolidationBatch) {
      const commitHook = afterBatchCommit;
      afterBatchCommit = undefined;
      commitHook?.();
    } else if (!invokeHook) {
      const commitHook = afterSessionBatchCommit;
      afterSessionBatchCommit = undefined;
      commitHook?.();
    }
    return results;
  };
  return {
    prepare,
    withSession() {
      return {
        prepare,
        batch(statements: ReturnType<typeof prepare>[]) {
          return executeBatch(statements, false);
        }
      };
    },
    async batch(statements: ReturnType<typeof prepare>[]) {
      return executeBatch(statements, true);
    }
  } as unknown as D1Database;
}

function d1Result(changes: number) {
  return {
    success: true as const,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes
    },
    results: []
  };
}
