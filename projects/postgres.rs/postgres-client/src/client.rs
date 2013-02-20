//! One socket, one connection, no global state.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::error::PostgresError;
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

/// A live protocol-v3 connection in the simple-query mode.
pub struct Connection {
    stream: TcpStream,
}

impl Connection {
    /// Opens the socket and completes the startup handshake.
    pub fn open(config: &ClientConfig) -> Result<Self, PostgresError> {
        let address = (config.host.as_str(), config.port)
            .to_socket_addrs()
            .map_err(|error| PostgresError::Io(format!("{}:{} cannot be resolved: {error}", config.host, config.port)))?
            .next()
            .ok_or_else(|| PostgresError::Io(format!("{}:{} resolved to no address", config.host, config.port)))?;
        let stream = TcpStream::connect_timeout(&address, TIMEOUT)
            .map_err(|error| PostgresError::Io(format!("{}:{} cannot be reached: {error}", config.host, config.port)))?;
        stream.set_read_timeout(Some(TIMEOUT)).map_err(io_error)?;
        stream.set_write_timeout(Some(TIMEOUT)).map_err(io_error)?;
        stream.set_nodelay(true).map_err(io_error)?;
        let mut connection = Self { stream };
        connection.startup(config)?;
        Ok(connection)
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
                b'S' | b'K' | b'N' => {}
                other => return Err(PostgresError::Protocol(format!("unsupported PostgreSQL startup response tag {other}"))),
            }
        }
    }

    /// Runs one simple-query statement and returns every result it produced.
    pub fn execute(&mut self, sql: &str) -> Result<Vec<QueryResult>, PostgresError> {
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
                    return Err(failure.expect("checked above"));
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
                    return Ok(results);
                }
                b'S' | b'K' | b'N' => {}
                other => return Err(PostgresError::Protocol(format!("unsupported PostgreSQL response tag {other}"))),
            }
        }
    }

    /// Closes the socket on the wire instead of waiting for the process to exit.
    pub fn close(mut self) -> Result<(), PostgresError> {
        self.stream.flush().map_err(io_error)?;
        self.stream.shutdown(std::net::Shutdown::Both).map_err(io_error)
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
