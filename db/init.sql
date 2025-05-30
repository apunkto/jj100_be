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