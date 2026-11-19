-- 0001_foundation: identity, sign-in, sessions, rate limits, audit trail, settings.
-- Applied once by scripts/migrate.ts inside a transaction. Never edit after it has run anywhere;
-- add a new numbered file instead (the runner refuses changed files).

-- Shared guard used by every append-only table (audit_log now; stock_movements in Phase 3).
CREATE FUNCTION forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TABLE users (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                 text NOT NULL,
  name                  text,
  univ_id               text,
  category              text,
  role                  text NOT NULL DEFAULT 'RECIPIENT',
  is_active             boolean NOT NULL DEFAULT true,
  profile_completed_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lower CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_univ_id_key UNIQUE (univ_id),
  CONSTRAINT users_univ_id_format CHECK (univ_id IS NULL OR univ_id ~ '^[A-Z0-9/-]{3,30}$'),
  CONSTRAINT users_role_valid CHECK (role IN ('FR_SPORTS','ASO','STOREKEEPER','PROCUREMENT','MANAGEMENT','RECIPIENT')),
  CONSTRAINT users_category_valid CHECK (category IS NULL OR category IN ('STUDENT','FACULTY','STAFF','COACH','SPORTS_COORDINATOR')),
  CONSTRAINT users_profile_complete CHECK (
    profile_completed_at IS NULL OR (name IS NOT NULL AND univ_id IS NOT NULL AND category IS NOT NULL)
  )
);
CREATE INDEX users_role_idx ON users (role) WHERE is_active;

CREATE TABLE otp_challenges (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email           text NOT NULL,
  code_salt       text NOT NULL,
  code_hash       text NOT NULL,
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  consumed_at     timestamptz,
  invalidated_at  timestamptz,
  request_ip      text,
  CONSTRAINT otp_attempts_range CHECK (attempts BETWEEN 0 AND 10),
  CONSTRAINT otp_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX otp_challenges_email_idx ON otp_challenges (email, created_at DESC);

CREATE TABLE sessions (
  id            text PRIMARY KEY,               -- SHA-256 of the cookie token; the token itself is never stored
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,           -- absolute limit regardless of activity
  ip            text,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE rate_limits (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint REFERENCES users(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  bigint REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
