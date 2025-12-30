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
    data           jsonb        not null,
    created_date   timestamptz NOT NULL DEFAULT now()
);


create index if not exists metrix_result_competition_id_idx
    on metrix_result (competition_id);

alter table metrix_result
    add constraint metrix_result_competition_id_unique unique (competition_id);

delete from player;

alter table player
    add column email varchar(255) not null,
    add column metrix_user_id bigint not null;

create unique index player_email_uidx on player (email);
create unique index player_metrix_user_id_uidx on player (metrix_user_id);

ALTER TABLE ctp_results
    ALTER COLUMN player_id SET NOT NULL,
    ALTER COLUMN hole_id SET NOT NULL;

-- Uniqueness: one result per player per hole
ALTER TABLE ctp_results
    ADD CONSTRAINT ctp_results_unique_player_hole UNIQUE (hole_id, player_id);