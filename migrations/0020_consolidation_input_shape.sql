CREATE TABLE migration_0020_consolidation_input_shape_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT consolidation_input_shape_cutover_requires_canonical_inputs
    CHECK (must_be_zero = 0)
);

INSERT INTO migration_0020_consolidation_input_shape_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (
  SELECT 1
  FROM consolidation_inputs
  WHERE input_kind = 'summary'
  GROUP BY project_id, consolidation_id
  HAVING COUNT(*) > 1
);

DROP TABLE migration_0020_consolidation_input_shape_preflight;

CREATE UNIQUE INDEX consolidation_inputs_one_summary
  ON consolidation_inputs(project_id, consolidation_id)
  WHERE input_kind = 'summary';

CREATE TRIGGER consolidation_inputs_shape_insert_guard
BEFORE INSERT ON consolidation_inputs
WHEN NEW.input_kind = 'summary'
  AND EXISTS (
    SELECT 1
    FROM consolidation_inputs
    WHERE project_id = NEW.project_id
      AND consolidation_id = NEW.consolidation_id
      AND input_kind = 'summary'
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation may contain only one summary input');
END;
