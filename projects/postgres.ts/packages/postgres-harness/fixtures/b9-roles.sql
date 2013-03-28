CREATE ROLE b9_fixture_alice LOGIN;
CREATE ROLE b9_fixture_bob NOLOGIN;
CREATE DATABASE b9_fixture_db OWNER b9_fixture_alice;
GRANT CONNECT, CREATE, TEMP ON DATABASE b9_fixture_db TO b9_fixture_bob;
GRANT USAGE, CREATE ON SCHEMA public TO b9_fixture_bob;
CREATE TABLE b9_fixture_t (id int, note text);
ALTER TABLE b9_fixture_t OWNER TO b9_fixture_alice;
GRANT SELECT, INSERT, UPDATE, DELETE ON b9_fixture_t TO b9_fixture_bob;
SELECT datname, datacl FROM pg_database WHERE datname = 'b9_fixture_db';
SELECT nspname, nspacl FROM pg_namespace WHERE nspname = 'public';
SELECT relname, relacl FROM pg_class WHERE relname = 'b9_fixture_t';
\du b9_fixture_*
\dn
\dp b9_fixture_*
\l b9_fixture_*
REVOKE SELECT ON b9_fixture_t FROM b9_fixture_bob;
SELECT relname, relacl FROM pg_class WHERE relname = 'b9_fixture_t';
REVOKE CONNECT ON DATABASE b9_fixture_db FROM PUBLIC;
SELECT datname, datacl FROM pg_database WHERE datname = 'b9_fixture_db';
REVOKE ALL ON SCHEMA public FROM b9_fixture_bob;
SELECT nspname, nspacl FROM pg_namespace WHERE nspname = 'public';
DROP TABLE b9_fixture_t;
DROP DATABASE b9_fixture_db;
DROP ROLE b9_fixture_bob;
DROP ROLE b9_fixture_alice;
