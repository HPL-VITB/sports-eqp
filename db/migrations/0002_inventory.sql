-- 0002_inventory: sports, categories, locations, equipment items, stock balances, the stock movement ledger,
-- idempotency keys and Excel import batches.

CREATE TABLE sports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  code        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sports_code_format CHECK (code ~ '^[A-Z]{2,4}$'),
  CONSTRAINT sports_code_key UNIQUE (code),
  CONSTRAINT sports_name_nonblank CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX sports_name_key ON sports (lower(name));

CREATE TABLE categories (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sport_id    bigint NOT NULL REFERENCES sports(id),
  name        text NOT NULL,
  code        text NOT NULL,
  next_seq    integer NOT NULL DEFAULT 1,   -- next number for item codes in this category
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_code_format CHECK (code ~ '^[A-Z0-9]{2,4}$'),
  CONSTRAINT categories_sport_code_key UNIQUE (sport_id, code),
  CONSTRAINT categories_id_sport_key UNIQUE (id, sport_id),  -- lets items prove category belongs to sport
  CONSTRAINT categories_name_nonblank CHECK (btrim(name) <> ''),
  CONSTRAINT categories_next_seq_positive CHECK (next_seq > 0)
);
CREATE UNIQUE INDEX categories_sport_name_key ON categories (sport_id, lower(name));

CREATE TABLE locations (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  parent_id   bigint REFERENCES locations(id),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locations_name_nonblank CHECK (btrim(name) <> ''),
  CONSTRAINT locations_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX locations_parent_name_key ON locations (coalesce(parent_id, 0), lower(name));

CREATE TABLE items (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text NOT NULL,
  sport_id        bigint NOT NULL REFERENCES sports(id),
  category_id     bigint NOT NULL,
  name            text NOT NULL,
  brand           text,
  model           text,
  size            text,
  spec            text,
  unit            text NOT NULL,
  location_id     bigint NOT NULL REFERENCES locations(id),
  min_stock       integer,
  is_consumable   boolean NOT NULL DEFAULT false,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      bigint REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT items_code_key UNIQUE (code),
  CONSTRAINT items_category_matches_sport FOREIGN KEY (category_id, sport_id) REFERENCES categories (id, sport_id),
  CONSTRAINT items_unit_valid CHECK (unit IN ('piece','pair','set','box','dozen','tube','roll','metre','pack')),
  CONSTRAINT items_min_stock_nonneg CHECK (min_stock IS NULL OR min_stock >= 0),
  CONSTRAINT items_name_nonblank CHECK (btrim(name) <> '')
);
-- One definition per category/name/brand/model/size, ignoring case: stops duplicate item records.
CREATE UNIQUE INDEX items_definition_key ON items (
  category_id, lower(name), lower(coalesce(brand, '')), lower(coalesce(model, '')), lower(coalesce(size, ''))
);
CREATE INDEX items_search_idx ON items (lower(name) text_pattern_ops);
CREATE INDEX items_sport_category_idx ON items (sport_id, category_id);

-- Current balance per item. Changed only by src/server/inventory/ledger.ts together with a stock_movements row.
CREATE TABLE item_stock (
  item_id     bigint PRIMARY KEY REFERENCES items(id),
  available   integer NOT NULL DEFAULT 0,
  issued      integer NOT NULL DEFAULT 0,
  damaged     integer NOT NULL DEFAULT 0,
  missing     integer NOT NULL DEFAULT 0,
  discarded   integer NOT NULL DEFAULT 0,
  reserved    integer NOT NULL DEFAULT 0,   -- held by pending discards (Phase 6)
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_available_nonneg CHECK (available >= 0),
  CONSTRAINT stock_issued_nonneg CHECK (issued >= 0),
  CONSTRAINT stock_damaged_nonneg CHECK (damaged >= 0),
  CONSTRAINT stock_missing_nonneg CHECK (missing >= 0),
  CONSTRAINT stock_discarded_nonneg CHECK (discarded >= 0),
  CONSTRAINT stock_reserved_valid CHECK (reserved >= 0 AND reserved <= available + damaged + missing)
);

CREATE TABLE stock_movements (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES items(id),
  type            text NOT NULL,
  qty             integer NOT NULL,
  from_state      text,      -- NULL = from outside the store's accountable stock
  to_state        text,      -- NULL = out of accountable stock
  before          jsonb NOT NULL,
  after           jsonb NOT NULL,
  source_table    text,
  source_id       text,
  actor_id        bigint REFERENCES users(id),
  approved_by     bigint REFERENCES users(id),
  reverses_id     bigint REFERENCES stock_movements(id),
  remarks         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT movement_qty_positive CHECK (qty > 0),
  CONSTRAINT movement_type_valid CHECK (type IN (
    'OPENING','RECEIPT','ISSUE','RETURN_USABLE','RETURN_DAMAGED','RETURN_MISSING','STORE_DAMAGE',
    'MARK_USABLE','RECOVERED','DISCARD','CORRECTION','REVERSAL')),
  CONSTRAINT movement_states_valid CHECK (
    (from_state IS NULL OR from_state IN ('AVAILABLE','ISSUED','DAMAGED','MISSING','DISCARDED')) AND
    (to_state   IS NULL OR to_state   IN ('AVAILABLE','ISSUED','DAMAGED','MISSING','DISCARDED')) AND
    (from_state IS NOT NULL OR to_state IS NOT NULL) AND
    from_state IS DISTINCT FROM to_state)
);
CREATE INDEX stock_movements_item_idx ON stock_movements (item_id, id DESC);
CREATE INDEX stock_movements_source_idx ON stock_movements (source_table, source_id);
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Recomputes every balance from the ledger; any row returned is an inconsistency (checked nightly and in tests).
CREATE VIEW stock_ledger_mismatches AS
WITH flows AS (
  SELECT item_id, to_state AS state, qty FROM stock_movements WHERE to_state IS NOT NULL
  UNION ALL
  SELECT item_id, from_state, -qty FROM stock_movements WHERE from_state IS NOT NULL
), ledger AS (
  SELECT item_id,
         coalesce(sum(qty) FILTER (WHERE state = 'AVAILABLE'), 0) AS available,
         coalesce(sum(qty) FILTER (WHERE state = 'ISSUED'), 0)    AS issued,
         coalesce(sum(qty) FILTER (WHERE state = 'DAMAGED'), 0)   AS damaged,
         coalesce(sum(qty) FILTER (WHERE state = 'MISSING'), 0)   AS missing,
         coalesce(sum(qty) FILTER (WHERE state = 'DISCARDED'), 0) AS discarded
    FROM flows GROUP BY item_id
)
SELECT s.item_id,
       s.available, coalesce(l.available, 0) AS ledger_available,
       s.issued,    coalesce(l.issued, 0)    AS ledger_issued,
       s.damaged,   coalesce(l.damaged, 0)   AS ledger_damaged,
       s.missing,   coalesce(l.missing, 0)   AS ledger_missing,
       s.discarded, coalesce(l.discarded, 0) AS ledger_discarded
  FROM item_stock s LEFT JOIN ledger l ON l.item_id = s.item_id
 WHERE (s.available, s.issued, s.damaged, s.missing, s.discarded)
       IS DISTINCT FROM (coalesce(l.available,0), coalesce(l.issued,0), coalesce(l.damaged,0), coalesce(l.missing,0), coalesce(l.discarded,0));

-- A repeated form submission (double click, network retry) returns the first result instead of acting twice.
CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  operation   text NOT NULL,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_key_format CHECK (key ~ '^[A-Za-z0-9_-]{16,64}$')
);

CREATE TABLE import_batches (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filename      text NOT NULL,
  uploaded_by   bigint NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'PREVIEW',
  raw_rows      jsonb NOT NULL,
  plan          jsonb NOT NULL,
  fingerprint   text NOT NULL,
  created_at    timestamptz NOT NULL,
  committed_at  timestamptz,
  CONSTRAINT import_status_valid CHECK (status IN ('PREVIEW','COMMITTED','DISCARDED'))
);

-- Starting data; FR Sports can rename, add or deactivate these.
INSERT INTO locations (name) VALUES ('Central Sports Store');
INSERT INTO sports (name, code) VALUES
  ('Cricket','CRI'), ('Football','FTB'), ('Basketball','BSK'), ('Volleyball','VOL'), ('Badminton','BAD'),
  ('Table Tennis','TT'), ('Tennis','TEN'), ('Pickleball','PKB'), ('Chess','CHS'), ('Athletics','ATH'),
  ('General & Kits','GEN');
