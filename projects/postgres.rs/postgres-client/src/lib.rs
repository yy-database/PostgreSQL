//! PostgreSQL protocol-v3 primitives plus the `.yyds`/`.yykv` store and the
//! `psql` argument surface.
//!
//! The crate exposes small, independently callable building blocks and keeps no
//! global state: one [`ClientConfig`] describes where to connect, one
//! [`Connection`] owns a single socket, [`Connection::execute`] performs the
//! simple-query round trip, [`Connection::execute_report`] keeps the statements
//! that finished before an error and every notice, [`Connection::execute_with_params`]
//! and [`Connection::prepare`] drive the extended-protocol subset,
//! [`PostgresError`] carries the server error code and the ordered response
//! fields, and [`Store`] persists rows. Rendering, command lines and server
//! emulation are composed outside.

mod client;
mod error;
pub mod protocol;
pub mod psql;
pub mod store;

pub use client::{
    BackendKeyData, ClientConfig, Column, Connection, CopyInReport, CopyOutReport, Prepared, QueryResult, Report,
};
pub use error::{MessageField, Notice, PostgresError};
pub use psql::PsqlOptions;
pub use store::Store;
