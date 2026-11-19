-- 0005_corrections: discard requests (FR Sports approval), reservations, physical stock counts, stock corrections
-- (FR Sports approval, applied as differences), and one-time reversal of erroneous receipts.

-- Units of an incident held by a pending discard: they cannot also be marked usable or recovered.
ALTER TABLE incidents
  ADD COLUMN qty_reserved integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT incidents_reserved_range CHECK (qty_reserved >= 0 AND qty_resolved + qty_reserved <= qty);

-- Resolutions may now also come from an approved stock correction.
ALTER TABLE incident_resolutions DROP CONSTRAINT resolutions_action_valid;
ALTER TABLE incident_resolutions ADD CONSTRAINT resolutions_action_valid
  CHECK (action IN ('MARKED_USABLE','RECOVERED_USABLE','RECOVERED_DAMAGED','DISCARDED','CORRECTED'));

-- item_stock.reserved now means: units of AVAILABLE held by pending discards (damaged/missing reservations live on incidents).
ALTER TABLE item_stock ADD CONSTRAINT stock_reserved_within_available CHECK (reserved <= available);

CREATE TABLE discard_requests (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id        bigint NOT NULL REFERENCES items(id),
  from_state     text NOT NULL,
  incident_id    bigint REFERENCES incidents(id),
  qty            integer NOT NULL,
  reason         text NOT NULL,
  details        text,
  auto           boolean NOT NULL DEFAULT false,    -- raised automatically for used-up consumables
  requested_by   bigint REFERENCES users(id),       -- NULL only when auto
  status         text NOT NULL DEFAULT 'PENDING',
  decided_by     bigint REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  movement_id    bigint REFERENCES stock_movements(id),
  created_at     timestamptz NOT NULL,
  CONSTRAINT discard_state_valid CHECK (from_state IN ('AVAILABLE','DAMAGED','MISSING')),   -- never ISSUED
  CONSTRAINT discard_incident_link CHECK ((from_state = 'AVAILABLE') = (incident_id IS NULL)),
  CONSTRAINT discard_qty_positive CHECK (qty > 0),
  CONSTRAINT discard_reason_valid CHECK (reason IN ('BROKEN','WORN_OUT','OBSOLETE','BEYOND_USE','LOST','CONSUMED','OTHER')),
  CONSTRAINT discard_status_valid CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  CONSTRAINT discard_requester CHECK (auto OR requested_by IS NOT NULL),
  CONSTRAINT discard_no_self_approval CHECK (status <> 'APPROVED' OR decided_by IS DISTINCT FROM requested_by),
  CONSTRAINT discard_approved_has_movement CHECK ((status = 'APPROVED') = (movement_id IS NOT NULL))
);
CREATE INDEX discard_requests_pending_idx ON discard_requests (created_at) WHERE status = 'PENDING';

CREATE TABLE verification_sessions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_type    text NOT NULL,
  scope_id      bigint,
  scope_label   text NOT NULL,
  started_by    bigint NOT NULL REFERENCES users(id),
  started_at    timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'OPEN',
  submitted_by  bigint REFERENCES users(id),
  submitted_at  timestamptz,
  CONSTRAINT verification_scope_valid CHECK (scope_type IN ('ALL','SPORT','CATEGORY','LOCATION')),
  CONSTRAINT verification_scope_id CHECK ((scope_type = 'ALL') = (scope_id IS NULL)),
  CONSTRAINT verification_status_valid CHECK (status IN ('OPEN','SUBMITTED','ABANDONED'))
);
-- Only one open count per scope at a time.
CREATE UNIQUE INDEX verification_one_open_per_scope ON verification_sessions (scope_type, coalesce(scope_id, 0)) WHERE status = 'OPEN';

CREATE TABLE verification_lines (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id        bigint NOT NULL REFERENCES verification_sessions(id),
  item_id           bigint NOT NULL REFERENCES items(id),
  counted_usable    integer,
  counted_damaged   integer,
  -- System figures captured when the count is submitted (under lock), so the report shows exactly what was compared.
  expected_usable   integer,
  expected_damaged  integer,
  issued_at_count   integer,
  missing_at_count  integer,
  CONSTRAINT verification_line_once UNIQUE (session_id, item_id),
  CONSTRAINT verification_counts_nonneg CHECK ((counted_usable IS NULL OR counted_usable >= 0) AND (counted_damaged IS NULL OR counted_damaged >= 0))
);

CREATE TABLE adjustments (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id               bigint NOT NULL REFERENCES items(id),
  state                 text NOT NULL,
  delta                 integer NOT NULL,
  expected_qty          integer NOT NULL,
  counted_qty           integer NOT NULL,
  reason                text NOT NULL,
  verification_line_id  bigint REFERENCES verification_lines(id),
  requested_by          bigint NOT NULL REFERENCES users(id),
  status                text NOT NULL DEFAULT 'PENDING',
  decided_by            bigint REFERENCES users(id),
  decided_at            timestamptz,
  decision_note         text,
  movement_id           bigint REFERENCES stock_movements(id),
  created_at            timestamptz NOT NULL,
  CONSTRAINT adjustment_state_valid CHECK (state IN ('AVAILABLE','DAMAGED')),
  CONSTRAINT adjustment_delta_nonzero CHECK (delta <> 0 AND delta = counted_qty - expected_qty),
  CONSTRAINT adjustment_status_valid CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  CONSTRAINT adjustment_no_self_approval CHECK (decided_by IS NULL OR status = 'CANCELLED' OR decided_by <> requested_by),
  CONSTRAINT adjustment_approved_has_movement CHECK ((status = 'APPROVED') = (movement_id IS NOT NULL))
);
CREATE INDEX adjustments_pending_idx ON adjustments (created_at) WHERE status = 'PENDING';

-- A movement can be reversed at most once.
CREATE UNIQUE INDEX stock_movements_reversed_once ON stock_movements (reverses_id) WHERE reverses_id IS NOT NULL;

-- Used-up consumables recorded before this migration get their automatic discard request now.
INSERT INTO discard_requests (item_id, from_state, incident_id, qty, reason, details, auto, created_at)
SELECT n.item_id, 'MISSING', n.id, n.qty - n.qty_resolved, 'CONSUMED', n.description, true, now()
  FROM incidents n WHERE n.type = 'CONSUMED' AND n.qty_resolved < n.qty;
UPDATE incidents SET qty_reserved = qty - qty_resolved WHERE type = 'CONSUMED' AND qty_resolved < qty;
