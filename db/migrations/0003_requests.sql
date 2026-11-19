-- 0003_requests: equipment requests, issues (approval + handover in one step), reference counters, email outbox.

-- Gap-free yearly reference numbers (REQ-2026-000001, ISS-2026-000001), incremented under a row lock.
CREATE TABLE counters (
  name   text PRIMARY KEY,
  value  integer NOT NULL
);

CREATE TABLE requests (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref              text NOT NULL,
  requester_id     bigint NOT NULL REFERENCES users(id),
  group_name       text,
  purpose          text NOT NULL,
  expected_return  date NOT NULL,
  status           text NOT NULL DEFAULT 'PENDING',
  ready            boolean NOT NULL DEFAULT false,
  ready_by         bigint REFERENCES users(id),
  ready_at         timestamptz,
  decided_by       bigint REFERENCES users(id),
  decided_at       timestamptz,
  reject_reason    text,
  created_at       timestamptz NOT NULL,
  CONSTRAINT requests_ref_key UNIQUE (ref),
  CONSTRAINT requests_status_valid CHECK (status IN ('PENDING','CANCELLED','REJECTED','ISSUED','RETURNED')),
  CONSTRAINT requests_reject_reason CHECK (status <> 'REJECTED' OR (reject_reason IS NOT NULL AND decided_by IS NOT NULL)),
  CONSTRAINT requests_no_self_decision CHECK (decided_by IS NULL OR status = 'CANCELLED' OR decided_by <> requester_id),
  CONSTRAINT requests_purpose_nonblank CHECK (btrim(purpose) <> '')
);
CREATE INDEX requests_status_idx ON requests (status, created_at);
CREATE INDEX requests_requester_idx ON requests (requester_id, created_at DESC);

CREATE TABLE request_lines (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id     bigint NOT NULL REFERENCES requests(id),
  item_id        bigint NOT NULL REFERENCES items(id),
  qty_requested  integer NOT NULL,
  qty_issued     integer,
  CONSTRAINT request_lines_item_once UNIQUE (request_id, item_id),
  CONSTRAINT request_lines_qty_range CHECK (qty_requested BETWEEN 1 AND 1000),
  CONSTRAINT request_lines_issued_range CHECK (qty_issued IS NULL OR qty_issued BETWEEN 0 AND qty_requested)
);

CREATE TABLE issues (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ref          text NOT NULL,
  request_id   bigint NOT NULL REFERENCES requests(id),
  recipient_id bigint NOT NULL REFERENCES users(id),
  approved_by  bigint NOT NULL REFERENCES users(id),
  issued_by    bigint NOT NULL REFERENCES users(id),
  issued_at    timestamptz NOT NULL,
  due_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'ISSUED',
  returned_at  timestamptz,
  received_by  bigint REFERENCES users(id),
  CONSTRAINT issues_ref_key UNIQUE (ref),
  CONSTRAINT issues_one_per_request UNIQUE (request_id),
  CONSTRAINT issues_status_valid CHECK (status IN ('ISSUED','RETURNED')),
  CONSTRAINT issues_no_self_approval CHECK (approved_by <> recipient_id),
  CONSTRAINT issues_returned_consistent CHECK ((status = 'RETURNED') = (returned_at IS NOT NULL))
);
CREATE INDEX issues_open_idx ON issues (due_date) WHERE status = 'ISSUED';
CREATE INDEX issues_recipient_idx ON issues (recipient_id, issued_at DESC);

CREATE TABLE issue_lines (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id  bigint NOT NULL REFERENCES issues(id),
  item_id   bigint NOT NULL REFERENCES items(id),
  qty       integer NOT NULL,
  CONSTRAINT issue_lines_item_once UNIQUE (issue_id, item_id),
  CONSTRAINT issue_lines_qty_positive CHECK (qty > 0)
);

-- Durable email outbox: rows are written in the same transaction as the event, sent after commit, retried on failure.
CREATE TABLE notifications (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key       text NOT NULL,
  kind             text NOT NULL,
  to_email         text NOT NULL,
  subject          text NOT NULL,
  text_body        text NOT NULL,
  html_body        text,
  entity           text,
  entity_id        text,
  status           text NOT NULL DEFAULT 'QUEUED',
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  claimed_at       timestamptz,
  sent_at          timestamptz,
  provider_id      text,
  last_error       text,
  created_at       timestamptz NOT NULL,
  CONSTRAINT notifications_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT notifications_status_valid CHECK (status IN ('QUEUED','SENDING','SENT','FAILED'))
);
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status = 'QUEUED';
CREATE INDEX notifications_entity_idx ON notifications (entity, entity_id);
