CREATE TEMP TABLE b5_err (id int, v text, w text);
COPY b5_err FROM STDIN;
1	a
\.
COPY b5_err FROM STDIN;
1	a	b	c
\.
COPY b5_err FROM STDIN;

\.
COPY b5_err FROM STDIN;
x	a	b
\.
COPY b5_err FROM STDIN WITH (HEADER);
id	v	w
2	ok	ok
\.
SELECT id, v, w FROM b5_err ORDER BY id;
