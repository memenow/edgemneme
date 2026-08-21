import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("synthetic cleanup policy", () => {
  it("allows every exact synthetic immutable-row deletion and preserves real rows", () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0001_initial.sql"
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    seedProject(database, "real-project", "project.real");
    seedProject(database, "synthetic-project", "system.synthetic.synthetic-project");
    seedImmutableRows(database, "real-project", "credential.real-project");
    seedImmutableRows(
      database,
      "synthetic-project",
      "system.synthetic.synthetic-project"
    );

    const cases = immutableCases();
    for (const testCase of cases) {
      expect(() => database.exec(testCase.realDelete)).toThrowError(testCase.error);
      expect(countRows(database, testCase.table, testCase.realWhere)).toBe(1);
      expect(() => database.exec(testCase.syntheticUpdate)).toThrowError(testCase.error);
    }

    for (const testCase of cases) {
      expect(() => database.exec(testCase.syntheticDelete)).not.toThrow();
      expect(countRows(database, testCase.table, testCase.syntheticWhere)).toBe(0);
    }
  });
});

function seedProject(database: DatabaseSync, projectId: string, projectRef: string): void {
  const principalId = `${projectId}-principal`;
  const sessionId = `${projectId}-session`;
  const observationId = `${projectId}-observation`;
  const evidenceId = `${projectId}-evidence`;
  const now = "2026-07-25T00:00:00.000Z";
  const insert = (sql: string, ...values: string[]) => database.prepare(sql).run(...values);

  insert(
    `INSERT INTO projects
     (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    projectId,
    projectRef,
    projectRef,
    projectRef,
    now,
    now
  );
  insert(
    `INSERT INTO principals
     (principal_id, issuer, subject, token_digest, created_at)
     VALUES (?, 'test', ?, ?, ?)`,
    principalId,
    principalId,
    `${projectId}-digest`,
    now
  );
  insert(
    `INSERT INTO project_grants
     (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
     VALUES (?, ?, ?, 'maintainer', 'project', ?, ?)`,
    `${projectId}-grant`,
    projectId,
    principalId,
    projectId,
    now
  );
  insert(
    `INSERT INTO sessions
     (session_id, project_id, principal_id, session_version, status, agent_meta_json, opened_at)
     VALUES (?, ?, ?, 1, 'open', '{}', ?)`,
    sessionId,
    projectId,
    principalId,
    now
  );
  insert(
    `INSERT INTO observations
     (observation_id, project_id, session_id, principal_id, candidate_version, status,
      content, content_sha256, evidence_json, created_at)
     VALUES (?, ?, ?, ?, 1, 'queued', 'candidate', ?, '[]', ?)`,
    observationId,
    projectId,
    sessionId,
    principalId,
    `${projectId}-content-sha`,
    now
  );
  insert(
    `INSERT INTO evidence
     (evidence_id, project_id, source_type, locator, excerpt_hash, sensitivity_status, recorded_at)
     VALUES (?, ?, 'test', ?, ?, 'clear', ?)`,
    evidenceId,
    projectId,
    `${projectRef}/evidence`,
    `${projectId}-excerpt-sha`,
    now
  );
  insert(
    `INSERT INTO observation_evidence
     (project_id, observation_id, evidence_id, created_at)
     VALUES (?, ?, ?, ?)`,
    projectId,
    observationId,
    evidenceId,
    now
  );
}

function seedImmutableRows(
  database: DatabaseSync,
  projectId: string,
  credentialVersion: string
): void {
  const principalId = `${projectId}-principal`;
  const sessionId = `${projectId}-session`;
  const observationId = `${projectId}-observation`;
  const evidenceId = `${projectId}-evidence`;
  const auditId = `${projectId}-audit`;
  const memoryId = `${projectId}-memory`;
  const revisionId = `${projectId}-revision`;
  const reviewRequestId = `${projectId}-review`;
  const consolidationId = `${projectId}-consolidation`;
  const now = "2026-07-25T00:00:00.000Z";
  const insert = (sql: string, ...values: Array<string | number>) =>
    database.prepare(sql).run(...values);

  insert(
    `INSERT INTO audit_events
     (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
      previous_event_hash, event_hash, recorded_at)
     VALUES (?, ?, 1, 'synthetic_test', ?, ?, NULL, ?, ?)`,
    auditId,
    projectId,
    principalId,
    `${projectId}-request`,
    `${projectId}-event-hash`,
    now
  );
  insert(
    `INSERT INTO memories
     (memory_id, project_id, current_revision_id, memory_version, kind, memory_class,
      scope, scope_id, status, created_at, updated_at)
     VALUES (?, ?, NULL, 0, 'fact', 'semantic', 'project', ?, 'active', ?, ?)`,
    memoryId,
    projectId,
    projectId,
    now,
    now
  );
  insert(
    `INSERT INTO memory_versions
     (revision_id, project_id, memory_id, memory_version, content, content_sha256,
      audit_id, source_observation_id, recorded_at)
     VALUES (?, ?, ?, 1, 'formal memory', ?, ?, ?, ?)`,
    revisionId,
    projectId,
    memoryId,
    `${projectId}-formal-sha`,
    auditId,
    observationId,
    now
  );
  insert(
    `UPDATE memories SET current_revision_id = ?, memory_version = 1
     WHERE project_id = ? AND memory_id = ?`,
    revisionId,
    projectId,
    memoryId
  );
  insert(
    `INSERT INTO version_evidence (project_id, revision_id, evidence_id)
     VALUES (?, ?, ?)`,
    projectId,
    revisionId,
    evidenceId
  );
  insert(
    `INSERT INTO review_requests
     (review_request_id, project_id, candidate_id, status, required_role, created_at, updated_at)
     VALUES (?, ?, ?, 'approved', 'maintainer', ?, ?)`,
    reviewRequestId,
    projectId,
    observationId,
    now,
    now
  );
  insert(
    `INSERT INTO review_decisions
     (decision_id, project_id, review_request_id, candidate_id, candidate_version,
      decision, reason, actor_principal_id, audit_id, request_digest, created_at)
     VALUES (?, ?, ?, ?, 2, 'approve', 'synthetic test', ?, ?, ?, ?)`,
    `${projectId}-decision`,
    projectId,
    reviewRequestId,
    observationId,
    principalId,
    auditId,
    `${projectId}-review-request`,
    now
  );
  insert(
    `INSERT INTO session_consolidations
     (consolidation_id, project_id, session_id, session_version, status,
      input_digest, created_at, updated_at)
     VALUES (?, ?, ?, 2, 'complete', ?, ?, ?)`,
    consolidationId,
    projectId,
    sessionId,
    `${projectId}-input-digest`,
    now,
    now
  );
  insert(
    `INSERT INTO consolidation_inputs
     (project_id, consolidation_id, input_order, input_kind, source_id,
      content, content_sha256)
     VALUES (?, ?, 0, 'candidate', ?, 'candidate', ?)`,
    projectId,
    consolidationId,
    observationId,
    `${projectId}-content-sha`
  );
  insert(
    `INSERT INTO consolidation_outputs
     (project_id, consolidation_id, output_order, candidate_id, input_digest, created_at)
     VALUES (?, ?, 0, ?, ?, ?)`,
    projectId,
    consolidationId,
    observationId,
    `${projectId}-output-digest`,
    now
  );
  insert(
    `INSERT INTO github_access_baselines
     (credential_version, user_id, scopes_json, repositories_json,
      approved_by_principal_id, approval_audit_id, approved_at, created_at)
     VALUES (?, ?, '[]', '[]', ?, ?, ?, ?)`,
    credentialVersion,
    projectId === "real-project" ? 1 : 2,
    principalId,
    auditId,
    now,
    now
  );
  insert(
    `INSERT INTO github_credential_expiry_warnings
     (event_id, credential_version, threshold_days, expires_at, observed_at,
      event_digest)
     VALUES (?, ?, 14, '2026-08-08T00:00:00.000Z', ?, ?)`,
    `${credentialVersion}.warning.14`,
    credentialVersion,
    now,
    `${credentialVersion}.warning.digest`
  );
}

function immutableCases(): Array<{
  table: string;
  realWhere: string;
  syntheticWhere: string;
  realDelete: string;
  syntheticDelete: string;
  syntheticUpdate: string;
  error: RegExp;
}> {
  const projectCase = (table: string, label: string, update: string) => ({
    table,
    realWhere: "project_id = 'real-project'",
    syntheticWhere: "project_id = 'synthetic-project'",
    realDelete: `DELETE FROM ${table} WHERE project_id = 'real-project'`,
    syntheticDelete: `DELETE FROM ${table} WHERE project_id = 'synthetic-project'`,
    syntheticUpdate: `UPDATE ${table} SET ${update} WHERE project_id = 'synthetic-project'`,
    error: new RegExp(`${label} (?:is|are) immutable`, "u")
  });
  return [
    projectCase("consolidation_outputs", "consolidation outputs", "input_digest = input_digest"),
    projectCase("consolidation_inputs", "consolidation inputs", "content = content"),
    projectCase("review_decisions", "review decisions", "reason = reason"),
    projectCase("version_evidence", "version evidence", "evidence_id = evidence_id"),
    projectCase("observation_evidence", "observation evidence", "evidence_id = evidence_id"),
    projectCase("memory_versions", "memory versions", "recorded_at = recorded_at"),
    projectCase("audit_events", "audit events", "recorded_at = recorded_at"),
    {
      table: "github_credential_expiry_warnings",
      realWhere: "credential_version = 'credential.real-project'",
      syntheticWhere:
        "credential_version = 'system.synthetic.synthetic-project'",
      realDelete:
        "DELETE FROM github_credential_expiry_warnings " +
        "WHERE credential_version = 'credential.real-project'",
      syntheticDelete:
        "DELETE FROM github_credential_expiry_warnings " +
        "WHERE credential_version = 'system.synthetic.synthetic-project'",
      syntheticUpdate:
        "UPDATE github_credential_expiry_warnings SET observed_at = observed_at " +
        "WHERE credential_version = 'system.synthetic.synthetic-project'",
      error: /github credential expiry warnings are immutable/u
    },
    {
      table: "github_access_baselines",
      realWhere: "credential_version = 'credential.real-project'",
      syntheticWhere: "credential_version = 'system.synthetic.synthetic-project'",
      realDelete:
        "DELETE FROM github_access_baselines WHERE credential_version = 'credential.real-project'",
      syntheticDelete:
        "DELETE FROM github_access_baselines WHERE credential_version = 'system.synthetic.synthetic-project'",
      syntheticUpdate:
        "UPDATE github_access_baselines SET approved_at = approved_at " +
        "WHERE credential_version = 'system.synthetic.synthetic-project'",
      error: /GitHub access baselines are immutable/u
    }
  ];
}

function countRows(database: DatabaseSync, table: string, where: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
    count: number;
  };
  return row.count;
}
