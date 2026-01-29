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

CREATE TABLE config
(
    key   varchar(255) NOT NULL PRIMARY KEY,
    value text
);

--ctp_enabled
insert into config (key, value)
values ('ctp_enabled', 'false');

insert into config (key, value)
values ('checkin_enabled', 'false');

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