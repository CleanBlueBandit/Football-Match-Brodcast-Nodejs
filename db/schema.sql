-- Run this once against your PostgreSQL database, e.g.:
--   psql "$DATABASE_URL" -f db/schema.sql

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(100) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_logs (
    id          SERIAL PRIMARY KEY,
    logged_at   TIMESTAMPTZ DEFAULT now(),
    ip          VARCHAR(64),
    port        VARCHAR(16),
    protocol    VARCHAR(32),
    method      VARCHAR(16),
    uri         TEXT,
    referer     TEXT,
    user_agent  TEXT,
    lang        VARCHAR(255),
    query_data  JSONB,
    body_keys   TEXT
);

CREATE TABLE IF NOT EXISTS login_events (
    id         SERIAL PRIMARY KEY,
    logged_at  TIMESTAMPTZ DEFAULT now(),
    username   VARCHAR(100),
    success    BOOLEAN,
    message    TEXT,
    ip         VARCHAR(64)
);

-- Single-row table holding the live match/broadcast state as JSON.
-- Replaces the old save_state.php -> state.json file.
CREATE TABLE IF NOT EXISTS app_state (
    id         SMALLINT PRIMARY KEY DEFAULT 1,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT single_row CHECK (id = 1)
);

-- Session store table required by connect-pg-simple
CREATE TABLE IF NOT EXISTS "session" (
    "sid"    varchar NOT NULL COLLATE "default",
    "sess"   json    NOT NULL,
    "expire" timestamp(6) NOT NULL
);

ALTER TABLE "session"
    DROP CONSTRAINT IF EXISTS "session_pkey";
ALTER TABLE "session"
    ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
