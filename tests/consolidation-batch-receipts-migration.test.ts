import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const RECEIPT_MIGRATION = "0018_consolidation_batch_receipts.sql";

describe("consolidation batch receipt migration", () => {
  it("requires legacy consolidation leases to be drained before contract cutover", () => {
    const database = databaseBeforeReceiptMigration();
    try {
      seedProject(database, "project-1", "project-1");
      seedClosedSession(database, "project-1", "session-1");
      database.prepare(
        `INSERT INTO session_consolidations
         (consolidation_id, project_id, session_id, session_version, status,
          input_digest, created_at, updated_at, lease_owner, lease_expires_at,
          lease_operation_id, lease_epoch)
         VALUES ('consolidation-1', 'project-1', 'session-1', 2, 'running',
                 ?, ?, ?, 'legacy-owner', ?, NULL, 1)`
      ).run(
        "a".repeat(64),
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:20:00.000Z"
      );

      expect(() => applyReceiptMigration(database)).toThrow(
        /consolidation_receipt_cutover_requires_drained_leases/iu
      );
    } finally {
      database.close();
    }
  });

  it("adds a claim fence and immutable batch receipts with bounded coordinates", () => {
    const database = databaseBeforeReceiptMigration();
    try {
      seedProject(database, "project-1", "project-1");
      seedClosedSession(database, "project-1", "session-1");
      seedConsolidation(database, "project-1", "session-1", "consolidation-1");
      applyReceiptMigration(database);

      expect(
        database.prepare(
          `SELECT lease_claim_id FROM session_consolidations
           WHERE consolidation_id = 'consolidation-1'`
        ).get()
      ).toEqual({ lease_claim_id: null });
      expect(() => database.prepare(
        `UPDATE session_consolidations
         SET status = 'running', lease_owner = 'owner-1', lease_epoch = 1,
             lease_expires_at = '2026-08-01T00:20:00.000Z'
         WHERE consolidation_id = 'consolidation-1'`
      ).run()).toThrow(/consolidation lease state is invalid/iu);

      expect(() => database.prepare(
        `UPDATE session_consolidations
         SET status = 'running', lease_owner = 'owner-1', lease_claim_id = ?,
             lease_epoch = 1, lease_expires_at = 'abcdefghijklmnopqrstuvwx'
         WHERE consolidation_id = 'consolidation-1'`
      ).run(
        "11111111-1111-4111-8111-111111111111"
      )).toThrow(/consolidation lease state is invalid/iu);

      database.prepare(
        `UPDATE session_consolidations
         SET status = 'running', lease_owner = 'owner-1', lease_claim_id = ?,
             lease_epoch = 1, lease_expires_at = '2099-08-01T00:20:00.000Z',
             lease_operation_id = ?
         WHERE consolidation_id = 'consolidation-1'`
      ).run(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222"
      );

      expect(() => database.prepare(
        `INSERT INTO consolidation_batch_receipts
         (project_id, consolidation_id, batch_index, lease_owner, lease_claim_id,
          lease_epoch, lease_operation_id, batch_input_digest, model_result_digest,
          output_manifest_json, output_manifest_digest, suggestion_count, completed_at)
         VALUES ('project-1', 'consolidation-1', 900719925474097, 'owner-1', ?, 1, ?,
                 ?, ?, '[]', ?, 0, 'abcdefghijklmnopqrstuvwx')`
      ).run(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64)
      )).toThrow(/check constraint failed/iu);

      expect(() => database.prepare(
        `INSERT INTO consolidation_batch_receipts
         (project_id, consolidation_id, batch_index, lease_owner, lease_claim_id,
          lease_epoch, lease_operation_id, batch_input_digest, model_result_digest,
          output_manifest_json, output_manifest_digest, suggestion_count, completed_at)
         VALUES ('project-1', 'consolidation-1', 900719925474098, 'owner-1', ?, 1, ?,
                 ?, ?, '[]', ?, 0, ?)`
      ).run(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "2026-08-01T00:00:00.000Z"
      )).not.toThrow();
      expect(() => database.prepare(
        `INSERT INTO consolidation_batch_receipts
         (project_id, consolidation_id, batch_index, lease_owner, lease_claim_id,
          lease_epoch, lease_operation_id, batch_input_digest, model_result_digest,
          output_manifest_json, output_manifest_digest, suggestion_count, completed_at)
         VALUES ('project-1', 'consolidation-1', 900719925474099, 'owner-1', ?, 1, ?,
                 ?, ?, '[]', ?, 0, ?)`
      ).run(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "2026-08-01T00:00:00.000Z"
      )).toThrow(/check constraint failed/iu);
    } finally {
      database.close();
    }
  });

  it("keeps terminal validation compact and indexes receipt-bound candidates", () => {
    const database = databaseBeforeReceiptMigration();
    try {
      applyReceiptMigration(database);
      const terminalTrigger = database.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'trigger'
           AND name = 'session_consolidations_terminal_receipt_guard'`
      ).get() as { sql: string };
      const candidateIndex = database.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index'
           AND name = 'consolidation_outputs_by_receipt_candidate'`
      ).get() as { sql: string };

      expect(terminalTrigger.sql).toContain("receipt_post_state_valid");
      expect(terminalTrigger.sql).toContain("expected_batches");
      expect(terminalTrigger.sql).not.toMatch(/output_manifest_json|json_each/iu);
      expect(candidateIndex.sql).toContain(
        "project_id, candidate_id, consolidation_id, output_order"
      );
    } finally {
      database.close();
    }
  });

  it("invalidates a nonterminal receipt when linked evidence becomes sensitive", () => {
    const database = databaseBeforeReceiptMigration();
    try {
      seedBoundReceipt(database);

      database.prepare(
        `UPDATE evidence SET sensitivity_status = 'quarantined'
         WHERE evidence_id = 'evidence-1'`
      ).run();
      expect(database.prepare(
        `SELECT receipt_post_state_valid FROM session_consolidations
         WHERE consolidation_id = 'consolidation-1'`
      ).get()).toEqual({ receipt_post_state_valid: 0 });
      expect(() => database.prepare(
        `UPDATE session_consolidations
         SET status = 'complete', lease_owner = NULL, lease_claim_id = NULL,
             lease_expires_at = NULL, lease_operation_id = NULL
         WHERE consolidation_id = 'consolidation-1'`
      ).run()).toThrow(/consolidation terminal receipt state is invalid/iu);
      expect(() => database.prepare(
        `UPDATE session_consolidations SET receipt_post_state_valid = 1
         WHERE consolidation_id = 'consolidation-1'`
      ).run()).toThrow(/receipt post-state cannot be revalidated/iu);
    } finally {
      database.close();
    }
  });

  it("accepts only a receipt that witnesses the exact live operation and post-state", () => {
    const database = databaseBeforeReceiptMigration();
    try {
      seedProject(database, "project-1", "project-1");
      seedClosedSession(database, "project-1", "session-1");
      seedConsolidation(database, "project-1", "session-1", "consolidation-1");
      applyReceiptMigration(database);
      const claimId = "11111111-1111-4111-8111-111111111111";
      const operationId = "22222222-2222-4222-8222-222222222222";
      const candidateId = "33333333-3333-5333-a333-333333333333";
      const evidenceId = "evidence-1";
      const contentSha = "d".repeat(64);
      const now = "2026-08-01T00:00:00.000Z";
      database.prepare(
        `UPDATE session_consolidations
         SET status = 'running', lease_owner = 'owner-1', lease_claim_id = ?,
             lease_epoch = 1, lease_expires_at = '2099-08-01T00:20:00.000Z',
             lease_operation_id = ?, updated_at = ?
         WHERE consolidation_id = 'consolidation-1'`
      ).run(claimId, operationId, now);
      database.prepare(
        `INSERT INTO consolidation_inputs
         (project_id, consolidation_id, input_order, input_kind, source_id,
          content, content_sha256)
         VALUES ('project-1', 'consolidation-1', 0, 'summary', 'session-summary',
                 'D1 is authoritative.', ?)`
      ).run("a".repeat(64));
      database.prepare(
        `INSERT INTO observations
         (observation_id, project_id, session_id, principal_id, candidate_version,
          status, content, content_sha256, evidence_json, analysis_json,
          source_consolidation_id,
          created_at, updated_at)
         VALUES (?, 'project-1', 'session-1', 'principal-1', 1, 'pending_review',
                 'durable fact', ?, '[]', '{}', 'consolidation-1', ?, ?)`
      ).run(candidateId, contentSha, now, now);
      database.prepare(
        `INSERT INTO consolidation_outputs
         (project_id, consolidation_id, output_order, candidate_id, input_digest, created_at)
         VALUES ('project-1', 'consolidation-1', 0, ?, ?, ?)`
      ).run(candidateId, "a".repeat(64), now);
      database.prepare(
        `INSERT INTO review_requests
         (review_request_id, project_id, candidate_id, status, required_role,
          created_at, updated_at)
         VALUES (?, 'project-1', ?, 'pending', 'maintainer', ?, ?)`
      ).run(candidateId, candidateId, now, now);
      database.prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, excerpt_hash,
          sensitivity_status, recorded_at)
         VALUES (?, 'project-1', 'agent_submission', 'memory://evidence/1', ?,
                 'clear', ?)`
      ).run(evidenceId, "e".repeat(64), now);
      database.prepare(
        `INSERT INTO observation_evidence
         (project_id, observation_id, evidence_id, created_at)
         VALUES ('project-1', ?, ?, ?)`
      ).run(candidateId, evidenceId, now);
      for (const malformedManifest of [
        JSON.stringify([
          {
            output_order: 0,
            candidate_id: candidateId,
            evidence_ids: [evidenceId]
          }
        ]),
        JSON.stringify([
          {
            output_order: 0,
            candidate_id: candidateId,
            content_sha256: null,
            evidence_ids: [evidenceId]
          }
        ]),
        JSON.stringify([
          {
            output_order: 0,
            candidate_id: candidateId,
            content_sha256: contentSha,
            evidence_ids: [evidenceId],
            extra: true
          }
        ]),
        JSON.stringify([
          {
            output_order: 0,
            candidate_id: candidateId,
            content_sha256: contentSha,
            evidence_ids: []
          }
        ])
      ]) {
        expect(() => insertReceipt(database, {
          claimId,
          operationId,
          manifest: malformedManifest,
          suggestionCount: 1
        })).toThrow(/consolidation batch receipt final state is invalid/iu);
      }

      const secondEvidenceId = "evidence-2";
      database.prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, excerpt_hash,
          sensitivity_status, recorded_at)
         VALUES (?, 'project-1', 'agent_submission', 'memory://evidence/2', ?,
                 'clear', ?)`
      ).run(secondEvidenceId, "f".repeat(64), now);
      database.prepare(
        `INSERT INTO observation_evidence
         (project_id, observation_id, evidence_id, created_at)
         VALUES ('project-1', ?, ?, ?)`
      ).run(candidateId, secondEvidenceId, now);
      expect(() => insertReceipt(database, {
        claimId,
        operationId,
        manifest: JSON.stringify([
          {
            output_order: 0,
            candidate_id: candidateId,
            content_sha256: contentSha,
            evidence_ids: [evidenceId, evidenceId]
          }
        ]),
        suggestionCount: 1
      })).toThrow(/consolidation batch receipt final state is invalid/iu);
      const validManifest = JSON.stringify([
        {
          output_order: 0,
          candidate_id: candidateId,
          content_sha256: contentSha,
          evidence_ids: [evidenceId, secondEvidenceId]
        }
      ]);

      database.prepare(
        `UPDATE review_requests SET status = 'approved' WHERE candidate_id = ?`
      ).run(candidateId);
      expect(() => insertReceipt(database, {
        claimId,
        operationId,
        manifest: validManifest,
        suggestionCount: 1
      })).toThrow(/consolidation batch receipt final state is invalid/iu);
      database.prepare(
        `UPDATE review_requests SET status = 'pending' WHERE candidate_id = ?`
      ).run(candidateId);

      database.prepare(
        `UPDATE evidence SET sensitivity_status = 'quarantined' WHERE evidence_id = ?`
      ).run(evidenceId);
      expect(() => insertReceipt(database, {
        claimId,
        operationId,
        manifest: validManifest,
        suggestionCount: 1
      })).toThrow(/consolidation batch receipt final state is invalid/iu);
      database.prepare(
        `UPDATE evidence SET sensitivity_status = 'clear' WHERE evidence_id = ?`
      ).run(evidenceId);

      expect(() => insertReceipt(database, {
        claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        operationId,
        manifest: validManifest,
        suggestionCount: 1
      })).toThrow(/consolidation batch receipt final state is invalid/iu);
      database.prepare(
        `UPDATE review_requests SET review_request_id = 'wrong-review'
         WHERE candidate_id = ?`
      ).run(candidateId);
      expect(() => insertReceipt(database, {
        claimId,
        operationId,
        manifest: validManifest,
        suggestionCount: 1
      })).toThrow(/consolidation batch receipt final state is invalid/iu);
      database.prepare(
        `UPDATE review_requests SET review_request_id = ?
         WHERE candidate_id = ?`
      ).run(candidateId, candidateId);
      const unrelatedCandidateId = "44444444-4444-5444-a444-444444444444";
      database.prepare(
        `INSERT INTO observations
         (observation_id, project_id, session_id, principal_id, candidate_version,
          status, content, content_sha256, evidence_json, analysis_json,
          source_consolidation_id,
          created_at, updated_at)
         VALUES (?, 'project-1', 'session-1', 'principal-1', 1, 'pending_review',
                 'unrelated duplicate', ?, '[]', '{}', 'consolidation-1', ?, ?)`
      ).run(unrelatedCandidateId, contentSha, now, now);
      expect(() => insertReceipt(database, {
        claimId,
        operationId,
        manifest: JSON.stringify([
          {
            output_order: 1,
            candidate_id: "55555555-5555-5555-a555-555555555555",
            content_sha256: contentSha,
            evidence_ids: [evidenceId]
          }
        ]),
        suggestionCount: 1
      })).toThrow(/consolidation batch receipt final state is invalid/iu);
      insertReceipt(database, {
        claimId,
        operationId,
        manifest: validManifest,
        suggestionCount: 1
      });
      expect(() => database.prepare(
        `UPDATE session_consolidations SET input_digest = ?
         WHERE consolidation_id = 'consolidation-1'`
      ).run("9".repeat(64))).toThrow(/receipt source state is immutable/iu);
      expect(() => database.prepare(
        `INSERT INTO consolidation_inputs
         (project_id, consolidation_id, input_order, input_kind, source_id,
          content, content_sha256)
         VALUES ('project-1', 'consolidation-1', 50, 'summary', 'late-summary',
                 'late input', ?)`
      ).run("8".repeat(64))).toThrow(/receipt input set is immutable/iu);
      expect(() => database.prepare(
        `UPDATE review_requests SET required_role = 'reader' WHERE candidate_id = ?`
      ).run(candidateId)).toThrow(/receipt review identity is immutable/iu);
      expect(() => database.prepare(
        `DELETE FROM review_requests WHERE candidate_id = ?`
      ).run(candidateId)).toThrow(/receipt review identity is immutable/iu);
      expect(() => database.prepare(
        `UPDATE observations SET analysis_json = '{"changed":true}'
         WHERE observation_id = ?`
      ).run(candidateId)).toThrow(/receipt candidate state is immutable/iu);
      expect(() => database.prepare(
        `UPDATE observations SET content = 'tampered' WHERE observation_id = ?`
      ).run(candidateId)).toThrow(/immutable/iu);
      expect(() => database.prepare(
        `UPDATE observations SET kind = 'fact' WHERE observation_id = ?`
      ).run(candidateId)).toThrow(/receipt candidate state is immutable/iu);
      expect(() => database.prepare(
        `INSERT INTO consolidation_outputs
         (project_id, consolidation_id, output_order, candidate_id, input_digest, created_at)
         VALUES ('project-1', 'consolidation-1', 1, ?, ?, ?)`
      ).run(candidateId, "a".repeat(64), now)).toThrow(
        /receipt output slots are immutable/iu
      );
      expect(() => database.prepare(
        `UPDATE consolidation_outputs SET input_digest = ?
         WHERE candidate_id = ?`
      ).run("2".repeat(64), candidateId)).toThrow(
        /consolidation outputs are immutable/iu
      );
      expect(() => database.prepare(
        `DELETE FROM consolidation_outputs WHERE candidate_id = ?`
      ).run(candidateId)).toThrow(/consolidation outputs are immutable/iu);
      database.prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, excerpt_hash,
          sensitivity_status, recorded_at)
         VALUES ('evidence-3', 'project-1', 'agent_submission',
                 'memory://evidence/3', ?, 'clear', ?)`
      ).run("1".repeat(64), now);
      expect(() => database.prepare(
        `INSERT INTO observation_evidence
         (project_id, observation_id, evidence_id, created_at)
         VALUES ('project-1', ?, 'evidence-3', ?)`
      ).run(candidateId, now)).toThrow(/receipt evidence links are immutable/iu);
      expect(() => database.prepare(
        `DELETE FROM observation_evidence
         WHERE project_id = 'project-1' AND observation_id = ?`
      ).run(candidateId)).toThrow(/receipt evidence links are immutable/iu);
      expect(() => database.prepare(
        `UPDATE review_requests SET status = 'approved', updated_at = ?
         WHERE candidate_id = ?`
      ).run("2026-08-01T00:01:00.000Z", candidateId)).not.toThrow();
      expect(() => database.prepare(
        `UPDATE observations
         SET status = 'request_changes', candidate_version = candidate_version + 1,
             updated_at = ?
         WHERE observation_id = ?`
      ).run("2026-08-01T00:01:00.000Z", candidateId)).not.toThrow();
      expect(() => database.prepare(
        `UPDATE session_consolidations
         SET status = 'complete', lease_owner = NULL, lease_claim_id = NULL,
             lease_expires_at = NULL, lease_operation_id = NULL
         WHERE consolidation_id = 'consolidation-1'`
      ).run()).not.toThrow();
      expect(() => database.prepare(
        `UPDATE consolidation_batch_receipts SET suggestion_count = 0
         WHERE consolidation_id = 'consolidation-1'`
      ).run()).toThrow(/consolidation batch receipts are immutable/iu);
      expect(() => database.prepare(
        `DELETE FROM consolidation_batch_receipts
         WHERE consolidation_id = 'consolidation-1'`
      ).run()).toThrow(/consolidation batch receipts are immutable/iu);
    } finally {
      database.close();
    }
  });

  it.each([
    ["a v4 candidate", "33333333-3333-4333-a333-333333333333"],
    ["a non-a variant candidate", "33333333-3333-5333-8333-333333333333"],
    ["an extra-hyphen candidate", "-3333333-3333-5333-a333-333333333333"]
  ])("rejects an exact output whose candidate ID is %s", (_label, candidateId) => {
    const database = databaseBeforeReceiptMigration();
    try {
      seedProject(database, "project-1", "project-1");
      seedClosedSession(database, "project-1", "session-1");
      seedConsolidation(database, "project-1", "session-1", "consolidation-1");
      applyReceiptMigration(database);
      const claimId = "11111111-1111-4111-8111-111111111111";
      const operationId = "22222222-2222-4222-8222-222222222222";
      const evidenceId = "evidence-1";
      const contentSha = "d".repeat(64);
      const now = "2026-08-01T00:00:00.000Z";
      database.prepare(
        `UPDATE session_consolidations
         SET status = 'running', lease_owner = 'owner-1', lease_claim_id = ?,
             lease_epoch = 1, lease_expires_at = '2099-08-01T00:20:00.000Z',
             lease_operation_id = ?
         WHERE consolidation_id = 'consolidation-1'`
      ).run(claimId, operationId);
      database.prepare(
        `INSERT INTO observations
         (observation_id, project_id, session_id, principal_id, candidate_version,
          status, content, content_sha256, evidence_json, analysis_json,
          source_consolidation_id, created_at, updated_at)
         VALUES (?, 'project-1', 'session-1', 'principal-1', 1, 'pending_review',
                 'durable fact', ?, '[]', '{}', 'consolidation-1', ?, ?)`
      ).run(candidateId, contentSha, now, now);
      database.prepare(
        `INSERT INTO consolidation_outputs
         (project_id, consolidation_id, output_order, candidate_id, input_digest, created_at)
         VALUES ('project-1', 'consolidation-1', 0, ?, ?, ?)`
      ).run(candidateId, "a".repeat(64), now);
      database.prepare(
        `INSERT INTO review_requests
         (review_request_id, project_id, candidate_id, status, required_role,
          created_at, updated_at)
         VALUES (?, 'project-1', ?, 'pending', 'maintainer', ?, ?)`
      ).run(candidateId, candidateId, now, now);
      database.prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, excerpt_hash,
          sensitivity_status, recorded_at)
         VALUES (?, 'project-1', 'agent_submission', 'memory://evidence/1', ?,
                 'clear', ?)`
      ).run(evidenceId, "e".repeat(64), now);
      database.prepare(
        `INSERT INTO observation_evidence
         (project_id, observation_id, evidence_id, created_at)
         VALUES ('project-1', ?, ?, ?)`
      ).run(candidateId, evidenceId, now);

      expect(() => insertReceipt(database, {
        claimId,
        operationId,
        manifest: JSON.stringify([
          {
            output_order: 0,
            candidate_id: candidateId,
            content_sha256: contentSha,
            evidence_ids: [evidenceId]
          }
        ]),
        suggestionCount: 1
      })).toThrow(/consolidation batch receipt final state is invalid/iu);
    } finally {
      database.close();
    }
  });

  it("allows synthetic child-first receipt cleanup and protects the registry", () => {
    const database = databaseBeforeReceiptMigration();
    try {
      seedProject(database, "synthetic-project", "system.synthetic.receipts");
      seedClosedSession(database, "synthetic-project", "synthetic-session");
      seedConsolidation(
        database,
        "synthetic-project",
        "synthetic-session",
        "synthetic-consolidation"
      );
      database.prepare(
        `INSERT INTO synthetic_cleanup_registry
         (project_id, principal_id, expires_at, created_at)
         VALUES ('synthetic-project', 'principal-1', ?, ?)`
      ).run("2026-08-02T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
      applyReceiptMigration(database);
      seedZeroReceipt(database, "synthetic-project", "synthetic-consolidation");

      expect(() => database.prepare(
        `DELETE FROM synthetic_cleanup_registry WHERE project_id = 'synthetic-project'`
      ).run()).toThrow(/synthetic cleanup requires child-first deletion/iu);
      expect(() => database.prepare(
        `DELETE FROM consolidation_batch_receipts WHERE project_id = 'synthetic-project'`
      ).run()).not.toThrow();
    } finally {
      database.close();
    }
  });
});

function seedBoundReceipt(database: DatabaseSync): void {
  const claimId = "11111111-1111-4111-8111-111111111111";
  const operationId = "22222222-2222-4222-8222-222222222222";
  const candidateId = "33333333-3333-5333-a333-333333333333";
  const now = "2026-08-01T00:00:00.000Z";
  seedProject(database, "project-1", "project-1");
  seedClosedSession(database, "project-1", "session-1");
  seedConsolidation(database, "project-1", "session-1", "consolidation-1");
  applyReceiptMigration(database);
  database.prepare(
    `UPDATE session_consolidations
     SET status = 'running', lease_owner = 'owner-1', lease_claim_id = ?,
         lease_epoch = 1, lease_expires_at = '2099-08-01T00:20:00.000Z',
         lease_operation_id = ?
     WHERE consolidation_id = 'consolidation-1'`
  ).run(claimId, operationId);
  database.prepare(
    `INSERT INTO consolidation_inputs
     (project_id, consolidation_id, input_order, input_kind, source_id,
      content, content_sha256)
     VALUES ('project-1', 'consolidation-1', 0, 'summary', 'session-summary',
             'D1 is authoritative.', ?)`
  ).run("a".repeat(64));
  database.prepare(
    `INSERT INTO observations
     (observation_id, project_id, session_id, principal_id, candidate_version,
      status, content, content_sha256, evidence_json, analysis_json,
      source_consolidation_id, created_at, updated_at)
     VALUES (?, 'project-1', 'session-1', 'principal-1', 1, 'pending_review',
             'durable fact', ?, '[]', '{}', 'consolidation-1', ?, ?)`
  ).run(candidateId, "d".repeat(64), now, now);
  database.prepare(
    `INSERT INTO consolidation_outputs
     (project_id, consolidation_id, output_order, candidate_id, input_digest, created_at)
     VALUES ('project-1', 'consolidation-1', 0, ?, ?, ?)`
  ).run(candidateId, "a".repeat(64), now);
  database.prepare(
    `INSERT INTO review_requests
     (review_request_id, project_id, candidate_id, status, required_role,
      created_at, updated_at)
     VALUES (?, 'project-1', ?, 'pending', 'maintainer', ?, ?)`
  ).run(candidateId, candidateId, now, now);
  database.prepare(
    `INSERT INTO evidence
     (evidence_id, project_id, source_type, locator, excerpt_hash,
      sensitivity_status, recorded_at)
     VALUES ('evidence-1', 'project-1', 'agent_submission',
             'memory://evidence/1', ?, 'clear', ?)`
  ).run("e".repeat(64), now);
  database.prepare(
    `INSERT INTO observation_evidence
     (project_id, observation_id, evidence_id, created_at)
     VALUES ('project-1', ?, 'evidence-1', ?)`
  ).run(candidateId, now);
  insertReceipt(database, {
    claimId,
    operationId,
    manifest: JSON.stringify([
      {
        output_order: 0,
        candidate_id: candidateId,
        content_sha256: "d".repeat(64),
        evidence_ids: ["evidence-1"]
      }
    ]),
    suggestionCount: 1
  });
}

function insertReceipt(
  database: DatabaseSync,
  input: {
    claimId: string;
    operationId: string;
    manifest: string;
    suggestionCount: number;
  }
): void {
  database.prepare(
    `INSERT INTO consolidation_batch_receipts
     (project_id, consolidation_id, batch_index, lease_owner, lease_claim_id,
      lease_epoch, lease_operation_id, batch_input_digest, model_result_digest,
      output_manifest_json, output_manifest_digest, suggestion_count, completed_at)
     VALUES ('project-1', 'consolidation-1', 0, 'owner-1', ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.claimId,
    input.operationId,
    "a".repeat(64),
    "b".repeat(64),
    input.manifest,
    "c".repeat(64),
    input.suggestionCount,
    "2026-08-01T00:00:00.000Z"
  );
}

function seedZeroReceipt(
  database: DatabaseSync,
  projectId: string,
  consolidationId: string
): void {
  const claimId = "11111111-1111-4111-8111-111111111111";
  const operationId = "22222222-2222-4222-8222-222222222222";
  database.prepare(
    `UPDATE session_consolidations
     SET status = 'running', lease_owner = 'owner-1', lease_claim_id = ?,
         lease_epoch = 1, lease_expires_at = '2099-08-01T00:20:00.000Z',
         lease_operation_id = ?
     WHERE project_id = ? AND consolidation_id = ?`
  ).run(claimId, operationId, projectId, consolidationId);
  database.prepare(
    `INSERT INTO consolidation_batch_receipts
     (project_id, consolidation_id, batch_index, lease_owner, lease_claim_id,
      lease_epoch, lease_operation_id, batch_input_digest, model_result_digest,
      output_manifest_json, output_manifest_digest, suggestion_count, completed_at)
     VALUES (?, ?, 0, 'owner-1', ?, 1, ?, ?, ?, '[]', ?, 0, ?)`
  ).run(
    projectId,
    consolidationId,
    claimId,
    operationId,
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
    "2026-08-01T00:00:00.000Z"
  );
}

function databaseBeforeReceiptMigration(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync("migrations")
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const migrationIndex = migrations.indexOf(RECEIPT_MIGRATION);
  expect(migrationIndex).toBeGreaterThan(0);
  for (const migration of migrations.slice(0, migrationIndex)) {
    database.exec(readFileSync(`migrations/${migration}`, "utf8"));
  }
  return database;
}

function applyReceiptMigration(database: DatabaseSync): void {
  database.exec(readFileSync(`migrations/${RECEIPT_MIGRATION}`, "utf8"));
}

function seedProject(database: DatabaseSync, projectId: string, projectRef: string): void {
  database.prepare(
    `INSERT OR IGNORE INTO principals
     (principal_id, issuer, subject, token_digest, created_at)
     VALUES ('principal-1', 'system.synthetic', 'principal-1', 'digest', ?)`
  ).run("2026-08-01T00:00:00.000Z");
  database.prepare(
    `INSERT INTO projects
     (project_id, project_ref, locator, display_name, created_at, updated_at)
     VALUES (?, ?, ?, 'Project', ?, ?)`
  ).run(
    projectId,
    projectRef,
    projectRef,
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z"
  );
}

function seedClosedSession(
  database: DatabaseSync,
  projectId: string,
  sessionId: string
): void {
  database.prepare(
    `INSERT INTO sessions
     (session_id, project_id, principal_id, session_version, status,
      agent_meta_json, opened_at, closed_at)
     VALUES (?, ?, 'principal-1', 2, 'closed', '{}', ?, ?)`
  ).run(
    sessionId,
    projectId,
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z"
  );
}

function seedConsolidation(
  database: DatabaseSync,
  projectId: string,
  sessionId: string,
  consolidationId: string
): void {
  database.prepare(
    `INSERT INTO session_consolidations
     (consolidation_id, project_id, session_id, session_version, status,
      input_digest, created_at, updated_at)
     VALUES (?, ?, ?, 2, 'queued', ?, ?, ?)`
  ).run(
    consolidationId,
    projectId,
    sessionId,
    "a".repeat(64),
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z"
  );
}
