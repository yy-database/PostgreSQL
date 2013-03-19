CREATE TABLE b3_num (id serial PRIMARY KEY, amount numeric(10,2), qty numeric(5));
INSERT INTO b3_num (amount, qty) VALUES (1.5, 2), ('-0.005', 999.995);
CREATE INDEX b3_num_amount_idx ON b3_num (amount);
CREATE UNIQUE INDEX b3_num_qty_uniq ON b3_num (qty);
CREATE INDEX b3_num_partial ON b3_num (amount) WHERE amount IS NOT NULL;

CREATE TABLE b3_ck (id int PRIMARY KEY, v int CHECK (v > 0), w int, CONSTRAINT ck_w CHECK (w < v));
INSERT INTO b3_ck VALUES (1, 5, 4);
ALTER TABLE b3_ck ADD CONSTRAINT ck_nv CHECK (v < 100) NOT VALID;

CREATE TABLE b3_p (id int PRIMARY KEY, name text);
CREATE TABLE b3_cascade (id int PRIMARY KEY, pid int REFERENCES b3_p(id) ON DELETE CASCADE);
CREATE TABLE b3_setnull (id int PRIMARY KEY, pid int REFERENCES b3_p(id) ON DELETE SET NULL);
CREATE TABLE b3_restrict (id int PRIMARY KEY, pid int REFERENCES b3_p(id) ON DELETE RESTRICT);
INSERT INTO b3_p VALUES (1,'a'),(2,'b');
