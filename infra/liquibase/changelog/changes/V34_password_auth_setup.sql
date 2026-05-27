--liquibase formatted sql
--changeset bettercases:V34-password-auth-setup

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash VARCHAR(512);
