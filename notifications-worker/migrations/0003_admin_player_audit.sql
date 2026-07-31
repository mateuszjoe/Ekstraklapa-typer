PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admin_player_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id TEXT NOT NULL,
  target_uid TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK (length(season_id) BETWEEN 1 AND 40),
  CHECK (length(target_uid) BETWEEN 1 AND 128),
  CHECK (length(actor_uid) BETWEEN 1 AND 128),
  CHECK (action IN ('entry-fee-paid', 'entry-fee-unpaid', 'player-removed')),
  CHECK (length(detail_json) BETWEEN 2 AND 1024),
  CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS admin_player_audit_target
  ON admin_player_audit(season_id, target_uid, created_at DESC);
