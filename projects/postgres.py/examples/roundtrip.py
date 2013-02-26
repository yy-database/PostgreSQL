import os

import postgres

port = int(os.environ.get("POSTGRES_TEST_PORT", "5432"))
host = os.environ.get("POSTGRES_TEST_HOST", "127.0.0.1")
user = os.environ.get("POSTGRES_TEST_USER", "postgres")
database = os.environ.get("POSTGRES_TEST_DATABASE", "postgres")

connection = postgres.connect(host, port, user, database)
try:
    [result] = connection.execute("SELECT 1 AS one")
    print(result.tag)
    print(result.columns[0].name, result.rows[0][0])
finally:
    connection.close()
