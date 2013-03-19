CREATE TABLE b4_dept (id int PRIMARY KEY, name text);
CREATE TABLE b4_emp (id int PRIMARY KEY, name text, dept int, salary int, mgr int);
INSERT INTO b4_dept VALUES (1, 'sales'), (2, 'eng'), (3, 'hr');
INSERT INTO b4_emp VALUES (1, 'ann', 1, 100, NULL), (2, 'bob', 1, 80, 1), (3, 'cid', 2, 120, 1), (4, 'dan', 2, 90, 3), (5, 'eve', NULL, 70, 2);
