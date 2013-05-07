DROP TABLE IF EXISTS agg_t;
DROP TABLE IF EXISTS agg_e;
CREATE TABLE agg_t (g text, n int, b bigint, f float8, d date, flag bool);
CREATE TABLE agg_e (g text, n int);
INSERT INTO agg_t VALUES
    ('a', 1, 10, 1.5, '2024-01-01', true),
    ('a', 2, 20, 2.5, '2024-01-02', false),
    ('a', NULL, NULL, NULL, NULL, NULL),
    ('b', 5, 50, 5.0, '2024-02-01', true),
    ('b', -3, -30, -3.25, '2024-02-02', NULL),
    (NULL, 7, 70, 7.75, '2024-03-01', false);
SELECT count(*), count(n), count(distinct g) FROM agg_t;
SELECT sum(n), sum(b), sum(f) FROM agg_t;
SELECT avg(n), avg(b), avg(f) FROM agg_t;
SELECT min(n), max(n), min(d), max(d), min(g), max(g) FROM agg_t;
SELECT g, count(*), count(n), sum(n), avg(n) FROM agg_t GROUP BY g ORDER BY g NULLS LAST;
SELECT g, count(*) FROM agg_t GROUP BY g HAVING count(*) > 1 ORDER BY g NULLS LAST;
SELECT g, count(*) FROM agg_t GROUP BY 1 ORDER BY 1 NULLS LAST;
SELECT g || '!' AS u, count(*) FROM agg_t GROUP BY g || '!' ORDER BY u NULLS LAST;
SELECT g || '!' AS label, count(*) FROM agg_t GROUP BY label ORDER BY label NULLS LAST;
SELECT g AS label, count(*) FROM agg_t GROUP BY label ORDER BY label NULLS LAST;
SELECT g FROM agg_t GROUP BY g ORDER BY count(*) DESC, g NULLS LAST;
SELECT g, count(*) AS c FROM agg_t GROUP BY g ORDER BY c DESC, g NULLS LAST;
SELECT count(*), sum(n), avg(n) FROM agg_e;
SELECT g, count(*) FROM agg_e GROUP BY g;
SELECT count(distinct n), sum(distinct n), avg(distinct n) FROM agg_t;
SELECT string_agg(g, ',' ORDER BY g) FROM agg_t;
SELECT string_agg(DISTINCT g, ',') FROM agg_t;
SELECT array_agg(n) FROM agg_t;
SELECT array_agg(n ORDER BY n) FROM agg_t;
SELECT array_agg(DISTINCT n) FROM agg_t;
SELECT bool_and(flag), bool_or(flag), every(flag) FROM agg_t;
SELECT count(*) FILTER (WHERE n > 1), sum(n) FILTER (WHERE flag) FROM agg_t;
SELECT g, count(*) FILTER (WHERE n IS NOT NULL) FROM agg_t GROUP BY g ORDER BY g NULLS LAST;
SELECT g FROM agg_t GROUP BY 0;
SELECT g FROM agg_t GROUP BY 9;
SELECT g AS x, n AS x FROM agg_t GROUP BY x;
SELECT count(*) FROM agg_t GROUP BY count(*);
SELECT g, n, count(*) FROM agg_t GROUP BY g;
DROP TABLE IF EXISTS agg_emp;
DROP TABLE IF EXISTS agg_dept;
CREATE TABLE agg_dept (id int, name text);
CREATE TABLE agg_emp (id int, dept_id int, salary int);
INSERT INTO agg_dept VALUES (1, 'eng'), (2, 'db'), (3, 'empty');
INSERT INTO agg_emp VALUES (1, 1, 100), (2, 1, 120), (3, 2, 90), (4, 2, 60), (5, NULL, 50);
SELECT d.name, count(e.id), sum(e.salary) FROM agg_dept d LEFT JOIN agg_emp e ON e.dept_id = d.id GROUP BY d.name ORDER BY d.name;
SELECT d.name, count(e.id) FROM agg_dept d LEFT JOIN agg_emp e ON e.dept_id = d.id GROUP BY d.name HAVING count(e.id) = 0 ORDER BY d.name;
SELECT d.name, sum(e.salary) FROM agg_dept d JOIN agg_emp e ON e.dept_id = d.id GROUP BY d.name HAVING sum(e.salary) > 150 ORDER BY d.name;
