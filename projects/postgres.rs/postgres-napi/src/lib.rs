//! Node-API bindings for the PostgreSQL protocol-v3, `.yyds`/`.yykv` store and
//! `psql` primitives.
//!
//! Each export is one independently callable building block: connect, execute a
//! statement, frame a packet, decode one response message, persist one row,
//! normalize one command line. No global state, no command loop and no server.
//! Command lines and emulation compose these in TypeScript.

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use postgres_client::psql::{format_results, parse_arguments, PsqlOptions};
use postgres_client::{Column, MessageField, Notice, PostgresError, QueryResult};

/// Where to connect and which identity to present.
#[napi(object)]
pub struct ClientOptions {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
}

/// The `pid` and `secret key` from `BackendKeyData`, needed for `CancelRequest`.
#[napi(object)]
pub struct BackendKeyDataInfo {
    pub process_id: i32,
    pub secret_key: i32,
}

/// One column of a result set.
#[napi(object)]
#[derive(Clone)]
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

/// One `ErrorResponse` or `NoticeResponse` field, kept in wire order.
#[napi(object)]
pub struct MessageFieldInfo {
    /// One-byte selector from the protocol, such as `C` or `P`.
    pub kind: String,
    pub value: String,
}

/// A server error together with every field the server sent, in wire order.
#[napi(object)]
pub struct ErrorInfo {
    pub code: String,
    pub message: String,
    pub fields: Vec<MessageFieldInfo>,
}

/// One `NoticeResponse` the server emitted while a statement ran.
#[napi(object)]
pub struct NoticeInfo {
    pub fields: Vec<MessageFieldInfo>,
}

/// Outcome of one simple-query batch.
///
/// `results` holds every statement that finished, `error` the failure that
/// stopped the batch, and `notices` every notice in wire order.
#[napi(object)]
pub struct ExecutionReport {
    pub results: Vec<StatementResult>,
    pub error: Option<ErrorInfo>,
    pub notices: Vec<NoticeInfo>,
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

/// One socket in the protocol-v3 simple and extended query modes.
///
/// Every [`PreparedStatement`] of this connection shares the same session, so a
/// statement can be executed after the connection handed it out.
#[napi]
pub struct Connection {
    inner: Arc<Mutex<Option<postgres_client::Connection>>>,
}

#[napi]
impl Connection {
    /// Runs one statement and returns every result set it produced.
    #[napi]
    pub fn execute(&self, sql: String) -> Result<Vec<StatementResult>> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        connection.execute(&sql).map(|results| results.into_iter().map(statement).collect()).map_err(native)
    }

    /// Runs one simple-query batch and keeps the statements that already finished.
    ///
    /// Unlike `execute`, a failure in a later statement does not discard earlier
    /// results: the report carries results, error and notices in server order.
    #[napi]
    pub fn execute_report(&self, sql: String) -> Result<ExecutionReport> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        let report = connection.execute_report(&sql).map_err(native)?;
        Ok(ExecutionReport {
            results: report.results.into_iter().map(statement).collect(),
            error: report.error.as_ref().and_then(error_info),
            notices: report.notices.iter().map(notice_info).collect(),
        })
    }

    /// Drains every notice received by `execute` calls so far, in wire order.
    #[napi]
    pub fn take_notices(&self) -> Result<Vec<NoticeInfo>> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        Ok(connection.take_notices().iter().map(notice_info).collect())
    }

    /// The `BackendKeyData` from startup, or `null` when the server skipped it.
    #[napi]
    pub fn backend_key_data(&self) -> Result<Option<BackendKeyDataInfo>> {
        let guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_ref().ok_or_else(closed_error)?;
        Ok(connection.backend_key_data().map(|key| BackendKeyDataInfo {
            process_id: key.process_id,
            secret_key: key.secret_key,
        }))
    }

    /// Sends a `CancelRequest` on a fresh socket and closes it.
    ///
    /// PostgreSQL answers nothing there, so success only means the packet left
    /// this process. The main socket is untouched.
    #[napi]
    pub fn cancel(&self) -> Result<()> {
        let guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_ref().ok_or_else(closed_error)?;
        connection.cancel().map_err(native)
    }

    /// Runs one parameterised statement through an unnamed prepared statement.
    /// `types` lists parameter OIDs; pass an empty list to let the server infer.
    #[napi]
    pub fn execute_with_params(
        &self,
        sql: String,
        params: Vec<Option<String>>,
        types: Vec<u32>,
    ) -> Result<Vec<StatementResult>> {
        let values: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        connection
            .execute_with_params(&sql, &values, &types)
            .map(|results| results.into_iter().map(statement).collect())
            .map_err(native)
    }

    /// Prepares a named statement and describes its parameters and columns.
    #[napi]
    pub fn prepare(&self, sql: String, types: Vec<u32>) -> Result<PreparedStatement> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        let prepared = connection.prepare(&sql, &types).map_err(native)?;
        Ok(PreparedStatement {
            connection: Arc::clone(&self.inner),
            name: prepared.name,
            parameters: prepared.parameters,
            columns: prepared.columns.into_iter().map(|column| ColumnInfo { name: column.name }).collect(),
            closed: false,
        })
    }

    /// Executes a statement by server-side name. The name is not checked
    /// locally, so a closed name surfaces the server error as-is.
    #[napi]
    pub fn execute_prepared(&self, name: String, params: Vec<Option<String>>) -> Result<Vec<StatementResult>> {
        let values: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        connection
            .execute_prepared(&name, &values)
            .map(|results| results.into_iter().map(statement).collect())
            .map_err(native)
    }

    /// Closes a prepared statement by server-side name.
    #[napi]
    pub fn close_prepared(&self, name: String) -> Result<()> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        connection.close_prepared(&name).map_err(native)
    }

    /// Shuts the socket down on the wire.
    #[napi]
    pub fn close(&self) -> Result<()> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(mut connection) = guard.take() else {
            return Err(closed_error());
        };
        connection.disconnect().map_err(native)
    }
}

/// One named prepared statement on a live connection.
#[napi]
pub struct PreparedStatement {
    connection: Arc<Mutex<Option<postgres_client::Connection>>>,
    name: String,
    parameters: Vec<u32>,
    columns: Vec<ColumnInfo>,
    closed: bool,
}

#[napi]
impl PreparedStatement {
    /// Server-side statement name.
    #[napi]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Parameter OIDs resolved by the server, in declaration order.
    #[napi]
    pub fn parameters(&self) -> Vec<u32> {
        self.parameters.clone()
    }

    /// Columns the statement returns; empty when it returns no row set.
    #[napi]
    pub fn columns(&self) -> Vec<ColumnInfo> {
        self.columns.clone()
    }

    /// Whether `close` already ran.
    #[napi]
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// Binds parameters and runs the statement.
    #[napi]
    pub fn execute(&mut self, params: Vec<Option<String>>) -> Result<Vec<StatementResult>> {
        if self.closed {
            return Err(Error::from_reason("statement is closed"));
        }
        let values: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
        let mut guard = self.connection.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        connection
            .execute_prepared(&self.name, &values)
            .map(|results| results.into_iter().map(statement).collect())
            .map_err(native)
    }

    /// Closes the server-side statement. Calling it twice is a no-op.
    #[napi]
    pub fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        {
            let mut guard = self.connection.lock().map_err(|_| lock_error())?;
            if let Some(connection) = guard.as_mut() {
                connection.close_prepared(&self.name).map_err(native)?;
            }
        }
        self.closed = true;
        Ok(())
    }
}

/// Opens one connection. The caller owns the handle and closes it.
#[napi]
pub fn connect(options: ClientOptions) -> Result<Connection> {
    let config = postgres_client::ClientConfig::new(options.host, options.port, options.user, options.database);
    postgres_client::Connection::open(&config)
        .map(|inner| Connection { inner: Arc::new(Mutex::new(Some(inner))) })
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

/// Builds the 16-byte `CancelRequest` sent on its own connection.
#[napi]
pub fn encode_cancel_request(process_id: i32, secret_key: i32) -> Buffer {
    Buffer::from(postgres_client::protocol::cancel_request_packet(process_id, secret_key))
}

/// Decodes an `ErrorResponse` payload.
#[napi]
pub fn decode_error_response(payload: Buffer) -> Result<ServerErrorInfo> {
    match postgres_client::protocol::error_response(payload.as_ref()) {
        PostgresError::Server { code, message, .. } => Ok(ServerErrorInfo { code, message }),
        other => Err(Error::from_reason(other.to_string())),
    }
}

/// Decodes every `ErrorResponse` field, in wire order.
#[napi]
pub fn decode_error_fields(payload: Buffer) -> Result<Vec<MessageFieldInfo>> {
    postgres_client::protocol::message_fields(payload.as_ref())
        .map(|fields| fields.iter().map(message_field_info).collect())
        .map_err(native)
}

/// Decodes every `NoticeResponse` field, in wire order.
#[napi]
pub fn decode_notice_fields(payload: Buffer) -> Result<Vec<MessageFieldInfo>> {
    postgres_client::protocol::notice_response(payload.as_ref())
        .map(|notice| notice.fields.iter().map(message_field_info).collect())
        .map_err(native)
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

/// Builds one extended-protocol `Parse` message. `paramTypes` holds OIDs;
/// an empty list lets the server infer every parameter.
#[napi]
pub fn encode_parse_message(name: String, sql: String, param_types: Vec<u32>) -> Result<Buffer> {
    postgres_client::protocol::parse_packet(&name, &sql, &param_types)
        .map(Buffer::from)
        .map_err(native)
}

/// Builds one extended-protocol `Bind` message. Parameters are text values and
/// `null` is SQL `NULL`. `resultFormat` must be `0`; binary results are refused.
#[napi]
pub fn encode_bind_message(
    portal: String,
    statement: String,
    params: Vec<Option<String>>,
    result_format: u32,
) -> Result<Buffer> {
    let format = u16::try_from(result_format)
        .map_err(|_| Error::from_reason("result format does not fit 16 bits"))?;
    let values: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
    postgres_client::protocol::bind_packet(&portal, &statement, &values, format)
        .map(Buffer::from)
        .map_err(native)
}

/// Builds one extended-protocol `Describe` message for a statement or portal.
#[napi]
pub fn encode_describe_message(target: String, name: String) -> Result<Buffer> {
    let kind = describe_target(&target)?;
    postgres_client::protocol::describe_packet(kind, &name)
        .map(Buffer::from)
        .map_err(native)
}

/// Builds one extended-protocol `Execute` message. `maxRows` must be `0`;
/// partial execution is refused.
#[napi]
pub fn encode_execute_message(portal: String, max_rows: i32) -> Result<Buffer> {
    postgres_client::protocol::execute_packet(&portal, max_rows)
        .map(Buffer::from)
        .map_err(native)
}

/// Builds the `Sync` message that ends an extended-protocol round trip.
#[napi]
pub fn encode_sync_message() -> Buffer {
    Buffer::from(postgres_client::protocol::sync_packet())
}

/// Builds one extended-protocol `Close` message for a statement or portal.
#[napi]
pub fn encode_close_message(target: String, name: String) -> Result<Buffer> {
    let kind = describe_target(&target)?;
    postgres_client::protocol::close_packet(kind, &name)
        .map(Buffer::from)
        .map_err(native)
}

/// Decodes the parameter OIDs of a `ParameterDescription`.
#[napi]
pub fn decode_parameter_description(payload: Buffer) -> Result<Vec<u32>> {
    postgres_client::protocol::parameter_description(payload.as_ref()).map_err(native)
}

/// OID of the named SQL type, or `null` when the mapping has no entry.
#[napi]
pub fn parameter_type_oid(name: String) -> Option<u32> {
    postgres_client::protocol::parameter_type_oid(&name)
}

/// Text-format `bytea` value: `\x` plus lowercase hexadecimal.
#[napi]
pub fn encode_bytea(bytes: Buffer) -> String {
    postgres_client::protocol::encode_bytea(bytes.as_ref())
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

fn message_field_info(field: &MessageField) -> MessageFieldInfo {
    MessageFieldInfo { kind: String::from_utf8_lossy(&[field.kind]).into_owned(), value: field.value.clone() }
}

fn notice_info(notice: &Notice) -> NoticeInfo {
    NoticeInfo { fields: notice.fields.iter().map(message_field_info).collect() }
}

fn error_info(error: &PostgresError) -> Option<ErrorInfo> {
    match error {
        PostgresError::Server { code, message, fields } => Some(ErrorInfo {
            code: code.clone(),
            message: message.clone(),
            fields: fields.iter().map(message_field_info).collect(),
        }),
        _ => None,
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

fn describe_target(target: &str) -> Result<u8> {
    match target {
        "statement" => Ok(b'S'),
        "portal" => Ok(b'P'),
        _ => Err(Error::from_reason("describe target must be S or P")),
    }
}

fn lock_error() -> Error {
    Error::from_reason("connection lock is poisoned")
}

fn closed_error() -> Error {
    Error::from_reason("connection is closed")
}

fn native(error: PostgresError) -> Error {
    Error::from_reason(error.to_string())
}
