CREATE TABLE migration_0018_consolidation_receipt_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT consolidation_receipt_cutover_requires_drained_leases
    CHECK (must_be_zero = 0)
);

INSERT INTO migration_0018_consolidation_receipt_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (
  SELECT 1
  FROM session_consolidations
  WHERE status = 'running'
    OR lease_owner IS NOT NULL
    OR lease_expires_at IS NOT NULL
    OR lease_operation_id IS NOT NULL
);

DROP TABLE migration_0018_consolidation_receipt_preflight;

ALTER TABLE session_consolidations ADD COLUMN lease_claim_id TEXT;
ALTER TABLE session_consolidations ADD COLUMN receipt_post_state_valid INTEGER NOT NULL
  DEFAULT 1 CHECK (receipt_post_state_valid IN (0, 1));

CREATE TRIGGER session_consolidations_lease_insert_guard
BEFORE INSERT ON session_consolidations
WHEN (
    NEW.status = 'running'
    AND (
      NEW.lease_owner IS NULL
      OR NEW.lease_claim_id IS NULL
      OR NEW.lease_expires_at IS NULL
      OR NEW.lease_epoch < 1
    )
  )
  OR (
    NEW.status <> 'running'
    AND (
      NEW.lease_owner IS NOT NULL
      OR NEW.lease_claim_id IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.lease_operation_id IS NOT NULL
    )
  )
  OR (
    NEW.lease_owner IS NOT NULL
    AND (
      length(NEW.lease_owner) NOT BETWEEN 1 AND 512
      OR trim(NEW.lease_owner) <> NEW.lease_owner
    )
  )
  OR (
    NEW.lease_claim_id IS NOT NULL
    AND (
      length(NEW.lease_claim_id) <> 36
      OR lower(NEW.lease_claim_id) <> NEW.lease_claim_id
      OR NEW.lease_claim_id GLOB '*[^0-9a-f-]*'
      OR length(replace(NEW.lease_claim_id, '-', '')) <> 32
      OR substr(NEW.lease_claim_id, 9, 1) <> '-'
      OR substr(NEW.lease_claim_id, 14, 1) <> '-'
      OR substr(NEW.lease_claim_id, 15, 1) <> '4'
      OR substr(NEW.lease_claim_id, 19, 1) <> '-'
      OR substr(NEW.lease_claim_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
      OR substr(NEW.lease_claim_id, 24, 1) <> '-'
    )
  )
  OR (
    NEW.lease_expires_at IS NOT NULL
    AND (
      length(NEW.lease_expires_at) <> 24
      OR strftime(
        '%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at, '+0 seconds'
      ) IS NULL
      OR strftime(
        '%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at, '+0 seconds'
      ) <> NEW.lease_expires_at
    )
  )
  OR (
    NEW.lease_operation_id IS NOT NULL
    AND (
      length(NEW.lease_operation_id) <> 36
      OR lower(NEW.lease_operation_id) <> NEW.lease_operation_id
      OR NEW.lease_operation_id GLOB '*[^0-9a-f-]*'
      OR length(replace(NEW.lease_operation_id, '-', '')) <> 32
      OR substr(NEW.lease_operation_id, 9, 1) <> '-'
      OR substr(NEW.lease_operation_id, 14, 1) <> '-'
      OR substr(NEW.lease_operation_id, 15, 1) <> '4'
      OR substr(NEW.lease_operation_id, 19, 1) <> '-'
      OR substr(NEW.lease_operation_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
      OR substr(NEW.lease_operation_id, 24, 1) <> '-'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation lease state is invalid');
END;

CREATE TRIGGER session_consolidations_lease_update_guard
BEFORE UPDATE OF status, lease_owner, lease_claim_id, lease_expires_at,
  lease_operation_id, lease_epoch
ON session_consolidations
WHEN NEW.lease_epoch < OLD.lease_epoch
  OR (
    NEW.status = 'running'
    AND (
      NEW.lease_owner IS NULL
      OR NEW.lease_claim_id IS NULL
      OR NEW.lease_expires_at IS NULL
      OR NEW.lease_epoch < 1
    )
  )
  OR (
    NEW.status <> 'running'
    AND (
      NEW.lease_owner IS NOT NULL
      OR NEW.lease_claim_id IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.lease_operation_id IS NOT NULL
    )
  )
  OR (
    NEW.lease_owner IS NOT NULL
    AND (
      length(NEW.lease_owner) NOT BETWEEN 1 AND 512
      OR trim(NEW.lease_owner) <> NEW.lease_owner
    )
  )
  OR (
    NEW.lease_claim_id IS NOT NULL
    AND (
      length(NEW.lease_claim_id) <> 36
      OR lower(NEW.lease_claim_id) <> NEW.lease_claim_id
      OR NEW.lease_claim_id GLOB '*[^0-9a-f-]*'
      OR length(replace(NEW.lease_claim_id, '-', '')) <> 32
      OR substr(NEW.lease_claim_id, 9, 1) <> '-'
      OR substr(NEW.lease_claim_id, 14, 1) <> '-'
      OR substr(NEW.lease_claim_id, 15, 1) <> '4'
      OR substr(NEW.lease_claim_id, 19, 1) <> '-'
      OR substr(NEW.lease_claim_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
      OR substr(NEW.lease_claim_id, 24, 1) <> '-'
    )
  )
  OR (
    NEW.lease_expires_at IS NOT NULL
    AND (
      length(NEW.lease_expires_at) <> 24
      OR strftime(
        '%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at, '+0 seconds'
      ) IS NULL
      OR strftime(
        '%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at, '+0 seconds'
      ) <> NEW.lease_expires_at
    )
  )
  OR (
    NEW.lease_operation_id IS NOT NULL
    AND (
      length(NEW.lease_operation_id) <> 36
      OR lower(NEW.lease_operation_id) <> NEW.lease_operation_id
      OR NEW.lease_operation_id GLOB '*[^0-9a-f-]*'
      OR length(replace(NEW.lease_operation_id, '-', '')) <> 32
      OR substr(NEW.lease_operation_id, 9, 1) <> '-'
      OR substr(NEW.lease_operation_id, 14, 1) <> '-'
      OR substr(NEW.lease_operation_id, 15, 1) <> '4'
      OR substr(NEW.lease_operation_id, 19, 1) <> '-'
      OR substr(NEW.lease_operation_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
      OR substr(NEW.lease_operation_id, 24, 1) <> '-'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation lease state is invalid');
END;

CREATE TABLE consolidation_batch_receipts (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  consolidation_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL CHECK (
    typeof(batch_index) = 'integer'
    AND batch_index >= 0
    AND batch_index <= 900719925474098
  ),
  lease_owner TEXT NOT NULL CHECK (
    length(lease_owner) BETWEEN 1 AND 512
    AND trim(lease_owner) = lease_owner
  ),
  lease_claim_id TEXT NOT NULL CHECK (
    length(lease_claim_id) = 36
    AND lower(lease_claim_id) = lease_claim_id
    AND lease_claim_id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(lease_claim_id, '-', '')) = 32
    AND substr(lease_claim_id, 9, 1) = '-'
    AND substr(lease_claim_id, 14, 1) = '-'
    AND substr(lease_claim_id, 15, 1) = '4'
    AND substr(lease_claim_id, 19, 1) = '-'
    AND substr(lease_claim_id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(lease_claim_id, 24, 1) = '-'
  ),
  lease_epoch INTEGER NOT NULL CHECK (
    typeof(lease_epoch) = 'integer'
    AND lease_epoch >= 1
    AND lease_epoch <= 9007199254740991
  ),
  lease_operation_id TEXT NOT NULL CHECK (
    length(lease_operation_id) = 36
    AND lower(lease_operation_id) = lease_operation_id
    AND lease_operation_id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(lease_operation_id, '-', '')) = 32
    AND substr(lease_operation_id, 9, 1) = '-'
    AND substr(lease_operation_id, 14, 1) = '-'
    AND substr(lease_operation_id, 15, 1) = '4'
    AND substr(lease_operation_id, 19, 1) = '-'
    AND substr(lease_operation_id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(lease_operation_id, 24, 1) = '-'
  ),
  batch_input_digest TEXT NOT NULL CHECK (
    length(batch_input_digest) = 64
    AND batch_input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  model_result_digest TEXT NOT NULL CHECK (
    length(model_result_digest) = 64
    AND model_result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  output_manifest_json TEXT NOT NULL CHECK (
    json_valid(output_manifest_json)
    AND json_type(output_manifest_json) = 'array'
  ),
  output_manifest_digest TEXT NOT NULL CHECK (
    length(output_manifest_digest) = 64
    AND output_manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  suggestion_count INTEGER NOT NULL CHECK (
    typeof(suggestion_count) = 'integer'
    AND suggestion_count BETWEEN 0 AND 10
    AND json_array_length(output_manifest_json) = suggestion_count
  ),
  completed_at TEXT NOT NULL CHECK (
    length(completed_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+0 seconds') IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+0 seconds') = completed_at
  ),
  PRIMARY KEY (project_id, consolidation_id, batch_index),
  FOREIGN KEY (project_id, consolidation_id)
    REFERENCES session_consolidations(project_id, consolidation_id)
);

CREATE INDEX consolidation_batch_receipts_by_claim
  ON consolidation_batch_receipts(
    project_id, consolidation_id, lease_claim_id, lease_epoch, batch_index
  );

CREATE INDEX consolidation_outputs_by_receipt_candidate
  ON consolidation_outputs(project_id, candidate_id, consolidation_id, output_order);

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
    WHERE COALESCE(
      entry.type = 'object'
      AND (SELECT COUNT(*) FROM json_each(entry.value)) = 4
      AND (
        SELECT COUNT(*) FROM json_each(entry.value) AS member
        WHERE member.key = 'output_order'
      ) = 1
      AND (
        SELECT COUNT(*) FROM json_each(entry.value) AS member
        WHERE member.key = 'candidate_id'
      ) = 1
      AND (
        SELECT COUNT(*) FROM json_each(entry.value) AS member
        WHERE member.key = 'content_sha256'
      ) = 1
      AND (
        SELECT COUNT(*) FROM json_each(entry.value) AS member
        WHERE member.key = 'evidence_ids'
      ) = 1
      AND json_type(entry.value, '$.output_order') = 'integer'
      AND CAST(json_extract(entry.value, '$.output_order') AS INTEGER)
            BETWEEN NEW.batch_index * 10 AND NEW.batch_index * 10 + 9
      AND json_type(entry.value, '$.candidate_id') = 'text'
      AND length(json_extract(entry.value, '$.candidate_id')) = 36
      AND lower(json_extract(entry.value, '$.candidate_id')) =
            json_extract(entry.value, '$.candidate_id')
      AND json_extract(entry.value, '$.candidate_id') NOT GLOB '*[^0-9a-f-]*'
      AND length(replace(json_extract(entry.value, '$.candidate_id'), '-', '')) = 32
      AND substr(json_extract(entry.value, '$.candidate_id'), 9, 1) = '-'
      AND substr(json_extract(entry.value, '$.candidate_id'), 14, 1) = '-'
      AND substr(json_extract(entry.value, '$.candidate_id'), 15, 1) = '5'
      AND substr(json_extract(entry.value, '$.candidate_id'), 19, 1) = '-'
      AND substr(json_extract(entry.value, '$.candidate_id'), 20, 1) = 'a'
      AND substr(json_extract(entry.value, '$.candidate_id'), 24, 1) = '-'
      AND json_type(entry.value, '$.content_sha256') = 'text'
      AND length(json_extract(entry.value, '$.content_sha256')) = 64
      AND json_extract(entry.value, '$.content_sha256') NOT GLOB '*[^0-9a-f]*'
      AND json_type(entry.value, '$.evidence_ids') = 'array'
      AND json_array_length(json_extract(entry.value, '$.evidence_ids')) BETWEEN 1 AND 50
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(entry.value, '$.evidence_ids')) AS evidence_id
        WHERE COALESCE(
          evidence_id.type = 'text'
          AND length(evidence_id.value) BETWEEN 1 AND 512,
          0
        ) = 0
      )
      AND (
        SELECT COUNT(DISTINCT evidence_id.value)
        FROM json_each(json_extract(entry.value, '$.evidence_ids')) AS evidence_id
      ) = json_array_length(json_extract(entry.value, '$.evidence_ids'))
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(entry.value, '$.evidence_ids')) AS current_evidence
        JOIN json_each(json_extract(entry.value, '$.evidence_ids')) AS previous_evidence
          ON CAST(previous_evidence.key AS INTEGER) =
             CAST(current_evidence.key AS INTEGER) - 1
        WHERE CAST(current_evidence.key AS INTEGER) > 0
          AND previous_evidence.value >= current_evidence.value
      ),
      0
    ) = 0
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
          AND output.input_digest = (
            SELECT input_digest
            FROM session_consolidations
            WHERE project_id = NEW.project_id
              AND consolidation_id = NEW.consolidation_id
          )
          AND candidate.source_consolidation_id = NEW.consolidation_id
          AND candidate.content_sha256 = json_extract(entry.value, '$.content_sha256')
          AND candidate.status = 'pending_review'
          AND candidate.content IS NOT NULL
          AND candidate.analysis_json IS NOT NULL
          AND json_valid(candidate.analysis_json)
          AND json_type(candidate.analysis_json) = 'object'
      )
  )
  OR (
    SELECT COUNT(DISTINCT json_extract(entry.value, '$.output_order'))
    FROM json_each(NEW.output_manifest_json) AS entry
  ) <> NEW.suggestion_count
  OR (
    SELECT COUNT(DISTINCT json_extract(entry.value, '$.candidate_id'))
    FROM json_each(NEW.output_manifest_json) AS entry
  ) <> NEW.suggestion_count
  OR (
    SELECT COUNT(DISTINCT json_extract(entry.value, '$.content_sha256'))
    FROM json_each(NEW.output_manifest_json) AS entry
  ) <> NEW.suggestion_count
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.output_manifest_json) AS entry
    JOIN consolidation_outputs AS output
      ON output.project_id = NEW.project_id
     AND output.consolidation_id = NEW.consolidation_id
     AND output.output_order = json_extract(entry.value, '$.output_order')
     AND output.candidate_id = json_extract(entry.value, '$.candidate_id')
    WHERE NOT EXISTS (
        SELECT 1
        FROM review_requests AS review
        WHERE review.project_id = NEW.project_id
          AND review.candidate_id = output.candidate_id
          AND review.review_request_id = output.candidate_id
          AND review.status = 'pending'
          AND review.required_role = 'maintainer'
      )
      OR (
        SELECT COUNT(*)
        FROM observation_evidence AS linked
        WHERE linked.project_id = NEW.project_id
          AND linked.observation_id = output.candidate_id
      ) <> json_array_length(json_extract(entry.value, '$.evidence_ids'))
      OR EXISTS (
        SELECT 1
        FROM json_each(json_extract(entry.value, '$.evidence_ids')) AS expected_evidence
        WHERE NOT EXISTS (
          SELECT 1
          FROM observation_evidence AS linked
          JOIN evidence AS evidence
            ON evidence.project_id = linked.project_id
           AND evidence.evidence_id = linked.evidence_id
          WHERE linked.project_id = NEW.project_id
            AND linked.observation_id = output.candidate_id
            AND linked.evidence_id = expected_evidence.value
            AND evidence.sensitivity_status = 'clear'
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
      AND output.output_order
            BETWEEN NEW.batch_index * 10 AND NEW.batch_index * 10 + 9
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

CREATE TRIGGER consolidation_receipt_consolidation_update_guard
BEFORE UPDATE OF consolidation_id, project_id, session_id, session_version,
  input_digest, created_at
ON session_consolidations
WHEN (
    NEW.consolidation_id IS NOT OLD.consolidation_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.session_id IS NOT OLD.session_id
    OR NEW.session_version IS NOT OLD.session_version
    OR NEW.input_digest IS NOT OLD.input_digest
    OR NEW.created_at IS NOT OLD.created_at
  )
  AND EXISTS (
    SELECT 1
    FROM consolidation_batch_receipts AS receipt
    WHERE receipt.project_id = OLD.project_id
      AND receipt.consolidation_id = OLD.consolidation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt source state is immutable');
END;

CREATE TRIGGER consolidation_receipt_input_insert_guard
BEFORE INSERT ON consolidation_inputs
WHEN EXISTS (
  SELECT 1
  FROM consolidation_batch_receipts AS receipt
  WHERE receipt.project_id = NEW.project_id
    AND receipt.consolidation_id = NEW.consolidation_id
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt input set is immutable');
END;

CREATE TRIGGER consolidation_receipt_candidate_update_guard
BEFORE UPDATE OF observation_id, project_id, session_id, principal_id, content,
  content_sha256, evidence_json, kind, memory_class, scope, scope_id, valid_from,
  valid_until, analysis_json, source_consolidation_id, created_at
ON observations
WHEN (
    NEW.observation_id IS NOT OLD.observation_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.session_id IS NOT OLD.session_id
    OR NEW.principal_id IS NOT OLD.principal_id
    OR NEW.content IS NOT OLD.content
    OR NEW.content_sha256 IS NOT OLD.content_sha256
    OR NEW.evidence_json IS NOT OLD.evidence_json
    OR NEW.kind IS NOT OLD.kind
    OR NEW.memory_class IS NOT OLD.memory_class
    OR NEW.scope IS NOT OLD.scope
    OR NEW.scope_id IS NOT OLD.scope_id
    OR NEW.valid_from IS NOT OLD.valid_from
    OR NEW.valid_until IS NOT OLD.valid_until
    OR NEW.analysis_json IS NOT OLD.analysis_json
    OR NEW.source_consolidation_id IS NOT OLD.source_consolidation_id
    OR NEW.created_at IS NOT OLD.created_at
  )
  AND EXISTS (
    SELECT 1
    FROM consolidation_outputs AS output
    JOIN consolidation_batch_receipts AS receipt
      ON receipt.project_id = output.project_id
     AND receipt.consolidation_id = output.consolidation_id
     AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
    WHERE output.project_id = OLD.project_id
      AND output.candidate_id = OLD.observation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt candidate state is immutable');
END;

CREATE TRIGGER consolidation_receipt_candidate_delete_guard
BEFORE DELETE ON observations
WHEN EXISTS (
  SELECT 1
  FROM consolidation_outputs AS output
  JOIN consolidation_batch_receipts AS receipt
    ON receipt.project_id = output.project_id
   AND receipt.consolidation_id = output.consolidation_id
   AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
  WHERE output.project_id = OLD.project_id
    AND output.candidate_id = OLD.observation_id
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt candidate state is immutable');
END;

CREATE TRIGGER consolidation_receipt_review_update_guard
BEFORE UPDATE OF review_request_id, project_id, candidate_id, conflict_id,
  required_role, created_at
ON review_requests
WHEN (
    NEW.review_request_id IS NOT OLD.review_request_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.candidate_id IS NOT OLD.candidate_id
    OR NEW.conflict_id IS NOT OLD.conflict_id
    OR NEW.required_role IS NOT OLD.required_role
    OR NEW.created_at IS NOT OLD.created_at
  )
  AND EXISTS (
    SELECT 1
    FROM consolidation_outputs AS output
    JOIN consolidation_batch_receipts AS receipt
      ON receipt.project_id = output.project_id
     AND receipt.consolidation_id = output.consolidation_id
     AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
    WHERE output.project_id = OLD.project_id
      AND output.candidate_id = OLD.candidate_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt review identity is immutable');
END;

CREATE TRIGGER consolidation_receipt_review_delete_guard
BEFORE DELETE ON review_requests
WHEN EXISTS (
  SELECT 1
  FROM consolidation_outputs AS output
  JOIN consolidation_batch_receipts AS receipt
    ON receipt.project_id = output.project_id
   AND receipt.consolidation_id = output.consolidation_id
   AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
  WHERE output.project_id = OLD.project_id
    AND output.candidate_id = OLD.candidate_id
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt review identity is immutable');
END;

CREATE TRIGGER consolidation_receipt_evidence_link_insert_guard
BEFORE INSERT ON observation_evidence
WHEN EXISTS (
    SELECT 1
    FROM consolidation_outputs AS output
    JOIN consolidation_batch_receipts AS receipt
      ON receipt.project_id = output.project_id
     AND receipt.consolidation_id = output.consolidation_id
     AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
    WHERE output.project_id = NEW.project_id
      AND output.candidate_id = NEW.observation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt evidence links are immutable');
END;

CREATE TRIGGER consolidation_receipt_evidence_link_delete_guard
BEFORE DELETE ON observation_evidence
WHEN NOT EXISTS (
    SELECT 1 FROM projects
    WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
  )
  AND EXISTS (
    SELECT 1
    FROM consolidation_outputs AS output
    JOIN consolidation_batch_receipts AS receipt
      ON receipt.project_id = output.project_id
     AND receipt.consolidation_id = output.consolidation_id
     AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
    WHERE output.project_id = OLD.project_id
      AND output.candidate_id = OLD.observation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt evidence links are immutable');
END;

CREATE TRIGGER consolidation_receipt_output_insert_guard
BEFORE INSERT ON consolidation_outputs
WHEN EXISTS (
    SELECT 1
    FROM consolidation_batch_receipts AS receipt
    WHERE receipt.project_id = NEW.project_id
      AND receipt.consolidation_id = NEW.consolidation_id
      AND receipt.batch_index = CAST(NEW.output_order / 10 AS INTEGER)
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt output slots are immutable');
END;

CREATE TRIGGER consolidation_receipt_evidence_sensitivity_invalidation
AFTER UPDATE OF sensitivity_status ON evidence
WHEN NEW.sensitivity_status IS NOT OLD.sensitivity_status
BEGIN
  UPDATE session_consolidations
  SET receipt_post_state_valid = 0
  WHERE project_id = OLD.project_id
    AND status IN ('queued', 'running', 'failed')
    AND receipt_post_state_valid = 1
    AND EXISTS (
      SELECT 1
      FROM observation_evidence AS linked
      JOIN consolidation_outputs AS output
        ON output.project_id = linked.project_id
       AND output.candidate_id = linked.observation_id
      JOIN consolidation_batch_receipts AS receipt
        ON receipt.project_id = output.project_id
       AND receipt.consolidation_id = output.consolidation_id
       AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
      WHERE linked.project_id = OLD.project_id
        AND linked.evidence_id = OLD.evidence_id
        AND output.consolidation_id = session_consolidations.consolidation_id
    );
END;

CREATE TRIGGER session_consolidations_receipt_validity_monotonic_guard
BEFORE UPDATE OF receipt_post_state_valid ON session_consolidations
WHEN OLD.receipt_post_state_valid = 0 AND NEW.receipt_post_state_valid <> 0
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt post-state cannot be revalidated');
END;

CREATE TRIGGER session_consolidations_terminal_receipt_guard
BEFORE UPDATE OF status ON session_consolidations
WHEN NEW.status IN ('complete', 'noop')
  AND (
    NEW.receipt_post_state_valid <> 1
    OR (NEW.status = 'complete' AND NOT EXISTS (
      SELECT 1 FROM consolidation_outputs AS output
      WHERE output.project_id = OLD.project_id
        AND output.consolidation_id = OLD.consolidation_id
    ))
    OR (NEW.status = 'noop' AND EXISTS (
      SELECT 1 FROM consolidation_outputs AS output
      WHERE output.project_id = OLD.project_id
        AND output.consolidation_id = OLD.consolidation_id
    ))
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT CAST(input_order / 50 AS INTEGER) AS batch_index
        FROM consolidation_inputs
        WHERE project_id = OLD.project_id
          AND consolidation_id = OLD.consolidation_id
        GROUP BY CAST(input_order / 50 AS INTEGER)
      ) AS expected_batch
      WHERE NOT EXISTS (
        SELECT 1 FROM consolidation_batch_receipts AS receipt
        WHERE receipt.project_id = OLD.project_id
          AND receipt.consolidation_id = OLD.consolidation_id
          AND receipt.batch_index = expected_batch.batch_index
      )
    )
    OR EXISTS (
      SELECT 1 FROM consolidation_batch_receipts AS receipt
      WHERE receipt.project_id = OLD.project_id
        AND receipt.consolidation_id = OLD.consolidation_id
        AND NOT EXISTS (
          SELECT 1 FROM consolidation_inputs AS input
          WHERE input.project_id = OLD.project_id
            AND input.consolidation_id = OLD.consolidation_id
            AND input.input_order BETWEEN receipt.batch_index * 50
                                      AND receipt.batch_index * 50 + 49
        )
    )
    OR EXISTS (
      SELECT 1
      FROM consolidation_batch_receipts AS receipt
      WHERE receipt.project_id = OLD.project_id
        AND receipt.consolidation_id = OLD.consolidation_id
        AND (
          typeof(receipt.batch_index) <> 'integer'
          OR receipt.batch_index < 0
          OR receipt.batch_index > 900719925474098
          OR length(receipt.lease_owner) NOT BETWEEN 1 AND 512
          OR trim(receipt.lease_owner) <> receipt.lease_owner
          OR length(receipt.lease_claim_id) <> 36
          OR lower(receipt.lease_claim_id) <> receipt.lease_claim_id
          OR receipt.lease_claim_id GLOB '*[^0-9a-f-]*'
          OR length(replace(receipt.lease_claim_id, '-', '')) <> 32
          OR substr(receipt.lease_claim_id, 9, 1) <> '-'
          OR substr(receipt.lease_claim_id, 14, 1) <> '-'
          OR substr(receipt.lease_claim_id, 15, 1) <> '4'
          OR substr(receipt.lease_claim_id, 19, 1) <> '-'
          OR substr(receipt.lease_claim_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
          OR substr(receipt.lease_claim_id, 24, 1) <> '-'
          OR length(receipt.lease_operation_id) <> 36
          OR lower(receipt.lease_operation_id) <> receipt.lease_operation_id
          OR receipt.lease_operation_id GLOB '*[^0-9a-f-]*'
          OR length(replace(receipt.lease_operation_id, '-', '')) <> 32
          OR substr(receipt.lease_operation_id, 9, 1) <> '-'
          OR substr(receipt.lease_operation_id, 14, 1) <> '-'
          OR substr(receipt.lease_operation_id, 15, 1) <> '4'
          OR substr(receipt.lease_operation_id, 19, 1) <> '-'
          OR substr(receipt.lease_operation_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
          OR substr(receipt.lease_operation_id, 24, 1) <> '-'
          OR typeof(receipt.lease_epoch) <> 'integer'
          OR receipt.lease_epoch < 1
          OR receipt.lease_epoch > 9007199254740991
          OR length(receipt.batch_input_digest) <> 64
          OR receipt.batch_input_digest GLOB '*[^0-9a-f]*'
          OR length(receipt.model_result_digest) <> 64
          OR receipt.model_result_digest GLOB '*[^0-9a-f]*'
          OR length(receipt.output_manifest_digest) <> 64
          OR receipt.output_manifest_digest GLOB '*[^0-9a-f]*'
          OR typeof(receipt.suggestion_count) <> 'integer'
          OR receipt.suggestion_count NOT BETWEEN 0 AND 10
          OR length(receipt.completed_at) <> 24
          OR strftime(
            '%Y-%m-%dT%H:%M:%fZ', receipt.completed_at, '+0 seconds'
          ) IS NULL
          OR strftime(
            '%Y-%m-%dT%H:%M:%fZ', receipt.completed_at, '+0 seconds'
          ) <> receipt.completed_at
        )
    )
    OR (
      SELECT COUNT(*)
      FROM consolidation_outputs AS output
      WHERE output.project_id = OLD.project_id
        AND output.consolidation_id = OLD.consolidation_id
    ) <> COALESCE((
      SELECT SUM(receipt.suggestion_count)
      FROM consolidation_batch_receipts AS receipt
      WHERE receipt.project_id = OLD.project_id
        AND receipt.consolidation_id = OLD.consolidation_id
    ), 0)
    OR (
      SELECT COUNT(*)
      FROM consolidation_batch_receipts AS receipt
      WHERE receipt.project_id = OLD.project_id
        AND receipt.consolidation_id = OLD.consolidation_id
    ) <> (
      SELECT COUNT(*)
      FROM (
        SELECT CAST(input_order / 50 AS INTEGER) AS batch_index
        FROM consolidation_inputs
        WHERE project_id = OLD.project_id
          AND consolidation_id = OLD.consolidation_id
        GROUP BY CAST(input_order / 50 AS INTEGER)
      ) AS expected_batches
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation terminal receipt state is invalid');
END;

CREATE TRIGGER consolidation_batch_receipts_no_update
BEFORE UPDATE ON consolidation_batch_receipts
BEGIN
  SELECT RAISE(ABORT, 'consolidation batch receipts are immutable');
END;

CREATE TRIGGER consolidation_batch_receipts_no_delete
BEFORE DELETE ON consolidation_batch_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation batch receipts are immutable');
END;

DROP TRIGGER synthetic_cleanup_registry_delete_child_guard;
CREATE TRIGGER synthetic_cleanup_registry_delete_child_guard
BEFORE DELETE ON synthetic_cleanup_registry
WHEN EXISTS (
    SELECT 1 FROM consolidation_batch_receipts WHERE project_id = OLD.project_id
  )
  OR EXISTS (SELECT 1 FROM consolidation_outputs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM consolidation_inputs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM session_consolidations WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM review_decisions WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM review_requests WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM version_evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM conflicts WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM memory_versions WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM memory_repository_contexts WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM observation_evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM memories WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM observations WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM workflow_runs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM idempotency_records WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM taxonomy_policies WHERE project_id = OLD.project_id)
  OR EXISTS (
    SELECT 1 FROM github_tree_activation_receipts
    WHERE project_id = OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_tree_activation_witnesses
    WHERE project_id = OLD.project_id
  )
  OR EXISTS (SELECT 1 FROM github_repository_sync_runs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_ref_heads WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_manifest_deltas WHERE project_id = OLD.project_id)
  OR EXISTS (
    SELECT 1 FROM github_tree_manifest_lifecycle_events
    WHERE project_id = OLD.project_id
  )
  OR EXISTS (SELECT 1 FROM github_tree_manifest_entries WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_manifests WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM sync_cursors WHERE project_id = OLD.project_id)
  OR EXISTS (
    SELECT 1 FROM project_grant_repository_contexts
    WHERE project_id = OLD.project_id
  )
  OR EXISTS (SELECT 1 FROM project_grants WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM sessions WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM repositories WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM outbox_events WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM projection_snapshots WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM audit_events WHERE project_id = OLD.project_id)
  OR EXISTS (
    SELECT 1 FROM github_credential_expiry_warnings AS warning
    JOIN github_access_baselines AS baseline
      ON baseline.credential_version = warning.credential_version
    WHERE baseline.approved_by_principal_id = OLD.principal_id
      AND baseline.credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_credential_states AS state
    JOIN github_access_baselines AS baseline
      ON baseline.credential_version = state.credential_version
    WHERE baseline.approved_by_principal_id = OLD.principal_id
      AND baseline.credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_rate_observations AS observation
    JOIN github_access_baselines AS baseline
      ON baseline.credential_version = observation.credential_version
    WHERE baseline.approved_by_principal_id = OLD.principal_id
      AND baseline.credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_access_baselines
    WHERE approved_by_principal_id = OLD.principal_id
      AND credential_version = 'system.synthetic.' || OLD.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup requires child-first deletion');
END;
