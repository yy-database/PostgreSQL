//! Byte level protocol-v3 framing.
//!
//! Every function is a pure transformation over bytes, so callers can be tested
//! without a socket.

use crate::error::PostgresError;

/// Protocol 3.0 as encoded in the startup packet.
pub const PROTOCOL_VERSION: u32 = 196_608;
/// Refuse payloads larger than this so a hostile server cannot exhaust memory.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

fn truncated(what: &str) -> PostgresError {
    PostgresError::Protocol(format!("truncated {what}"))
}

/// One startup packet carrying the user, database and application name.
pub fn startup_packet(user: &str, database: &str) -> Vec<u8> {
    let mut parameters = Vec::new();
    for (key, value) in [
        ("user", user),
        ("database", database),
        ("client_encoding", "UTF8"),
        ("application_name", "postgres-psql"),
    ] {
        parameters.extend_from_slice(key.as_bytes());
        parameters.push(0);
        parameters.extend_from_slice(value.as_bytes());
        parameters.push(0);
    }
    parameters.push(0);

    let mut packet = Vec::with_capacity(parameters.len() + 8);
    packet.extend_from_slice(&(parameters.len() as u32 + 8).to_be_bytes());
    packet.extend_from_slice(&PROTOCOL_VERSION.to_be_bytes());
    packet.extend_from_slice(&parameters);
    packet
}

/// One `Query` message in the simple-query protocol.
pub fn query_packet(sql: &str) -> Result<Vec<u8>, PostgresError> {
    let payload = sql.len() + 1;
    if payload + 4 > MAX_MESSAGE_BYTES {
        return Err(PostgresError::Protocol("query exceeds the byte limit".into()));
    }
    let mut packet = Vec::with_capacity(payload + 5);
    packet.push(b'Q');
    packet.extend_from_slice(&(payload as u32 + 4).to_be_bytes());
    packet.extend_from_slice(sql.as_bytes());
    packet.push(0);
    Ok(packet)
}

/// Decodes an `ErrorResponse` payload into the server error shape.
pub fn error_response(payload: &[u8]) -> PostgresError {
    let mut code = "unknown".to_owned();
    let mut message = "PostgreSQL error".to_owned();
    let mut offset = 0;
    while offset < payload.len() && payload[offset] != 0 {
        let field = payload[offset];
        offset += 1;
        let Some(end) = payload[offset..].iter().position(|byte| *byte == 0).map(|index| index + offset) else {
            return PostgresError::Protocol("malformed PostgreSQL error response".into());
        };
        let value = String::from_utf8_lossy(&payload[offset..end]).into_owned();
        match field {
            b'C' => code = value,
            b'M' => message = value,
            _ => {}
        }
        offset = end + 1;
    }
    PostgresError::Server { code, message }
}

/// Column names carried by a `RowDescription`. Binary formats are rejected.
pub fn column_names(payload: &[u8]) -> Result<Vec<String>, PostgresError> {
    if payload.len() < 2 {
        return Err(truncated("RowDescription"));
    }
    let count = u16::from_be_bytes([payload[0], payload[1]]) as usize;
    let mut names = Vec::with_capacity(count);
    let mut offset = 2;
    for _ in 0..count {
        let Some(end) = payload[offset..].iter().position(|byte| *byte == 0).map(|index| index + offset) else {
            return Err(truncated("column description"));
        };
        if end + 19 > payload.len() {
            return Err(truncated("column description"));
        }
        let format = u16::from_be_bytes([payload[end + 17], payload[end + 18]]);
        if format != 0 {
            return Err(PostgresError::Protocol("binary PostgreSQL results are unsupported".into()));
        }
        names.push(String::from_utf8_lossy(&payload[offset..end]).into_owned());
        offset = end + 19;
    }
    if offset != payload.len() {
        return Err(PostgresError::Protocol("trailing RowDescription bytes".into()));
    }
    Ok(names)
}

/// Cell values carried by a `DataRow`. `-1` lengths become SQL `NULL`.
pub fn data_row(payload: &[u8], columns: usize) -> Result<Vec<Option<String>>, PostgresError> {
    if payload.len() < 2 || u16::from_be_bytes([payload[0], payload[1]]) as usize != columns {
        return Err(PostgresError::Protocol("invalid DataRow column count".into()));
    }
    let mut values = Vec::with_capacity(columns);
    let mut offset = 2;
    for _ in 0..columns {
        if offset + 4 > payload.len() {
            return Err(truncated("DataRow length"));
        }
        let length = i32::from_be_bytes([payload[offset], payload[offset + 1], payload[offset + 2], payload[offset + 3]]);
        offset += 4;
        if length == -1 {
            values.push(None);
            continue;
        }
        if length < 0 || offset + length as usize > payload.len() {
            return Err(PostgresError::Protocol("invalid DataRow length".into()));
        }
        let end = offset + length as usize;
        values.push(Some(String::from_utf8_lossy(&payload[offset..end]).into_owned()));
        offset = end;
    }
    if offset != payload.len() {
        return Err(PostgresError::Protocol("trailing DataRow bytes".into()));
    }
    Ok(values)
}

/// Command tag carried by a `CommandComplete`, such as `SELECT 1`.
pub fn command_tag(payload: &[u8]) -> Result<String, PostgresError> {
    if payload.len() < 2 || payload[payload.len() - 1] != 0 {
        return Err(PostgresError::Protocol("invalid CommandComplete".into()));
    }
    Ok(String::from_utf8_lossy(&payload[..payload.len() - 1]).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_packet_starts_with_version_and_ends_once() {
        let packet = startup_packet("postgres", "postgres");
        assert_eq!(&packet[4..8], &PROTOCOL_VERSION.to_be_bytes());
        assert_eq!(packet.len() as u32, u32::from_be_bytes([packet[0], packet[1], packet[2], packet[3]]));
        assert_eq!(packet[packet.len() - 1], 0);
    }

    #[test]
    fn error_response_keeps_code_and_message() {
        let error = error_response(b"SERROR\0C42P01\0Mrelation does not exist\0\0");
        assert_eq!(error.code(), Some("42P01"));
        assert_eq!(error.message(), "relation does not exist");
    }

    #[test]
    fn data_row_maps_negative_length_to_null() {
        let mut payload = vec![0, 2, 0, 0, 0, 1, b'7', 0xff, 0xff, 0xff, 0xff];
        assert_eq!(data_row(&payload, 2).unwrap(), vec![Some("7".into()), None]);
        payload[1] = 3;
        assert!(data_row(&payload, 3).is_err());
    }
}
