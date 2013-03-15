//! Scripted protocol-v3 servers that drive failure paths no SQL engine can
//! produce on demand: a peer that dies mid-result, a truncated frame, the
//! `ReadyForQuery` recovery after `08P01`, and the `CancelRequest` bytes.
//!
//! The fixtures speak only framing. They are not an engine, and their replies
//! are fixed byte scripts.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use postgres_client::{ClientConfig, Connection, PostgresError};

const WAIT: Duration = Duration::from_secs(5);

fn frame(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(payload.len() + 5);
    bytes.push(tag);
    bytes.extend_from_slice(&(payload.len() as u32 + 4).to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

fn read_startup(stream: &mut TcpStream) {
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length).expect("startup length");
    let length = u32::from_be_bytes(length) as usize;
    let mut body = vec![0_u8; length - 4];
    stream.read_exact(&mut body).expect("startup body");
}

fn startup_ok(stream: &mut TcpStream, key: Option<(i32, i32)>) {
    stream.write_all(&frame(b'R', &[0, 0, 0, 0])).expect("AuthenticationOk");
    if let Some((process_id, secret_key)) = key {
        let mut payload = Vec::new();
        payload.extend_from_slice(&process_id.to_be_bytes());
        payload.extend_from_slice(&secret_key.to_be_bytes());
        stream.write_all(&frame(b'K', &payload)).expect("BackendKeyData");
    }
    stream.write_all(&frame(b'Z', b"I")).expect("ReadyForQuery");
}

fn read_tagged(stream: &mut TcpStream) -> (u8, Vec<u8>) {
    let mut header = [0_u8; 5];
    stream.read_exact(&mut header).expect("message header");
    let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
    let mut payload = vec![0_u8; length - 4];
    stream.read_exact(&mut payload).expect("message payload");
    (header[0], payload)
}

fn row_description(column: &str) -> Vec<u8> {
    let mut payload = vec![0, 1];
    payload.extend_from_slice(column.as_bytes());
    payload.push(0);
    payload.extend_from_slice(&[0, 0, 0, 0]); // table oid
    payload.extend_from_slice(&[0, 0]); // column attribute
    payload.extend_from_slice(&[0, 0, 0, 23]); // int4
    payload.extend_from_slice(&[0, 0]); // type size
    payload.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // type modifier
    payload.extend_from_slice(&[0, 0]); // text format
    payload
}

fn data_row(value: &str) -> Vec<u8> {
    let mut payload = vec![0, 1];
    payload.extend_from_slice(&(value.len() as i32).to_be_bytes());
    payload.extend_from_slice(value.as_bytes());
    payload
}

fn spawn_server<F>(script: F) -> (u16, thread::JoinHandle<()>)
where
    F: FnOnce(TcpListener) + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("local address").port();
    let handle = thread::spawn(move || script(listener));
    (port, handle)
}

fn config(port: u16) -> ClientConfig {
    ClientConfig::new("127.0.0.1", port, "postgres", "postgres")
}

#[test]
fn cancel_request_uses_a_fresh_connection_and_the_backend_key() {
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    let (port, handle) = spawn_server(move |listener| {
        let (mut main, _) = listener.accept().expect("main session");
        read_startup(&mut main);
        startup_ok(&mut main, Some((1234, 5678)));

        let (_tag, _payload) = read_tagged(&mut main);
        main.write_all(&frame(b'C', b"SELECT 1\0")).expect("CommandComplete");
        main.write_all(&frame(b'Z', b"I")).expect("ReadyForQuery");

        let (mut cancel, _) = listener.accept().expect("cancel connection");
        let mut packet = [0_u8; 16];
        cancel.read_exact(&mut packet).expect("CancelRequest bytes");
        sender.send(packet.to_vec()).expect("send captured packet");
        drop(cancel);

        let (_tag, _payload) = read_tagged(&mut main);
        main.write_all(&frame(b'C', b"SELECT 1\0")).expect("CommandComplete");
        main.write_all(&frame(b'Z', b"I")).expect("ReadyForQuery");
    });

    let mut connection = Connection::open(&config(port)).expect("open");
    let key = connection.backend_key_data().expect("server sent BackendKeyData");
    assert_eq!((key.process_id, key.secret_key), (1234, 5678));
    assert_eq!(connection.execute("SELECT 1").expect("first statement")[0].tag, "SELECT 1");

    connection.cancel().expect("cancel");
    let packet = receiver.recv_timeout(WAIT).expect("cancel packet arrived");
    assert_eq!(packet.len(), 16, "CancelRequest is exactly sixteen bytes");
    assert_eq!(u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]), 808_771_02);
    assert_eq!(i32::from_be_bytes([packet[8], packet[9], packet[10], packet[11]]), 1234);
    assert_eq!(i32::from_be_bytes([packet[12], packet[13], packet[14], packet[15]]), 5678);

    assert_eq!(connection.execute("SELECT 1").expect("same session after cancel")[0].tag, "SELECT 1");
    handle.join().expect("server thread");
    let _ = connection.close();
}

#[test]
fn server_error_then_ready_for_query_keeps_the_connection_usable() {
    let (port, handle) = spawn_server(|listener| {
        let (mut server, _) = listener.accept().expect("session");
        read_startup(&mut server);
        startup_ok(&mut server, Some((7, 9)));

        let (_tag, _payload) = read_tagged(&mut server);
        server
            .write_all(&frame(b'E', b"SERROR\0VERROR\0C08P01\0Mbind message supplies 0 parameters\0\0"))
            .expect("ErrorResponse");
        server.write_all(&frame(b'Z', b"I")).expect("ReadyForQuery");

        let (_tag, _payload) = read_tagged(&mut server);
        server.write_all(&frame(b'T', &row_description("n"))).expect("RowDescription");
        server.write_all(&frame(b'D', &data_row("1"))).expect("DataRow");
        server.write_all(&frame(b'C', b"SELECT 1\0")).expect("CommandComplete");
        server.write_all(&frame(b'Z', b"I")).expect("ReadyForQuery");
    });

    let mut connection = Connection::open(&config(port)).expect("open");
    let error = connection.execute("SELECT $1").expect_err("server error");
    assert_eq!(error.code(), Some("08P01"));
    let results = connection.execute("SELECT 1 AS n").expect("next statement on the same socket");
    assert_eq!(results[0].rows, vec![vec![Some("1".to_owned())]]);
    assert_eq!(results[0].column_names().collect::<Vec<_>>(), vec!["n"]);
    handle.join().expect("server thread");
    let _ = connection.close();
}

#[test]
fn peer_close_after_a_partial_row_poisons_the_connection() {
    let (port, handle) = spawn_server(|listener| {
        let (mut server, _) = listener.accept().expect("session");
        read_startup(&mut server);
        startup_ok(&mut server, Some((1, 2)));
        let (_tag, _payload) = read_tagged(&mut server);
        server.write_all(&frame(b'T', &row_description("n"))).expect("RowDescription");
        server.write_all(&frame(b'D', &data_row("1"))).expect("DataRow");
        // No CommandComplete and no ReadyForQuery: the result is cut in half.
    });

    let mut connection = Connection::open(&config(port)).expect("open");
    let error = connection.execute("SELECT 1 AS n").expect_err("partial result must fail");
    assert!(matches!(error, PostgresError::Io(_)), "unexpected {error}");
    let again = connection.execute("SELECT 2").expect_err("poisoned connection must refuse");
    assert_eq!(again.message(), format!("connection is unusable after {error}"));
    handle.join().expect("server thread");
    let _ = connection.close();
}

#[test]
fn truncated_message_length_poisons_the_connection() {
    let (port, handle) = spawn_server(|listener| {
        let (mut server, _) = listener.accept().expect("session");
        read_startup(&mut server);
        startup_ok(&mut server, Some((3, 4)));
        let (_tag, _payload) = read_tagged(&mut server);
        // Declares a 20-byte message but only delivers five payload bytes.
        server.write_all(&[b'D', 0, 0, 0, 20, 0, 1, 0, 0, 0]).expect("half frame");
    });

    let mut connection = Connection::open(&config(port)).expect("open");
    let error = connection.execute("SELECT 1").expect_err("half frame must fail");
    assert!(matches!(error, PostgresError::Io(_)), "unexpected {error}");
    let again = connection.execute("SELECT 2").expect_err("poisoned connection must refuse");
    assert_eq!(again.message(), format!("connection is unusable after {error}"));
    handle.join().expect("server thread");
    let _ = connection.close();
}

#[test]
fn cancel_without_backend_key_data_is_a_protocol_error() {
    let (port, handle) = spawn_server(|listener| {
        let (mut server, _) = listener.accept().expect("session");
        read_startup(&mut server);
        startup_ok(&mut server, None);
        server.set_read_timeout(Some(Duration::from_millis(50))).expect("read timeout");
    });

    let connection = Connection::open(&config(port)).expect("open");
    assert!(connection.backend_key_data().is_none(), "no BackendKeyData was sent");
    let error = connection.cancel().expect_err("cancel must refuse");
    assert_eq!(error.message(), "server sent no BackendKeyData to cancel");
    handle.join().expect("server thread");
}
