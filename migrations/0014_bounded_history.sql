-- A seek in each retained UTC day can skip expired history without assuming
-- that server timestamps always increase in message ID order.
CREATE INDEX messages_room_day ON messages(room_id, created_at/86400, id);
CREATE INDEX messages_sender_recent ON messages(participant_id, id);
CREATE INDEX messages_relayed_for ON messages(relayed_for) WHERE relayed_for IS NOT NULL;
CREATE INDEX question_targets_seat ON question_targets(participant_id);
CREATE INDEX participants_room_id ON participants(room_id, id);
CREATE INDEX rate_auth_cleanup ON rate_hits(window_start) WHERE bucket IN ('auth_fail','auth_fail_day');
CREATE INDEX spaces_source_cleanup ON spaces(created_at) WHERE created_ip_hash IS NOT NULL;

ALTER TABLE participants ADD COLUMN scan_next_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE participants ADD COLUMN scan_next_rev INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER clear_history_scan_on_reissue AFTER UPDATE OF key_hash ON participants
WHEN OLD.key_hash<>NEW.key_hash AND NEW.scan_next_id<>0 BEGIN
  UPDATE participants SET scan_next_id=0 WHERE id=NEW.id;
END;

ALTER TABLE question_targets ADD COLUMN preceding_reply_id INTEGER;
UPDATE question_targets AS t SET preceding_reply_id=(SELECT prior.reply_id FROM question_targets prior
  WHERE prior.question_id=t.question_id AND prior.step=t.step-1)
WHERE step>1 AND reply_id IS NULL;
CREATE INDEX question_targets_ready ON question_targets(participant_id, question_id)
  WHERE reply_id IS NULL AND preceding_reply_id IS NOT NULL;

CREATE TRIGGER index_relay_turn AFTER UPDATE OF reply_id ON question_targets
WHEN NEW.step IS NOT NULL AND NEW.reply_id IS NOT OLD.reply_id
BEGIN
  UPDATE question_targets SET preceding_reply_id=NEW.reply_id
  WHERE question_id=NEW.question_id AND step=NEW.step+1;
  UPDATE question_targets SET preceding_reply_id=(SELECT prior.reply_id FROM question_targets prior
    WHERE prior.question_id=NEW.question_id AND prior.step=NEW.step-1)
  WHERE question_id=NEW.question_id AND step=NEW.step AND NEW.step>1 AND NEW.reply_id IS NULL;
END;

-- A reply refers to the question itself or to one indexed preceding reply.
DROP TRIGGER track_question_message;
CREATE TRIGGER track_question_message AFTER INSERT ON messages
WHEN NEW.question_route IS NOT NULL OR NEW.reply_to IS NOT NULL
BEGIN
  INSERT INTO question_targets(question_id, participant_id, step)
  SELECT NEW.id, p.id, json_extract(target.value, '$.step')
  FROM json_each(NEW.question_route) target
  JOIN participants p ON p.id=json_extract(target.value, '$.id')
  WHERE p.room_id=NEW.room_id AND p.kind='assistant' AND p.revoked=0;

  UPDATE question_targets SET reply_id=NEW.id,preceding_reply_id=NULL
  WHERE participant_id=COALESCE(NEW.relayed_for, NEW.participant_id) AND reply_id IS NULL
    AND question_id IN (SELECT NEW.reply_to UNION SELECT question_id FROM question_targets WHERE reply_id=NEW.reply_to)
    AND (question_id=NEW.reply_to OR (step>1 AND NEW.reply_to=preceding_reply_id))
    AND EXISTS (SELECT 1 FROM messages q
      WHERE q.id=question_targets.question_id AND q.room_id=NEW.room_id AND q.created_at<=NEW.created_at)
    AND NOT EXISTS (SELECT 1 FROM question_targets prior
      WHERE prior.question_id=question_targets.question_id AND prior.step<question_targets.step AND prior.reply_id IS NULL);
END;
