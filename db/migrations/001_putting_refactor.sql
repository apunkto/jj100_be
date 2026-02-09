-- Migration: Replace final_game + final_game_attempt with final_game_state + participant last_level/last_result
-- Run on existing DBs that have final_game/final_game_attempt. New installs use init.sql.

-- 1. Add last_level, last_result to final_game_participant
ALTER TABLE final_game_participant
  ADD COLUMN IF NOT EXISTS last_level int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_result text;

-- 2. Create final_game_state
CREATE TABLE IF NOT EXISTS final_game_state (
  id                                   bigserial PRIMARY KEY,
  metrix_competition_id                bigint NOT NULL REFERENCES metrix_competition(id),
  status                               text NOT NULL DEFAULT 'not_started',
  current_level                        int NOT NULL DEFAULT 1,
  current_turn_final_game_participant_id bigint REFERENCES final_game_participant(id),
  winner_final_game_participant_id     bigint REFERENCES final_game_participant(id),
  started_at                           timestamptz,
  finished_at                          timestamptz,
  updated_at                           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (metrix_competition_id)
);
CREATE INDEX IF NOT EXISTS final_game_state_competition_idx ON final_game_state(metrix_competition_id);

-- 3. Backfill final_game_state from final_game (if exists)
INSERT INTO final_game_state (
  metrix_competition_id,
  status,
  current_level,
  current_turn_final_game_participant_id,
  winner_final_game_participant_id,
  started_at,
  finished_at,
  updated_at
)
SELECT
  metrix_competition_id,
  status,
  current_level,
  current_turn_final_game_id,
  winner_final_game_id,
  started_at,
  finished_at,
  updated_at
FROM final_game
ON CONFLICT (metrix_competition_id) DO NOTHING;

-- 4. Drop old tables
DROP TABLE IF EXISTS final_game_attempt;
DROP TABLE IF EXISTS final_game;
