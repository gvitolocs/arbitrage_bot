-- wPKN Liquidity Guardian schema v1

CREATE TABLE IF NOT EXISTS reserve_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  wpkn_reserve TEXT NOT NULL,
  quote_reserve TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  price_quote_per_wpkn REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_pool_time ON reserve_snapshots(pool_address, created_at);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  profitable INTEGER NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  pool_name TEXT,
  instant INTEGER NOT NULL DEFAULT 0,
  digest_batch TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_kind_time ON alerts_sent(kind, created_at);

CREATE TABLE IF NOT EXISTS digest_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_digest_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_hash TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT,
  gas_used TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_usage (
  date TEXT PRIMARY KEY,
  wpkn_refilled TEXT NOT NULL DEFAULT '0',
  wbnb_spent TEXT NOT NULL DEFAULT '0'
);

CREATE TABLE IF NOT EXISTS pool_state (
  pool_address TEXT PRIMARY KEY,
  last_block INTEGER NOT NULL,
  last_reserve_wpkn TEXT NOT NULL,
  last_updated_at TEXT NOT NULL
);
