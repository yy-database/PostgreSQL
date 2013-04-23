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

use database_client::pgsql::{
    client::{ClientConfig, Column, Connection as CoreConnection, Param as PostgresParam, QueryResult},
    error::{MessageField, Notice, PostgresError},
    psql::{PsqlOptions, format_results, parse_arguments},
    ServerChange as CoreServerChange, ServerStore as CoreServerStore, Store as CoreStore,
};
use database_protocol_pgsql as protocol;

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

/// Outcome of one `COPY ... FROM STDIN` round trip.
#[napi(object)]
pub struct CopyInReport {
    pub tag: String,
    pub error: Option<ErrorInfo>,
    pub notices: Vec<NoticeInfo>,
}

/// Outcome of one `COPY ... TO STDOUT` round trip.
#[napi(object)]
pub struct CopyOutReport {
    /// Every `CopyData` payload concatenated in wire order.
    pub data: Buffer,
    pub tag: String,
    pub error: Option<ErrorInfo>,
    pub notices: Vec<NoticeInfo>,
}

/// One decoded `CopyInResponse`, `CopyOutResponse` or `CopyBothResponse`.
#[napi(object)]
pub struct CopyResponseInfo {
    /// `0` for text and `1` for binary.
    pub format: u32,
    pub columns: u32,
    pub column_formats: Vec<u32>,
}

/// One bound parameter: a format code plus an optional payload.
///
/// `format` is `0` for text and `1` for binary. `null` is SQL `NULL`.
#[napi(object)]
pub struct ParamInfo {
    pub format: u32,
    pub value: Option<Buffer>,
}

/// One named portal bound to a prepared statement.
#[napi(object)]
pub struct PortalInfo {
    pub name: String,
    pub parameters: Vec<u32>,
    pub columns: Vec<ColumnInfo>,
}

/// One `Execute` round trip on a portal.
///
/// `results` holds this batch, and `suspended` is `true` when the server stopped
/// at the row limit with rows still waiting.
#[napi(object)]
pub struct PortalExecReport {
    pub results: Vec<StatementResult>,
    pub suspended: bool,
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
    inner: Arc<Mutex<Option<CoreConnection>>>,
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
        Ok(connection
            .backend_key_data()
            .map(|key| BackendKeyDataInfo { process_id: key.process_id, secret_key: key.secret_key }))
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
        connection.execute_prepared(&name, &values).map(|results| results.into_iter().map(statement).collect()).map_err(native)
    }

    /// Closes a prepared statement by server-side name.
    #[napi]
    pub fn close_prepared(&self, name: String) -> Result<()> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        connection.close_prepared(&name).map_err(native)
    }

    /// Runs one parameterised statement with explicit text or binary parameters
    /// and result formats. `resultFormats` is empty for text, one code for every
    /// column, or one code per column.
    #[napi]
    pub fn execute_with_param_formats(
        &self,
        sql: String,
        params: Vec<ParamInfo>,
        types: Vec<u32>,
        result_formats: Vec<u32>,
    ) -> Result<Vec<StatementResult>> {
        let owned = param_buffers(&params)?;
        let values: Vec<PostgresParam<'_>> =
            owned.iter().map(|(format, value)| PostgresParam { format: *format, value: value.as_deref() }).collect();
        let formats = result_formats_u16(result_formats)?;
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        connection
            .execute_with_param_formats(&sql, &values, &types, &formats)
            .map(|results| results.into_iter().map(statement).collect())
            .map_err(native)
    }

    /// Executes a prepared statement with explicit text or binary parameters.
    #[napi]
    pub fn execute_prepared_formats(
        &self,
        name: String,
        params: Vec<ParamInfo>,
        result_formats: Vec<u32>,
    ) -> Result<Vec<StatementResult>> {
        let owned = param_buffers(&params)?;
        let values: Vec<PostgresParam<'_>> =
            owned.iter().map(|(format, value)| PostgresParam { format: *format, value: value.as_deref() }).collect();
        let formats = result_formats_u16(result_formats)?;
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        connection
            .execute_prepared_formats(&name, &values, &formats)
            .map(|results| results.into_iter().map(statement).collect())
            .map_err(native)
    }

    /// Binds a named portal so it can be executed more than once.
    #[napi]
    pub fn bind_portal(
        &self,
        statement: String,
        portal: String,
        params: Vec<ParamInfo>,
        result_formats: Vec<u32>,
    ) -> Result<PortalInfo> {
        let owned = param_buffers(&params)?;
        let values: Vec<PostgresParam<'_>> =
            owned.iter().map(|(format, value)| PostgresParam { format: *format, value: value.as_deref() }).collect();
        let formats = result_formats_u16(result_formats)?;
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        let portal = connection.bind_portal(&statement, &portal, &values, &formats).map_err(native)?;
        Ok(PortalInfo {
            name: portal.name,
            parameters: portal.parameters,
            columns: portal.columns.into_iter().map(|column| ColumnInfo { name: column.name }).collect(),
        })
    }

    /// Executes an open portal. `maxRows` of `0` runs it to completion.
    #[napi]
    pub fn execute_portal(&self, portal: String, max_rows: i32) -> Result<PortalExecReport> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        let report = connection.execute_portal(&portal, max_rows).map_err(native)?;
        Ok(PortalExecReport { results: report.results.into_iter().map(statement).collect(), suspended: report.suspended })
    }

    /// Closes a portal by server-side name.
    #[napi]
    pub fn close_portal(&self, name: String) -> Result<()> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        connection.close_portal(&name).map_err(native)
    }

    /// Streams `chunks` as `COPY ... FROM STDIN` data for one statement.
    ///
    /// Data is only written after the server answered `CopyInResponse`. A
    /// failure keeps its tag, error and notices instead of throwing, so the
    /// caller can tell how many rows the server accepted.
    #[napi]
    pub fn copy_in(&self, sql: String, chunks: Vec<Buffer>) -> Result<CopyInReport> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        let slices: Vec<&[u8]> = chunks.iter().map(|chunk| chunk.as_ref()).collect();
        let report = connection.copy_in(&sql, &slices).map_err(native)?;
        Ok(CopyInReport {
            tag: report.tag,
            error: report.error.as_ref().and_then(error_info),
            notices: report.notices.iter().map(notice_info).collect(),
        })
    }

    /// Collects every `CopyData` payload of one `COPY ... TO STDOUT` statement.
    ///
    /// A failure keeps the bytes that already arrived instead of discarding them.
    #[napi]
    pub fn copy_out(&self, sql: String) -> Result<CopyOutReport> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        let report = connection.copy_out(&sql).map_err(native)?;
        Ok(CopyOutReport {
            data: Buffer::from(report.data),
            tag: report.tag,
            error: report.error.as_ref().and_then(error_info),
            notices: report.notices.iter().map(notice_info).collect(),
        })
    }

    /// Shuts the socket down on the wire.
    #[napi]
    pub fn close(&self) -> Result<()> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(mut connection) = guard.take()
        else {
            return Err(closed_error());
        };
        connection.disconnect().map_err(native)
    }
}

/// One named prepared statement on a live connection.
#[napi]
pub struct PreparedStatement {
    connection: Arc<Mutex<Option<CoreConnection>>>,
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
    let config = ClientConfig::new(options.host, options.port, options.user, options.database);
    CoreConnection::open(&config)
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
    protocol::PROTOCOL_VERSION
}

/// Message length ceiling accepted by the client.
#[napi]
pub fn max_message_bytes() -> u32 {
    protocol::MAX_MESSAGE_BYTES as u32
}

/// Builds the startup packet for one identity.
#[napi]
pub fn encode_startup_packet(user: String, database: String) -> Buffer {
    Buffer::from(protocol::startup_packet(&user, &database))
}

/// Builds one simple-query `Query` message.
#[napi]
pub fn encode_query_packet(sql: String) -> Result<Buffer> {
    protocol::query_packet(&sql).map(Buffer::from).map_err(native)
}

/// Builds the 16-byte `CancelRequest` sent on its own connection.
#[napi]
pub fn encode_cancel_request(process_id: i32, secret_key: i32) -> Buffer {
    Buffer::from(protocol::cancel_request_packet(process_id, secret_key))
}

/// Decodes an `ErrorResponse` payload.
#[napi]
pub fn decode_error_response(payload: Buffer) -> Result<ServerErrorInfo> {
    match protocol::error_response(payload.as_ref()) {
        PostgresError::Server { code, message, .. } => Ok(ServerErrorInfo { code, message }),
        other => Err(Error::from_reason(other.to_string())),
    }
}

/// Decodes every `ErrorResponse` field, in wire order.
#[napi]
pub fn decode_error_fields(payload: Buffer) -> Result<Vec<MessageFieldInfo>> {
    protocol::message_fields(payload.as_ref())
        .map(|fields| fields.iter().map(message_field_info).collect())
        .map_err(native)
}

/// Decodes every `NoticeResponse` field, in wire order.
#[napi]
pub fn decode_notice_fields(payload: Buffer) -> Result<Vec<MessageFieldInfo>> {
    protocol::notice_response(payload.as_ref())
        .map(|notice| notice.fields.iter().map(message_field_info).collect())
        .map_err(native)
}

/// Decodes the column names of a `RowDescription`.
#[napi]
pub fn decode_row_description(payload: Buffer) -> Result<Vec<String>> {
    protocol::column_names(payload.as_ref()).map_err(native)
}

/// Decodes the cells of a `DataRow`.
#[napi]
pub fn decode_data_row(payload: Buffer, columns: u32) -> Result<Vec<Option<String>>> {
    protocol::data_row(payload.as_ref(), columns as usize).map_err(native)
}

/// Decodes the command tag of a `CommandComplete`.
#[napi]
pub fn decode_command_tag(payload: Buffer) -> Result<String> {
    protocol::command_tag(payload.as_ref()).map_err(native)
}

/// Builds one extended-protocol `Parse` message. `paramTypes` holds OIDs;
/// an empty list lets the server infer every parameter.
#[napi]
pub fn encode_parse_message(name: String, sql: String, param_types: Vec<u32>) -> Result<Buffer> {
    protocol::parse_packet(&name, &sql, &param_types).map(Buffer::from).map_err(native)
}

/// Builds one extended-protocol `Bind` message. Parameters are text values and
/// `null` is SQL `NULL`. `resultFormat` is `0` for text columns and `1` for
/// binary ones.
#[napi]
pub fn encode_bind_message(
    portal: String,
    statement: String,
    params: Vec<Option<String>>,
    result_format: u32,
) -> Result<Buffer> {
    let format = u16::try_from(result_format).map_err(|_| Error::from_reason("result format does not fit 16 bits"))?;
    let values: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
    protocol::bind_packet(&portal, &statement, &values, format).map(Buffer::from).map_err(native)
}

/// Builds one extended-protocol `Bind` message with explicit parameter and
/// result format codes. An empty format list means text for every value.
#[napi]
pub fn encode_bind_message_with_formats(
    portal: String,
    statement: String,
    params: Vec<ParamInfo>,
    param_formats: Vec<u32>,
    result_formats: Vec<u32>,
) -> Result<Buffer> {
    let owned = param_buffers(&params)?;
    let values: Vec<Option<&[u8]>> = owned.iter().map(|(_, value)| value.as_deref()).collect();
    let param_codes = result_formats_u16(param_formats)?;
    let result_codes = result_formats_u16(result_formats)?;
    protocol::bind_packet_with_formats(&portal, &statement, &values, &param_codes, &result_codes)
        .map(Buffer::from)
        .map_err(native)
}

/// Builds one extended-protocol `Describe` message for a statement or portal.
#[napi]
pub fn encode_describe_message(target: String, name: String) -> Result<Buffer> {
    let kind = describe_target(&target)?;
    protocol::describe_packet(kind, &name).map(Buffer::from).map_err(native)
}

/// Builds one extended-protocol `Execute` message. `maxRows` of `0` runs the
/// portal to completion and a positive limit suspends it after that many rows.
#[napi]
pub fn encode_execute_message(portal: String, max_rows: i32) -> Result<Buffer> {
    protocol::execute_packet(&portal, max_rows).map(Buffer::from).map_err(native)
}

/// Builds the `Sync` message that ends an extended-protocol round trip.
#[napi]
pub fn encode_sync_message() -> Buffer {
    Buffer::from(protocol::sync_packet())
}

/// Builds one extended-protocol `Close` message for a statement or portal.
#[napi]
pub fn encode_close_message(target: String, name: String) -> Result<Buffer> {
    let kind = describe_target(&target)?;
    protocol::close_packet(kind, &name).map(Buffer::from).map_err(native)
}

/// Decodes the parameter OIDs of a `ParameterDescription`.
#[napi]
pub fn decode_parameter_description(payload: Buffer) -> Result<Vec<u32>> {
    protocol::parameter_description(payload.as_ref()).map_err(native)
}

/// Builds one `CopyData` message carrying a chunk of the copy stream.
#[napi]
pub fn encode_copy_data(data: Buffer) -> Result<Buffer> {
    protocol::copy_data_packet(data.as_ref()).map(Buffer::from).map_err(native)
}

/// Builds the `CopyDone` message that ends a `COPY ... FROM STDIN` stream.
#[napi]
pub fn encode_copy_done() -> Buffer {
    Buffer::from(protocol::copy_done_packet())
}

/// Builds a `CopyFail` message carrying a human readable reason.
#[napi]
pub fn encode_copy_fail(reason: String) -> Result<Buffer> {
    protocol::copy_fail_packet(&reason).map(Buffer::from).map_err(native)
}

/// Decodes a `CopyInResponse`, `CopyOutResponse` or `CopyBothResponse` payload.
#[napi]
pub fn decode_copy_response(payload: Buffer) -> Result<CopyResponseInfo> {
    let response = protocol::copy_response(payload.as_ref()).map_err(native)?;
    Ok(CopyResponseInfo {
        format: response.format as u32,
        columns: response.columns as u32,
        column_formats: response.column_formats.into_iter().map(u32::from).collect(),
    })
}

/// OID of the named SQL type, or `null` when the mapping has no entry.
#[napi]
pub fn parameter_type_oid(name: String) -> Option<u32> {
    protocol::parameter_type_oid(&name)
}

/// Text-format `bytea` value: `\x` plus lowercase hexadecimal.
#[napi]
pub fn encode_bytea(bytes: Buffer) -> String {
    protocol::encode_bytea(bytes.as_ref())
}

/// Parses the supported `psql` flags.
#[napi]
pub fn parse_psql_arguments(args: Vec<String>) -> Result<CommandOptions> {
    parse_arguments(&args).map(CommandOptions::from).map_err(Error::from_reason)
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
    inner: CoreStore,
}

#[napi]
impl Store {
    /// Opens or creates a store in `dataDir`.
    #[napi(constructor)]
    pub fn new(data_dir: String) -> Result<Self> {
        CoreStore::open(&data_dir).map(|inner| Self { inner }).map_err(native)
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

/// Copies every parameter into owned bytes so the borrows outlive the lock.
fn param_buffers(params: &[ParamInfo]) -> Result<Vec<(u16, Option<Vec<u8>>)>> {
    let mut owned = Vec::with_capacity(params.len());
    for param in params {
        let format = u16::try_from(param.format).map_err(|_| Error::from_reason("parameter format does not fit 16 bits"))?;
        if format > 1 {
            return Err(Error::from_reason("parameter format is 0 for text and 1 for binary"));
        }
        owned.push((format, param.value.as_ref().map(|buffer| buffer.to_vec())));
    }
    Ok(owned)
}

fn result_formats_u16(formats: Vec<u32>) -> Result<Vec<u16>> {
    let mut codes = Vec::with_capacity(formats.len());
    for format in formats {
        let code = u16::try_from(format).map_err(|_| Error::from_reason("result format does not fit 16 bits"))?;
        if code > 1 {
            return Err(Error::from_reason("result format is 0 for text and 1 for binary"));
        }
        codes.push(code);
    }
    Ok(codes)
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

/// One mutation inside a `ServerStore` commit batch.
#[napi(object)]
pub struct ServerStoreChange {
    /// `put` or `delete`.
    pub kind: String,
    pub namespace: String,
    pub key: Buffer,
    /// Required for `put`, ignored for `delete`.
    pub value: Option<Buffer>,
}

/// One row returned by `ServerStore.scan`.
#[napi(object)]
pub struct ServerStoreRow {
    pub key: Buffer,
    pub value: Buffer,
}

/// One durable server data directory: `.yyds` catalog, `.yykv` shard and lock.
#[napi]
pub struct ServerStore {
    inner: Mutex<Option<CoreServerStore>>,
}

fn with_server_store<T>(
    inner: &Mutex<Option<CoreServerStore>>,
    run: impl FnOnce(&mut CoreServerStore) -> Result<T>,
) -> Result<T> {
    let mut guard = inner.lock().map_err(|_| Error::from_reason("server store lock poisoned"))?;
    let store = guard.as_mut().ok_or_else(|| Error::from_reason("server store is closed"))?;
    run(store)
}

#[napi]
impl ServerStore {
    /// Opens or creates the data directory and takes its lock.
    #[napi(constructor)]
    pub fn new(data_dir: String) -> Result<Self> {
        CoreServerStore::open(&data_dir).map(|inner| Self { inner: Mutex::new(Some(inner)) }).map_err(native)
    }

    /// Ordered prefix scan inside one namespace.
    #[napi]
    pub fn scan(
        &self,
        namespace: String,
        prefix: Buffer,
        after: Option<Buffer>,
        before: Option<Buffer>,
        limit: u32,
    ) -> Result<Vec<ServerStoreRow>> {
        with_server_store(&self.inner, |store| {
            store.scan(&namespace, prefix.as_ref(), after.as_deref(), before.as_deref(), limit as usize).map_err(native)
        })
        .map(|rows| {
            rows.into_iter().map(|row| ServerStoreRow { key: Buffer::from(row.key), value: Buffer::from(row.value) }).collect()
        })
    }

    /// Applies one batch as a single durable atomic commit.
    #[napi]
    pub fn commit_changes(&self, changes: Vec<ServerStoreChange>) -> Result<()> {
        let mut batch = Vec::with_capacity(changes.len());
        for change in changes {
            batch.push(match change.kind.as_str() {
                "put" => CoreServerChange::Put {
                    namespace: change.namespace,
                    key: change.key.to_vec(),
                    value: change.value.ok_or_else(|| Error::from_reason("put change carries no value"))?.to_vec(),
                },
                "delete" => CoreServerChange::Delete { namespace: change.namespace, key: change.key.to_vec() },
                other => return Err(Error::from_reason(format!("unknown server store change kind {other}"))),
            });
        }
        with_server_store(&self.inner, |store| store.commit_changes(batch).map_err(native))
    }

    /// Releases the directory lock.
    #[napi]
    pub fn close(&self) -> Result<()> {
        let mut guard = self.inner.lock().map_err(|_| Error::from_reason("server store lock poisoned"))?;
        if let Some(store) = guard.take() {
            store.close().map_err(native)?;
        }
        Ok(())
    }

    /// Whether every commit survives process exit.
    #[napi]
    pub fn durable_atomic_commit(&self) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(CoreServerStore::durable_atomic_commit))
            .unwrap_or(false)
    }

    /// Data directory.
    #[napi]
    pub fn data_dir(&self) -> Result<String> {
        with_server_store(&self.inner, |store| Ok(store.data_dir()))
    }

    /// `.yykv` shard path.
    #[napi]
    pub fn shard_path(&self) -> Result<String> {
        with_server_store(&self.inner, |store| Ok(store.shard_path()))
    }

    /// `.yyds` catalog path.
    #[napi]
    pub fn catalog_path(&self) -> Result<String> {
        with_server_store(&self.inner, |store| Ok(store.catalog_path()))
    }

    /// `postmaster.pid` lock path.
    #[napi]
    pub fn lock_path(&self) -> Result<String> {
        with_server_store(&self.inner, |store| Ok(store.lock_path()))
    }
}
