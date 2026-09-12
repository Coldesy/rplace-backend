CREATE TABLE users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  banned BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE pixel_log (
  seq BIGINT PRIMARY KEY,
  placement_id UUID UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES users (id),
  x INT NOT NULL,
  y INT NOT NULL,
  color_index SMALLINT NOT NULL,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO users (id, display_name, banned) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice', false),
  ('22222222-2222-2222-2222-222222222222', 'bob', false),
  ('33333333-3333-3333-3333-333333333333', 'viewer', false);
