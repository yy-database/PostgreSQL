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

use database::harness::{
    Baseline, BaselineIdentity, DifferenceObservation, Digest, GatePolicy, ReportEnvelope, Stats, SuiteReport, check_baseline,
    evaluate, per_op_ms, render_json, summarize,
};
use database_client::pgsql::{
    ServerChange as CoreServerChange, ServerStore as CoreServerStore, Store as CoreStore,
    client::{ClientConfig, Column, Connection as CoreConnection, Param as PostgresParam, QueryResult},
    error::{MessageField, Notice, PostgresError},
    psql::{PsqlOptions, format_results, parse_arguments},
};
use database_protocol_pgsql as protocol;

/// Where to connect and which identity to present.
#[napi(object)]
pub struct ClientOptions {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    /// Password for cleartext, MD5 or SCRAM-SHA-256 authentication.
    pub password: Option<String>,
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

/// One result column together with the type OID the server assigned.
#[napi(object)]
#[derive(Clone)]
pub struct TypedColumnInfo {
    pub name: String,
    pub type_oid: u32,
}

/// One extended-protocol result set that kept its column type OIDs.
#[napi(object)]
pub struct TypedStatementResult {
    pub columns: Vec<TypedColumnInfo>,
    pub rows: Vec<DataRow>,
    pub tag: String,
}

/// Outcome of one typed extended-protocol round trip.
///
/// A server `ErrorResponse` arrives decoded in `error`; only transport and
/// protocol failures throw, because those leave the connection unusable.
#[napi(object)]
pub struct TypedExecutionReport {
    pub results: Vec<TypedStatementResult>,
    /// The decoded server error, or `null` when the statement succeeded.
    pub error: Option<ErrorInfo>,
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

    /// Runs one statement through the unnamed extended-protocol round trip and
    /// keeps each result column's `RowDescription` type OID.
    ///
    /// A server error is returned decoded in `error` instead of thrown, so the
    /// caller can read `SQLSTATE`, detail and constraint fields. Transport and
    /// protocol failures still throw because they poison the connection.
    #[napi]
    pub fn execute_with_params_typed(
        &self,
        sql: String,
        params: Vec<Option<String>>,
        types: Vec<u32>,
    ) -> Result<TypedExecutionReport> {
        let owned: Vec<PostgresParam<'_>> = params.iter().map(|value| PostgresParam::text(value.as_deref())).collect();
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let connection = guard.as_mut().ok_or_else(closed_error)?;
        match connection.execute_with_param_formats_typed(&sql, &owned, &types, &[]) {
            Ok(results) => Ok(TypedExecutionReport {
                results: results
                    .into_iter()
                    .map(|result| TypedStatementResult {
                        columns: result
                            .columns
                            .into_iter()
                            .map(|column| TypedColumnInfo { name: column.name, type_oid: column.type_oid })
                            .collect(),
                        rows: result.rows.into_iter().map(|values| DataRow { values }).collect(),
                        tag: result.tag,
                    })
                    .collect(),
                error: None,
            }),
            Err(error @ PostgresError::Server { .. }) => {
                Ok(TypedExecutionReport { results: Vec::new(), error: error_info(&error) })
            }
            Err(error) => Err(native(error)),
        }
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
    let config = match options.password {
        Some(password) => config.with_password(password),
        None => config,
    };
    CoreConnection::open(&config).map(|inner| Connection { inner: Arc::new(Mutex::new(Some(inner))) }).map_err(native)
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
    protocol::message_fields(payload.as_ref()).map(|fields| fields.iter().map(message_field_info).collect()).map_err(native)
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

/// Whether a process with this id is still running, the way PostgreSQL checks
/// `postmaster.pid` before refusing a data directory.
///
/// Windows opens the process with `PROCESS_QUERY_LIMITED_INFORMATION` and
/// treats `STILL_ACTIVE` as alive; Unix sends signal `0`, where success or
/// `EPERM` both mean the process exists. PID reuse is accepted exactly as
/// PostgreSQL accepts it: a recycled id keeps the lock owned.
#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    use std::ffi::c_void;

    type Dword = u32;
    type Handle = *mut c_void;
    const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x1000;
    const STILL_ACTIVE: Dword = 259;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(desired_access: Dword, inherit_handle: i32, process_id: Dword) -> Handle;
        fn GetExitCodeProcess(process: Handle, exit_code: *mut Dword) -> i32;
        fn CloseHandle(object: Handle) -> i32;
    }

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code: Dword = 0;
        let queried = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        queried && code == STILL_ACTIVE
    }
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    const EPERM: i32 = 1;

    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    #[cfg(target_os = "macos")]
    unsafe extern "C" {
        fn __error() -> *mut i32;
    }
    #[cfg(not(target_os = "macos"))]
    unsafe extern "C" {
        fn __errno_location() -> *mut i32;
    }

    let Ok(pid) = i32::try_from(pid)
    else {
        return false;
    };
    unsafe {
        if kill(pid, 0) == 0 {
            return true;
        }
        #[cfg(target_os = "macos")]
        let errno_ptr = __error();
        #[cfg(not(target_os = "macos"))]
        let errno_ptr = __errno_location();
        *errno_ptr == EPERM
    }
}

#[cfg(not(any(windows, unix)))]
fn process_exists(_pid: u32) -> bool {
    true
}

/// Drops a `postmaster.pid` whose recorded process is gone, so the next
/// `ServerStore::open` takes the directory instead of asking the operator to
/// delete the file. A live holder, an unreadable file or an unparseable first
/// line all leave the lock in place and let the open fail as before.
fn clear_stale_lock(data_dir: &str) {
    let lock = std::path::Path::new(data_dir).join(database_client::pgsql::postmaster::LOCK_FILE);
    let Ok(bytes) = std::fs::read(&lock)
    else {
        return;
    };
    let text = String::from_utf8_lossy(&bytes);
    let Some(first) = text.lines().next()
    else {
        return;
    };
    let Ok(pid) = first.trim().parse::<u32>()
    else {
        return;
    };
    if process_exists(pid) {
        return;
    }
    let _ = std::fs::remove_file(&lock);
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
    /// Opens or creates the data directory and takes its lock, reclaiming a
    /// `postmaster.pid` whose holder process is gone.
    #[napi(constructor)]
    pub fn new(data_dir: String) -> Result<Self> {
        clear_stale_lock(&data_dir);
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

    /// Flat transfer form of [`Self::scan`]: one `Buffer` for the whole result.
    ///
    /// Layout is `u32le` row count, then per row `u32le` key length, `u32le`
    /// value length, key bytes, value bytes. One boundary crossing replaces the
    /// per-row object and the two per-row `Buffer` copies, which is what a
    /// thousand-row relation load pays for; the caller reads rows as zero-copy
    /// views. The bytes are the same rows `scan` returns, in the same order.
    #[napi]
    pub fn scan_flat(
        &self,
        namespace: String,
        prefix: Buffer,
        after: Option<Buffer>,
        before: Option<Buffer>,
        limit: u32,
    ) -> Result<Buffer> {
        let rows = with_server_store(&self.inner, |store| {
            store.scan(&namespace, prefix.as_ref(), after.as_deref(), before.as_deref(), limit as usize).map_err(native)
        })?;
        let mut bytes: Vec<u8> =
            Vec::with_capacity(4 + rows.iter().map(|row| 8 + row.key.len() + row.value.len()).sum::<usize>());
        bytes.extend_from_slice(&(rows.len() as u32).to_le_bytes());
        for row in &rows {
            bytes.extend_from_slice(&(row.key.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&(row.value.len() as u32).to_le_bytes());
            bytes.extend_from_slice(&row.key);
            bytes.extend_from_slice(&row.value);
        }
        Ok(Buffer::from(bytes))
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
        self.inner.lock().ok().and_then(|guard| guard.as_ref().map(CoreServerStore::durable_atomic_commit)).unwrap_or(false)
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

fn harness_error(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

/// 对给定字节取 SHA-256，返回小写十六进制。
#[napi]
pub fn harness_digest(bytes: Buffer) -> String {
    Digest::of(bytes.as_ref()).to_hex()
}

/// 按已知差异台账判定一次语料运行。
#[napi]
pub fn harness_check_baseline(baseline_json: String, current_json: String, observed_json: String) -> Result<String> {
    let baseline: Baseline = serde_json::from_str(&baseline_json).map_err(harness_error)?;
    let current: BaselineIdentity = serde_json::from_str(&current_json).map_err(harness_error)?;
    let observed: Vec<DifferenceObservation> = serde_json::from_str(&observed_json).map_err(harness_error)?;
    let verdict = check_baseline(&baseline, &current, &observed);
    serde_json::to_string(&verdict).map_err(harness_error)
}

/// 将报告信封渲染为稳定 JSON 文本。
#[napi]
pub fn harness_render_report(report_json: String) -> Result<String> {
    let report: ReportEnvelope = serde_json::from_str(&report_json).map_err(harness_error)?;
    render_json(&report).map_err(harness_error)
}

/// 门禁判定：消费执行状态、oracle 资格、证据与 floors，失败关闭，不用单个
/// `ok` 掩盖未验证项。
///
/// `input_json` 是 `{ "suites": [SuiteReport..], "policy": GatePolicy }` 的
/// serde 形态（核心类型 snake_case 字段），返回 `GateVerdict` 的 JSON。测试
/// 输出解析与 floor 数值由调用方持有，判定算法在上游 `database.harness` 统一
/// 维护：skipped 即红、failed 记问题、逐条 floor 比较，任一问题即 `ok = false`。
#[napi]
pub fn harness_evaluate_gate(input_json: String) -> Result<String> {
    #[derive(serde::Deserialize)]
    struct GateInput {
        suites: Vec<SuiteReport>,
        #[serde(default)]
        policy: GatePolicy,
    }
    let input: GateInput = serde_json::from_str(&input_json).map_err(harness_error)?;
    let gate = evaluate(&input.suites, &input.policy);
    serde_json::to_string(&gate).map_err(harness_error)
}

/// 基准统计的 JS 形态。字段名由本 DTO 负责 camelCase，核心 `Stats` 说 Rust。
#[napi(object)]
pub struct BenchStatsJson {
    pub median_ms: f64,
    pub p95_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub rounds: u32,
}

impl From<Stats> for BenchStatsJson {
    fn from(stats: Stats) -> Self {
        Self {
            median_ms: stats.median_ms,
            p95_ms: stats.p95_ms,
            min_ms: stats.min_ms,
            max_ms: stats.max_ms,
            rounds: stats.rounds,
        }
    }
}

/// 对一组毫秒样本求 median/p95/极值（nearest-rank，判定公式在上游 `database.harness`
/// 的 golden vector 钉死），基准脚本的统计口径统一走这里，不在 JS 侧另写一份。
#[napi]
pub fn harness_bench_summary(samples_ms: Vec<f64>) -> Result<BenchStatsJson> {
    summarize(&samples_ms).map(Into::into).map_err(harness_error)
}

/// 单次操作的归一毫秒（median / ops）。`ops` 为 0 时返回 NaN。
#[napi]
pub fn harness_bench_per_op(stats: BenchStatsJson, ops: u32) -> Result<f64> {
    per_op_ms(
        &Stats {
            median_ms: stats.median_ms,
            p95_ms: stats.p95_ms,
            min_ms: stats.min_ms,
            max_ms: stats.max_ms,
            rounds: stats.rounds,
        },
        u64::from(ops),
    )
    .map_err(harness_error)
}
