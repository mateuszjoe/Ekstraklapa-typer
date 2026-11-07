-- Apply before deploying the Worker that synchronizes administrative corrections.
-- Existing picks keep their millisecond verified_at; canonical versions are
-- populated on the next successful verification against Firestore.
ALTER TABLE picks ADD COLUMN firestore_updated_at TEXT NOT NULL DEFAULT '';
