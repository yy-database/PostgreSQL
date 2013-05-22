CREATE TABLE ord_t (id int PRIMARY KEY, val int, note text);
INSERT INTO ord_t VALUES (1, 5, 'a'), (2, 7, 'b'), (3, 5, 'c'), (4, NULL, 'd'), (5, 7, 'e'), (6, 1, 'f'), (7, NULL, 'g');
CREATE INDEX ord_t_val_idx ON ord_t (val DESC, id);
-- 键序与索引一致：降序默认 NULLS FIRST，第二键 id 升序。
SELECT id, val FROM ord_t ORDER BY val DESC, id LIMIT 3;
SELECT id, val FROM ord_t ORDER BY val DESC, id LIMIT 4;
SELECT id, val FROM ord_t ORDER BY val DESC, id LIMIT 3 OFFSET 3;
SELECT id, val FROM ord_t ORDER BY val DESC, id LIMIT 0;
SELECT id, val FROM ord_t ORDER BY val DESC, id;
-- NULLS LAST 与索引的 NULL 位置不符，必须退回排序。
SELECT id, val FROM ord_t ORDER BY val DESC NULLS LAST, id LIMIT 3;
-- 方向与索引相反，同样退回排序。
SELECT id, val FROM ord_t ORDER BY val ASC, id LIMIT 3;
-- note 上没有索引，只能排序。
SELECT id, note FROM ord_t ORDER BY note LIMIT 4;
-- OFFSET 超过前列行数，只取剩余两行。
SELECT id, val FROM ord_t ORDER BY val DESC, id LIMIT 2 OFFSET 5;
-- 带 WHERE 时不走有序索引扫描，但结果仍需按序。
SELECT id, val FROM ord_t WHERE val > 4 ORDER BY val DESC, id LIMIT 2;
