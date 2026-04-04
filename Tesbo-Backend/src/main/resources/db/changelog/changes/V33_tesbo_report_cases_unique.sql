--liquibase formatted sql
--changeset bettercases:V33-tesbo-report-cases-unique

CREATE UNIQUE INDEX IF NOT EXISTS uq_tesbo_cases_run_spec_test
    ON tesbo_report_cases (run_id, spec_name, test_name);
