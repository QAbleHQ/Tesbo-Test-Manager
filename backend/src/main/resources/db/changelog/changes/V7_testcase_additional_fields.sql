--liquibase formatted sql
--changeset bettercases:V7-testcase-additional-fields
ALTER TABLE testcases
    ADD COLUMN estimated_duration VARCHAR(64),
    ADD COLUMN attachments TEXT;
