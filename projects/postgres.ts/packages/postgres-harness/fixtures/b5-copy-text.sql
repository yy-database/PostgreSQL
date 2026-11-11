CREATE TEMP TABLE b5_text (id int, note text);
COPY b5_text FROM STDIN;
1	\N
2	
3	abc
\.
SELECT id, note IS NULL AS isnull, coalesce(note, '<null>') AS note FROM b5_text ORDER BY id;
COPY b5_text TO STDOUT;
COPY b5_text TO STDOUT WITH (FORMAT text, HEADER, DELIMITER '|');
CREATE TEMP TABLE b5_text_delim (id int, v text);
COPY b5_text_delim FROM STDIN WITH (DELIMITER '|', NULL 'NA');
1|a\|b
2|x\\y
3|NA
4|\N
\.
SELECT id, v IS NULL AS isnull, coalesce(v, '<null>') AS v FROM b5_text_delim ORDER BY id;
COPY b5_text_delim TO STDOUT WITH (DELIMITER '|');
