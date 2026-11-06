-- Amounts are stored as text base units to keep BigInt precision.

CREATE TABLE IF NOT EXISTS rounds (
  id              INTEGER PRIMARY KEY,
  status          TEXT NOT NULL,
  burn_raw        TEXT NOT NULL,
  open_slot       BIGINT,
  packs_total     INTEGER NOT NULL,
  first_slot      BIGINT,
  deadline_slot   BIGINT,
  winner          TEXT,
  end_reason      TEXT,
  secret          TEXT NOT NULL,
  commit_hash     TEXT NOT NULL,
  commit_sig      TEXT,
  cutoff_at       TIMESTAMPTZ,
  settled_slot    BIGINT,
  settled_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The timer this round opened with, as JSON. Empty on rounds older than this column.
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS heat_tiers TEXT;

-- One row per pack in a round, in shuffled order.
CREATE TABLE IF NOT EXISTS lineup_slots (
  round_id     INTEGER NOT NULL REFERENCES rounds(id),
  position     INTEGER NOT NULL,
  price        INTEGER NOT NULL,
  rip_sig      TEXT UNIQUE,
  PRIMARY KEY (round_id, position)
);

-- Every verified burn or voucher redemption seen on-chain.
CREATE TABLE IF NOT EXISTS burns (
  signature       TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,            -- burn | voucher
  round_id        INTEGER NOT NULL,
  wallet          TEXT NOT NULL,
  slot            BIGINT NOT NULL,
  block_index     INTEGER NOT NULL,
  origin_sig      TEXT,                     -- voucher redemptions only
  commitment      TEXT NOT NULL,            -- confirmed | finalized | dropped
  result          TEXT NOT NULL DEFAULT 'pending', -- pending | counted | late
  usd_value       DOUBLE PRECISION,         -- what the burn was worth when it landed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS burns_round_order ON burns (round_id, slot, block_index);

-- Signatures that failed verification, so the indexer stops re-fetching them.
CREATE TABLE IF NOT EXISTS rejected_sigs (
  signature   TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vouchers (
  origin_sig      TEXT PRIMARY KEY,
  wallet          TEXT NOT NULL,
  reason          TEXT NOT NULL,            -- late | no_pack
  created_round   INTEGER NOT NULL,
  redeemed_sig    TEXT UNIQUE,
  redeemed_round  INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vouchers_wallet ON vouchers (wallet);

CREATE TABLE IF NOT EXISTS pack_orders (
  rip_sig        TEXT PRIMARY KEY,
  round_id       INTEGER NOT NULL,
  position       INTEGER NOT NULL,
  price          INTEGER NOT NULL,
  machine        TEXT NOT NULL,
  state          TEXT NOT NULL,   -- queued | generated | signed | paid | opened | failed
  attempt        INTEGER NOT NULL DEFAULT 0,
  memo           TEXT,
  signed_tx      TEXT,
  pay_sig        TEXT,
  last_error     TEXT,
  paid_at        TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pack_orders_state ON pack_orders (state);

CREATE TABLE IF NOT EXISTS cards (
  nft            TEXT PRIMARY KEY,
  round_id       INTEGER NOT NULL,
  rip_sig        TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  image          TEXT,
  rarity         TEXT,
  insured_value  DOUBLE PRECISION,
  interface      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_round ON cards (round_id);

CREATE TABLE IF NOT EXISTS sweeps (
  round_id    INTEGER NOT NULL,
  idx         INTEGER NOT NULL,
  slot        BIGINT NOT NULL,
  ranked      TEXT NOT NULL,      -- JSON wallets, best first
  pool        TEXT NOT NULL,      -- JSON rip signatures in chain order
  blockhash   TEXT,
  seed_slot   BIGINT,
  picks       TEXT,               -- JSON rip signatures, same order as ranked
  PRIMARY KEY (round_id, idx)
);

-- A card can be paid exactly once, whether it was swept or won.
CREATE TABLE IF NOT EXISTS payouts (
  id          SERIAL PRIMARY KEY,
  rip_sig     TEXT NOT NULL UNIQUE,
  round_id    INTEGER NOT NULL,
  recipient   TEXT NOT NULL,
  reason      TEXT NOT NULL,      -- win | drop
  state       TEXT NOT NULL,      -- waiting | queued | signed | sent | delivered | stuck
  signed_tx   TEXT,
  signature   TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payouts_state ON payouts (state);

CREATE TABLE IF NOT EXISTS ledger (
  ref         TEXT PRIMARY KEY,   -- unique per on-chain event, so replays can't double count
  kind        TEXT NOT NULL,      -- fee_claim | swap | pack | refund | gas
  usd_micro   TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservations (
  round_id    INTEGER PRIMARY KEY,
  usd_micro   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  name        TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
