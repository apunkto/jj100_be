create table player
(
    id   bigserial    NOT NULL PRIMARY KEY,
    name varchar(255) not null
);

create table ctp_results
(
    id          bigserial NOT NULL PRIMARY KEY,
    hole        numeric   not null,
    distance_cm numeric   not null,
    player_id   bigint
);

ALTER TABLE "ctp_results"
    ADD FOREIGN KEY ("player_id") REFERENCES "player" ("id");

ALTER TABLE ctp_results
    ADD COLUMN created_date timestamptz NOT NULL DEFAULT now();

CREATE TABLE lottery_checkin
(
    id           bigserial   NOT NULL PRIMARY KEY,
    player_id    bigint      NOT NULL REFERENCES player (id) ON DELETE CASCADE,
    created_date timestamptz NOT NULL DEFAULT now(),
    UNIQUE (player_id) -- prevent duplicate check-ins
);

CREATE TABLE hole
(
    id     bigserial NOT NULL PRIMARY KEY,
    number int,
    is_ctp boolean   NOT NULL default false,
    UNIQUE (number)
);

alter table ctp_results
    add column hole_id bigint;

alter table ctp_results
    add constraint fk_hole
        foreign key (hole_id) references hole (id);

alter table ctp_results
    drop column hole;

-- Config table removed - functionality moved to metrix_competition table

alter table lottery_checkin
    add column prize_won boolean default false;

alter table lottery_checkin
    add column final_game boolean default false;

alter table lottery_checkin
    add column final_game_order int;

alter table hole
    add column length int;

alter table hole
    add column coordinates varchar(255);

CREATE TABLE feedback
(
    id       bigserial NOT NULL PRIMARY KEY,
    score    int,
    feedback text
);

alter table feedback
    add column created_date timestamptz NOT NULL DEFAULT now();

alter table hole
    add column
        eagles int default 0;

alter table hole
    add column
        birdies int default 0;

alter table hole
    add column
        pars int default 0;

alter table hole
    add column
        bogeys int default 0;

alter table hole
    add column
        double_bogeys int default 0;

alter table hole
    add column
        others int default 0;

alter table hole
    add column
        average_diff numeric default 0;

alter table hole
    add column
        rank int default 0;

alter table hole
    add column
        ob_percent numeric default 0;

create table metrix_result
(
    id             bigserial   NOT NULL PRIMARY KEY,
    competition_id bigint      NOT NULL,
    data           jsonb       not null,
    created_date   timestamptz NOT NULL DEFAULT now()
);


create index if not exists metrix_result_competition_id_idx
    on metrix_result (competition_id);

alter table metrix_result
    add constraint metrix_result_competition_id_unique unique (competition_id);

delete
from player;

alter table player
    add column email          varchar(255) not null,
    add column metrix_user_id bigint       not null;

create unique index player_email_uidx on player (email);
create unique index player_metrix_user_id_uidx on player (metrix_user_id);

ALTER TABLE ctp_results
    ALTER COLUMN player_id SET NOT NULL,
    ALTER COLUMN hole_id SET NOT NULL;

-- Uniqueness: one result per player per hole
ALTER TABLE ctp_results
    ADD CONSTRAINT ctp_results_unique_player_hole UNIQUE (hole_id, player_id);


create table player_participation
(
    id             bigserial NOT NULL PRIMARY KEY,
    metrix_user_id bigint    NOT NULL,
    year           int       NOT NULL,
    rank           int       NOT NULL,
    score          int       NOT null,
    player_name    text      not NULL
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS pp_user_year_idx
    ON player_participation (metrix_user_id, year);

CREATE OR REPLACE VIEW participation_leaderboard AS
WITH latest_year AS (SELECT metrix_user_id, MAX(year) AS max_year
                     FROM player_participation
                     GROUP BY metrix_user_id),
     last_name AS (SELECT DISTINCT ON (p.metrix_user_id) p.metrix_user_id,
                                                         p.player_name
                   FROM player_participation p
                            JOIN latest_year ly
                                 ON ly.metrix_user_id = p.metrix_user_id
                                     AND ly.max_year = p.year
                   ORDER BY p.metrix_user_id, p.id DESC)
SELECT p.metrix_user_id,
       ln.player_name,
       COUNT(DISTINCT p.year) AS participation_years
FROM player_participation p
         JOIN last_name ln
              ON ln.metrix_user_id = p.metrix_user_id
GROUP BY p.metrix_user_id, ln.player_name
ORDER BY participation_years DESC, p.metrix_user_id;

ALTER TABLE hole
    ADD COLUMN rules text;

ALTER TABLE hole
    ADD COLUMN par numeric;

ALTER TABLE hole
    ADD COLUMN is_food boolean NOT NULL DEFAULT false;

-- 2025-02-03: metrix_competition registry for scheduled sync (waiting | started | finished)
create table metrix_competition
(
    id                    bigserial   NOT NULL PRIMARY KEY,
    metrix_competition_id bigint      NOT NULL,
    name                  text,       -- competition name (e.g. from Metrix)
    status                varchar(20) NOT NULL DEFAULT 'waiting', -- waiting | started | finished
    last_synced_at        timestamptz,
    created_date          timestamptz NOT NULL DEFAULT now()
);
create unique index metrix_competition_metrix_id_uidx on metrix_competition (metrix_competition_id);
create index metrix_competition_status_idx on metrix_competition (status);

alter table metrix_competition
    add column competition_date date;

-- 2025-02-04: Add ctp_enabled and checkin_enabled flags to metrix_competition
alter table metrix_competition
    add column ctp_enabled boolean NOT NULL DEFAULT false,
    add column checkin_enabled boolean NOT NULL DEFAULT false;

-- 2025-02-03: metrix_player_result normalized per-player cache (replaces loading full json from metrix_result)
create table metrix_player_result
(
    id             bigserial   NOT NULL PRIMARY KEY,
    competition_id bigint      NOT NULL, -- metrix_competition_id
    user_id        varchar(32) NOT NULL, -- metrix UserID
    name           text,
    class_name     text,
    order_number   int,
    diff           int,
    sum            int,
    dnf            boolean     NOT NULL DEFAULT false,
    start_group    int,        -- player Group (avoid reserved "group")
    player_results jsonb,     -- this player's hole results only
    created_date   timestamptz NOT NULL DEFAULT now(),
    updated_date   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (competition_id, user_id)
);
create index metrix_player_result_competition_user_idx on metrix_player_result (competition_id, user_id);

-- 2025-02-03: per-user active competition (our metrix_competition.id)
alter table player add column active_competition_id bigint references metrix_competition(id);
create index player_active_competition_id_idx on player(active_competition_id);

-- 2025-02-03: holes per competition
ALTER TABLE hole ADD COLUMN metrix_competition_id bigint;
ALTER TABLE hole ADD COLUMN card_img varchar(255);

-- Backfill existing rows (requires at least one metrix_competition)
UPDATE hole SET metrix_competition_id = (SELECT id FROM metrix_competition ORDER BY id LIMIT 1)
WHERE metrix_competition_id IS NULL;

-- Set NOT NULL after backfill
ALTER TABLE hole ALTER COLUMN metrix_competition_id SET NOT NULL;

-- Add FK and unique constraint
ALTER TABLE hole ADD CONSTRAINT hole_metrix_competition_id_fk
  FOREIGN KEY (metrix_competition_id) REFERENCES metrix_competition(id);

-- Replace unique constraint: (number) -> (metrix_competition_id, number)
ALTER TABLE hole DROP CONSTRAINT IF EXISTS hole_number_key;
ALTER TABLE hole ADD CONSTRAINT hole_competition_number_unique UNIQUE (metrix_competition_id, number);

-- 2025-02-04: Add metrix_competition_id to lottery_checkin table
-- Delete all existing check-in data to allow NOT NULL constraint
DELETE FROM lottery_checkin;

-- Drop the old unique constraint on player_id
ALTER TABLE lottery_checkin DROP CONSTRAINT IF EXISTS lottery_checkin_player_id_key;

-- Add metrix_competition_id column (references metrix_competition.id, the internal ID)
ALTER TABLE lottery_checkin ADD COLUMN metrix_competition_id bigint;

-- Set NOT NULL after data deletion
ALTER TABLE lottery_checkin ALTER COLUMN metrix_competition_id SET NOT NULL;

-- Add foreign key constraint
ALTER TABLE lottery_checkin ADD CONSTRAINT lottery_checkin_metrix_competition_id_fk
  FOREIGN KEY (metrix_competition_id) REFERENCES metrix_competition(id);

-- Add unique constraint: one check-in per player per competition
ALTER TABLE lottery_checkin ADD CONSTRAINT lottery_checkin_player_competition_unique 
  UNIQUE (player_id, metrix_competition_id);

-- 2025-02-04: Refactor metrix_player_result to use metrix_competition.id instead of metrix_competition_id
-- Add new column metrix_competition_id (references metrix_competition.id)
ALTER TABLE metrix_player_result ADD COLUMN metrix_competition_id bigint;

-- Fill the new column with data from metrix_competition table
UPDATE metrix_player_result mpr
SET metrix_competition_id = mc.id
FROM metrix_competition mc
WHERE mc.metrix_competition_id = mpr.competition_id;

-- Drop old unique constraint and index
ALTER TABLE metrix_player_result DROP CONSTRAINT IF EXISTS metrix_player_result_competition_id_user_id_key;
DROP INDEX IF EXISTS metrix_player_result_competition_user_idx;

-- Drop old competition_id column
ALTER TABLE metrix_player_result DROP COLUMN competition_id;

-- Make new column NOT NULL
ALTER TABLE metrix_player_result ALTER COLUMN metrix_competition_id SET NOT NULL;

-- Add foreign key constraint
ALTER TABLE metrix_player_result ADD CONSTRAINT metrix_player_result_metrix_competition_id_fk
  FOREIGN KEY (metrix_competition_id) REFERENCES metrix_competition(id);

-- Add new unique constraint and index
ALTER TABLE metrix_player_result ADD CONSTRAINT metrix_player_result_competition_user_unique
  UNIQUE (metrix_competition_id, user_id);
CREATE INDEX metrix_player_result_competition_user_idx ON metrix_player_result (metrix_competition_id, user_id);

-- 2025-02-04: Add is_admin column to player table
ALTER TABLE player ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- 2025-02-06: Add prediction_enabled flag to metrix_competition
alter table metrix_competition
    add column prediction_enabled boolean NOT NULL DEFAULT false;

-- 2025-02-06: Create predictions table
create table predictions
(
    id                    bigserial   NOT NULL PRIMARY KEY,
    metrix_competition_id bigint      NOT NULL REFERENCES metrix_competition(id),
    player_id             bigint      NOT NULL REFERENCES player(id),
    best_overall_score    int,
    best_female_score     int,
    will_rain             boolean,
    player_own_score      int,
    hole_in_ones_count   int,
    water_discs_count    int,
    created_date          timestamptz NOT NULL DEFAULT now(),
    updated_date          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (metrix_competition_id, player_id)
);
create index predictions_competition_id_idx on predictions (metrix_competition_id);

-- 2025-02-06: Add indexes for prediction scoring queries on metrix_player_result
-- Index for best_overall_score query (metrix_competition_id, dnf, diff)
create index if not exists metrix_player_result_competition_dnf_diff_idx 
    on metrix_player_result (metrix_competition_id, dnf, diff) 
    where dnf = false and diff is not null;

-- Index for best_female_score query (metrix_competition_id, class_name, dnf, diff)
create index if not exists metrix_player_result_competition_class_dnf_diff_idx 
    on metrix_player_result (metrix_competition_id, class_name, dnf, diff) 
    where dnf = false and diff is not null;

-- 2025-02-06: Add precomputed prediction results tables for fast reads
-- Table for shared actual results per competition
create table prediction_actual_results (
    metrix_competition_id bigint NOT NULL PRIMARY KEY REFERENCES metrix_competition(id),
    best_overall_score int,
    best_female_score int,
    will_rain boolean,
    hole_in_ones_count int,
    water_discs_count int,
    updated_at timestamptz NOT NULL DEFAULT now()
);
create index prediction_actual_results_updated_at_idx on prediction_actual_results(updated_at);

-- Table for precomputed scores per prediction
create table prediction_scores (
    id bigserial NOT NULL PRIMARY KEY,
    metrix_competition_id bigint NOT NULL REFERENCES metrix_competition(id),
    player_id bigint NOT NULL REFERENCES player(id),
    -- Actual results (denormalized for this player)
    player_own_score int,
    -- Precomputed field scores
    best_overall_score_points int NOT NULL DEFAULT 0,
    best_female_score_points int NOT NULL DEFAULT 0,
    player_own_score_points int NOT NULL DEFAULT 0,
    will_rain_points int NOT NULL DEFAULT 0,
    hole_in_ones_count_points int NOT NULL DEFAULT 0,
    water_discs_count_points int NOT NULL DEFAULT 0,
    -- Total score and rank
    total_score int NOT NULL DEFAULT 0,
    rank int,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (metrix_competition_id, player_id)
);
create index prediction_scores_competition_score_idx on prediction_scores(metrix_competition_id, total_score DESC);
create index prediction_scores_competition_player_idx on prediction_scores(metrix_competition_id, player_id);

-- 2025-02-06: Add HIO and water throwers tracking to hole table
alter table hole add column hio_count integer NOT NULL DEFAULT 0;
alter table hole add column is_water_hole boolean NOT NULL DEFAULT false;
alter table hole add column players_with_pen integer NOT NULL DEFAULT 0;

-- 2025-02-06: Add water_holes_with_pen to metrix_player_result for precomputed water throwers count
alter table metrix_player_result add column water_holes_with_pen integer NOT NULL DEFAULT 0;

-- 2025-02-06: Add did_rain flag to metrix_competition
alter table metrix_competition
    add column did_rain boolean NOT NULL DEFAULT false;