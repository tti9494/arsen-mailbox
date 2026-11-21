ALTER TABLE participants ADD COLUMN read_guard_at INTEGER;
CREATE TABLE capacity_assertion (
  failure TEXT NOT NULL CONSTRAINT capacity_daily_quota CHECK(failure!='daily_capacity')
    CONSTRAINT capacity_space_daily_quota CHECK(failure!='space_daily_capacity')
    CONSTRAINT capacity_space_operation_quota CHECK(failure!='space_operation_capacity')
);
ALTER TABLE participants ADD COLUMN read_minute INTEGER NOT NULL DEFAULT 0;
ALTER TABLE participants ADD COLUMN read_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE participants ADD COLUMN ticket_generation INTEGER NOT NULL DEFAULT 0;
UPDATE participants
SET read_guard_at = last_read_at,
    read_minute = unixepoch()/60*60,
    read_count = COALESCE((SELECT count FROM rate_hits
      WHERE bucket='read' AND subject=participants.id AND window_start=unixepoch()/60*60),0)
WHERE last_read_at IS NOT NULL OR EXISTS(SELECT 1 FROM rate_hits
  WHERE bucket='read' AND subject=participants.id AND window_start=unixepoch()/60*60);

DROP TRIGGER participant_reissued;
CREATE TRIGGER participant_reissued AFTER UPDATE OF key_hash ON participants
WHEN NEW.key_hash != OLD.key_hash AND NEW.revoked=0 BEGIN
  UPDATE participants SET issued_at_message_id=COALESCE((SELECT MAX(id) FROM messages WHERE room_id=NEW.room_id),0),
    first_read_at=NULL,last_read_at=NULL,read_guard_at=NULL,cooldown_armed=0 WHERE id=NEW.id;
END;

ALTER TABLE spaces ADD COLUMN request_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spaces ADD COLUMN request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spaces ADD COLUMN request_minute INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spaces ADD COLUMN request_minute_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spaces ADD COLUMN request_write_estimate INTEGER NOT NULL DEFAULT 0;
UPDATE spaces
SET request_day=unixepoch()/86400*86400,
    request_count=COALESCE((SELECT count FROM rate_hits
      WHERE bucket='space_day' AND subject=spaces.id AND window_start=unixepoch()/86400*86400),0),
    request_minute=unixepoch()/60*60,
    request_minute_count=COALESCE((SELECT count FROM rate_hits
      WHERE bucket='space' AND subject=spaces.id AND window_start=unixepoch()/60*60),0)
WHERE EXISTS(SELECT 1 FROM rate_hits WHERE subject=spaces.id AND
  ((bucket='space_day' AND window_start=unixepoch()/86400*86400) OR
   (bucket='space' AND window_start=unixepoch()/60*60)));

-- The active-day lookup avoids scanning inactive spaces. Stable-day writes leave this index untouched.
CREATE INDEX spaces_request_day ON spaces(request_day);
