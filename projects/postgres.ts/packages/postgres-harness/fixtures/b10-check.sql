CREATE TABLE b10_ck (id int PRIMARY KEY, v int CHECK (v > 0), w int, CONSTRAINT ck_w CHECK (w < v));
INSERT INTO b10_ck VALUES (1, 5, 4);
ALTER TABLE b10_ck ADD CONSTRAINT ck_nv CHECK (v < 100) NOT VALID;
\d b10_ck
INSERT INTO b10_ck VALUES (2, -1, 0);
INSERT INTO b10_ck VALUES (3, 150, 10);
INSERT INTO b10_ck VALUES (4, 5, 6);
INSERT INTO b10_ck VALUES (5, NULL, 1);
SELECT conname, contype, convalidated, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = (SELECT oid FROM pg_class WHERE relname = 'b10_ck') ORDER BY conname;
ALTER TABLE b10_ck VALIDATE CONSTRAINT ck_nv;
\d b10_ck
