//! Byte level protocol-v3 framing.
//!
//! Every function is a pure transformation over bytes, so callers can be tested
//! without a socket.

use crate::error::{MessageField, Notice, PostgresError};

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

/// Decodes the ordered fields of an `ErrorResponse` or `NoticeResponse` payload.
///
/// The field order is the wire order, and values are decoded byte for byte,
/// because callers compare them with the raw payload.
pub fn message_fields(payload: &[u8]) -> Result<Vec<MessageField>, PostgresError> {
    let mut fields = Vec::new();
    let mut offset = 0;
    while offset < payload.len() && payload[offset] != 0 {
        let kind = payload[offset];
        offset += 1;
        let Some(end) = payload[offset..].iter().position(|byte| *byte == 0).map(|index| index + offset) else {
            return Err(PostgresError::Protocol("malformed PostgreSQL error response".into()));
        };
        fields.push(MessageField::new(kind, String::from_utf8_lossy(&payload[offset..end]).into_owned()));
        offset = end + 1;
    }
    Ok(fields)
}

/// Decodes one `NoticeResponse` payload, keeping every field in wire order.
pub fn notice_response(payload: &[u8]) -> Result<Notice, PostgresError> {
    message_fields(payload).map(Notice::new)
}

/// Decodes an `ErrorResponse` payload into the server error shape.
pub fn error_response(payload: &[u8]) -> PostgresError {
    let fields = match message_fields(payload) {
        Ok(fields) => fields,
        Err(error) => return error,
    };
    let code = fields
        .iter()
        .find(|field| field.kind == b'C')
        .map(|field| field.value.clone())
        .unwrap_or_else(|| "unknown".to_owned());
    let message = fields
        .iter()
        .find(|field| field.kind == b'M')
        .map(|field| field.value.clone())
        .unwrap_or_else(|| "PostgreSQL error".to_owned());
    PostgresError::Server { code, message, fields }
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

// -------------------------------------------------------------------------------
// Extended query protocol: Parse, Bind, Describe, Execute, Close and Sync.
// ---------------------------------------------------------------------------

/// The wire encodes parameter counts in 16 bits, so this is the hard ceiling for
/// every declared or bound parameter list.
pub const MAX_PARAMETERS: usize = 65_535;

/// OID of the named parameter type, as published by the PostgreSQL catalog.
/// `None` means the name is not part of the supported mapping.
pub fn parameter_type_oid(name: &str) -> Option<u32> {
    Some(match name {
        "bool" => 16,
        "bytea" => 17,
        "int8" | "bigint" => 20,
        "int2" | "smallint" => 21,
        "int4" | "int" | "integer" => 23,
        "text" => 25,
        "varchar" => 1043,
        "float4" | "real" => 700,
        "float8" | "double precision" => 701,
        "numeric" | "decimal" => 1700,
        "date" => 1082,
        "time" => 1083,
        "timestamp" => 1114,
        "timestamptz" => 1184,
        "uuid" => 2950,
        "json" => 114,
        "jsonb" => 3802,
        _ => return None,
    })
}

/// Text-format `bytea` encoding: `\x` followed by lowercase hexadecimal.
pub fn encode_bytea(bytes: &[u8]) -> String {
    use core::fmt::Write as _;
    let mut text = String::with_capacity(2 + bytes.len() * 2);
    text.push_str("\\x");
    for byte in bytes {
        write!(text, "{byte:02x}").expect("writing into a String cannot fail");
    }
    text
}

fn push_text(payload: &mut Vec<u8>, value: &str) {
    payload.extend_from_slice(value.as_bytes());
    payload.push(0);
}

fn frame(tag: u8, payload: Vec<u8>) -> Result<Vec<u8>, PostgresError> {
    if payload.len() + 4 > MAX_MESSAGE_BYTES {
        return Err(PostgresError::Protocol("extended message exceeds the byte limit".into()));
    }
    let mut packet = Vec::with_capacity(payload.len() + 5);
    packet.push(tag);
    packet.extend_from_slice(&(payload.len() as u32 + 4).to_be_bytes());
    packet.extend_from_slice(&payload);
    Ok(packet)
}

/// One `Parse` message. Type OIDs may be empty so the server infers them from
/// the statement, and may be shorter than the highest `$n` the statement uses.
pub fn parse_packet(name: &str, sql: &str, param_types: &[u32]) -> Result<Vec<u8>, PostgresError> {
    if param_types.len() > MAX_PARAMETERS {
        return Err(PostgresError::Protocol(format!(
            "at most {MAX_PARAMETERS} parameter types can be declared"
        )));
    }
    let mut payload = Vec::with_capacity(name.len() + sql.len() + 4 + param_types.len() * 4);
    push_text(&mut payload, name);
    push_text(&mut payload, sql);
    payload.extend_from_slice(&(param_types.len() as u16).to_be_bytes());
    for oid in param_types {
        payload.extend_from_slice(&oid.to_be_bytes());
    }
    frame(b'P', payload)
}

/// One `Bind` message. Parameters travel in text format; `None` is SQL `NULL`.
/// Only text result formats are implemented.
pub fn bind_packet(
    portal: &str,
    statement: &str,
    params: &[Option<&str>],
    result_format: u16,
) -> Result<Vec<u8>, PostgresError> {
    if result_format != 0 {
        return Err(PostgresError::Unsupported("binary-result-format".into()));
    }
    if params.len() > MAX_PARAMETERS {
        return Err(PostgresError::Protocol(format!(
            "at most {MAX_PARAMETERS} parameters can be bound"
        )));
    }
    let mut payload = Vec::new();
    push_text(&mut payload, portal);
    push_text(&mut payload, statement);
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&(params.len() as u16).to_be_bytes());
    for param in params {
        match param {
            None => payload.extend_from_slice(&(-1_i32).to_be_bytes()),
            Some(value) => {
                let length = i32::try_from(value.len())
                    .map_err(|_| PostgresError::Protocol("parameter value is too long".into()))?;
                payload.extend_from_slice(&length.to_be_bytes());
                payload.extend_from_slice(value.as_bytes());
            }
        }
    }
    payload.extend_from_slice(&0_u16.to_be_bytes());
    frame(b'B', payload)
}

/// One `Describe` message for a prepared statement (`b'S'`) or a portal (`b'P'`).
pub fn describe_packet(target: u8, name: &str) -> Result<Vec<u8>, PostgresError> {
    if target != b'S' && target != b'P' {
        return Err(PostgresError::Protocol("describe target must be S or P".into()));
    }
    let mut payload = vec![target];
    push_text(&mut payload, name);
    frame(b'D', payload)
}

/// One `Execute` message. Partial execution is refused because this client does
/// not implement portal suspension.
pub fn execute_packet(portal: &str, max_rows: i32) -> Result<Vec<u8>, PostgresError> {
    if max_rows < 0 {
        return Err(PostgresError::Protocol("execute row limit cannot be negative".into()));
    }
    if max_rows > 0 {
        return Err(PostgresError::Unsupported("execute-row-limit".into()));
    }
    let mut payload = Vec::new();
    push_text(&mut payload, portal);
    payload.extend_from_slice(&max_rows.to_be_bytes());
    frame(b'E', payload)
}

/// One `Close` message for a prepared statement (`b'S'`) or a portal (`b'P'`).
pub fn close_packet(target: u8, name: &str) -> Result<Vec<u8>, PostgresError> {
    if target != b'S' && target != b'P' {
        return Err(PostgresError::Protocol("close target must be S or P".into()));
    }
    let mut payload = vec![target];
    push_text(&mut payload, name);
    frame(b'C', payload)
}

// ---------------------------------------------------------------------------
// COPY subprotocol: server `G`/`H`/`W`, client `d`/`c`/`f`.
// ---------------------------------------------------------------------------

/// Overall and per-column formats carried by `CopyInResponse`,
/// `CopyOutResponse` and `CopyBothResponse`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyResponse {
    /// `0` for text and `1` for binary.
    pub format: u8,
    pub columns: u16,
    /// One format code per column.
    pub column_formats: Vec<u16>,
}

/// Decodes a `CopyInResponse`, `CopyOutResponse` or `CopyBothResponse` payload.
pub fn copy_response(payload: &[u8]) -> Result<CopyResponse, PostgresError> {
    if payload.len() < 3 {
        return Err(PostgresError::Protocol("truncated PostgreSQL copy response".into()));
    }
    let format = payload[0];
    if format > 1 {
        return Err(PostgresError::Protocol(format!("invalid PostgreSQL copy format {format}")));
    }
    let columns = u16::from_be_bytes([payload[1], payload[2]]);
    let expected = 3 + columns as usize * 2;
    if payload.len() != expected {
        return Err(PostgresError::Protocol("PostgreSQL copy response column count does not match its length".into()));
    }
    let mut column_formats = Vec::with_capacity(columns as usize);
    for index in 0..columns as usize {
        let offset = 3 + index * 2;
        let code = u16::from_be_bytes([payload[offset], payload[offset + 1]]);
        if code > 1 {
            return Err(PostgresError::Protocol(format!("invalid PostgreSQL copy column format {code}")));
        }
        column_formats.push(code);
    }
    Ok(CopyResponse { format, columns, column_formats })
}

/// One `CopyData` message carrying a chunk of the copy stream.
pub fn copy_data_packet(data: &[u8]) -> Result<Vec<u8>, PostgresError> {
    frame(b'd', data.to_vec())
}

/// One `CopyDone` message.
pub fn copy_done_packet() -> Vec<u8> {
    vec![b'c', 0, 0, 0, 4]
}

/// One `CopyFail` message carrying a human readable reason.
pub fn copy_fail_packet(reason: &str) -> Result<Vec<u8>, PostgresError> {
    let mut payload = Vec::with_capacity(reason.len() + 1);
    push_text(&mut payload, reason);
    frame(b'f', payload)
}

/// One `Sync` message, which ends every extended-protocol round trip.
pub fn sync_packet() -> Vec<u8> {
    let mut packet = Vec::with_capacity(5);
    packet.push(b'S');
    packet.extend_from_slice(&4_u32.to_be_bytes());
    packet
}

// -------------------------------------------------------------------------------
// `CancelRequest`: a startup-position packet sent on its own connection.
// ---------------------------------------------------------------------------

/// Code carried where the startup packet carries the protocol version.
pub const CANCEL_REQUEST_CODE: u32 = 808_771_02;
/// Every `CancelRequest` packet is exactly this long.
pub const CANCEL_REQUEST_BYTES: usize = 16;

/// One `CancelRequest`, carrying the `pid` and `secret key` from `BackendKeyData`.
///
/// The packet has the startup layout instead of a tagged message, so the caller
/// writes it on a fresh socket and closes it: the server answers nothing.
pub fn cancel_request_packet(process_id: i32, secret_key: i32) -> Vec<u8> {
    let mut packet = Vec::with_capacity(CANCEL_REQUEST_BYTES);
    packet.extend_from_slice(&(CANCEL_REQUEST_BYTES as u32).to_be_bytes());
    packet.extend_from_slice(&CANCEL_REQUEST_CODE.to_be_bytes());
    packet.extend_from_slice(&process_id.to_be_bytes());
    packet.extend_from_slice(&secret_key.to_be_bytes());
    packet
}

/// Parameter OIDs carried by a `ParameterDescription`, in declaration order.
/// The server sends OID `0` for parameters whose type it could not infer.
pub fn parameter_description(payload: &[u8]) -> Result<Vec<u32>, PostgresError> {
    if payload.len() < 2 {
        return Err(truncated("ParameterDescription"));
    }
    let count = u16::from_be_bytes([payload[0], payload[1]]) as usize;
    if payload.len() != 2 + count * 4 {
        return Err(PostgresError::Protocol("invalid ParameterDescription length".into()));
    }
    let mut oids = Vec::with_capacity(count);
    for index in 0..count {
        let offset = 2 + index * 4;
        oids.push(u32::from_be_bytes([
            payload[offset],
            payload[offset + 1],
            payload[offset + 2],
            payload[offset + 3],
        ]));
    }
    Ok(oids)
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
    fn message_fields_keep_wire_order_and_every_selector() {
        let payload = b"SERROR\0VERROR\0C22P02\0Minvalid input syntax\0P8\0Ddetail text\0Hhint text\0\0";
        let fields = message_fields(payload).unwrap();
        let ordered: Vec<(u8, &str)> = fields.iter().map(|field| (field.kind, field.value.as_str())).collect();
        assert_eq!(
            ordered,
            vec![
                (b'S', "ERROR"),
                (b'V', "ERROR"),
                (b'C', "22P02"),
                (b'M', "invalid input syntax"),
                (b'P', "8"),
                (b'D', "detail text"),
                (b'H', "hint text"),
            ]
        );
    }

    #[test]
    fn error_response_exposes_position_detail_and_hint() {
        let error = error_response(b"SERROR\0VERROR\0C22P02\0Minvalid input\0P8\0Ddetail\0Hhint\0\0");
        assert_eq!(error.field(b'P'), Some("8"));
        assert_eq!(error.field(b'D'), Some("detail"));
        assert_eq!(error.field(b'H'), Some("hint"));
    }

    #[test]
    fn notice_response_keeps_severity_code_and_message() {
        let notice = notice_response(b"SNOTICE\0VNOTICE\0C00000\0Mtable \"x\" does not exist, skipping\0\0").unwrap();
        assert_eq!(notice.severity(), Some("NOTICE"));
        assert_eq!(notice.code(), Some("00000"));
        assert_eq!(notice.message(), Some("table \"x\" does not exist, skipping"));
    }

    #[test]
    fn data_row_maps_negative_length_to_null() {
        let mut payload = vec![0, 2, 0, 0, 0, 1, b'7', 0xff, 0xff, 0xff, 0xff];
        assert_eq!(data_row(&payload, 2).unwrap(), vec![Some("7".into()), None]);
        payload[1] = 3;
        assert!(data_row(&payload, 3).is_err());
    }

    fn body(packet: &[u8]) -> &[u8] {
        &packet[5..]
    }

    #[test]
    fn parse_packet_carries_names_and_type_oids() {
        let packet = parse_packet("", "SELECT $1::int4", &[23, 25]).unwrap();
        assert_eq!(packet[0], b'P');
        assert_eq!(packet.len() as u32 - 1, u32::from_be_bytes([packet[1], packet[2], packet[3], packet[4]]));
        let payload = body(&packet);
        assert_eq!(payload[0], 0);
        assert_eq!(&payload[1..17], b"SELECT $1::int4\0");
        assert_eq!(u16::from_be_bytes([payload[17], payload[18]]), 2);
        assert_eq!(u32::from_be_bytes([payload[19], payload[20], payload[21], payload[22]]), 23);
        assert_eq!(u32::from_be_bytes([payload[23], payload[24], payload[25], payload[26]]), 25);
    }

    #[test]
    fn parse_packet_refuses_more_types_than_the_wire_allows() {
        let types = vec![23_u32; MAX_PARAMETERS + 1];
        let error = parse_packet("", "SELECT 1", &types).unwrap_err();
        assert_eq!(error.message(), "at most 65535 parameter types can be declared");
    }

    #[test]
    fn bind_packet_marks_nulls_and_keeps_text_values() {
        let packet = bind_packet("", "", &[Some("42"), None, Some("héllo")], 0).unwrap();
        assert_eq!(packet[0], b'B');
        let payload = body(&packet);
        assert_eq!(&payload[..6], b"\0\0\0\0\0\x03"); // portal, statement, no formats, three parameters
        assert_eq!(i32::from_be_bytes([payload[6], payload[7], payload[8], payload[9]]), 2);
        assert_eq!(&payload[10..12], b"42");
        assert_eq!(i32::from_be_bytes([payload[12], payload[13], payload[14], payload[15]]), -1);
        assert_eq!(i32::from_be_bytes([payload[16], payload[17], payload[18], payload[19]]), "héllo".len() as i32);
        assert_eq!(payload[20], b'h');
        assert_eq!(&payload[26..], b"\0\0"); // text result formats
    }

    #[test]
    fn bind_packet_refuses_binary_results() {
        let error = bind_packet("", "", &[], 1).unwrap_err();
        assert_eq!(error.feature(), Some("binary-result-format"));
        assert_eq!(error.to_string(), "unsupported: binary-result-format");
    }

    #[test]
    fn bind_packet_refuses_more_parameters_than_the_wire_allows() {
        let params = vec![None; MAX_PARAMETERS + 1];
        let error = bind_packet("", "", &params, 0).unwrap_err();
        assert_eq!(error.message(), "at most 65535 parameters can be bound");
    }

    #[test]
    fn describe_execute_and_close_frames_are_well_formed() {
        let describe = describe_packet(b'S', "s1").unwrap();
        assert_eq!(describe, b"D\0\0\0\x08Ss1\0".to_vec());
        let execute = execute_packet("", 0).unwrap();
        assert_eq!(execute, b"E\0\0\0\x09\0\0\0\0\0".to_vec());
        let close = close_packet(b'S', "s1").unwrap();
        assert_eq!(close, b"C\0\0\0\x08Ss1\0".to_vec());
        assert_eq!(sync_packet(), b"S\0\0\0\x04".to_vec());
        assert!(describe_packet(b'X', "s1").is_err());
    }

    #[test]
    fn execute_packet_refuses_partial_row_limits() {
        let error = execute_packet("", 5).unwrap_err();
        assert_eq!(error.feature(), Some("execute-row-limit"));
        assert!(execute_packet("", -1).is_err());
    }

    #[test]
    fn parameter_description_reads_oids_in_order() {
        assert_eq!(
            parameter_description(&[0, 2, 0, 0, 0, 23, 0, 0, 6, 164]).unwrap(),
            vec![23, 1700]
        );
        assert!(parameter_description(&[0, 2, 0, 0, 0, 23]).is_err());
        assert!(parameter_description(&[]).is_err());
    }

    #[test]
    fn parameter_type_oid_matches_the_catalog() {
        assert_eq!(parameter_type_oid("int4"), Some(23));
        assert_eq!(parameter_type_oid("timestamptz"), Some(1184));
        assert_eq!(parameter_type_oid("nope"), None);
    }

    #[test]
    fn cancel_request_carries_pid_and_secret_in_sixteen_bytes() {
        let packet = cancel_request_packet(1234, 5678);
        assert_eq!(packet, b"\0\0\0\x10\x04\xd2\x16\x2e\0\0\x04\xd2\0\0\x16\x2e".to_vec());
        assert_eq!(packet.len(), CANCEL_REQUEST_BYTES);
        assert_eq!(u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]), CANCEL_REQUEST_CODE);
        assert_eq!(i32::from_be_bytes([packet[8], packet[9], packet[10], packet[11]]), 1234);
        assert_eq!(i32::from_be_bytes([packet[12], packet[13], packet[14], packet[15]]), 5678);
        assert_ne!(cancel_request_packet(0, 0), packet);
    }

    #[test]
    fn bytea_text_is_backslash_x_and_lowercase_hex() {
        assert_eq!(encode_bytea(&[0x00, 0x41, 0xff]), "\\x0041ff");
        assert_eq!(encode_bytea(&[]), "\\x");
    }
}
