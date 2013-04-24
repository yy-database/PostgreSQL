//! PyO3 bindings for the PostgreSQL protocol-v3, `.yyds`/`.yykv` store and
//! `psql` primitives.
//!
//! Each export is one independently callable building block: connect, execute a
//! statement, frame a packet, decode one response message, persist one row,
//! normalize one command line. No global state, no command loop and no server.
//! Command lines and emulation compose these in Python.

use std::sync::{Arc, Mutex};

use pyo3::{create_exception, exceptions::PyException, prelude::*};

use database_client::pgsql::{
    ServerChange as CoreServerChange, ServerStore as CoreServerStore, Store as CoreStore,
    client::{ClientConfig, Column, Connection as CoreConnection, Param as CoreParam, QueryResult},
    error::{MessageField, Notice, PostgresError as CoreError},
    psql::{PsqlOptions as CoreOptions, format_results, parse_arguments},
};
use database_protocol_pgsql as protocol;

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

/// One `ErrorResponse` or `NoticeResponse` field, kept in wire order.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct MessageFieldInfo {
    /// One-byte selector from the protocol, such as `C` or `P`.
    #[pyo3(get)]
    kind: String,
    #[pyo3(get)]
    value: String,
}

#[pymethods]
impl MessageFieldInfo {
    #[new]
    fn new(kind: String, value: String) -> Self {
        Self { kind, value }
    }
}

/// A server error together with every field the server sent, in wire order.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct ErrorInfo {
    #[pyo3(get)]
    code: String,
    #[pyo3(get)]
    message: String,
    #[pyo3(get)]
    fields: Vec<MessageFieldInfo>,
}

#[pymethods]
impl ErrorInfo {
    #[new]
    fn new(code: String, message: String, fields: Vec<MessageFieldInfo>) -> Self {
        Self { code, message, fields }
    }
}

/// One `NoticeResponse` the server emitted while a statement ran.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct NoticeInfo {
    #[pyo3(get)]
    fields: Vec<MessageFieldInfo>,
}

#[pymethods]
impl NoticeInfo {
    #[new]
    fn new(fields: Vec<MessageFieldInfo>) -> Self {
        Self { fields }
    }
}

/// Outcome of one simple-query batch.
///
/// `results` holds every statement that finished, `error` the failure that
/// stopped the batch, and `notices` every notice in wire order.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct ExecutionReport {
    #[pyo3(get)]
    results: Vec<StatementResult>,
    #[pyo3(get)]
    error: Option<ErrorInfo>,
    #[pyo3(get)]
    notices: Vec<NoticeInfo>,
}

#[pymethods]
impl ExecutionReport {
    #[new]
    fn new(results: Vec<StatementResult>, error: Option<ErrorInfo>, notices: Vec<NoticeInfo>) -> Self {
        Self { results, error, notices }
    }
}

/// Outcome of one `COPY ... FROM STDIN` round trip.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct CopyInReport {
    #[pyo3(get)]
    tag: String,
    #[pyo3(get)]
    error: Option<ErrorInfo>,
    #[pyo3(get)]
    notices: Vec<NoticeInfo>,
}

#[pymethods]
impl CopyInReport {
    #[new]
    fn new(tag: String, error: Option<ErrorInfo>, notices: Vec<NoticeInfo>) -> Self {
        Self { tag, error, notices }
    }
}

/// Outcome of one `COPY ... TO STDOUT` round trip.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct CopyOutReport {
    /// Every `CopyData` payload concatenated in wire order.
    #[pyo3(get)]
    data: Vec<u8>,
    #[pyo3(get)]
    tag: String,
    #[pyo3(get)]
    error: Option<ErrorInfo>,
    #[pyo3(get)]
    notices: Vec<NoticeInfo>,
}

#[pymethods]
impl CopyOutReport {
    #[new]
    fn new(data: Vec<u8>, tag: String, error: Option<ErrorInfo>, notices: Vec<NoticeInfo>) -> Self {
        Self { data, tag, error, notices }
    }
}

/// One decoded `CopyInResponse`, `CopyOutResponse` or `CopyBothResponse`.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct CopyResponseInfo {
    /// `0` for text and `1` for binary.
    #[pyo3(get)]
    format: u32,
    #[pyo3(get)]
    columns: u32,
    #[pyo3(get)]
    column_formats: Vec<u32>,
}

#[pymethods]
impl CopyResponseInfo {
    #[new]
    fn new(format: u32, columns: u32, column_formats: Vec<u32>) -> Self {
        Self { format, columns, column_formats }
    }
}

/// One named portal bound to a prepared statement.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct PortalInfo {
    #[pyo3(get)]
    name: String,
    #[pyo3(get)]
    parameters: Vec<u32>,
    #[pyo3(get)]
    columns: Vec<ColumnInfo>,
}

#[pymethods]
impl PortalInfo {
    #[new]
    fn new(name: String, parameters: Vec<u32>, columns: Vec<ColumnInfo>) -> Self {
        Self { name, parameters, columns }
    }
}

/// One `Execute` round trip on a portal.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct PortalExecReport {
    /// Rows produced by this batch.
    #[pyo3(get)]
    results: Vec<StatementResult>,
    /// `True` when the server stopped at the row limit with rows still waiting.
    #[pyo3(get)]
    suspended: bool,
}

#[pymethods]
impl PortalExecReport {
    #[new]
    fn new(results: Vec<StatementResult>, suspended: bool) -> Self {
        Self { results, suspended }
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
    #[allow(clippy::too_many_arguments)]
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

/// One socket in the protocol-v3 simple and extended query modes.
#[pyclass]
pub struct Connection {
    inner: Arc<Mutex<Option<CoreConnection>>>,
}

#[pymethods]
impl Connection {
    /// Runs one statement and returns every result set it produced.
    fn execute(&self, sql: &str) -> PyResult<Vec<StatementResult>> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        connection.execute(sql).map(|results| results.into_iter().map(statement).collect()).map_err(native)
    }

    /// Runs one simple-query batch and keeps the statements that already finished.
    ///
    /// Unlike `execute`, a failure in a later statement does not discard earlier
    /// results: the report carries results, error and notices in server order.
    fn execute_report(&self, sql: &str) -> PyResult<ExecutionReport> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        let report = connection.execute_report(sql).map_err(native)?;
        Ok(ExecutionReport {
            results: report.results.into_iter().map(statement).collect(),
            error: report.error.as_ref().and_then(error_info),
            notices: report.notices.iter().map(notice_info).collect(),
        })
    }

    /// Drains every notice received by `execute` calls so far, in wire order.
    fn take_notices(&self) -> PyResult<Vec<NoticeInfo>> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        Ok(connection.take_notices().iter().map(notice_info).collect())
    }

    /// The `BackendKeyData` from startup as `(process_id, secret_key)`.
    fn backend_key_data(&self) -> PyResult<Option<(i32, i32)>> {
        let guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_ref()
        else {
            return Err(closed_error());
        };
        Ok(connection.backend_key_data().map(|key| (key.process_id, key.secret_key)))
    }

    /// Sends a `CancelRequest` on a fresh socket and closes it.
    ///
    /// PostgreSQL answers nothing there, so success only means the packet left
    /// this process. The main socket is untouched.
    fn cancel(&self) -> PyResult<()> {
        let guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_ref()
        else {
            return Err(closed_error());
        };
        connection.cancel().map_err(native)
    }

    /// Runs one parameterised statement through an unnamed prepared statement.
    /// `types` lists parameter OIDs; pass an empty list to let the server infer.
    fn execute_with_params(&self, sql: &str, params: Vec<Option<String>>, types: Vec<u32>) -> PyResult<Vec<StatementResult>> {
        let values: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        connection
            .execute_with_params(sql, &values, &types)
            .map(|results| results.into_iter().map(statement).collect())
            .map_err(native)
    }

    /// Prepares a named statement and describes its parameters and columns.
    fn prepare(&self, sql: &str, types: Vec<u32>) -> PyResult<PreparedStatement> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        let prepared = connection.prepare(sql, &types).map_err(native)?;
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
    fn execute_prepared(&self, name: &str, params: Vec<Option<String>>) -> PyResult<Vec<StatementResult>> {
        let values: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        connection.execute_prepared(name, &values).map(|results| results.into_iter().map(statement).collect()).map_err(native)
    }

    /// Closes a prepared statement by server-side name.
    fn close_prepared(&self, name: &str) -> PyResult<()> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        connection.close_prepared(name).map_err(native)
    }

    /// Runs one parameterised statement with explicit text or binary parameters
    /// and result formats.
    ///
    /// `params` holds `(format, value)` pairs where `format` is `0` for text and
    /// `1` for binary. `result_formats` is empty for text, one code for every
    /// column, or one code per column.
    #[pyo3(signature = (sql, params, types, result_formats))]
    fn execute_with_param_formats(
        &self,
        sql: &str,
        params: Vec<(u32, Option<Vec<u8>>)>,
        types: Vec<u32>,
        result_formats: Vec<u32>,
    ) -> PyResult<Vec<StatementResult>> {
        let owned = param_buffers(&params)?;
        let values: Vec<CoreParam<'_>> =
            owned.iter().map(|(format, value)| CoreParam { format: *format, value: value.as_deref() }).collect();
        let formats = result_formats_u16(&result_formats)?;
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        connection
            .execute_with_param_formats(sql, &values, &types, &formats)
            .map(|results| results.into_iter().map(statement).collect())
            .map_err(native)
    }

    /// Executes a prepared statement with explicit text or binary parameters.
    #[pyo3(signature = (name, params, result_formats))]
    fn execute_prepared_formats(
        &self,
        name: &str,
        params: Vec<(u32, Option<Vec<u8>>)>,
        result_formats: Vec<u32>,
    ) -> PyResult<Vec<StatementResult>> {
        let owned = param_buffers(&params)?;
        let values: Vec<CoreParam<'_>> =
            owned.iter().map(|(format, value)| CoreParam { format: *format, value: value.as_deref() }).collect();
        let formats = result_formats_u16(&result_formats)?;
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        connection
            .execute_prepared_formats(name, &values, &formats)
            .map(|results| results.into_iter().map(statement).collect())
            .map_err(native)
    }

    /// Binds a named portal so it can be executed more than once.
    #[pyo3(signature = (statement, portal, params, result_formats))]
    fn bind_portal(
        &self,
        statement: &str,
        portal: &str,
        params: Vec<(u32, Option<Vec<u8>>)>,
        result_formats: Vec<u32>,
    ) -> PyResult<PortalInfo> {
        let owned = param_buffers(&params)?;
        let values: Vec<CoreParam<'_>> =
            owned.iter().map(|(format, value)| CoreParam { format: *format, value: value.as_deref() }).collect();
        let formats = result_formats_u16(&result_formats)?;
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        let portal = connection.bind_portal(statement, portal, &values, &formats).map_err(native)?;
        Ok(PortalInfo {
            name: portal.name,
            parameters: portal.parameters,
            columns: portal.columns.into_iter().map(|column| ColumnInfo { name: column.name }).collect(),
        })
    }

    /// Executes an open portal. `max_rows` of `0` runs it to completion.
    fn execute_portal(&self, portal: &str, max_rows: i32) -> PyResult<PortalExecReport> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        let report = connection.execute_portal(portal, max_rows).map_err(native)?;
        Ok(PortalExecReport { results: report.results.into_iter().map(statement).collect(), suspended: report.suspended })
    }

    /// Closes a portal by server-side name.
    fn close_portal(&self, name: &str) -> PyResult<()> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        connection.close_portal(name).map_err(native)
    }

    /// Streams `chunks` as `COPY ... FROM STDIN` data for one statement.
    ///
    /// Data is only written after the server answered `CopyInResponse`. A
    /// failure keeps its tag, error and notices instead of raising, so the
    /// caller can tell how many rows the server accepted.
    fn copy_in(&self, sql: &str, chunks: Vec<Vec<u8>>) -> PyResult<CopyInReport> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        let slices: Vec<&[u8]> = chunks.iter().map(|chunk| chunk.as_slice()).collect();
        let report = connection.copy_in(sql, &slices).map_err(native)?;
        Ok(CopyInReport {
            tag: report.tag,
            error: report.error.as_ref().and_then(error_info),
            notices: report.notices.iter().map(notice_info).collect(),
        })
    }

    /// Collects every `CopyData` payload of one `COPY ... TO STDOUT` statement.
    ///
    /// A failure keeps the bytes that already arrived instead of discarding them.
    fn copy_out(&self, sql: &str) -> PyResult<CopyOutReport> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        let report = connection.copy_out(sql).map_err(native)?;
        Ok(CopyOutReport {
            data: report.data,
            tag: report.tag,
            error: report.error.as_ref().and_then(error_info),
            notices: report.notices.iter().map(notice_info).collect(),
        })
    }

    /// Shuts the socket down on the wire.
    fn close(&self) -> PyResult<()> {
        let mut guard = self.inner.lock().map_err(|_| lock_error())?;
        let Some(mut connection) = guard.take()
        else {
            return Err(closed_error());
        };
        connection.disconnect().map_err(native)
    }
}

/// One named prepared statement on a live connection.
#[pyclass]
pub struct PreparedStatement {
    connection: Arc<Mutex<Option<CoreConnection>>>,
    name: String,
    parameters: Vec<u32>,
    columns: Vec<ColumnInfo>,
    closed: bool,
}

#[pymethods]
impl PreparedStatement {
    /// Server-side statement name.
    #[getter]
    fn name(&self) -> String {
        self.name.clone()
    }

    /// Parameter OIDs resolved by the server, in declaration order.
    #[getter]
    fn parameters(&self) -> Vec<u32> {
        self.parameters.clone()
    }

    /// Columns the statement returns; empty when it returns no row set.
    #[getter]
    fn columns(&self) -> Vec<ColumnInfo> {
        self.columns.clone()
    }

    /// Whether `close` already ran.
    #[getter]
    fn is_closed(&self) -> bool {
        self.closed
    }

    /// Binds parameters and runs the statement.
    fn execute(&mut self, params: Vec<Option<String>>) -> PyResult<Vec<StatementResult>> {
        if self.closed {
            return Err(PostgresError::new_err("statement is closed"));
        }
        let values: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
        let mut guard = self.connection.lock().map_err(|_| lock_error())?;
        let Some(connection) = guard.as_mut()
        else {
            return Err(closed_error());
        };
        connection
            .execute_prepared(&self.name, &values)
            .map(|results| results.into_iter().map(statement).collect())
            .map_err(native)
    }

    /// Closes the server-side statement. Calling it twice is a no-op.
    fn close(&mut self) -> PyResult<()> {
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
#[pyfunction]
fn connect(host: &str, port: u16, user: &str, database: &str) -> PyResult<Connection> {
    let config = ClientConfig::new(host, port, user, database);
    CoreConnection::open(&config).map(|inner| Connection { inner: Arc::new(Mutex::new(Some(inner))) }).map_err(native)
}

/// Package version of this binding.
#[pyfunction]
fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Protocol 3.0 number carried by the startup packet.
#[pyfunction]
fn protocol_version() -> u32 {
    protocol::PROTOCOL_VERSION
}

/// Message length ceiling accepted by the client.
#[pyfunction]
fn max_message_bytes() -> u32 {
    protocol::MAX_MESSAGE_BYTES as u32
}

/// Builds the startup packet for one identity.
#[pyfunction]
fn encode_startup_packet(user: &str, database: &str) -> Vec<u8> {
    protocol::startup_packet(user, database)
}

/// Builds one simple-query `Query` message.
#[pyfunction]
fn encode_query_packet(sql: &str) -> PyResult<Vec<u8>> {
    protocol::query_packet(sql).map_err(native)
}

/// Builds the 16-byte `CancelRequest` sent on its own connection.
#[pyfunction]
fn encode_cancel_request(process_id: i32, secret_key: i32) -> Vec<u8> {
    protocol::cancel_request_packet(process_id, secret_key)
}

/// Decodes an `ErrorResponse` payload into `(code, message)`.
#[pyfunction]
fn decode_error_response(payload: Vec<u8>) -> PyResult<(String, String)> {
    match protocol::error_response(&payload) {
        CoreError::Server { code, message, .. } => Ok((code, message)),
        other => Err(native(other)),
    }
}

/// Decodes the ordered fields of an `ErrorResponse` payload.
#[pyfunction]
fn decode_error_fields(payload: Vec<u8>) -> PyResult<Vec<MessageFieldInfo>> {
    protocol::message_fields(&payload).map(|fields| fields.iter().map(message_field_info).collect()).map_err(native)
}

/// Decodes the ordered fields of a `NoticeResponse` payload.
#[pyfunction]
fn decode_notice_fields(payload: Vec<u8>) -> PyResult<Vec<MessageFieldInfo>> {
    protocol::notice_response(&payload).map(|notice| notice.fields.iter().map(message_field_info).collect()).map_err(native)
}

/// Decodes the column names of a `RowDescription`.
#[pyfunction]
fn decode_row_description(payload: Vec<u8>) -> PyResult<Vec<String>> {
    protocol::column_names(&payload).map_err(native)
}

/// Decodes the cells of a `DataRow`.
#[pyfunction]
fn decode_data_row(payload: Vec<u8>, columns: usize) -> PyResult<Vec<Option<String>>> {
    protocol::data_row(&payload, columns).map_err(native)
}

/// Decodes the command tag of a `CommandComplete`.
#[pyfunction]
fn decode_command_tag(payload: Vec<u8>) -> PyResult<String> {
    protocol::command_tag(&payload).map_err(native)
}

/// Builds one extended-protocol `Parse` message. `param_types` holds OIDs;
/// an empty list lets the server infer every parameter.
#[pyfunction]
fn encode_parse_message(name: &str, sql: &str, param_types: Vec<u32>) -> PyResult<Vec<u8>> {
    protocol::parse_packet(name, sql, &param_types).map_err(native)
}

/// Builds one extended-protocol `Bind` message. Parameters are text values and
/// `None` is SQL `NULL`. `result_format` is `0` for text columns and `1` for
/// binary ones.
#[pyfunction]
fn encode_bind_message(portal: &str, statement: &str, params: Vec<Option<String>>, result_format: u16) -> PyResult<Vec<u8>> {
    let values: Vec<Option<&str>> = params.iter().map(|value| value.as_deref()).collect();
    protocol::bind_packet(portal, statement, &values, result_format).map_err(native)
}

/// Builds one extended-protocol `Bind` message with explicit parameter and
/// result format codes.
#[pyfunction]
fn encode_bind_message_with_formats(
    portal: &str,
    statement: &str,
    params: Vec<(u32, Option<Vec<u8>>)>,
    param_formats: Vec<u32>,
    result_formats: Vec<u32>,
) -> PyResult<Vec<u8>> {
    let owned = param_buffers(&params)?;
    let values: Vec<Option<&[u8]>> = owned.iter().map(|(_, value)| value.as_deref()).collect();
    let param_codes = result_formats_u16(&param_formats)?;
    let result_codes = result_formats_u16(&result_formats)?;
    protocol::bind_packet_with_formats(portal, statement, &values, &param_codes, &result_codes).map_err(native)
}

/// Builds one extended-protocol `Describe` message for a statement or portal.
#[pyfunction]
fn encode_describe_message(target: &str, name: &str) -> PyResult<Vec<u8>> {
    let kind = describe_target(target)?;
    protocol::describe_packet(kind, name).map_err(native)
}

/// Builds one extended-protocol `Execute` message. `max_rows` of `0` runs the
/// portal to completion and a positive limit suspends it after that many rows.
#[pyfunction]
fn encode_execute_message(portal: &str, max_rows: i32) -> PyResult<Vec<u8>> {
    protocol::execute_packet(portal, max_rows).map_err(native)
}

/// Builds the `Sync` message that ends an extended-protocol round trip.
#[pyfunction]
fn encode_sync_message() -> Vec<u8> {
    protocol::sync_packet()
}

/// Builds one extended-protocol `Close` message for a statement or portal.
#[pyfunction]
fn encode_close_message(target: &str, name: &str) -> PyResult<Vec<u8>> {
    let kind = describe_target(target)?;
    protocol::close_packet(kind, name).map_err(native)
}

/// Decodes the parameter OIDs of a `ParameterDescription`.
#[pyfunction]
fn decode_parameter_description(payload: Vec<u8>) -> PyResult<Vec<u32>> {
    protocol::parameter_description(&payload).map_err(native)
}

/// Builds one `CopyData` message carrying a chunk of the copy stream.
#[pyfunction]
fn encode_copy_data(data: Vec<u8>) -> PyResult<Vec<u8>> {
    protocol::copy_data_packet(&data).map_err(native)
}

/// Builds the `CopyDone` message that ends a `COPY ... FROM STDIN` stream.
#[pyfunction]
fn encode_copy_done() -> Vec<u8> {
    protocol::copy_done_packet()
}

/// Builds a `CopyFail` message carrying a human readable reason.
#[pyfunction]
fn encode_copy_fail(reason: &str) -> PyResult<Vec<u8>> {
    protocol::copy_fail_packet(reason).map_err(native)
}

/// Decodes a `CopyInResponse`, `CopyOutResponse` or `CopyBothResponse` payload.
#[pyfunction]
fn decode_copy_response(payload: Vec<u8>) -> PyResult<CopyResponseInfo> {
    let response = protocol::copy_response(&payload).map_err(native)?;
    Ok(CopyResponseInfo {
        format: response.format as u32,
        columns: response.columns as u32,
        column_formats: response.column_formats.into_iter().map(u32::from).collect(),
    })
}

/// OID of the named SQL type, or `None` when the mapping has no entry.
#[pyfunction]
fn parameter_type_oid(name: &str) -> Option<u32> {
    protocol::parameter_type_oid(name)
}

/// Text-format `bytea` value: `\x` plus lowercase hexadecimal.
#[pyfunction]
fn encode_bytea(bytes: Vec<u8>) -> String {
    protocol::encode_bytea(&bytes)
}

/// Parses the supported `psql` flags.
#[pyfunction]
fn parse_psql_arguments(args: Vec<String>) -> PyResult<PsqlOptions> {
    parse_arguments(&args).map(PsqlOptions::from).map_err(PostgresError::new_err)
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
    inner: CoreStore,
}

#[pymethods]
impl Store {
    #[new]
    fn new(data_dir: String) -> PyResult<Self> {
        CoreStore::open(&data_dir).map(|inner| Self { inner }).map_err(native)
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
        self.inner.scan(&namespace, &prefix).into_iter().map(|(key, value)| StoreRow { key, value }).collect()
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

/// One mutation inside a `ServerStore` commit batch.
#[pyclass(from_py_object)]
#[derive(Clone)]
pub struct ServerStoreChange {
    /// `put` or `delete`.
    #[pyo3(get)]
    kind: String,
    #[pyo3(get)]
    namespace: String,
    #[pyo3(get)]
    key: Vec<u8>,
    /// Required for `put`, ignored for `delete`.
    #[pyo3(get)]
    value: Option<Vec<u8>>,
}

#[pymethods]
impl ServerStoreChange {
    #[new]
    fn new(kind: String, namespace: String, key: Vec<u8>, value: Option<Vec<u8>>) -> Self {
        Self { kind, namespace, key, value }
    }
}

/// One durable server data directory: `.yyds` catalog, `.yykv` shard and lock.
#[pyclass]
pub struct ServerStore {
    inner: Mutex<Option<CoreServerStore>>,
}

#[pymethods]
impl ServerStore {
    #[new]
    fn new(data_dir: String) -> PyResult<Self> {
        CoreServerStore::open(&data_dir).map(|inner| Self { inner: Mutex::new(Some(inner)) }).map_err(native)
    }

    /// Ordered prefix scan inside one namespace.
    #[pyo3(signature = (namespace, prefix, after=None, before=None, limit=0))]
    fn scan(
        &self,
        namespace: String,
        prefix: Vec<u8>,
        after: Option<Vec<u8>>,
        before: Option<Vec<u8>>,
        limit: usize,
    ) -> PyResult<Vec<StoreRow>> {
        let mut guard = self.inner.lock().map_err(|_| native_message("server store lock poisoned"))?;
        let store = guard.as_mut().ok_or_else(|| native_message("server store is closed"))?;
        store
            .scan(&namespace, &prefix, after.as_deref(), before.as_deref(), limit)
            .map(|rows| rows.into_iter().map(|row| StoreRow { key: row.key, value: row.value }).collect())
            .map_err(native)
    }

    /// Applies one batch as a single durable atomic commit.
    fn commit_changes(&self, changes: Vec<ServerStoreChange>) -> PyResult<()> {
        let mut batch = Vec::with_capacity(changes.len());
        for change in changes {
            batch.push(match change.kind.as_str() {
                "put" => CoreServerChange::Put {
                    namespace: change.namespace,
                    key: change.key,
                    value: change.value.ok_or_else(|| native_message("put change carries no value"))?,
                },
                "delete" => CoreServerChange::Delete { namespace: change.namespace, key: change.key },
                other => return Err(native_message(format!("unknown server store change kind {other}"))),
            });
        }
        let mut guard = self.inner.lock().map_err(|_| native_message("server store lock poisoned"))?;
        let store = guard.as_mut().ok_or_else(|| native_message("server store is closed"))?;
        store.commit_changes(batch).map_err(native)
    }

    /// Releases the directory lock.
    fn close(&self) -> PyResult<()> {
        let mut guard = self.inner.lock().map_err(|_| native_message("server store lock poisoned"))?;
        if let Some(store) = guard.take() {
            store.close().map_err(native)?;
        }
        Ok(())
    }

    /// Whether every commit survives process exit.
    fn durable_atomic_commit(&self) -> bool {
        self.inner.lock().ok().and_then(|guard| guard.as_ref().map(CoreServerStore::durable_atomic_commit)).unwrap_or(false)
    }

    /// Data directory.
    fn data_dir(&self) -> PyResult<String> {
        Ok(self.locked()?.data_dir())
    }

    /// `.yykv` shard path.
    fn shard_path(&self) -> PyResult<String> {
        Ok(self.locked()?.shard_path())
    }

    /// `.yyds` catalog path.
    fn catalog_path(&self) -> PyResult<String> {
        Ok(self.locked()?.catalog_path())
    }

    /// `postmaster.pid` lock path.
    fn lock_path(&self) -> PyResult<String> {
        Ok(self.locked()?.lock_path())
    }
}

/// Guard that dereferences to the live store, never to a closed slot.
struct StoreGuard<'a>(std::sync::MutexGuard<'a, Option<CoreServerStore>>);

impl std::ops::Deref for StoreGuard<'_> {
    type Target = CoreServerStore;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("server store is open")
    }
}

impl ServerStore {
    fn locked(&self) -> PyResult<StoreGuard<'_>> {
        let guard = self.inner.lock().map_err(|_| native_message("server store lock poisoned"))?;
        if guard.is_none() {
            return Err(native_message("server store is closed"));
        }
        Ok(StoreGuard(guard))
    }
}

fn native_message(message: impl Into<String>) -> PyErr {
    pyo3::exceptions::PyRuntimeError::new_err(message.into())
}

fn statement(result: QueryResult) -> StatementResult {
    StatementResult {
        columns: result.columns.into_iter().map(|column| ColumnInfo { name: column.name }).collect(),
        rows: result.rows,
        tag: result.tag,
    }
}

fn message_field_info(field: &MessageField) -> MessageFieldInfo {
    MessageFieldInfo { kind: String::from_utf8_lossy(&[field.kind]).into_owned(), value: field.value.clone() }
}

fn notice_info(notice: &Notice) -> NoticeInfo {
    NoticeInfo { fields: notice.fields.iter().map(message_field_info).collect() }
}

fn error_info(error: &CoreError) -> Option<ErrorInfo> {
    match error {
        CoreError::Server { code, message, fields } => Some(ErrorInfo {
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
        rows: result.rows,
        tag: result.tag,
    }
}

fn describe_target(target: &str) -> PyResult<u8> {
    match target {
        "statement" => Ok(b'S'),
        "portal" => Ok(b'P'),
        _ => Err(PostgresError::new_err("describe target must be S or P")),
    }
}

/// Copies every parameter into owned bytes so the borrows outlive the lock.
fn param_buffers(params: &[(u32, Option<Vec<u8>>)]) -> PyResult<Vec<(u16, Option<Vec<u8>>)>> {
    let mut owned = Vec::with_capacity(params.len());
    for (format, value) in params {
        let format = u16::try_from(*format).map_err(|_| PostgresError::new_err("parameter format does not fit 16 bits"))?;
        if format > 1 {
            return Err(PostgresError::new_err("parameter format is 0 for text and 1 for binary"));
        }
        owned.push((format, value.clone()));
    }
    Ok(owned)
}

fn result_formats_u16(formats: &[u32]) -> PyResult<Vec<u16>> {
    let mut codes = Vec::with_capacity(formats.len());
    for format in formats {
        let code = u16::try_from(*format).map_err(|_| PostgresError::new_err("result format does not fit 16 bits"))?;
        if code > 1 {
            return Err(PostgresError::new_err("result format is 0 for text and 1 for binary"));
        }
        codes.push(code);
    }
    Ok(codes)
}

fn lock_error() -> PyErr {
    PostgresError::new_err("connection lock is poisoned")
}

fn closed_error() -> PyErr {
    PostgresError::new_err("connection is closed")
}

fn native(error: CoreError) -> PyErr {
    PostgresError::new_err(error.to_string())
}

#[pymodule]
fn postgres_pyo3(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<Connection>()?;
    module.add_class::<PreparedStatement>()?;
    module.add_class::<ColumnInfo>()?;
    module.add_class::<StatementResult>()?;
    module.add_class::<MessageFieldInfo>()?;
    module.add_class::<ErrorInfo>()?;
    module.add_class::<NoticeInfo>()?;
    module.add_class::<ExecutionReport>()?;
    module.add_class::<CopyInReport>()?;
    module.add_class::<CopyOutReport>()?;
    module.add_class::<CopyResponseInfo>()?;
    module.add_class::<PortalInfo>()?;
    module.add_class::<PortalExecReport>()?;
    module.add_class::<PsqlOptions>()?;
    module.add_class::<Store>()?;
    module.add_class::<StoreRow>()?;
    module.add_class::<ServerStore>()?;
    module.add_class::<ServerStoreChange>()?;
    module.add("PostgresError", module.py().get_type::<PostgresError>())?;
    module.add_function(wrap_pyfunction!(connect, module)?)?;
    module.add_function(wrap_pyfunction!(version, module)?)?;
    module.add_function(wrap_pyfunction!(protocol_version, module)?)?;
    module.add_function(wrap_pyfunction!(max_message_bytes, module)?)?;
    module.add_function(wrap_pyfunction!(encode_startup_packet, module)?)?;
    module.add_function(wrap_pyfunction!(encode_query_packet, module)?)?;
    module.add_function(wrap_pyfunction!(encode_cancel_request, module)?)?;
    module.add_function(wrap_pyfunction!(decode_error_response, module)?)?;
    module.add_function(wrap_pyfunction!(decode_error_fields, module)?)?;
    module.add_function(wrap_pyfunction!(decode_notice_fields, module)?)?;
    module.add_function(wrap_pyfunction!(decode_row_description, module)?)?;
    module.add_function(wrap_pyfunction!(decode_data_row, module)?)?;
    module.add_function(wrap_pyfunction!(decode_command_tag, module)?)?;
    module.add_function(wrap_pyfunction!(encode_parse_message, module)?)?;
    module.add_function(wrap_pyfunction!(encode_bind_message, module)?)?;
    module.add_function(wrap_pyfunction!(encode_bind_message_with_formats, module)?)?;
    module.add_function(wrap_pyfunction!(encode_describe_message, module)?)?;
    module.add_function(wrap_pyfunction!(encode_execute_message, module)?)?;
    module.add_function(wrap_pyfunction!(encode_sync_message, module)?)?;
    module.add_function(wrap_pyfunction!(encode_close_message, module)?)?;
    module.add_function(wrap_pyfunction!(decode_parameter_description, module)?)?;
    module.add_function(wrap_pyfunction!(encode_copy_data, module)?)?;
    module.add_function(wrap_pyfunction!(encode_copy_done, module)?)?;
    module.add_function(wrap_pyfunction!(encode_copy_fail, module)?)?;
    module.add_function(wrap_pyfunction!(decode_copy_response, module)?)?;
    module.add_function(wrap_pyfunction!(parameter_type_oid, module)?)?;
    module.add_function(wrap_pyfunction!(encode_bytea, module)?)?;
    module.add_function(wrap_pyfunction!(parse_psql_arguments, module)?)?;
    module.add_function(wrap_pyfunction!(format_psql_results, module)?)?;
    Ok(())
}
