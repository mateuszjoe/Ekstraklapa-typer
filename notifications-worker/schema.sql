PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  rotation_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(uid) BETWEEN 1 AND 128),
  CHECK (length(endpoint) BETWEEN 16 AND 2048),
  CHECK (length(p256dh) = 87),
  CHECK (length(auth_secret) = 22),
  CHECK (length(rotation_token_hash) = 43)
);

CREATE INDEX IF NOT EXISTS subscriptions_uid_updated
  ON subscriptions(uid, updated_at DESC);

CREATE TABLE IF NOT EXISTS picks (
  uid TEXT NOT NULL,
  match_id TEXT NOT NULL,
  matchday INTEGER NOT NULL,
  pick TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (uid, match_id),
  CHECK (matchday BETWEEN 1 AND 17),
  CHECK (pick IN ('1', 'X', '2'))
);

CREATE INDEX IF NOT EXISTS picks_match
  ON picks(match_id, uid);

CREATE INDEX IF NOT EXISTS picks_matchday
  ON picks(matchday, uid);

CREATE TABLE IF NOT EXISTS match_results (
  match_id TEXT PRIMARY KEY,
  matchday INTEGER NOT NULL,
  result TEXT NOT NULL,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  status TEXT NOT NULL,
  finalized_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (matchday BETWEEN 1 AND 17),
  CHECK (result IN ('1', 'X', '2')),
  CHECK (home_score >= 0 AND away_score >= 0)
);

CREATE INDEX IF NOT EXISTS match_results_matchday
  ON match_results(matchday, match_id);

-- The official provider may expose a partial lineup first. `published` becomes
-- 1 only once both complete starting elevens are present and never goes back.
CREATE TABLE IF NOT EXISTS match_lineups (
  match_id TEXT PRIMARY KEY,
  provider_match_id TEXT NOT NULL UNIQUE,
  matchday INTEGER NOT NULL,
  kickoff_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (matchday BETWEEN 1 AND 17),
  CHECK (published IN (0, 1)),
  CHECK (kickoff_at > 0),
  CHECK (length(payload_json) >= 2)
);

CREATE INDEX IF NOT EXISTS match_lineups_publication
  ON match_lineups(published, kickoff_at, matchday);

-- An event key is a stable idempotency key. A short lease lets a later Queue
-- delivery retry an interrupted dispatch without sending completed work twice.
CREATE TABLE IF NOT EXISTS notification_events (
  event_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  target_uid TEXT NOT NULL DEFAULT '',
  exclude_uid TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (length(payload_json) BETWEEN 2 AND 4096),
  CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CHECK (length(lease_token) = 43),
  CHECK (attempts BETWEEN 1 AND 4)
);

CREATE INDEX IF NOT EXISTS notification_events_cleanup
  ON notification_events(updated_at);

CREATE INDEX IF NOT EXISTS notification_events_dispatch
  ON notification_events(status, updated_at, created_at);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  event_key TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_key, subscription_id),
  FOREIGN KEY (event_key) REFERENCES notification_events(event_key) ON DELETE CASCADE,
  CHECK (status IN ('sent', 'invalid'))
);

CREATE TABLE IF NOT EXISTS worker_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_limits (
  uid TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uid, bucket),
  CHECK (request_count >= 1)
);

CREATE INDEX IF NOT EXISTS request_limits_cleanup
  ON request_limits(updated_at);
