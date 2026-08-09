-- Runs once, on first initialization of the Postgres volume.
-- `npm test` truncates this database on every run, so it must never be the
-- same database as DATABASE_URL.
CREATE DATABASE cia_test OWNER cia;
