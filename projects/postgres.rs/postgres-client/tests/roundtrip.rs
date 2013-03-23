//! Smallest real round trip against a live PostgreSQL server.
//!
//! The harness starts a server and passes `POSTGRES_TEST_HOST` / `_PORT` /
//! `_USER` / `_DATABASE`. Without them the test fails on purpose: a missing
//! server is a blocked gate, never a skipped pass.

use postgres_client::{ClientConfig, Connection};

fn config() -> ClientConfig {
    let port = std::env::var("POSTGRES_TEST_PORT")
        .expect("blocked: POSTGRES_TEST_PORT must point at a running PostgreSQL server")
        .parse()
        .expect("POSTGRES_TEST_PORT must be a number");
    let config = ClientConfig::new(
        std::env::var("POSTGRES_TEST_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        port,
        std::env::var("POSTGRES_TEST_USER").unwrap_or_else(|_| "postgres".into()),
        std::env::var("POSTGRES_TEST_DATABASE").unwrap_or_else(|_| "postgres".into()),
    );
    match std::env::var("POSTGRES_TEST_PASSWORD") {
        Ok(password) => config.with_password(password),
        Err(_) => config,
    }
}

#[test]
fn selects_one_row_from_a_live_server() {
    let mut connection = Connection::open(&config()).expect("a live server must accept the startup packet");
    let results = connection.execute("SELECT 1 AS one").expect("SELECT 1 must succeed");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].tag, "SELECT 1");
    assert_eq!(results[0].column_names().collect::<Vec<_>>(), vec!["one"]);
    assert_eq!(results[0].cell(0, 0), Some(Some("1")));
    connection.close().expect("closing must succeed");
}

#[test]
fn reports_server_error_code_and_message() {
    let mut connection = Connection::open(&config()).expect("a live server must accept the startup packet");
    let error = connection.execute("SELECT * FROM missing_table").expect_err("a missing table must fail");
    assert_eq!(error.code(), Some("42P01"));
    assert!(error.message().contains("missing_table"));
}
