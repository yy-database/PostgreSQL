use core::fmt;

/// Everything a protocol-v3 client can fail with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostgresError {
    /// Socket level failure: refused, reset, closed early.
    Io(String),
    /// The server answered with an `ErrorResponse`.
    Server { code: String, message: String },
    /// The byte stream did not match the protocol contract.
    Protocol(String),
}

impl PostgresError {
    /// Server error code such as `42P01`. Absent for transport failures.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Server { code, .. } => Some(code),
            _ => None,
        }
    }

    /// Human readable message without the code prefix.
    pub fn message(&self) -> &str {
        match self {
            Self::Io(message) | Self::Protocol(message) => message,
            Self::Server { message, .. } => message,
        }
    }
}

impl fmt::Display for PostgresError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message) | Self::Protocol(message) => formatter.write_str(message),
            Self::Server { code, message } => write!(formatter, "{code}: {message}"),
        }
    }
}

impl std::error::Error for PostgresError {}
