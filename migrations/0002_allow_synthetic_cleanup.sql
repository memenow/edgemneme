DROP TRIGGER memory_versions_no_delete;
CREATE TRIGGER memory_versions_no_delete
BEFORE DELETE ON memory_versions
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'memory versions are immutable');
END;

DROP TRIGGER audit_events_no_delete;
CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

DROP TRIGGER version_evidence_no_delete;
CREATE TRIGGER version_evidence_no_delete
BEFORE DELETE ON version_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'version evidence is immutable');
END;

DROP TRIGGER observation_evidence_no_delete;
CREATE TRIGGER observation_evidence_no_delete
BEFORE DELETE ON observation_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'observation evidence is immutable');
END;

DROP TRIGGER review_decisions_no_delete;
CREATE TRIGGER review_decisions_no_delete
BEFORE DELETE ON review_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'review decisions are immutable');
END;

DROP TRIGGER consolidation_inputs_no_delete;
CREATE TRIGGER consolidation_inputs_no_delete
BEFORE DELETE ON consolidation_inputs
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation inputs are immutable');
END;

DROP TRIGGER consolidation_outputs_no_delete;
CREATE TRIGGER consolidation_outputs_no_delete
BEFORE DELETE ON consolidation_outputs
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation outputs are immutable');
END;

DROP TRIGGER github_access_baselines_no_delete;
CREATE TRIGGER github_access_baselines_no_delete
BEFORE DELETE ON github_access_baselines
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'GitHub access baselines are immutable');
END;
