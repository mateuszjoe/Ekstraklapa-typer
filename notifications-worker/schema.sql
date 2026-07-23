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

CREATE TABLE IF NOT EXISTS player_identities (
  uid TEXT PRIMARY KEY,
  google_email TEXT NOT NULL,
  google_full_name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  CHECK (length(uid) BETWEEN 1 AND 128),
  CHECK (length(google_email) BETWEEN 3 AND 254),
  CHECK (google_email = lower(google_email)),
  CHECK (length(google_full_name) BETWEEN 1 AND 120),
  CHECK (first_seen_at > 0),
  CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX IF NOT EXISTS player_identities_last_seen
  ON player_identities(last_seen_at DESC, uid);

CREATE TABLE IF NOT EXISTS notification_admins (
  email TEXT PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (email = 'mateuszjoe@gmail.com'),
  CHECK (length(uid) BETWEEN 1 AND 128),
  CHECK (verified_at > 0),
  CHECK (updated_at >= verified_at),
  FOREIGN KEY (uid) REFERENCES player_identities(uid) ON DELETE CASCADE
);

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

-- API-Football is queried only by the Worker after an official fixture is
-- final. The sync row provides a durable retry/lease state so browser traffic
-- can never consume the external provider quota.
CREATE TABLE IF NOT EXISTS api_football_rating_sync (
  match_id TEXT PRIMARY KEY,
  provider_match_id TEXT NOT NULL UNIQUE,
  api_fixture_id INTEGER UNIQUE,
  api_home_team_id INTEGER,
  api_away_team_id INTEGER,
  matchday INTEGER NOT NULL,
  kickoff_at INTEGER NOT NULL,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  ratings_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '',
  synced_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (matchday BETWEEN 1 AND 17),
  CHECK (kickoff_at > 0),
  CHECK (status IN ('pending', 'queued', 'syncing', 'retry', 'ready', 'unavailable')),
  CHECK (attempts BETWEEN 0 AND 20),
  CHECK (next_attempt_at >= 0),
  CHECK (lease_until >= 0),
  CHECK (ratings_count >= 0),
  CHECK (length(home_team_id) BETWEEN 1 AND 40),
  CHECK (length(away_team_id) BETWEEN 1 AND 40),
  CHECK (length(last_error_code) <= 64)
);

CREATE INDEX IF NOT EXISTS api_football_rating_sync_due
  ON api_football_rating_sync(status, next_attempt_at, kickoff_at);

CREATE TABLE IF NOT EXISTS api_football_daily_budget (
  budget_date TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(budget_date) = 10),
  CHECK (request_count >= 0 AND request_count <= 100)
);

-- One immutable row represents one rated player appearance. The public squad
-- response averages at most the five newest rows per API-Football player.
CREATE TABLE IF NOT EXISTS api_football_player_ratings (
  match_id TEXT NOT NULL,
  api_fixture_id INTEGER NOT NULL,
  api_player_id INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  player_key TEXT NOT NULL,
  player_fallback_key TEXT NOT NULL DEFAULT '',
  player_name TEXT NOT NULL,
  photo_url TEXT NOT NULL DEFAULT '',
  rating REAL NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  position TEXT NOT NULL DEFAULT '',
  kickoff_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, api_player_id),
  FOREIGN KEY (match_id) REFERENCES api_football_rating_sync(match_id) ON DELETE CASCADE,
  CHECK (api_fixture_id > 0),
  CHECK (api_player_id > 0),
  CHECK (length(team_id) BETWEEN 1 AND 40),
  CHECK (length(player_key) BETWEEN 1 AND 160),
  CHECK (length(player_fallback_key) <= 160),
  CHECK (length(player_name) BETWEEN 1 AND 120),
  CHECK (length(photo_url) <= 512),
  CHECK (rating > 0 AND rating <= 10),
  CHECK (minutes >= 0),
  CHECK (length(position) <= 24),
  CHECK (kickoff_at > 0)
);

CREATE INDEX IF NOT EXISTS api_football_player_ratings_recent
  ON api_football_player_ratings(team_id, api_player_id, kickoff_at DESC);

CREATE INDEX IF NOT EXISTS api_football_player_ratings_name
  ON api_football_player_ratings(team_id, player_key, kickoff_at DESC);

CREATE INDEX IF NOT EXISTS api_football_player_ratings_fallback
  ON api_football_player_ratings(team_id, player_fallback_key, kickoff_at DESC);
