\copy b5_copy (id, name, note) FROM STDIN
4	dave	plain
5	erin	\N
\.
SELECT 'after-copy' AS phase, count(*) AS n FROM b5_copy;
COPY b5_copy (id, name, note) FROM STDIN;
6	frank	esc\ttab
\.
SELECT 'after-server-copy' AS phase, count(*) AS n FROM b5_copy;
\copy b5_copy FROM STDIN CSV HEADER
id,name,note
12,"quoted,comma","say ""hi"""
13,empty,NA
\.
SELECT id, name, note FROM b5_copy WHERE id IN (12,13) ORDER BY id;
