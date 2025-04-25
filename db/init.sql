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
    id   bigserial    NOT NULL PRIMARY KEY,
    player_id    uuid        NOT NULL REFERENCES player (id) ON DELETE CASCADE,
    created_date timestamptz NOT NULL DEFAULT now(),
    UNIQUE (player_id) -- prevent duplicate check-ins
);