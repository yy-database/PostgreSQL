//! PyO3 bindings for the PostgreSQL protocol-v3, `.yyds`/`.yykv` store and
//! `psql` primitives.
//!
//! Each export is one independently callable building block: connect, execute a
//! statement, frame a packet, decode one response message, persist one row,
//! normalize one command line. No global state, no command loop and no server.
//! Command lines and emulation compose these in Python.

use pyo3::create_exception;
use pyo3::exceptions::PyException;
use pyo3::prelude::*;

use postgres_client::psql::{format_results, parse_arguments, PsqlOptions as CoreOptions};
use postgres_client::{Column, PostgresError as CoreError, QueryResult};

create_exception!(postgres_pyo3, PostgresError, PyException);

/// One column of a result set.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct ColumnInfo {
    #[pyo3(get)]
    name: String,
}

#[pymethods]
impl ColumnInfo {
    #[new]
    fn new(name: String) -> Self {
        Self { name }
    }
}

/// Everything one statement returned. `rows` holds `None` for SQL `NULL` cells.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct StatementResult {
    #[pyo3(get)]
    columns: Vec<ColumnInfo>,
    #[pyo3(get)]
    rows: Vec<Vec<Option<String>>>,
    #[pyo3(get)]
    tag: String,
}

#[pymethods]
impl StatementResult {
    #[new]
    fn new(columns: Vec<ColumnInfo>, rows: Vec<Vec<Option<String>>>, tag: String) -> Self {
        Self { columns, rows, tag }
    }
}

/// Effective `psql` options.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct PsqlOptions {
    #[pyo3(get)]
    host: String,
    #[pyo3(get)]
    port: u16,
    #[pyo3(get)]
    user: String,
    #[pyo3(get)]
    database: String,
    #[pyo3(get)]
    sql: String,
    #[pyo3(get)]
    headers: bool,
    #[pyo3(get)]
    separator: String,
    #[pyo3(get)]
    null_value: String,
}

#[pymethods]
impl PsqlOptions {
    #[new]
    #[pyo3(signature = (
        host = "127.0.0.1".to_owned(),
        port = 5432,
        user = "postgres".to_owned(),
        database = "postgres".to_owned(),
        sql = String::new(),
        headers = true,
        separator = "|".to_owned(),
        null_value = String::new()
    ))]
    fn new(
        host: String,
        port: u16,
        user: String,
        database: String,
        sql: String,
        headers: bool,
        separator: String,
        null_value: String,
    ) -> Self {
        Self { host, port, user, database, sql, headers, separator, null_value }
    }
}

impl From<CoreOptions> for PsqlOptions {
    fn from(options: CoreOptions) -> Self {
        Self {
            host: options.host,
            port: options.port,
            user: options.user,
            database: options.database,
            sql: options.sql,
            headers: options.headers,
            separator: options.separator,
            null_value: options.null_value,
        }
    }
}

impl From<&PsqlOptions> for CoreOptions {
    fn from(options: &PsqlOptions) -> Self {
        Self {
            host: options.host.clone(),
            port: options.port,
            user: options.user.clone(),
            database: options.database.clone(),
            sql: options.sql.clone(),
            headers: options.headers,
            separator: options.separator.clone(),
            null_value: options.null_value.clone(),
        }
    }
}

/// One stored row.
#[pyclass]
pub struct StoreRow {
    #[pyo3(get)]
    key: Vec<u8>,
    #[pyo3(get)]
    value: Vec<u8>,
}

/// One socket in the simple-query protocol.
#[pyclass]
pub struct Connection {
    inner: Option<postgres_client::Connection>,
}

#[pymethods]
impl Connection {
    /// Runs one statement and returns every result set it produced.
    fn execute(&mut self, sql: &str) -> PyResult<Vec<StatementResult>> {
        let Some(connection) = self.inner.as_mut() else {
            return Err(PostgresError::new_err("connection is closed"));
        };
        connection.execute(sql).map(|results| results.into_iter().map(statement).collect()).map_err(native)
    }

    /// Shuts the socket down on the wire.
    fn close(&mut self) -> PyResult<()> {
        let Some(connection) = self.inner.take() else {
            return Err(PostgresError::new_err("connection is closed"));
        };
        connection.close().map_err(native)
    }
}

/// Opens one connection. The caller owns the handle and closes it.
#[pyfunction]
fn connect(host: &str, port: u16, user: &str, database: &str) -> PyResult<Connection> {
    let config = postgres_client::ClientConfig::new(host, port, user, database);
    postgres_client::Connection::open(&config)
        .map(|inner| Connection { inner: Some(inner) })
        .map_err(native)
}

/// Package version of this binding.
#[pyfunction]
fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Protocol 3.0 number carried by the startup packet.
#[pyfunction]
fn protocol_version() -> u32 {
    postgres_client::protocol::PROTOCOL_VERSION
}

/// Message length ceiling accepted by the client.
#[pyfunction]
fn max_message_bytes() -> u32 {
    postgres_client::protocol::MAX_MESSAGE_BYTES as u32
}

/// Builds the startup packet for one identity.
#[pyfunction]
fn encode_startup_packet(user: &str, database: &str) -> Vec<u8> {
    postgres_client::protocol::startup_packet(user, database)
}

/// Builds one simple-query `Query` message.
#[pyfunction]
fn encode_query_packet(sql: &str) -> PyResult<Vec<u8>> {
    postgres_client::protocol::query_packet(sql).map_err(native)
}

/// Decodes an `ErrorResponse` payload into `(code, message)`.
#[pyfunction]
fn decode_error_response(payload: Vec<u8>) -> PyResult<(String, String)> {
    match postgres_client::protocol::error_response(&payload) {
        CoreError::Server { code, message } => Ok((code, message)),
        other => Err(native(other)),
    }
}

/// Decodes the column names of a `RowDescription`.
#[pyfunction]
fn decode_row_description(payload: Vec<u8>) -> PyResult<Vec<String>> {
    postgres_client::protocol::column_names(&payload).map_err(native)
}

/// Decodes the cells of a `DataRow`.
#[pyfunction]
fn decode_data_row(payload: Vec<u8>, columns: usize) -> PyResult<Vec<Option<String>>> {
    postgres_client::protocol::data_row(&payload, columns).map_err(native)
}

/// Decodes the command tag of a `CommandComplete`.
#[pyfunction]
fn decode_command_tag(payload: Vec<u8>) -> PyResult<String> {
    postgres_client::protocol::command_tag(&payload).map_err(native)
}

/// Parses the supported `psql` flags.
#[pyfunction]
fn parse_psql_arguments(args: Vec<String>) -> PyResult<PsqlOptions> {
    parse_arguments(&args).map(PsqlOptions::from).map_err(|message| PostgresError::new_err(message))
}

/// Turns result sets into the lines `psql` prints.
#[pyfunction]
fn format_psql_results(results: Vec<StatementResult>, options: PsqlOptions) -> Vec<String> {
    let results: Vec<QueryResult> = results.into_iter().map(query_result).collect();
    format_results(&results, &CoreOptions::from(&options))
}

/// One durable `.yyds`/`.yykv` store.
#[pyclass]
pub struct Store {
    inner: postgres_client::Store,
}

#[pymethods]
impl Store {
    #[new]
    fn new(data_dir: String) -> PyResult<Self> {
        postgres_client::Store::open(&data_dir).map(|inner| Self { inner }).map_err(native)
    }

    /// Writes one row.
    fn put(&self, namespace: String, key: Vec<u8>, value: Vec<u8>) -> PyResult<()> {
        self.inner.put(&namespace, &key, &value).map_err(native)
    }

    /// Reads one row, or `None` when absent.
    fn get(&self, namespace: String, key: Vec<u8>) -> Option<Vec<u8>> {
        self.inner.get(&namespace, &key)
    }

    /// Removes one row and reports whether it existed.
    fn delete(&self, namespace: String, key: Vec<u8>) -> PyResult<bool> {
        self.inner.delete(&namespace, &key).map_err(native)
    }

    /// Keys of one namespace with the byte prefix, ordered by key.
    fn keys(&self, namespace: String, prefix: Vec<u8>) -> Vec<Vec<u8>> {
        self.inner.keys(&namespace, &prefix)
    }

    /// Key/value pairs of one namespace with the byte prefix.
    fn scan(&self, namespace: String, prefix: Vec<u8>) -> Vec<StoreRow> {
        self.inner
            .scan(&namespace, &prefix)
            .into_iter()
            .map(|(key, value)| StoreRow { key, value })
            .collect()
    }

    /// Distinct namespaces holding at least one row.
    fn namespaces(&self) -> Vec<String> {
        self.inner.namespaces()
    }

    /// Rows in one namespace.
    fn len(&self, namespace: String) -> usize {
        self.inner.len(&namespace)
    }

    /// Removes every row of one namespace.
    fn flush(&self, namespace: String) -> PyResult<usize> {
        self.inner.flush(&namespace).map_err(native)
    }

    /// Store directory.
    fn data_dir(&self) -> String {
        self.inner.data_dir()
    }

    /// `.yykv` shard path.
    fn shard_path(&self) -> String {
        self.inner.shard_path()
    }

    /// `.yyds` catalog path.
    fn catalog_path(&self) -> String {
        self.inner.catalog_path()
    }
}

fn statement(result: QueryResult) -> StatementResult {
    StatementResult {
        columns: result.columns.into_iter().map(|column| ColumnInfo { name: column.name }).collect(),
        rows: result.rows,
        tag: result.tag,
    }
}

fn query_result(result: StatementResult) -> QueryResult {
    QueryResult {
        columns: result.columns.into_iter().map(|column| Column { name: column.name }).collect(),
        rows: result.rows,
        tag: result.tag,
    }
}

fn native(error: CoreError) -> PyErr {
    PostgresError::new_err(error.to_string())
}

#[pymodule]
fn postgres_pyo3(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<Connection>()?;
    module.add_class::<ColumnInfo>()?;
    module.add_class::<StatementResult>()?;
    module.add_class::<PsqlOptions>()?;
    module.add_class::<Store>()?;
    module.add_class::<StoreRow>()?;
    module.add("PostgresError", module.py().get_type::<PostgresError>())?;
    module.add_function(wrap_pyfunction!(connect, module)?)?;
    module.add_function(wrap_pyfunction!(version, module)?)?;
    module.add_function(wrap_pyfunction!(protocol_version, module)?)?;
    module.add_function(wrap_pyfunction!(max_message_bytes, module)?)?;
    module.add_function(wrap_pyfunction!(encode_startup_packet, module)?)?;
    module.add_function(wrap_pyfunction!(encode_query_packet, module)?)?;
    module.add_function(wrap_pyfunction!(decode_error_response, module)?)?;
    module.add_function(wrap_pyfunction!(decode_row_description, module)?)?;
    module.add_function(wrap_pyfunction!(decode_data_row, module)?)?;
    module.add_function(wrap_pyfunction!(decode_command_tag, module)?)?;
    module.add_function(wrap_pyfunction!(parse_psql_arguments, module)?)?;
    module.add_function(wrap_pyfunction!(format_psql_results, module)?)?;
    Ok(())
}
