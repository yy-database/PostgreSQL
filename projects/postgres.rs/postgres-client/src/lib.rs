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

pub mod psql;
pub mod server_store;
pub mod store;

/// Protocol-v3 message builders and parsers, re-exported from
/// `database-protocol-pgsql`.
pub mod protocol {
    pub use database_protocol_pgsql::*;
}

pub use database_client::pgsql::{
    client::{
        BackendKeyData, ClientConfig, Column, Connection, CopyInReport, CopyOutReport, Param, Portal, PortalReport, Prepared,
        QueryResult, Report,
    },
    error::{MessageField, Notice, PostgresError},
};
pub use psql::PsqlOptions;
pub use server_store::{ServerChange, ServerRow, ServerStore};
pub use store::Store;
