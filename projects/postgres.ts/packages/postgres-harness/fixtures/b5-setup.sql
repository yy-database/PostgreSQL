CREATE TABLE b5_copy (id int PRIMARY KEY, name text, note text);
INSERT INTO b5_copy VALUES (1,'ann','x'),(2,'bob',NULL),(3,'cid',E'a\tb');
CREATE TABLE b5_cur (id int PRIMARY KEY, v text);
INSERT INTO b5_cur VALUES (1,'one'),(2,'two'),(3,'three');
CREATE TABLE b5_csv (id int, v text);
INSERT INTO b5_csv VALUES (1,''),(2,NULL),(3,' plain '),(4,'a,b'),(5,'a"b'),(6,E'line1\nline2');
