//! `.yyds` catalog plus `.yykv` shard persistence.
//!
//! The layout is fixed and versioned so callers can verify it byte by byte:
//!
//! `.yyds` (big endian): magic `YYDS\x01`, version `u32`, schema `u32`,
//! shard count `u32`, shard id length `u32` with the id bytes, then two zero
//! `u32` terminators.
//!
//! `.yykv` (little endian): magic `YYKV\x03`, FNV-1a checksum `u64` over the
//! body, then `next_revision u64`, record count `u32`, and records made of
//! namespace, key, revision `u64`, deadline `u64`, tag `u8` and value bytes.
//! Writes go through a temp file and a rename, so a crash leaves the previous
//! shard intact.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::PostgresError;

const SHARD_MAGIC: &[u8] = b"YYKV\x03";
const LEGACY_SHARD_MAGIC: &[u8] = b"YYKV\x02";
const CATALOG_MAGIC: &[u8] = b"YYDS\x01";
const CATALOG_VERSION: u32 = 0;
const SHARD_ID: &str = "postgres-0";
const SHARD_FILE: &str = "postgres-0.yykv";
const CATALOG_FILE: &str = "postgres-0.yyds";

fn io_error(error: impl std::fmt::Display) -> PostgresError {
    PostgresError::Io(error.to_string())
}

fn protocol(message: &str) -> PostgresError {
    PostgresError::Protocol(message.to_owned())
}

/// FNV-1a 64 bit, used by the shard checksum and by independent verifiers.
pub fn checksum(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn read_u32(bytes: &[u8], offset: &mut usize, what: &str) -> Result<u32, PostgresError> {
    if *offset + 4 > bytes.len() {
        return Err(protocol(&format!("truncated {what}")));
    }
    let value = u32::from_le_bytes([bytes[*offset], bytes[*offset + 1], bytes[*offset + 2], bytes[*offset + 3]]);
    *offset += 4;
    Ok(value)
}

fn read_u64(bytes: &[u8], offset: &mut usize, what: &str) -> Result<u64, PostgresError> {
    if *offset + 8 > bytes.len() {
        return Err(protocol(&format!("truncated {what}")));
    }
    let mut buffer = [0_u8; 8];
    buffer.copy_from_slice(&bytes[*offset..*offset + 8]);
    *offset += 8;
    Ok(u64::from_le_bytes(buffer))
}

/// One stored row.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    revision: u64,
    deadline: u64,
    tag: u8,
    value: Vec<u8>,
}

struct Inner {
    records: BTreeMap<(String, Vec<u8>), Record>,
    next_revision: u64,
}

impl Inner {
    fn encode_shard(&self) -> Vec<u8> {
        let mut body = Vec::new();
        push_u64(&mut body, self.next_revision);
        push_u32(&mut body, self.records.len() as u32);
        for ((namespace, key), record) in &self.records {
            push_u32(&mut body, namespace.len() as u32);
            body.extend_from_slice(namespace.as_bytes());
            push_u32(&mut body, key.len() as u32);
            body.extend_from_slice(key);
            push_u64(&mut body, record.revision);
            push_u64(&mut body, record.deadline);
            body.push(record.tag);
            push_u32(&mut body, record.value.len() as u32);
            body.extend_from_slice(&record.value);
        }
        let mut bytes = Vec::with_capacity(body.len() + 13);
        bytes.extend_from_slice(SHARD_MAGIC);
        bytes.extend_from_slice(&checksum(&body).to_le_bytes());
        bytes.extend_from_slice(&body);
        bytes
    }
}

fn decode_shard(bytes: &[u8]) -> Result<(BTreeMap<(String, Vec<u8>), Record>, u64), PostgresError> {
    if bytes.len() < SHARD_MAGIC.len() {
        return Err(protocol("truncated .yykv header"));
    }
    let magic = &bytes[..SHARD_MAGIC.len()];
    if magic == LEGACY_SHARD_MAGIC {
        return Err(protocol(
            "legacy .yykv v2 snapshot carries no checksum: delete the shard and let the node recreate it",
        ));
    }
    if magic != SHARD_MAGIC {
        return Err(protocol("unknown .yykv header"));
    }
    if bytes.len() < SHARD_MAGIC.len() + 8 {
        return Err(protocol("truncated shard checksum"));
    }
    let expected = u64::from_le_bytes([
        bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12],
    ]);
    let body = &bytes[13..];
    if checksum(body) != expected {
        return Err(protocol(".yykv checksum mismatch"));
    }

    let mut offset = 0;
    let next_revision = read_u64(body, &mut offset, "shard header")?;
    if next_revision == 0 {
        return Err(protocol("invalid shard revision"));
    }
    let count = read_u32(body, &mut offset, "shard header")?;
    let mut records = BTreeMap::new();
    for _ in 0..count {
        let namespace_length = read_u32(body, &mut offset, "shard record")? as usize;
        if offset + namespace_length > body.len() {
            return Err(protocol("truncated shard record"));
        }
        let namespace_bytes = &body[offset..offset + namespace_length];
        offset += namespace_length;
        let namespace = String::from_utf8(namespace_bytes.to_vec()).map_err(|_| protocol("shard namespace is not utf8"))?;
        let key_length = read_u32(body, &mut offset, "shard record")? as usize;
        if offset + key_length > body.len() {
            return Err(protocol("truncated shard record"));
        }
        let key = body[offset..offset + key_length].to_vec();
        offset += key_length;
        let revision = read_u64(body, &mut offset, "shard record")?;
        let deadline = read_u64(body, &mut offset, "shard record")?;
        if offset + 1 > body.len() {
            return Err(protocol("truncated shard record"));
        }
        let tag = body[offset];
        offset += 1;
        let value_length = read_u32(body, &mut offset, "shard record")? as usize;
        if offset + value_length > body.len() {
            return Err(protocol("truncated shard record"));
        }
        let value = body[offset..offset + value_length].to_vec();
        offset += value_length;
        if revision == 0 || revision >= next_revision {
            return Err(protocol("invalid shard revision"));
        }
        if deadline != 0 {
            return Err(protocol("expired shard records are unsupported"));
        }
        if tag != 0 {
            return Err(protocol("unknown shard record tag"));
        }
        if records.insert((namespace, key), Record { revision, deadline, tag, value }).is_some() {
            return Err(protocol("duplicate shard key"));
        }
    }
    if offset != body.len() {
        return Err(protocol("trailing shard bytes"));
    }
    Ok((records, next_revision))
}

fn encode_catalog() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(CATALOG_MAGIC);
    bytes.extend_from_slice(&CATALOG_VERSION.to_be_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(&1_u32.to_be_bytes());
    bytes.extend_from_slice(&(SHARD_ID.len() as u32).to_be_bytes());
    bytes.extend_from_slice(SHARD_ID.as_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes
}

fn decode_catalog(bytes: &[u8]) -> Result<String, PostgresError> {
    if bytes.len() < CATALOG_MAGIC.len() + 4 {
        return Err(protocol("truncated catalog header"));
    }
    if &bytes[..CATALOG_MAGIC.len()] != CATALOG_MAGIC {
        return Err(protocol("unknown .yyds catalog header"));
    }
    let version = u32::from_be_bytes([bytes[5], bytes[6], bytes[7], bytes[8]]);
    if version != CATALOG_VERSION {
        return Err(protocol("catalog version requires regeneration"));
    }
    let read = |offset: usize| -> Result<u32, PostgresError> {
        if offset + 4 > bytes.len() {
            return Err(protocol("truncated catalog header"));
        }
        Ok(u32::from_be_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]]))
    };
    let _schema = read(9)?;
    let shard_count = read(13)?;
    if shard_count != 1 {
        return Err(protocol("unsupported catalog shard count"));
    }
    let id_length = read(17)? as usize;
    if 21 + id_length + 8 > bytes.len() {
        return Err(protocol("truncated catalog header"));
    }
    let shard_id = String::from_utf8(bytes[21..21 + id_length].to_vec()).map_err(|_| protocol("catalog shard id is not utf8"))?;
    let terminator = 21 + id_length;
    if read(terminator)? != 0 || read(terminator + 4)? != 0 {
        return Err(protocol("trailing catalog bytes"));
    }
    if terminator + 8 != bytes.len() {
        return Err(protocol("trailing catalog bytes"));
    }
    Ok(shard_id)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), PostgresError> {
    use std::io::Write;

    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    let mut file = fs::File::create(&temp).map_err(|error| io_error(format!("{}: {error}", temp.display())))?;
    file.write_all(bytes).map_err(|error| io_error(format!("{}: {error}", temp.display())))?;
    file.sync_all().map_err(|error| io_error(format!("{}: {error}", temp.display())))?;
    drop(file);
    fs::rename(&temp, path).map_err(|error| io_error(format!("{} -> {}: {error}", temp.display(), path.display())))
}

/// A durable namespace/key store backed by one `.yyds` catalog and one `.yykv` shard.
pub struct Store {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

impl Store {
    /// Opens or creates the store. Missing files are written; corrupt files are rejected.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self, PostgresError> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir).map_err(io_error)?;
        let catalog = dir.join(CATALOG_FILE);
        let shard = dir.join(SHARD_FILE);
        if catalog.exists() {
            let bytes = fs::read(&catalog).map_err(io_error)?;
            decode_catalog(&bytes)?;
        } else {
            write_atomic(&catalog, &encode_catalog())?;
        }
        let inner = if shard.exists() {
            let bytes = fs::read(&shard).map_err(io_error)?;
            let (records, next_revision) = decode_shard(&bytes)?;
            Inner { records, next_revision }
        } else {
            Inner { records: BTreeMap::new(), next_revision: 1 }
        };
        if !shard.exists() {
            write_atomic(&shard, &inner.encode_shard())?;
        }
        Ok(Self { dir, inner: Mutex::new(inner) })
    }

    /// Absolute directory the store lives in.
    pub fn data_dir(&self) -> String {
        self.dir.display().to_string()
    }

    /// Absolute `.yykv` shard path.
    pub fn shard_path(&self) -> String {
        self.dir.join(SHARD_FILE).display().to_string()
    }

    /// Absolute `.yyds` catalog path.
    pub fn catalog_path(&self) -> String {
        self.dir.join(CATALOG_FILE).display().to_string()
    }

    /// Writes one row, assigning the next revision.
    pub fn put(&self, namespace: &str, key: &[u8], value: &[u8]) -> Result<(), PostgresError> {
        validate_namespace(namespace)?;
        let mut inner = self.inner.lock().expect("store lock");
        let revision = inner.next_revision;
        inner.next_revision += 1;
        inner
            .records
            .insert((namespace.to_owned(), key.to_vec()), Record { revision, deadline: 0, tag: 0, value: value.to_vec() });
        let bytes = inner.encode_shard();
        write_atomic(&self.dir.join(SHARD_FILE), &bytes)
    }

    /// Reads one row, or `None` when the key is absent.
    pub fn get(&self, namespace: &str, key: &[u8]) -> Option<Vec<u8>> {
        let inner = self.inner.lock().expect("store lock");
        inner.records.get(&(namespace.to_owned(), key.to_vec())).map(|record| record.value.clone())
    }

    /// Removes one row and reports whether it existed.
    pub fn delete(&self, namespace: &str, key: &[u8]) -> Result<bool, PostgresError> {
        let mut inner = self.inner.lock().expect("store lock");
        let removed = inner.records.remove(&(namespace.to_owned(), key.to_vec())).is_some();
        if removed {
            let bytes = inner.encode_shard();
            write_atomic(&self.dir.join(SHARD_FILE), &bytes)?;
        }
        Ok(removed)
    }

    /// Keys of one namespace with the given byte prefix, ordered by key.
    pub fn keys(&self, namespace: &str, prefix: &[u8]) -> Vec<Vec<u8>> {
        let inner = self.inner.lock().expect("store lock");
        inner
            .records
            .keys()
            .filter(|(name, key)| name == namespace && key.starts_with(prefix))
            .map(|(_, key)| key.clone())
            .collect()
    }

    /// Key/value pairs of one namespace with the given byte prefix.
    pub fn scan(&self, namespace: &str, prefix: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
        let inner = self.inner.lock().expect("store lock");
        inner
            .records
            .iter()
            .filter(|((name, key), _)| name == namespace && key.starts_with(prefix))
            .map(|((_, key), record)| (key.clone(), record.value.clone()))
            .collect()
    }

    /// Distinct namespaces that currently hold at least one row.
    pub fn namespaces(&self) -> Vec<String> {
        let inner = self.inner.lock().expect("store lock");
        inner.records.keys().map(|(namespace, _)| namespace.clone()).collect::<BTreeSet<_>>().into_iter().collect()
    }

    /// Number of rows in one namespace.
    pub fn len(&self, namespace: &str) -> usize {
        let inner = self.inner.lock().expect("store lock");
        inner.records.keys().filter(|(name, _)| name == namespace).count()
    }

    /// Whether the namespace holds no rows.
    pub fn is_empty(&self, namespace: &str) -> bool {
        self.len(namespace) == 0
    }

    /// Removes every row of one namespace and returns how many were removed.
    pub fn flush(&self, namespace: &str) -> Result<usize, PostgresError> {
        let mut inner = self.inner.lock().expect("store lock");
        let before = inner.records.len();
        inner.records.retain(|(name, _), _| name != namespace);
        let removed = before - inner.records.len();
        if removed > 0 {
            let bytes = inner.encode_shard();
            write_atomic(&self.dir.join(SHARD_FILE), &bytes)?;
        }
        Ok(removed)
    }
}

fn validate_namespace(namespace: &str) -> Result<(), PostgresError> {
    if namespace.is_empty() {
        return Err(protocol("namespace must not be empty"));
    }
    if namespace.as_bytes().contains(&0) {
        return Err(protocol("namespace must not contain a NUL byte"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary(label: &str) -> PathBuf {
        let mut path = std::env::current_exe().expect("test binary path");
        path.pop();
        if path.ends_with("deps") {
            path.pop();
        }
        path.push(format!("postgres-store-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn round_trip_keeps_revision_order() {
        let dir = temporary("roundtrip");
        let store = Store::open(&dir).unwrap();
        store.put("public.users", b"u1", b"alice").unwrap();
        store.put("public.users", b"u2", b"bob").unwrap();
        drop(store);
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.get("public.users", b"u1"), Some(b"alice".to_vec()));
        assert_eq!(reopened.namespaces(), vec!["public.users".to_owned()]);
        let bytes = fs::read(reopened.shard_path()).unwrap();
        assert_eq!(&bytes[..5], SHARD_MAGIC);
        let (records, next) = decode_shard(&bytes).unwrap();
        assert_eq!(next, 3);
        assert_eq!(records.len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn checksum_rejects_tampering() {
        let bytes = b"YYKV\x03\0\0\0\0\0\0\0\0";
        assert_eq!(decode_shard(bytes).unwrap_err().message(), ".yykv checksum mismatch");
    }

    #[test]
    fn catalog_layout_is_stable() {
        let bytes = encode_catalog();
        assert_eq!(&bytes[..5], CATALOG_MAGIC);
        assert_eq!(decode_catalog(&bytes).unwrap(), SHARD_ID);
    }
}
