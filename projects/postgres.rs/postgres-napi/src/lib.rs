//! Node-API bindings for the PostgreSQL protocol-v3, `.yyds`/`.yykv` store and
//! `psql` primitives.
//!
//! Each export is one independently callable building block: connect, execute a
//! statement, frame a packet, decode one response message, persist one row,
//! normalize one command line. No global state, no command loop and no server.
//! Command lines and emulation compose these in TypeScript.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use postgres_client::psql::{format_results, parse_arguments, PsqlOptions};
use postgres_client::{Column, PostgresError, QueryResult};

/// Where to connect and which identity to present.
#[napi(object)]
pub struct ClientOptions {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
}

/// One column of a result set.
#[napi(object)]
pub struct ColumnInfo {
    pub name: String,
}

/// One row. `null` inside `values` is a SQL `NULL` cell.
#[napi(object)]
pub struct DataRow {
    pub values: Vec<Option<String>>,
}

/// Everything one statement returned.
#[napi(object)]
pub struct StatementResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<DataRow>,
    pub tag: String,
}

/// A decoded server error.
#[napi(object)]
pub struct ServerErrorInfo {
    pub code: String,
    pub message: String,
}

/// One stored row.
#[napi(object)]
pub struct StoreRow {
    pub key: Buffer,
    pub value: Buffer,
}

/// Effective `psql` options.
#[napi(object)]
pub struct CommandOptions {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub sql: String,
    pub headers: bool,
    pub separator: String,
    pub null_value: String,
}

/// One socket in the simple-query protocol.
#[napi]
pub struct Connection {
    inner: Option<postgres_client::Connection>,
}

#[napi]
impl Connection {
    /// Runs one statement and returns every result set it produced.
    #[napi]
    pub fn execute(&mut self, sql: String) -> Result<Vec<StatementResult>> {
        let connection = self
            .inner
            .as_mut()
            .ok_or_else(|| Error::from_reason("connection is closed"))?;
        connection.execute(&sql).map(|results| results.into_iter().map(statement).collect()).map_err(native)
    }

    /// Shuts the socket down on the wire.
    #[napi]
    pub fn close(&mut self) -> Result<()> {
        let connection = self
            .inner
            .take()
            .ok_or_else(|| Error::from_reason("connection is closed"))?;
        connection.close().map_err(native)
    }
}

/// Opens one connection. The caller owns the handle and closes it.
#[napi]
pub fn connect(options: ClientOptions) -> Result<Connection> {
    let config = postgres_client::ClientConfig::new(options.host, options.port, options.user, options.database);
    postgres_client::Connection::open(&config)
        .map(|inner| Connection { inner: Some(inner) })
        .map_err(native)
}

/// Package version of this binding.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Protocol 3.0 number carried by the startup packet.
#[napi]
pub fn protocol_version() -> u32 {
    postgres_client::protocol::PROTOCOL_VERSION
}

/// Message length ceiling accepted by the client.
#[napi]
pub fn max_message_bytes() -> u32 {
    postgres_client::protocol::MAX_MESSAGE_BYTES as u32
}

/// Builds the startup packet for one identity.
#[napi]
pub fn encode_startup_packet(user: String, database: String) -> Buffer {
    Buffer::from(postgres_client::protocol::startup_packet(&user, &database))
}

/// Builds one simple-query `Query` message.
#[napi]
pub fn encode_query_packet(sql: String) -> Result<Buffer> {
    postgres_client::protocol::query_packet(&sql)
        .map(Buffer::from)
        .map_err(native)
}

/// Decodes an `ErrorResponse` payload.
#[napi]
pub fn decode_error_response(payload: Buffer) -> Result<ServerErrorInfo> {
    match postgres_client::protocol::error_response(payload.as_ref()) {
        PostgresError::Server { code, message } => Ok(ServerErrorInfo { code, message }),
        other => Err(Error::from_reason(other.to_string())),
    }
}

/// Decodes the column names of a `RowDescription`.
#[napi]
pub fn decode_row_description(payload: Buffer) -> Result<Vec<String>> {
    postgres_client::protocol::column_names(payload.as_ref()).map_err(native)
}

/// Decodes the cells of a `DataRow`.
#[napi]
pub fn decode_data_row(payload: Buffer, columns: u32) -> Result<Vec<Option<String>>> {
    postgres_client::protocol::data_row(payload.as_ref(), columns as usize).map_err(native)
}

/// Decodes the command tag of a `CommandComplete`.
#[napi]
pub fn decode_command_tag(payload: Buffer) -> Result<String> {
    postgres_client::protocol::command_tag(payload.as_ref()).map_err(native)
}

/// Parses the supported `psql` flags.
#[napi]
pub fn parse_psql_arguments(args: Vec<String>) -> Result<CommandOptions> {
    parse_arguments(&args)
        .map(CommandOptions::from)
        .map_err(|message| Error::from_reason(message))
}

/// Turns result sets into the lines `psql` prints.
#[napi]
pub fn format_psql_results(results: Vec<StatementResult>, options: CommandOptions) -> Vec<String> {
    let results: Vec<QueryResult> = results.into_iter().map(query_result).collect();
    format_results(&results, &PsqlOptions::from(options))
}

/// One durable `.yyds`/`.yykv` store.
#[napi]
pub struct Store {
    inner: postgres_client::Store,
}

#[napi]
impl Store {
    /// Opens or creates a store in `dataDir`.
    #[napi(constructor)]
    pub fn new(data_dir: String) -> Result<Self> {
        postgres_client::Store::open(&data_dir)
            .map(|inner| Self { inner })
            .map_err(native)
    }

    /// Writes one row.
    #[napi]
    pub fn put(&self, namespace: String, key: Buffer, value: Buffer) -> Result<()> {
        self.inner.put(&namespace, key.as_ref(), value.as_ref()).map_err(native)
    }

    /// Reads one row, or `null` when absent.
    #[napi]
    pub fn get(&self, namespace: String, key: Buffer) -> Option<Buffer> {
        self.inner.get(&namespace, key.as_ref()).map(Buffer::from)
    }

    /// Removes one row and reports whether it existed.
    #[napi]
    pub fn delete(&self, namespace: String, key: Buffer) -> Result<bool> {
        self.inner.delete(&namespace, key.as_ref()).map_err(native)
    }

    /// Keys of one namespace with the byte prefix, ordered by key.
    #[napi]
    pub fn keys(&self, namespace: String, prefix: Buffer) -> Vec<Buffer> {
        self.inner.keys(&namespace, prefix.as_ref()).into_iter().map(Buffer::from).collect()
    }

    /// Key/value pairs of one namespace with the byte prefix.
    #[napi]
    pub fn scan(&self, namespace: String, prefix: Buffer) -> Vec<StoreRow> {
        self.inner
            .scan(&namespace, prefix.as_ref())
            .into_iter()
            .map(|(key, value)| StoreRow { key: Buffer::from(key), value: Buffer::from(value) })
            .collect()
    }

    /// Distinct namespaces holding at least one row.
    #[napi]
    pub fn namespaces(&self) -> Vec<String> {
        self.inner.namespaces()
    }

    /// Rows in one namespace.
    #[napi]
    pub fn len(&self, namespace: String) -> u32 {
        self.inner.len(&namespace) as u32
    }

    /// Removes every row of one namespace.
    #[napi]
    pub fn flush(&self, namespace: String) -> Result<u32> {
        self.inner.flush(&namespace).map(|removed| removed as u32).map_err(native)
    }

    /// Store directory.
    #[napi]
    pub fn data_dir(&self) -> String {
        self.inner.data_dir()
    }

    /// `.yykv` shard path.
    #[napi]
    pub fn shard_path(&self) -> String {
        self.inner.shard_path()
    }

    /// `.yyds` catalog path.
    #[napi]
    pub fn catalog_path(&self) -> String {
        self.inner.catalog_path()
    }
}

fn statement(result: QueryResult) -> StatementResult {
    StatementResult {
        columns: result.columns.into_iter().map(|column| ColumnInfo { name: column.name }).collect(),
        rows: result.rows.into_iter().map(|values| DataRow { values }).collect(),
        tag: result.tag,
    }
}

fn query_result(result: StatementResult) -> QueryResult {
    QueryResult {
        columns: result.columns.into_iter().map(|column| Column { name: column.name }).collect(),
        rows: result.rows.into_iter().map(|row| row.values).collect(),
        tag: result.tag,
    }
}

impl From<PsqlOptions> for CommandOptions {
    fn from(options: PsqlOptions) -> Self {
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

impl From<CommandOptions> for PsqlOptions {
    fn from(options: CommandOptions) -> Self {
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

fn native(error: PostgresError) -> Error {
    Error::from_reason(error.to_string())
}
