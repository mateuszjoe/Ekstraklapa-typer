PRAGMA foreign_keys = ON;

-- A previous retry could only have produced duplicate cleanup markers before
-- this uniqueness constraint existed. Keep the oldest completion and discard
-- redundant copies before creating the index.
DELETE FROM admin_player_audit
WHERE action = 'player-removed'
  AND id NOT IN (
    SELECT MIN(id)
    FROM admin_player_audit
    WHERE action = 'player-removed'
    GROUP BY season_id, target_uid, action
  );

CREATE UNIQUE INDEX IF NOT EXISTS admin_player_audit_one_removal
  ON admin_player_audit(season_id, target_uid, action)
  WHERE action = 'player-removed';

-- Payment audit payloads carry a stable eventKey derived from Firestore's
-- canonical entryFeeUpdatedAt. Rows created before eventKey was introduced are
-- intentionally outside this partial index.
DELETE FROM admin_player_audit
WHERE CASE
    WHEN json_valid(detail_json) THEN json_type(detail_json, '$.eventKey') = 'text'
    ELSE 0
  END
  AND id NOT IN (
    SELECT MIN(id)
    FROM admin_player_audit
    WHERE CASE
        WHEN json_valid(detail_json) THEN json_type(detail_json, '$.eventKey') = 'text'
        ELSE 0
      END
    GROUP BY json_extract(detail_json, '$.eventKey')
  );

CREATE UNIQUE INDEX IF NOT EXISTS admin_player_audit_event_key
  ON admin_player_audit(
    CASE
      WHEN json_valid(detail_json) THEN json_extract(detail_json, '$.eventKey')
      ELSE NULL
    END
  )
  WHERE CASE
    WHEN json_valid(detail_json) THEN json_type(detail_json, '$.eventKey') = 'text'
    ELSE 0
  END;
