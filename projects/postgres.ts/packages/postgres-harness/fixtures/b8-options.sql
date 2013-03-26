CREATE DATABASE b8_fixture_opts WITH TEMPLATE = template0 CONNECTION LIMIT = 5 ALLOW_CONNECTIONS = true;
SELECT datname, datallowconn, datconnlimit FROM pg_database WHERE datname = 'b8_fixture_opts';
SELECT has_database_privilege('pg_database_owner', 'b8_fixture_opts', 'CONNECT') AS public_connect,
       has_database_privilege('pg_database_owner', 'b8_fixture_opts', 'TEMP') AS public_temp;
DROP DATABASE b8_fixture_opts;
