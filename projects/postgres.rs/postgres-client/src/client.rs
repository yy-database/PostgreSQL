//! One socket, one connection, no global state.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::error::{Notice, PostgresError};
use crate::protocol::{self, MAX_MESSAGE_BYTES};

const TIMEOUT: Duration = Duration::from_secs(5);

/// Where to connect and which identity to present in the startup packet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 5432,
            user: "postgres".into(),
            database: "postgres".into(),
        }
    }
}

impl ClientConfig {
    pub fn new(host: impl Into<String>, port: u16, user: impl Into<String>, database: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            port,
            user: user.into(),
            database: database.into(),
        }
    }
}

/// One column of a result set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
}

/// Everything one statement returned.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QueryResult {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Option<String>>>,
    pub tag: String,
}

impl QueryResult {
    pub fn column_names(&self) -> impl Iterator<Item = &str> {
        self.columns.iter().map(|column| column.name.as_str())
    }

    /// Cell text for one coordinate, or `None` when the cell is SQL `NULL`.
    pub fn cell(&self, row: usize, column: usize) -> Option<Option<&str>> {
        self.rows.get(row).and_then(|values| values.get(column)).map(|value| value.as_deref())
    }
}

/// A named prepared statement living on one connection's session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    /// Server-side statement name, unique per connection.
    pub name: String,
    /// Parameter OIDs the server resolved, in declaration order.
    pub parameters: Vec<u32>,
    /// Columns the statement returns; empty when it returns no row set.
    pub columns: Vec<Column>,
}

/// The `pid` and `secret key` the server sent in `BackendKeyData`.
///
/// Both values appear verbatim in a `CancelRequest`, so they are kept for the
/// lifetime of the session instead of being discarded during startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendKeyData {
    pub process_id: i32,
    pub secret_key: i32,
}

/// A live protocol-v3 connection in the simple-query mode.
pub struct Connection {
    stream: TcpStream,
    config: ClientConfig,
    backend_key: Option<BackendKeyData>,
    session_tag: u32,
    statements: u64,
    notices: Vec<Notice>,
    /// Set once the stream is desynchronised, so later calls cannot read the
    /// reply of an abandoned round trip as if it belonged to a new statement.
    failure: Option<String>,
}

/// One simple-query round trip that keeps the statements that already finished.
///
/// `execute` throws the error and drops them. [`Report`] keeps both, matching
/// the order the server sent: every completed result first, then the error.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub results: Vec<QueryResult>,
    pub error: Option<PostgresError>,
    pub notices: Vec<Notice>,
}

/// Response of one extended-protocol round trip.
struct ExtendedOutcome {
    results: Vec<QueryResult>,
    parameters: Vec<u32>,
    described: Vec<Column>,
}

/// One simple-query reply once `ReadyForQuery` arrived.
struct SimpleOutcome {
    results: Vec<QueryResult>,
    error: Option<PostgresError>,
}

impl Connection {
    /// Opens the socket and completes the startup handshake.
    pub fn open(config: &ClientConfig) -> Result<Self, PostgresError> {
        let address = resolve_address(config)?;
        let stream = TcpStream::connect_timeout(&address, TIMEOUT)
            .map_err(|error| PostgresError::Io(format!("{}:{} cannot be reached: {error}", config.host, config.port)))?;
        stream.set_read_timeout(Some(TIMEOUT)).map_err(io_error)?;
        stream.set_write_timeout(Some(TIMEOUT)).map_err(io_error)?;
        stream.set_nodelay(true).map_err(io_error)?;
        let session_tag = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.subsec_nanos())
            .unwrap_or(0);
        let mut connection = Self {
            stream,
            config: config.clone(),
            backend_key: None,
            session_tag,
            statements: 0,
            notices: Vec::new(),
            failure: None,
        };
        connection.startup(config)?;
        Ok(connection)
    }

    /// The `BackendKeyData` sent during startup, or `None` when the server
    /// skipped it.
    pub fn backend_key_data(&self) -> Option<BackendKeyData> {
        self.backend_key
    }

    /// Sends one `CancelRequest` on a fresh socket, then closes it.
    ///
    /// PostgreSQL answers nothing on this connection, so `Ok` means the packet
    /// left this process. The main socket is untouched and stays usable.
    pub fn cancel(&self) -> Result<(), PostgresError> {
        let Some(key) = self.backend_key else {
            return Err(PostgresError::Protocol("server sent no BackendKeyData to cancel".into()));
        };
        let address = resolve_address(&self.config)?;
        let mut stream = TcpStream::connect_timeout(&address, TIMEOUT).map_err(|error| {
            PostgresError::Io(format!(
                "cancel connection to {}:{} failed: {error}",
                self.config.host, self.config.port
            ))
        })?;
        stream.set_write_timeout(Some(TIMEOUT)).map_err(io_error)?;
        stream.write_all(&protocol::cancel_request_packet(key.process_id, key.secret_key)).map_err(io_error)?;
        stream.shutdown(std::net::Shutdown::Both).map_err(io_error)?;
        Ok(())
    }

    fn ensure_usable(&self) -> Result<(), PostgresError> {
        match &self.failure {
            Some(reason) => Err(PostgresError::Io(format!("connection is unusable after {reason}"))),
            None => Ok(()),
        }
    }

    /// Marks the stream as unusable after a transport or protocol failure.
    ///
    /// A server error is not a desync: the server answered and the next
    /// `ReadyForQuery` already drained the stream, so the session stays usable.
    fn poison(&mut self, error: &PostgresError) {
        if !matches!(error, PostgresError::Io(_) | PostgresError::Protocol(_)) {
            return;
        }
        if self.failure.is_none() {
            self.failure = Some(error.to_string());
        }
    }

    fn startup(&mut self, config: &ClientConfig) -> Result<(), PostgresError> {
        self.stream
            .write_all(&protocol::startup_packet(&config.user, &config.database))
            .map_err(io_error)?;
        let mut authenticated = false;
        loop {
            let (tag, payload) = self.read_message()?;
            match tag {
                b'E' => return Err(protocol::error_response(&payload)),
                b'R' => {
                    if payload.len() != 4 || u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]) != 0 {
                        return Err(PostgresError::Protocol("PostgreSQL authentication is unsupported".into()));
                    }
                    authenticated = true;
                }
                b'Z' => {
                    if !authenticated {
                        return Err(PostgresError::Protocol("ReadyForQuery arrived before authentication".into()));
                    }
                    if payload.len() != 1 {
                        return Err(PostgresError::Protocol("invalid ReadyForQuery".into()));
                    }
                    return Ok(());
                }
                b'K' => {
                    if payload.len() == 8 {
                        self.backend_key = Some(BackendKeyData {
                            process_id: i32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]),
                            secret_key: i32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]),
                        });
                    }
                }
                b'S' => {}
                b'N' => self.record_notice(&payload)?,
                other => return Err(PostgresError::Protocol(format!("unsupported PostgreSQL startup response tag {other}"))),
            }
        }
    }

    /// Runs one simple-query statement and returns every result it produced.
    pub fn execute(&mut self, sql: &str) -> Result<Vec<QueryResult>, PostgresError> {
        self.ensure_usable()?;
        let outcome = match self.run_simple(sql) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.poison(&error);
                return Err(error);
            }
        };
        match outcome.error {
            Some(error) => Err(error),
            None => Ok(outcome.results),
        }
    }

    /// Runs one simple-query batch and keeps the statements that already finished.
    ///
    /// The reply order is the server order: every completed result first, then
    /// the error, then every notice the server emitted for this batch. Notices
    /// of earlier batches stay buffered for `take_notices`.
    pub fn execute_report(&mut self, sql: &str) -> Result<Report, PostgresError> {
        self.ensure_usable()?;
        let start = self.notices.len();
        let outcome = match self.run_simple(sql) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.poison(&error);
                return Err(error);
            }
        };
        let notices = self.notices.split_off(start);
        Ok(Report { results: outcome.results, error: outcome.error, notices })
    }

    /// Drains every notice received so far, in wire order.
    pub fn take_notices(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.notices)
    }

    fn record_notice(&mut self, payload: &[u8]) -> Result<(), PostgresError> {
        self.notices.push(protocol::notice_response(payload)?);
        Ok(())
    }

    fn run_simple(&mut self, sql: &str) -> Result<SimpleOutcome, PostgresError> {
        self.stream.write_all(&protocol::query_packet(sql)?).map_err(io_error)?;
        let mut results = Vec::new();
        let mut current: Option<(Vec<String>, Vec<Vec<Option<String>>>)> = None;
        let mut failure: Option<PostgresError> = None;
        loop {
            let (tag, payload) = self.read_message()?;
            if failure.is_some() {
                // The server abandons the remaining statements after an error and
                // only sends ReadyForQuery next; drain it so the socket stays usable.
                if tag == b'Z' {
                    if payload.len() != 1 {
                        return Err(PostgresError::Protocol("invalid ReadyForQuery".into()));
                    }
                    return Ok(SimpleOutcome { results, error: failure });
                }
                continue;
            }
            match tag {
                b'E' => {
                    failure = Some(protocol::error_response(&payload));
                }
                b'T' => {
                    if current.is_some() {
                        return Err(PostgresError::Protocol("unexpected PostgreSQL RowDescription".into()));
                    }
                    current = Some((protocol::column_names(&payload)?, Vec::new()));
                }
                b'D' => {
                    let Some((columns, rows)) = current.as_mut() else {
                        return Err(PostgresError::Protocol("DataRow without RowDescription".into()));
                    };
                    rows.push(protocol::data_row(&payload, columns.len())?);
                }
                b'C' => {
                    let command = protocol::command_tag(&payload)?;
                    let (columns, rows) = current.take().unwrap_or_default();
                    results.push(QueryResult {
                        columns: columns.into_iter().map(|name| Column { name }).collect(),
                        rows,
                        tag: command,
                    });
                }
                b'I' => {
                    if !payload.is_empty() || current.is_some() {
                        return Err(PostgresError::Protocol("invalid EmptyQueryResponse".into()));
                    }
                }
                b'Z' => {
                    if current.is_some() {
                        return Err(PostgresError::Protocol("PostgreSQL result ended before CommandComplete".into()));
                    }
                    if payload.len() != 1 {
                        return Err(PostgresError::Protocol("invalid ReadyForQuery".into()));
                    }
                    return Ok(SimpleOutcome { results, error: None });
                }
                b'S' | b'K' => {}
                b'N' => self.record_notice(&payload)?,
                other => return Err(PostgresError::Protocol(format!("unsupported PostgreSQL response tag {other}"))),
            }
        }
    }

    /// Runs one parameterised statement through the extended protocol using the
    /// unnamed prepared statement, so nothing stays on the server afterwards.
    pub fn execute_with_params(
        &mut self,
        sql: &str,
        params: &[Option<&str>],
        param_types: &[u32],
    ) -> Result<Vec<QueryResult>, PostgresError> {
        self.ensure_usable()?;
        let mut packet = protocol::parse_packet("", sql, param_types)?;
        packet.extend_from_slice(&protocol::bind_packet("", "", params, 0)?);
        packet.extend_from_slice(&protocol::describe_packet(b'P', "")?);
        packet.extend_from_slice(&protocol::execute_packet("", 0)?);
        packet.extend_from_slice(&protocol::sync_packet());
        match self.read_extended(&packet) {
            Ok(outcome) => Ok(outcome.results),
            Err(error) => {
                self.poison(&error);
                Err(error)
            }
        }
    }

    /// Prepares a named statement and describes it in the same round trip.
    pub fn prepare(&mut self, sql: &str, param_types: &[u32]) -> Result<Prepared, PostgresError> {
        self.ensure_usable()?;
        self.statements += 1;
        let name = format!("pg_rs_{:08x}_{}", self.session_tag, self.statements);
        let mut packet = protocol::parse_packet(&name, sql, param_types)?;
        packet.extend_from_slice(&protocol::describe_packet(b'S', &name)?);
        packet.extend_from_slice(&protocol::sync_packet());
        let outcome = match self.read_extended(&packet) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.poison(&error);
                return Err(error);
            }
        };
        Ok(Prepared { name, parameters: outcome.parameters, columns: outcome.described })
    }

    /// Binds parameters to an existing prepared statement and executes it.
    pub fn execute_prepared(&mut self, name: &str, params: &[Option<&str>]) -> Result<Vec<QueryResult>, PostgresError> {
        self.ensure_usable()?;
        let mut packet = protocol::bind_packet("", name, params, 0)?;
        packet.extend_from_slice(&protocol::describe_packet(b'P', "")?);
        packet.extend_from_slice(&protocol::execute_packet("", 0)?);
        packet.extend_from_slice(&protocol::sync_packet());
        match self.read_extended(&packet) {
            Ok(outcome) => Ok(outcome.results),
            Err(error) => {
                self.poison(&error);
                Err(error)
            }
        }
    }

    /// Closes a prepared statement on the server. Closing an unknown name is a
    /// no-op: the server answers CloseComplete either way.
    pub fn close_prepared(&mut self, name: &str) -> Result<(), PostgresError> {
        self.ensure_usable()?;
        let mut packet = protocol::close_packet(b'S', name)?;
        packet.extend_from_slice(&protocol::sync_packet());
        let outcome = match self.read_extended(&packet) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.poison(&error);
                return Err(error);
            }
        };
        if !outcome.results.is_empty() {
            return Err(PostgresError::Protocol("Close returned a result set".into()));
        }
        Ok(())
    }

    fn read_extended(&mut self, packet: &[u8]) -> Result<ExtendedOutcome, PostgresError> {
        self.stream.write_all(packet).map_err(io_error)?;
        let mut results = Vec::new();
        let mut parameters = Vec::new();
        let mut described = Vec::new();
        let mut current: Option<(Vec<Column>, Vec<Vec<Option<String>>>)> = None;
        let mut failure: Option<PostgresError> = None;
        loop {
            let (tag, payload) = self.read_message()?;
            if failure.is_some() {
                // After an error the server skips the rest of the batch and only
                // sends ReadyForQuery, so drain it to keep the socket usable.
                if tag == b'Z' {
                    return Err(failure.expect("checked above"));
                }
                continue;
            }
            match tag {
                b'1' | b'2' | b'3' => {
                    if !payload.is_empty() {
                        return Err(PostgresError::Protocol("invalid extended-protocol completion".into()));
                    }
                }
                b't' => parameters = protocol::parameter_description(&payload)?,
                b'T' => {
                    if current.is_some() {
                        return Err(PostgresError::Protocol("unexpected PostgreSQL RowDescription".into()));
                    }
                    let columns: Vec<Column> =
                        protocol::column_names(&payload)?.into_iter().map(|name| Column { name }).collect();
                    described = columns.clone();
                    current = Some((columns, Vec::new()));
                }
                b'n' => {
                    if current.is_some() {
                        return Err(PostgresError::Protocol("unexpected PostgreSQL NoData".into()));
                    }
                    current = Some((Vec::new(), Vec::new()));
                }
                b'D' => {
                    let Some((columns, rows)) = current.as_mut() else {
                        return Err(PostgresError::Protocol("DataRow without RowDescription".into()));
                    };
                    rows.push(protocol::data_row(&payload, columns.len())?);
                }
                b'C' => {
                    let command = protocol::command_tag(&payload)?;
                    let (columns, rows) = current.take().unwrap_or_else(|| (described.clone(), Vec::new()));
                    results.push(QueryResult { columns, rows, tag: command });
                }
                b'I' => {
                    // An empty statement answers Describe with NoData and Execute
                    // with EmptyQueryResponse, so clear that placeholder instead of
                    // treating it as a result set.
                    if !payload.is_empty() {
                        return Err(PostgresError::Protocol("invalid EmptyQueryResponse".into()));
                    }
                    if let Some((columns, rows)) = current.take() {
                        if !columns.is_empty() || !rows.is_empty() {
                            return Err(PostgresError::Protocol("invalid EmptyQueryResponse".into()));
                        }
                    }
                }
                b's' => return Err(PostgresError::Unsupported("execute-row-limit".into())),
                b'E' => failure = Some(protocol::error_response(&payload)),
                b'Z' => {
                    if payload.len() != 1 {
                        return Err(PostgresError::Protocol("invalid ReadyForQuery".into()));
                    }
                    // A describe-only round trip (prepare) leaves the RowDescription
                    // pending without a CommandComplete; that is not a result set.
                    if let Some((_, rows)) = current.take() {
                        if !rows.is_empty() {
                            return Err(PostgresError::Protocol("PostgreSQL result ended before CommandComplete".into()));
                        }
                    }
                    return Ok(ExtendedOutcome { results, parameters, described });
                }
                b'S' | b'K' => {}
                b'N' => self.record_notice(&payload)?,
                other => return Err(PostgresError::Protocol(format!("unsupported PostgreSQL response tag {other}"))),
            }
        }
    }

    /// Shuts the socket down without consuming the handle.
    pub fn disconnect(&mut self) -> Result<(), PostgresError> {
        self.stream.flush().map_err(io_error)?;
        self.stream.shutdown(std::net::Shutdown::Both).map_err(io_error)
    }

    /// Closes the socket on the wire instead of waiting for the process to exit.
    pub fn close(mut self) -> Result<(), PostgresError> {
        self.disconnect()
    }

    fn read_message(&mut self) -> Result<(u8, Vec<u8>), PostgresError> {
        let mut header = [0_u8; 5];
        self.stream.read_exact(&mut header).map_err(io_error)?;
        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        if length < 4 || length > MAX_MESSAGE_BYTES {
            return Err(PostgresError::Protocol("invalid PostgreSQL message length".into()));
        }
        let mut payload = vec![0_u8; length - 4];
        self.stream.read_exact(&mut payload).map_err(io_error)?;
        Ok((header[0], payload))
    }
}

fn resolve_address(config: &ClientConfig) -> Result<SocketAddr, PostgresError> {
    (config.host.as_str(), config.port)
        .to_socket_addrs()
        .map_err(|error| PostgresError::Io(format!("{}:{} cannot be resolved: {error}", config.host, config.port)))?
        .next()
        .ok_or_else(|| PostgresError::Io(format!("{}:{} resolved to no address", config.host, config.port)))
}

fn io_error(error: std::io::Error) -> PostgresError {
    PostgresError::Io(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_reads_one_coordinate_and_nulls() {
        let result = QueryResult {
            columns: vec![Column { name: "one".into() }],
            rows: vec![vec![Some("1".into())], vec![None]],
            tag: "SELECT 2".into(),
        };
        assert_eq!(result.cell(0, 0), Some(Some("1")));
        assert_eq!(result.cell(1, 0), Some(None));
        assert_eq!(result.cell(2, 0), None);
        assert_eq!(result.column_names().collect::<Vec<_>>(), vec!["one"]);
    }

    #[test]
    fn default_config_points_at_loopback() {
        assert_eq!(ClientConfig::default().port, 5432);
    }
}
