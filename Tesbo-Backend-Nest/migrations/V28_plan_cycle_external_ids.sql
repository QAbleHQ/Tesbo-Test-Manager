
ALTER TABLE plans ADD COLUMN external_id VARCHAR(64);
CREATE INDEX idx_plans_external_id ON plans(external_id);

ALTER TABLE cycles ADD COLUMN external_id VARCHAR(64);
CREATE INDEX idx_cycles_external_id ON cycles(external_id);
