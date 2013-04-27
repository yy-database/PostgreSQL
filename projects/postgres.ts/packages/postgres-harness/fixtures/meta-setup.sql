-- Schema used by the system-catalog meta command fixtures.
-- The same file seeds the real PostgreSQL 16 oracle and the harness server,
-- so `\d`, `\dt`, `\di` and `\l` print identical text on both sides.
DROP TABLE IF EXISTS u CASCADE;
DROP TABLE IF EXISTS t CASCADE;
CREATE TABLE t (id int PRIMARY KEY, name varchar(20) NOT NULL, amount numeric(10,2), note text DEFAULT 'n');
CREATE UNIQUE INDEX t_name ON t (name);
CREATE INDEX t_amount ON t (amount);
CREATE TABLE u (id int, parent int REFERENCES t(id));
INSERT INTO t VALUES (1, 'one', 1.50, 'hello');
