ALTER TABLE spaces ADD COLUMN daily_post_limit INTEGER NOT NULL DEFAULT 500
  CHECK(typeof(daily_post_limit)='integer' AND daily_post_limit BETWEEN 1 AND 600);

CREATE TABLE space_post_assertion (
  failure TEXT NOT NULL CONSTRAINT space_post_quota CHECK(failure!='quota')
);
