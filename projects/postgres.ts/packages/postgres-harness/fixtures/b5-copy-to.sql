\copy b5_copy TO STDOUT
\copy b5_copy TO STDOUT WITH (FORMAT csv, HEADER, NULL 'NA')
\copy b5_copy TO STDOUT WITH (FORMAT csv, HEADER, DELIMITER '|')
COPY (SELECT id, name FROM b5_copy WHERE id < 3) TO STDOUT
\copy b5_csv TO STDOUT CSV HEADER
\copy b5_csv TO STDOUT
