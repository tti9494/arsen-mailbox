ALTER TABLE rooms ADD COLUMN image_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE message_images (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL CHECK(length(owner_id)>0),
  mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 1000000),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 4096),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 4096),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  data BLOB NOT NULL CHECK(length(data)=bytes),
  created_at INTEGER NOT NULL
);
CREATE INDEX message_images_room ON message_images(room_id);
CREATE TABLE image_storage (
  owner_id TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL CHECK(bytes>=0)
);

CREATE TRIGGER image_added AFTER INSERT ON message_images BEGIN
  INSERT OR IGNORE INTO image_storage(owner_id,bytes) VALUES(NEW.owner_id,0),('',0);
  UPDATE image_storage SET bytes=bytes+NEW.bytes WHERE owner_id IN (NEW.owner_id,'');
END;
CREATE TRIGGER image_removed AFTER DELETE ON message_images BEGIN
  UPDATE rooms SET image_revision=image_revision+1 WHERE id=OLD.room_id;
  UPDATE image_storage SET bytes=bytes-OLD.bytes WHERE owner_id IN (OLD.owner_id,'');
  DELETE FROM image_storage WHERE owner_id IN (OLD.owner_id,'') AND bytes=0;
END;

CREATE TABLE image_assertion (
  failure TEXT NOT NULL,
  CONSTRAINT image_site_storage CHECK(failure!='site_storage'),
  CONSTRAINT image_space_storage CHECK(failure!='space_storage'),
  CONSTRAINT image_site_daily CHECK(failure!='site_daily'),
  CONSTRAINT image_space_daily CHECK(failure!='space_daily'),
  CONSTRAINT image_participant_minute CHECK(failure!='participant_minute')
);

-- Both current and rollback Workers must classify new human posts for R1.
ALTER TABLE messages ADD COLUMN human_origin INTEGER NOT NULL DEFAULT 0 CHECK(human_origin IN (0,1));
UPDATE messages SET human_origin=1
  WHERE relayed_for IS NULL AND participant_id IN (SELECT id FROM participants WHERE kind='human');
CREATE INDEX messages_room_human_id ON messages(room_id,id DESC) WHERE human_origin=1;
CREATE TRIGGER message_human_origin AFTER INSERT ON messages
  WHEN NEW.relayed_for IS NULL AND (SELECT kind FROM participants WHERE id=NEW.participant_id)='human'
BEGIN
  UPDATE messages SET human_origin=1 WHERE id=NEW.id;
END;
