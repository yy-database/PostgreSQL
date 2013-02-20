//! PostgreSQL protocol-v3 primitives plus the `.yyds`/`.yykv` store and the
//! `psql` argument surface.
//!
//! The crate exposes small, independently callable building blocks and keeps no
//! global state: one [`ClientConfig`] describes where to connect, one
//! [`Connection`] owns a single socket, one [`Connection::execute`] performs the
//! simple-query round trip, [`PostgresError`] carries the server error code, and
//! [`Store`] persists rows. Rendering, command lines and server emulation are
//! composed outside.

mod client;
mod error;
pub mod protocol;
pub mod psql;
pub mod store;

pub use client::{ClientConfig, Column, Connection, QueryResult};
pub use error::PostgresError;
pub use psql::PsqlOptions;
pub use store::Store;
