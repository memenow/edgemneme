ALTER TABLE session_consolidations ADD COLUMN lease_owner TEXT;
ALTER TABLE session_consolidations ADD COLUMN lease_expires_at TEXT;
ALTER TABLE session_consolidations ADD COLUMN lease_operation_id TEXT;
ALTER TABLE session_consolidations
  ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (
    typeof(lease_epoch) = 'integer'
    AND lease_epoch >= 0
    AND lease_epoch <= 9007199254740991
  );

CREATE INDEX session_consolidations_lease_expiry
  ON session_consolidations(status, lease_expires_at)
  WHERE status = 'running';
