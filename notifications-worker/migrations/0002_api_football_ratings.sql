PRAGMA foreign_keys = ON;

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
