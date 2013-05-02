CREATE TABLE tx_vis (id int, v text);
INSERT INTO tx_vis VALUES (1, 'seed');
BEGIN;
SELECT count(*) FROM tx_vis;
\! {{PSQL}} -X -q -h 127.0.0.1 -p {{PORT}} -U postgres -d {{DB}} -c "INSERT INTO tx_vis VALUES (2, 'rc')" > NUL 2>&1
SELECT count(*) FROM tx_vis;
UPDATE tx_vis SET v = 'rc-update' WHERE id = 1;
SELECT v FROM tx_vis WHERE id = 2;
COMMIT;
SELECT count(*) FROM tx_vis;
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT count(*) FROM tx_vis;
\! {{PSQL}} -X -q -h 127.0.0.1 -p {{PORT}} -U postgres -d {{DB}} -c "INSERT INTO tx_vis VALUES (3, 'rr')" > NUL 2>&1
SELECT count(*) FROM tx_vis;
SELECT count(*) FROM tx_vis WHERE id = 3;
COMMIT;
SELECT count(*) FROM tx_vis;
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT v FROM tx_vis WHERE id = 1;
\! {{PSQL}} -X -q -h 127.0.0.1 -p {{PORT}} -U postgres -d {{DB}} -c "UPDATE tx_vis SET v = 'rr-other' WHERE id = 1" > NUL 2>&1
UPDATE tx_vis SET v = 'rr-mine' WHERE id = 1;
ROLLBACK;
SELECT v FROM tx_vis WHERE id = 1;
BEGIN;
SELECT v FROM tx_vis WHERE id = 1;
\! {{PSQL}} -X -q -h 127.0.0.1 -p {{PORT}} -U postgres -d {{DB}} -c "UPDATE tx_vis SET v = 'rc-other' WHERE id = 1" > NUL 2>&1
UPDATE tx_vis SET v = 'rc-mine' WHERE id = 1;
SELECT v FROM tx_vis WHERE id = 1;
COMMIT;
SELECT v FROM tx_vis WHERE id = 1;
BEGIN ISOLATION LEVEL REPEATABLE READ;
\! {{PSQL}} -X -q -h 127.0.0.1 -p {{PORT}} -U postgres -d {{DB}} -c "INSERT INTO tx_vis VALUES (4, 'lazy')" > NUL 2>&1
SELECT count(*) FROM tx_vis WHERE id = 4;
COMMIT;
SELECT count(*) FROM tx_vis;
