//! `.yyds` catalog plus `.yykv` shard persistence.
//!
//! Both byte formats are owned by `database-formats`: the catalog is the shared
//! contract-layout codec (the same bytes Redis and MongoDB write: magic
//! `YYDS\x01`, little-endian version, schema slot, routing slot, shard
//! registrations, resolved contract and owners), and the shard is the shared
//! `.yykv` snapshot codec (magic `YYKV\x03`, FNV-1a body checksum, then
//! `next_revision u64`, record count `u32`, and records made of namespace, key,
//! revision `u64`, deadline `u64`, value tag `u8` and value bytes).
//!
//! This module only keeps the PostgreSQL-specific mapping: the catalog owns the
//! shard id (`<id>.yykv` next to it), the record model stays inline-only, and
//! every shared-codec failure is re-worded to the message PostgreSQL users
//! already see. Legacy big-endian PostgreSQL catalogs (`postgres-0.yyds`) are
//! rejected explicitly; they are never sniffed or guessed. Writes go through a
//! temp file and a rename, so a crash leaves the previous shard intact.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use database_formats::yy::{
    yyds::{CATALOG_MAGIC, decode_catalog_shard_id as shared_catalog_shard_id, encode_catalog},
    yykv::{
        InlineValue, KV_LEGACY_MAGIC, KV_MAGIC, Key, Record as ShardRecord, Snapshot, StoredValue, decode_snapshot_strict,
        encode_snapshot, kv_format::checksum as shard_checksum,
    },
};
use database_types::{
    ReasonCode,
    cluster::{Error as ClusterError, ShardId},
};

use crate::PostgresError;

const DEFAULT_SHARD_ID: &str = "local-0";
const CATALOG_FILE: &str = "local-0.yyds";
const LEGACY_CATALOG_FILE: &str = "postgres-0.yyds";

fn io_error(error: impl std::fmt::Display) -> PostgresError {
    PostgresError::Io(error.to_string())
}

fn protocol(message: &str) -> PostgresError {
    PostgresError::Protocol(message.to_owned())
}

/// Re-words a shared `.yykv` codec failure as the PostgreSQL-facing message.
///
/// The shared codec names the format without a product prefix; PostgreSQL
/// messages have always called it `.yykv`, so the mapping keeps the external
/// wording byte-for-byte while the decoder itself stays in `database-formats`.
fn shard_error(error: ClusterError) -> PostgresError {
    match error {
        ClusterError::Io(error) => io_error(error.to_string()),
        ClusterError::Corrupt(reason) => protocol(shard_message(reason)),
        ClusterError::CorruptReason { message, .. } => protocol(shard_message(message)),
        other => protocol(&other.to_string()),
    }
}

fn shard_message(message: &'static str) -> &'static str {
    match message {
        "unknown yykv header" => "unknown .yykv header",
        "yykv checksum mismatch" => ".yykv checksum mismatch",
        "legacy yykv v2 snapshot has no checksum: delete the shard file and let the node recreate it" => {
            "legacy .yykv v2 snapshot carries no checksum: delete the shard and let the node recreate it"
        }
        // The shared decoder reports both pre-contract revision layouts as legacy;
        // PostgreSQL has always folded them into one message.
        "legacy yykv revision layout: next_revision is zero" | "legacy yykv revision layout: record sits on next_revision" => {
            "invalid shard revision"
        }
        "shard namespace utf8" => "shard namespace is not utf8",
        "invalid shard value kind" => "unknown shard record tag",
        "unexpected shard eof" => "truncated shard record",
        other => other,
    }
}

/// Byte length of the shard body header: `next_revision u64` plus count `u32`.
const SHARD_HEADER_LEN: usize = 12;

/// Fixed prefix the shared snapshot encoder writes before its first record:
/// magic `5`, checksum `8`, `next_revision` `8` and count `4`.
const SNAPSHOT_PREFIX_LEN: usize = KV_MAGIC.len() + 8 + 8 + 4;

/// One stored row: the shard-assigned revision, its inline bytes, and where the
/// encoded record sits inside [`Inner::body`].
#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    revision: u64,
    value: Vec<u8>,
    start: usize,
}

struct Inner {
    records: BTreeMap<(String, Vec<u8>), Record>,
    next_revision: u64,
    /// Canonical shard body: the 12-byte header followed by every encoded record
    /// in `records` order. A mutation splices only the affected record, so the
    /// shard is never re-encoded as a whole.
    body: Vec<u8>,
}

impl Inner {
    fn empty() -> Self {
        let mut inner = Self { records: BTreeMap::new(), next_revision: 1, body: vec![0; SHARD_HEADER_LEN] };
        inner.sync_header();
        inner
    }

    fn from_decoded(records: BTreeMap<(String, Vec<u8>), Record>, next_revision: u64) -> Result<Self, PostgresError> {
        let mut inner = Self { records, next_revision, body: Vec::new() };
        inner.rebuild_body()?;
        Ok(inner)
    }

    fn sync_header(&mut self) {
        self.body[..8].copy_from_slice(&self.next_revision.to_le_bytes());
        self.body[8..SHARD_HEADER_LEN].copy_from_slice(&(self.records.len() as u32).to_le_bytes());
    }

    /// Re-encodes every record. Used at open and for namespace-wide removals;
    /// the steady-state write path never calls it.
    fn rebuild_body(&mut self) -> Result<(), PostgresError> {
        let mut body = vec![0_u8; SHARD_HEADER_LEN];
        for ((namespace, key), record) in &mut self.records {
            let bytes = encode_record(namespace, key, record.revision, &record.value)?;
            record.start = body.len();
            body.extend_from_slice(&bytes);
        }
        self.body = body;
        self.sync_header();
        Ok(())
    }

    /// Inserts or overwrites one row and splices only that record into the body.
    fn write_row(&mut self, namespace: &str, key: &[u8], revision: u64, value: &[u8]) -> Result<(), PostgresError> {
        let bytes = encode_record(namespace, key, revision, value)?;
        let lookup = (namespace.to_owned(), key.to_vec());
        let (offset, replaced) = match self.records.get(&lookup) {
            Some(record) => {
                let start = record.start;
                (start, self.span_end(&lookup) - start)
            }
            None => (self.insert_offset(&lookup), 0),
        };
        self.body.splice(offset..offset + replaced, bytes.iter().copied());
        let delta = bytes.len() as isize - replaced as isize;
        self.shift_starts(&lookup, offset + replaced, delta);
        self.records.insert(lookup, Record { revision, value: value.to_vec(), start: offset });
        self.next_revision = revision.saturating_add(1);
        self.sync_header();
        Ok(())
    }

    /// Removes one row and splices its bytes out of the body.
    fn remove_row(&mut self, key: &(String, Vec<u8>)) -> bool {
        let (start, end) = match self.records.get(key) {
            Some(record) => {
                let start = record.start;
                (start, self.span_end(key))
            }
            None => return false,
        };
        self.body.drain(start..end);
        self.records.remove(key);
        self.shift_starts(key, end, -((end - start) as isize));
        self.sync_header();
        true
    }

    /// Byte offset where the next record after `key` starts, or the body end.
    fn span_end(&self, key: &(String, Vec<u8>)) -> usize {
        self.records.range(key.clone()..).nth(1).map(|(_, record)| record.start).unwrap_or(self.body.len())
    }

    /// Byte offset a record inserted at `key` would occupy.
    fn insert_offset(&self, key: &(String, Vec<u8>)) -> usize {
        self.records.range(key.clone()..).next().map(|(_, record)| record.start).unwrap_or(self.body.len())
    }

    /// Shifts the cached offsets of every record at or after `threshold`.
    fn shift_starts(&mut self, key: &(String, Vec<u8>), threshold: usize, delta: isize) {
        if delta == 0 {
            return;
        }
        for (_, record) in self.records.range_mut(key.clone()..) {
            if record.start >= threshold {
                record.start = (record.start as isize + delta) as usize;
            }
        }
    }
}

/// Encodes one record by asking the shared codec for a one-record snapshot and
/// dropping its fixed prefix, so the record layout stays in `database-formats`.
fn encode_record(namespace: &str, key: &[u8], revision: u64, value: &[u8]) -> Result<Vec<u8>, PostgresError> {
    let key = Key::new(namespace, key.to_vec());
    let record =
        ShardRecord { key: key.clone(), value: StoredValue::Inline(InlineValue(value.to_vec())), revision, expires_at: None };
    let snapshot = BTreeMap::from([(key, record)]);
    // `revision + 1` satisfies the shared guard that every record sits below
    // `next_revision`.
    let bytes = encode_snapshot(&snapshot, revision.saturating_add(1)).map_err(shard_error)?;
    Ok(bytes[SNAPSHOT_PREFIX_LEN..].to_vec())
}

fn persist(path: &Path, inner: &Inner) -> Result<(), PostgresError> {
    let checksum = shard_checksum(&inner.body);
    write_atomic(path, &[KV_MAGIC, &checksum.to_le_bytes(), &inner.body])
}

fn decode_shard(bytes: &[u8]) -> Result<(BTreeMap<(String, Vec<u8>), Record>, u64), PostgresError> {
    // Header checks stay here so the shared decoder's generic EOF/legacy
    // classification keeps mapping onto the messages PostgreSQL has always
    // returned for these shard shapes.
    if bytes.len() < KV_MAGIC.len() {
        return Err(protocol("truncated .yykv header"));
    }
    if bytes.starts_with(KV_LEGACY_MAGIC) {
        return Err(protocol("legacy .yykv v2 snapshot carries no checksum: delete the shard and let the node recreate it"));
    }
    if !bytes.starts_with(KV_MAGIC) {
        return Err(protocol("unknown .yykv header"));
    }
    if bytes.len() < KV_MAGIC.len() + 8 {
        return Err(protocol("truncated shard checksum"));
    }
    let body = &bytes[KV_MAGIC.len() + 8..];
    let Snapshot { next_revision, records } = decode_snapshot_strict(bytes).map_err(|error| {
        // The shared decoder reports one generic EOF class; PostgreSQL has always
        // split it by whether the fixed shard header itself fit.
        if matches!(error, ClusterError::CorruptReason { reason: ReasonCode::Truncated, .. }) {
            return protocol(if body.len() < 12 { "truncated shard header" } else { "truncated shard record" });
        }
        shard_error(error)
    })?;
    let mut shard = BTreeMap::new();
    for (key, record) in records {
        if record.expires_at.is_some() {
            return Err(protocol("expired shard records are unsupported"));
        }
        let StoredValue::Inline(value) = record.value
        else {
            return Err(protocol("unknown shard record tag"));
        };
        shard.insert((key.namespace.0, key.bytes), Record { revision: record.revision, value: value.0, start: 0 });
    }
    Ok((shard, next_revision))
}

pub(crate) fn encode_catalog_bytes(shard_id: &str) -> Result<Vec<u8>, PostgresError> {
    let message = match encode_catalog(None, None, &[ShardId(shard_id.to_owned())], None, &[]) {
        Ok(bytes) => return Ok(bytes),
        Err(error) => format!("cannot encode .yyds catalog: {error}"),
    };
    Err(protocol(&message))
}

/// Reads the single shard id a catalog registers.
///
/// Decoding and single-registration validation come from `database-formats`;
/// this wrapper only keeps the PostgreSQL-facing wording and the legacy
/// big-endian pre-check.
pub(crate) fn decode_catalog_shard_id(bytes: &[u8]) -> Result<String, PostgresError> {
    if legacy_catalog_bytes(bytes) {
        return Err(protocol("legacy PostgreSQL catalog layout: delete the store directory and reinitialize"));
    }
    let shard_id = shared_catalog_shard_id(bytes).map_err(catalog_error)?;
    // `ShardId::try_new` rejects `.`, `..` and path separators. The id also
    // becomes a file stem here, so a NUL byte stays unusable even though the
    // shared constructor does not check for it.
    if shard_id.0.as_bytes().contains(&0) {
        return Err(protocol("catalog shard id is unusable"));
    }
    Ok(shard_id.0)
}

fn catalog_error(error: ClusterError) -> PostgresError {
    match error {
        ClusterError::InvalidShardId { .. } => protocol("catalog shard id is unusable"),
        ClusterError::Unsupported(reason)
            if reason == "catalog registers no shard" || reason == "catalog registers more than one shard" =>
        {
            protocol("unsupported catalog shard count")
        }
        other => protocol(&format!("invalid .yyds catalog: {}", catalog_reason(other))),
    }
}

fn catalog_reason(error: ClusterError) -> String {
    match error {
        ClusterError::Corrupt(reason) | ClusterError::Unsupported(reason) => reason.to_owned(),
        other => other.to_string(),
    }
}

/// Pre-contract PostgreSQL catalogs encoded the shard count as big-endian
/// `1` where the contract stores the routing presence flag. They are rejected
/// outright; the bytes are never interpreted as a little-endian catalog.
fn legacy_catalog_bytes(bytes: &[u8]) -> bool {
    bytes.len() >= 17
        && bytes.starts_with(CATALOG_MAGIC)
        && bytes[5..9] == [0, 0, 0, 0]
        && bytes[9..13] == [0, 0, 0, 0]
        && bytes[13..17] == [0, 0, 0, 1]
}

/// Test-only fault points inside [`write_atomic`], so crash safety can be
/// exercised without killing the process.
#[cfg(test)]
mod fault {
    use std::cell::Cell;

    pub const NONE: u8 = 0;
    pub const BEFORE_RENAME: u8 = 1;
    pub const AFTER_RENAME: u8 = 2;

    // Thread-local so parallel unit tests never share an armed fault point.
    thread_local! {
        static POINT: Cell<u8> = const { Cell::new(NONE) };
    }

    pub fn arm(point: u8) {
        POINT.with(|slot| slot.set(point));
    }

    pub fn disarm() {
        POINT.with(|slot| slot.set(NONE));
    }

    pub fn armed(point: u8) -> bool {
        POINT.with(|slot| slot.get() == point)
    }
}

fn write_atomic(path: &Path, parts: &[&[u8]]) -> Result<(), PostgresError> {
    use std::io::Write;

    let mut temp = path.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    let mut file = fs::File::create(&temp).map_err(|error| io_error(format!("{}: {error}", temp.display())))?;
    for part in parts {
        file.write_all(part).map_err(|error| io_error(format!("{}: {error}", temp.display())))?;
    }
    file.sync_all().map_err(|error| io_error(format!("{}: {error}", temp.display())))?;
    drop(file);
    // The temp file is complete and durable, but the shard is still untouched.
    #[cfg(test)]
    if fault::armed(fault::BEFORE_RENAME) {
        return Err(io_error(format!("{}: injected failure before rename", temp.display())));
    }
    fs::rename(&temp, path).map_err(|error| io_error(format!("{} -> {}: {error}", temp.display(), path.display())))?;
    // The swap already happened, so the new shard is live even though the call
    // reports failure.
    #[cfg(test)]
    if fault::armed(fault::AFTER_RENAME) {
        return Err(io_error(format!("{}: injected failure after rename", path.display())));
    }
    Ok(())
}

/// A durable namespace/key store backed by one `.yyds` catalog and one `.yykv` shard.
pub struct Store {
    dir: PathBuf,
    catalog: PathBuf,
    shard: PathBuf,
    inner: Mutex<Inner>,
}

impl Store {
    /// Opens or creates the store. Missing files are written; corrupt files are rejected.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self, PostgresError> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir).map_err(io_error)?;
        let catalog = dir.join(CATALOG_FILE);
        let legacy = dir.join(LEGACY_CATALOG_FILE);
        if legacy.exists() {
            return Err(protocol("legacy PostgreSQL catalog layout: delete the store directory and reinitialize"));
        }
        let shard_id = if catalog.exists() {
            let bytes = fs::read(&catalog).map_err(io_error)?;
            decode_catalog_shard_id(&bytes)?
        }
        else {
            DEFAULT_SHARD_ID.to_owned()
        };
        let shard = dir.join(format!("{shard_id}.yykv"));
        if !catalog.exists() {
            write_atomic(&catalog, &[&encode_catalog_bytes(&shard_id)?])?;
        }
        let inner = if shard.exists() {
            let bytes = fs::read(&shard).map_err(io_error)?;
            let (records, next_revision) = decode_shard(&bytes)?;
            Inner::from_decoded(records, next_revision)?
        }
        else {
            Inner::empty()
        };
        if !shard.exists() {
            persist(&shard, &inner)?;
        }
        Ok(Self { dir, catalog, shard, inner: Mutex::new(inner) })
    }

    /// Absolute directory the store lives in.
    pub fn data_dir(&self) -> String {
        self.dir.display().to_string()
    }

    /// Absolute `.yykv` shard path.
    pub fn shard_path(&self) -> String {
        self.shard.display().to_string()
    }

    /// Absolute `.yyds` catalog path.
    pub fn catalog_path(&self) -> String {
        self.catalog.display().to_string()
    }

    /// Writes one row, assigning the next revision.
    pub fn put(&self, namespace: &str, key: &[u8], value: &[u8]) -> Result<(), PostgresError> {
        validate_namespace(namespace)?;
        let mut inner = self.inner.lock().expect("store lock");
        let revision = inner.next_revision;
        inner.write_row(namespace, key, revision, value)?;
        persist(&self.shard, &inner)
    }

    /// Reads one row, or `None` when the key is absent.
    pub fn get(&self, namespace: &str, key: &[u8]) -> Option<Vec<u8>> {
        let inner = self.inner.lock().expect("store lock");
        inner.records.get(&(namespace.to_owned(), key.to_vec())).map(|record| record.value.clone())
    }

    /// Removes one row and reports whether it existed.
    pub fn delete(&self, namespace: &str, key: &[u8]) -> Result<bool, PostgresError> {
        let mut inner = self.inner.lock().expect("store lock");
        let removed = inner.remove_row(&(namespace.to_owned(), key.to_vec()));
        if removed {
            persist(&self.shard, &inner)?;
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
            inner.rebuild_body()?;
            persist(&self.shard, &inner)?;
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
        assert_eq!(&bytes[..5], KV_MAGIC);
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
    fn catalog_matches_shared_contract_layout() {
        let bytes = encode_catalog_bytes(DEFAULT_SHARD_ID).unwrap();
        assert_eq!(&bytes[..5], CATALOG_MAGIC);
        assert_eq!(&bytes[5..9], &[0, 0, 0, 0], "version is little endian");
        assert_eq!(&bytes[9..13], &[0, 0, 0, 0], "schema slot absent");
        assert_eq!(&bytes[13..17], &[0, 0, 0, 0], "routing slot absent");
        assert_eq!(&bytes[17..21], &[1, 0, 0, 0], "one shard registration");
        assert_eq!(&bytes[21..25], &[7, 0, 0, 0], "shard id length");
        assert_eq!(&bytes[25..32], b"local-0");
        assert_eq!(&bytes[32..36], &[0, 0, 0, 0], "resolved contract absent");
        assert_eq!(&bytes[36..40], &[0, 0, 0, 0], "no owners");
        assert_eq!(bytes.len(), 40);
        assert_eq!(decode_catalog_shard_id(&bytes).unwrap(), DEFAULT_SHARD_ID);
    }

    #[test]
    fn legacy_big_endian_catalog_is_rejected() {
        let legacy = b"YYDS\x01\0\0\0\0\0\0\0\0\0\0\0\x01\0\0\0\x0apostgres-0\0\0\0\0\0\0\0\0".to_vec();
        assert_eq!(
            decode_catalog_shard_id(&legacy).unwrap_err().message(),
            "legacy PostgreSQL catalog layout: delete the store directory and reinitialize"
        );
    }

    #[test]
    fn shared_codec_decodes_and_reencodes_store_catalog_bytes() {
        let dir = temporary("catalog-interop-out");
        let store = Store::open(&dir).unwrap();
        let bytes = fs::read(store.catalog_path()).unwrap();
        let shard_id = shared_catalog_shard_id(&bytes).unwrap();
        assert_eq!(shard_id.0, DEFAULT_SHARD_ID);
        assert_eq!(encode_catalog(None, None, &[shard_id], None, &[]).unwrap(), bytes);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn shared_codec_catalog_opens_as_a_store() {
        let dir = temporary("catalog-interop-in");
        let bytes = encode_catalog(None, None, &[ShardId("custom-7".to_owned())], None, &[]).unwrap();
        let hex = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        // Same catalog bytes the TS and PY corpora seed for `catalog-authoritative-shard-id`.
        assert_eq!(hex, "59594453010000000000000000000000000100000008000000637573746f6d2d370000000000000000");

        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CATALOG_FILE), &bytes).unwrap();
        let shard = encode_snapshot(&BTreeMap::from([shared_record("public.seed", b"k", b"v", 1)]), 2).unwrap();
        fs::write(dir.join("custom-7.yykv"), &shard).unwrap();

        let store = Store::open(&dir).unwrap();
        assert_eq!(Path::new(&store.shard_path()).file_name().unwrap().to_string_lossy(), "custom-7.yykv");
        assert_eq!(store.get("public.seed", b"k"), Some(b"v".to_vec()));
        assert_eq!(fs::read(store.catalog_path()).unwrap(), bytes, "opening must not rewrite shared catalog bytes");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nul_shard_id_stays_unusable() {
        let dir = temporary("catalog-interop-nul");
        let bytes = encode_catalog(None, None, &[ShardId("a\0b".to_owned())], None, &[]).unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CATALOG_FILE), &bytes).unwrap();
        assert_eq!(Store::open(&dir).err().unwrap().message(), "catalog shard id is unusable");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Assembles one shared-codec record, i.e. exactly what a node outside this
    /// repo writes when `database-formats` owns the shard.
    fn shared_record(namespace: &str, key: &[u8], value: &[u8], revision: u64) -> (Key, ShardRecord) {
        let key = Key::new(namespace, key.to_vec());
        let stored = ShardRecord {
            key: key.clone(),
            value: StoredValue::Inline(InlineValue(value.to_vec())),
            revision,
            expires_at: None,
        };
        (key, stored)
    }

    #[test]
    fn shared_codec_decodes_and_reencodes_store_bytes() {
        let dir = temporary("interop-out");
        let store = Store::open(&dir).unwrap();
        store.put("public.users", b"u1", b"alice").unwrap();
        store.put("public.users", b"u2", b"bob").unwrap();
        let bytes = fs::read(store.shard_path()).unwrap();
        let snapshot = decode_snapshot_strict(&bytes).unwrap();
        assert_eq!(snapshot.next_revision, 3);
        assert_eq!(
            snapshot.records[&Key::new("public.users", b"u1".to_vec())].value,
            StoredValue::Inline(InlineValue(b"alice".to_vec()))
        );
        assert_eq!(
            snapshot.records[&Key::new("public.users", b"u2".to_vec())].value,
            StoredValue::Inline(InlineValue(b"bob".to_vec()))
        );
        assert_eq!(encode_snapshot(&snapshot.records, snapshot.next_revision).unwrap(), bytes);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn shared_codec_snapshot_opens_as_a_store() {
        let dir = temporary("interop-in");
        Store::open(&dir).unwrap();
        let written_by_shared_codec =
            BTreeMap::from([shared_record("public.seed", b"a", b"1", 1), shared_record("public.seed", b"b", b"2", 2)]);
        let bytes = encode_snapshot(&written_by_shared_codec, 3).unwrap();
        fs::write(dir.join(format!("{DEFAULT_SHARD_ID}.yykv")), &bytes).unwrap();

        let store = Store::open(&dir).unwrap();
        assert_eq!(store.get("public.seed", b"a"), Some(b"1".to_vec()));
        assert_eq!(store.get("public.seed", b"b"), Some(b"2".to_vec()));
        assert_eq!(fs::read(store.shard_path()).unwrap(), bytes, "opening must not rewrite shared bytes");

        store.put("public.seed", b"c", b"3").unwrap();
        let expected = BTreeMap::from([
            shared_record("public.seed", b"a", b"1", 1),
            shared_record("public.seed", b"b", b"2", 2),
            shared_record("public.seed", b"c", b"3", 3),
        ]);
        assert_eq!(fs::read(store.shard_path()).unwrap(), encode_snapshot(&expected, 4).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_shard_matches_the_shared_corpus_bytes() {
        let dir = temporary("interop-empty");
        let store = Store::open(&dir).unwrap();
        let bytes = fs::read(store.shard_path()).unwrap();
        let hex = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        // Same empty-shard bytes the TS and PY corpora seed in `store.json`.
        assert_eq!(hex, "59594b5603e42b42c2392d245f010000000000000000000000");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn incremental_writes_stay_byte_identical_to_a_full_encode() {
        let dir = temporary("incremental-bytes");
        let store = Store::open(&dir).unwrap();
        let big = [9_u8; 257];
        let long_key = [3_u8; 40];
        let steps: Vec<(&str, &[u8], Option<&[u8]>)> = vec![
            ("public.users", b"u2", Some(b"bob")),
            ("public.users", b"u1", Some(b"alice")),
            ("public.users", b"u3", Some(big.as_slice())),
            ("public.users", b"u2", Some(b"bobby")),
            ("public.users", b"u2", None),
            ("public.audit", b"a1", Some(b"")),
            ("public.audit", b"a0", Some(b"zero")),
            ("sys.utf8", "雪".as_bytes(), Some(long_key.as_slice())),
            ("public.users", b"u1", Some(b"alice-again")),
        ];
        let mut expected: BTreeMap<(String, Vec<u8>), (u64, Vec<u8>)> = BTreeMap::new();
        let mut next_revision = 1_u64;
        for (namespace, key, value) in steps {
            match value {
                Some(value) => {
                    store.put(namespace, key, value).unwrap();
                    expected.insert((namespace.to_owned(), key.to_vec()), (next_revision, value.to_vec()));
                    next_revision += 1;
                }
                None => {
                    store.delete(namespace, key).unwrap();
                    expected.remove(&(namespace.to_owned(), key.to_vec()));
                }
            }
            let written = fs::read(store.shard_path()).unwrap();
            let snapshot = expected
                .iter()
                .map(|((namespace, key), (revision, value))| shared_record(namespace, key, value, *revision))
                .collect::<BTreeMap<_, _>>();
            assert_eq!(written, encode_snapshot(&snapshot, next_revision).unwrap());
        }
        drop(store);
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.get("public.users", b"u1"), Some(b"alice-again".to_vec()));
        assert_eq!(reopened.get("public.users", b"u2"), None);
        assert_eq!(reopened.get("sys.utf8", "雪".as_bytes()), Some(long_key.to_vec()));
        drop(reopened);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn interrupted_rename_leaves_either_the_old_or_the_new_shard() {
        let dir = temporary("fault-rename");
        let store = Store::open(&dir).unwrap();
        store.put("public.users", b"u1", b"alice").unwrap();
        let old = fs::read(store.shard_path()).unwrap();

        fault::arm(fault::BEFORE_RENAME);
        let interrupted = store.put("public.users", b"u2", b"bob");
        fault::disarm();
        assert!(interrupted.is_err(), "the interrupted write must surface as an error");
        assert_eq!(fs::read(store.shard_path()).unwrap(), old, "a failure before rename must keep the old shard");
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.get("public.users", b"u1"), Some(b"alice".to_vec()));
        assert_eq!(reopened.get("public.users", b"u2"), None);
        drop(reopened);

        fault::arm(fault::AFTER_RENAME);
        let interrupted = store.put("public.users", b"u2", b"bob");
        fault::disarm();
        assert!(interrupted.is_err(), "a failure after the swap still reports an error");
        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.get("public.users", b"u1"), Some(b"alice".to_vec()));
        assert_eq!(reopened.get("public.users", b"u2"), Some(b"bob".to_vec()));
        let bytes = fs::read(reopened.shard_path()).unwrap();
        assert_eq!(decode_shard(&bytes).unwrap().0.len(), 2, "the swapped shard must decode cleanly");
        drop(reopened);
        let _ = fs::remove_dir_all(&dir);
    }
}
