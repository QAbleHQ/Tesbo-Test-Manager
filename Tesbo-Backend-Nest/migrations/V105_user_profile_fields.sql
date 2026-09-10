-- Splits the previously-combined `name` column into first_name/last_name, and adds an optional
-- mobile_number, so signup can collect them as distinct fields and the Account page can read
-- structured data instead of guessing where one name ends and the other begins. `name` is kept and
-- kept in sync by every write path, since many existing reads (workspace/project member lists, bug
-- reporter/assignee, activity feed) already display it and are out of scope for this change.
ALTER TABLE users
    ADD COLUMN first_name VARCHAR(50);

ALTER TABLE users
    ADD COLUMN last_name VARCHAR(50);

-- E.164-ish: a leading "+", then 2-15 digits. Stored already normalized (no spaces/dashes), so the
-- constraint doubles as a sanity check on what the application writes.
ALTER TABLE users
    ADD COLUMN mobile_number VARCHAR(20) CHECK (mobile_number ~ '^\+[1-9]\d{6,14}$');

-- NULL means this account still owes the one-time profile step (name + optional mobile) that
-- self-serve signup and invite registration already collect up front. Only the passwordless-OTP
-- first-time path (OtpService.findOrCreateUser) can leave this NULL going forward — see the backfill
-- below for why every pre-existing account is exempted rather than interrupted retroactively.
ALTER TABLE users
    ADD COLUMN profile_completed_at TIMESTAMPTZ;

-- Best-effort split of the existing combined name, so accounts created before this migration show a
-- first/last name immediately rather than reading as permanently incomplete. Split on the first
-- space; a name with no space becomes first_name only, matching how the Account page already treated
-- a single-word name before this migration existed.
UPDATE users
SET
    first_name = CASE WHEN position(' ' in name) > 0 THEN split_part(name, ' ', 1) ELSE name END,
    last_name = CASE WHEN position(' ' in name) > 0 THEN substring(name from position(' ' in name) + 1) ELSE NULL END
WHERE name IS NOT NULL;

-- Every pre-existing account is marked complete regardless of how it was created: this feature is
-- about collecting the fields going forward, not retroactively forcing already-active users through
-- a new mandatory step they never agreed to when they signed up.
UPDATE users SET profile_completed_at = created_at WHERE profile_completed_at IS NULL;

-- Same fields on the pre-verification row, so a signup or invite registration in progress can carry
-- them through to the final INSERT INTO users once the OTP checks out.
ALTER TABLE pending_signups
    ADD COLUMN first_name VARCHAR(50);

ALTER TABLE pending_signups
    ADD COLUMN last_name VARCHAR(50);

ALTER TABLE pending_signups
    ADD COLUMN mobile_number VARCHAR(20) CHECK (mobile_number ~ '^\+[1-9]\d{6,14}$');
