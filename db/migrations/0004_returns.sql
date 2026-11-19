-- 0004_returns: full-return reconciliation, damage / missing / consumed incidents and their resolution,
-- damage photographs, overdue reminder log and reminder settings.

-- Damage photographs (compressed in the browser to ~300 KB). Stored in PostgreSQL so they share its backups and access control.
CREATE TABLE photos (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uploaded_by   bigint NOT NULL REFERENCES users(id),
  content_type  text NOT NULL,
  bytes         bytea NOT NULL,
  size          integer NOT NULL,
  linked        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL,
  CONSTRAINT photos_type_valid CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  CONSTRAINT photos_size_limit CHECK (size > 0 AND size <= 1572864)
);

ALTER TABLE issues
  ADD COLUMN return_remarks  text,
  ADD COLUMN return_photo_id bigint REFERENCES photos(id),
  ADD CONSTRAINT issues_received_when_returned CHECK (status <> 'RETURNED' OR received_by IS NOT NULL);

-- One row per returned item: every issued unit is accounted for as usable, damaged, missing or consumed.
CREATE TABLE return_lines (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id      bigint NOT NULL REFERENCES issues(id),
  item_id       bigint NOT NULL REFERENCES items(id),
  qty_usable    integer NOT NULL,
  qty_damaged   integer NOT NULL,
  qty_missing   integer NOT NULL,
  qty_consumed  integer NOT NULL,
  note          text,
  CONSTRAINT return_lines_item_once UNIQUE (issue_id, item_id),
  CONSTRAINT return_lines_nonneg CHECK (qty_usable >= 0 AND qty_damaged >= 0 AND qty_missing >= 0 AND qty_consumed >= 0),
  CONSTRAINT return_lines_some CHECK (qty_usable + qty_damaged + qty_missing + qty_consumed > 0)
);

-- Damaged / missing / consumed units, each traceable to the issue and the accountable recipient (if any).
CREATE TABLE incidents (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type          text NOT NULL,
  item_id       bigint NOT NULL REFERENCES items(id),
  issue_id      bigint REFERENCES issues(id),
  recipient_id  bigint REFERENCES users(id),
  qty           integer NOT NULL,
  qty_resolved  integer NOT NULL DEFAULT 0,
  description   text,
  photo_id      bigint REFERENCES photos(id),
  reported_by   bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL,
  CONSTRAINT incidents_type_valid CHECK (type IN ('DAMAGED','MISSING','CONSUMED','STORE_DAMAGE')),
  CONSTRAINT incidents_qty_positive CHECK (qty > 0),
  CONSTRAINT incidents_resolved_range CHECK (qty_resolved BETWEEN 0 AND qty),
  CONSTRAINT incidents_issue_link CHECK ((type = 'STORE_DAMAGE') = (issue_id IS NULL))
);
CREATE INDEX incidents_open_idx ON incidents (item_id) WHERE qty_resolved < qty;
CREATE INDEX incidents_issue_idx ON incidents (issue_id);

CREATE TABLE incident_resolutions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id  bigint NOT NULL REFERENCES incidents(id),
  action       text NOT NULL,
  qty          integer NOT NULL,
  remarks      text,
  movement_id  bigint REFERENCES stock_movements(id),
  resolved_by  bigint NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  CONSTRAINT resolutions_action_valid CHECK (action IN ('MARKED_USABLE','RECOVERED_USABLE','RECOVERED_DAMAGED','DISCARDED')),
  CONSTRAINT resolutions_qty_positive CHECK (qty > 0)
);
CREATE TRIGGER incident_resolutions_append_only
  BEFORE UPDATE OR DELETE ON incident_resolutions
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Which overdue reminder (1st, 2nd, ...) has been queued for which issue. Unique: a re-run never sends twice.
CREATE TABLE reminders_sent (
  issue_id     bigint NOT NULL REFERENCES issues(id),
  reminder_no  integer NOT NULL,
  queued_at    timestamptz NOT NULL,
  PRIMARY KEY (issue_id, reminder_no),
  CONSTRAINT reminders_no_positive CHECK (reminder_no > 0)
);

INSERT INTO settings (key, value) VALUES ('overdue_reminders', '{"firstAfterDays": 1, "everyDays": 3, "max": 4}');
