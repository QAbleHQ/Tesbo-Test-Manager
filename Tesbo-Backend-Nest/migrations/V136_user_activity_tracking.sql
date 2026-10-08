-- Per-user login/activity tracking, so a daily analytics report can be computed for any past day
-- without drifting.
--
-- Why not just read audit_logs: login is audited, but only some mutations are, and audit_logs has no
-- IST-day index. The report needs one cheap, exact answer per (user, day): did they log in, did they
-- do something. user_daily_activity is that answer; users.last_login_at / last_active_at are the
-- "when" for support and dashboards.
--
-- activity_date is the Asia/Kolkata calendar day (India has no DST), the same zone the report is
-- scheduled and labelled in. Both flags are raw facts: "engaged WITHOUT login" is derived at report
-- time as engaged AND NOT logged_in, so a user who logs in and also works is a DAU, not double counted.

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS user_daily_activity (
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_date  DATE NOT NULL,
    logged_in      BOOLEAN NOT NULL DEFAULT false,
    engaged        BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, activity_date)
);

-- The report scans one day at a time.
CREATE INDEX IF NOT EXISTS idx_user_daily_activity_date ON user_daily_activity(activity_date);

-- Backfill from the audit log, which is append-only and goes back to the first user. A login is an
-- 'login' auth row; engagement is any non-auth audit row (auth rows are otp_requested, logout,
-- password_*, which are not product activity). Joined to users so agent actors (Zyra) and deleted
-- users (actor_id NULL) never land here. Idempotent: ON CONFLICT only ever turns a flag on.
INSERT INTO user_daily_activity (user_id, activity_date, logged_in, engaged)
SELECT a.actor_id,
       (a.created_at AT TIME ZONE 'Asia/Kolkata')::date,
       bool_or(a.action = 'login' AND a.entity_type = 'auth'),
       bool_or(a.entity_type <> 'auth')
  FROM audit_logs a
  JOIN users u ON u.id = a.actor_id
 WHERE a.action <> 'otp_requested'
 GROUP BY a.actor_id, (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
ON CONFLICT (user_id, activity_date) DO UPDATE
   SET logged_in = user_daily_activity.logged_in OR EXCLUDED.logged_in,
       engaged   = user_daily_activity.engaged   OR EXCLUDED.engaged;

UPDATE users u
   SET last_login_at = s.last_login, last_active_at = s.last_active
  FROM (
    SELECT actor_id,
           max(created_at) FILTER (WHERE action = 'login' AND entity_type = 'auth') AS last_login,
           max(created_at) FILTER (WHERE entity_type <> 'auth' OR action = 'login') AS last_active
      FROM audit_logs
     WHERE actor_id IS NOT NULL
     GROUP BY actor_id
  ) s
 WHERE u.id = s.actor_id AND u.last_active_at IS NULL;
