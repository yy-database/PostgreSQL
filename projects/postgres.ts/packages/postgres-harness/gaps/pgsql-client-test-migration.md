# PostgreSQL client test migration ledger

`postgres-client` is gone. It dropped its local `src/protocol.rs` (1026 lines),
`src/client.rs` (889 lines) and `src/error.rs` (120 lines) in `5f60187` and
re-exported `database-protocol-pgsql` plus `database-client` instead. The
remaining glue then followed the same route: `store.rs` became an adapter over
`database-storage`'s `FileShard` and moved to `database.client/src/pgsql/store.rs`,
the data directory and `postmaster.pid` lock moved to
`database.client/src/pgsql/postmaster.rs`, and `psql.rs` moved to
`database.client/src/pgsql/psql.rs`. Its two integration suites,
`tests/robustness.rs` and `tests/roundtrip.rs`, moved to
`database.client/tests/pgsql_robustness.rs` and `pgsql_live.rs` in the
`database.rs` repository.

The `rust` harness stage now runs `cargo test -p postgres-napi -p postgres-pyo3`.
Those two crates only compile, so the stage's executable count is 0. The tests
themselves run upstream: `cargo test --workspace` in `database.rs` covers them
on the same three-OS matrix.

This ledger accounts for every disappeared test. It is the basis for the
`floor: 0` value in `stages/rust.mjs`, which cites this file.

## Counts

| Source | Tests before removal | Tests left in this workspace | Where they went |
|--------|----------------------|-----------------------------|-----------------|
| `src/protocol.rs` | 23 | 0 (file removed) | `database-protocol-pgsql/src/messages.rs` |
| `src/client.rs` | 2 | 0 (file removed) | `database-client/src/pgsql/client.rs` |
| `src/error.rs` | 0 | 0 (file removed) | `database-client/src/pgsql/error.rs` |
| Other local unit tests | 18 | 0 (files removed) | `database-client/src/pgsql/{store,psql,postmaster}.rs` |
| `tests/roundtrip.rs` + `tests/robustness.rs` | 18 | 0 (files removed) | `database.client/tests/pgsql_live.rs` and `pgsql_robustness.rs` |
| Total | 60 | 0 | |

`error.rs` had no tests, so the whole 25-test drop comes from `protocol.rs` and
`client.rs`.

## Per-test map: `src/protocol.rs` (23 tests)

Reference: the `mod tests` block of `database.rs/projects/database/database.protocol.pgsql/src/messages.rs`.
The removed module was byte-identical to that block (`Compare-Object` showed no
difference), and every test name below exists upstream.

| # | Test | Behaviour asserted | Upstream location | Verdict |
|---|------|--------------------|-------------------|---------|
| 1 | `startup_packet_starts_with_version_and_ends_once` | Version, length header and the single trailing NUL of the startup packet | `messages.rs`, same name | Present upstream |
| 2 | `error_response_keeps_code_and_message` | ErrorResponse `C` code and `M` message | `error_response_keeps_code_and_message` | Present upstream |
| 3 | `message_fields_keep_wire_order_and_every_selector` | Field selectors `S`/`V`/`C`/`M`/`P`/`D`/`H` kept in wire order | `message_fields_keep_wire_order_and_every_selector` | Present upstream |
| 4 | `error_response_exposes_position_detail_and_hint` | `P`/`D`/`H` reachable by selector | `error_response_exposes_position_detail_and_hint` | Present upstream |
| 5 | `notice_response_keeps_severity_code_and_message` | NoticeResponse severity, code and message | `notice_response_keeps_severity_code_and_message` | Present upstream |
| 6 | `data_row_maps_negative_length_to_null` | Column length `-1` becomes NULL and a column-count mismatch errors | `data_row_maps_negative_length_to_null` | Present upstream |
| 7 | `parse_packet_carries_names_and_type_oids` | Parse statement name, SQL and parameter type oid count/order | `parse_packet_carries_names_and_type_oids` | Present upstream |
| 8 | `parse_packet_refuses_more_types_than_the_wire_allows` | More than 65535 parameter types rejected | `parse_packet_refuses_more_types_than_the_wire_allows` | Present upstream |
| 9 | `bind_packet_marks_nulls_and_keeps_text_values` | Bind NULL as `-1`, UTF-8 values verbatim, text result format | `bind_packet_marks_nulls_and_keeps_text_values` | Present upstream |
| 10 | `bind_packet_carries_a_single_binary_result_format` | One binary result format code and rejection of an illegal format count | `bind_packet_carries_a_single_binary_result_format` | Present upstream |
| 11 | `bind_packet_with_formats_mixes_text_and_binary_parameters` | Per-parameter text/binary format mix byte layout | `bind_packet_with_formats_mixes_text_and_binary_parameters` | Present upstream |
| 12 | `bind_packet_with_formats_refuses_mismatched_counts` | Format count must be 0, 1 or the parameter count | `bind_packet_with_formats_refuses_mismatched_counts` | Present upstream |
| 13 | `bind_packet_refuses_more_parameters_than_the_wire_allows` | More than 65535 parameters rejected | `bind_packet_refuses_more_parameters_than_the_wire_allows` | Present upstream |
| 14 | `describe_execute_and_close_frames_are_well_formed` | Describe/Execute/Close/Sync frame bytes and an illegal Describe kind | `describe_execute_and_close_frames_are_well_formed` | Present upstream |
| 15 | `execute_packet_carries_a_row_limit` | Execute row limit and rejection of a negative limit | `execute_packet_carries_a_row_limit` | Present upstream |
| 16 | `parameter_description_reads_oids_in_order` | ParameterDescription oid order and truncation error | `parameter_description_reads_oids_in_order` | Present upstream |
| 17 | `parameter_type_oid_matches_the_catalog` | `int4`/`timestamptz` oid mapping and `None` for unknown types | `parameter_type_oid_matches_the_catalog` | Present upstream |
| 18 | `cancel_request_carries_pid_and_secret_in_sixteen_bytes` | 16-byte cancel packet, cancel code and pid/secret positions | `cancel_request_carries_pid_and_secret_in_sixteen_bytes` | Present upstream |
| 19 | `bytea_text_is_backslash_x_and_lowercase_hex` | bytea text as `\x` plus lowercase hex | `bytea_text_is_backslash_x_and_lowercase_hex` | Present upstream |
| 20 | `row_description_reads_type_and_format_of_every_column` | RowDescription name/oid/length/format and a column-name parse error | `row_description_reads_type_and_format_of_every_column` | Present upstream |
| 21 | `data_row_with_formats_decodes_the_pglite_binary_payloads` | 12 binary result types decoded to text | `data_row_with_formats_decodes_the_pglite_binary_payloads` | Present upstream |
| 22 | `data_row_with_formats_mixes_text_binary_and_null` | Text, binary and NULL cells in one row | `data_row_with_formats_mixes_text_binary_and_null` | Present upstream |
| 23 | `data_row_with_formats_refuses_unsupported_binary_types` | Unsupported types (`701`/`999999`) surface a feature flag | `data_row_with_formats_refuses_unsupported_binary_types` | Present upstream |

## Per-test map: `src/client.rs` (2 tests)

Reference: the `mod tests` block of `database.rs/projects/database/database.client/src/pgsql/client.rs`,
also byte-identical.

| # | Test | Behaviour asserted | Upstream location | Verdict |
|---|------|--------------------|-------------------|---------|
| 24 | `cell_reads_one_coordinate_and_nulls` | `QueryResult::cell` returns `None` out of range, `Some(None)` for NULL and iterates column names | `client.rs`, same name | Present upstream |
| 25 | `default_config_points_at_loopback` | `ClientConfig::default()` uses port 5432 | `default_config_points_at_loopback` | Present upstream |

## `src/error.rs` (120 lines, 0 tests)

No tests existed before the removal, so nothing migrated. Its error shape is
carried by `database.client/src/pgsql/error.rs`; the `code`/`message`/`field`/
`feature` accessors are still asserted by #2, #4, #21 and #23 above.

## Per-test map: `tests/robustness.rs` (16 tests) and `tests/roundtrip.rs` (2 tests)

Both suites spoke only framing and public client APIs, with no `Store`,
`ServerStore` or `database-protocol-pgsql` dependency, so they compiled
upstream with zero API additions. The copies are byte-identical apart from the
`use` paths (`database_client::pgsql::client` and `database_client::pgsql::error`
instead of `postgres_client`), and `roundtrip.rs` now returns early when
`POSTGRES_TEST_PORT` is absent instead of failing, matching the other live
tests in `database.client`.

| # | Test | Behaviour asserted | Upstream file |
|---|------|--------------------|---------------|
| 26 | `cancel_request_uses_a_fresh_connection_and_the_backend_key` | Cancel opens a second socket and sends the backend pid/secret | `pgsql_robustness.rs` |
| 27 | `server_error_then_ready_for_query_keeps_the_connection_usable` | `08P01` plus `ReadyForQuery` leaves the session usable | `pgsql_robustness.rs` |
| 28 | `peer_close_after_a_partial_row_poisons_the_connection` | EOF mid-result marks the connection poisoned | `pgsql_robustness.rs` |
| 29 | `truncated_message_length_poisons_the_connection` | A truncated length header poisons the connection | `pgsql_robustness.rs` |
| 30 | `cancel_without_backend_key_data_is_a_protocol_error` | Cancel before `BackendKeyData` is a protocol error | `pgsql_robustness.rs` |
| 31 | `copy_in_streams_every_chunk_and_reports_the_tag` | `COPY IN` streams every chunk and reports the tag | `pgsql_robustness.rs` |
| 32 | `copy_in_mid_error_keeps_the_connection_usable` | A mid-copy error drains to `ReadyForQuery` | `pgsql_robustness.rs` |
| 33 | `copy_in_rejected_before_copy_response_sends_no_data` | Rejection before `CopyInResponse` sends no data | `pgsql_robustness.rs` |
| 34 | `copy_out_collects_every_chunk_and_reports_the_tag` | `COPY OUT` collects every chunk and reports the tag | `pgsql_robustness.rs` |
| 35 | `copy_in_streams_a_large_batch_without_buffering_it` | A large batch is streamed without buffering | `pgsql_robustness.rs` |
| 36 | `copy_in_transport_loss_poisons_the_connection` | Transport loss during copy poisons the connection | `pgsql_robustness.rs` |
| 37 | `copy_out_error_keeps_the_prefix_and_the_connection_usable` | A copy-out error keeps the received prefix | `pgsql_robustness.rs` |
| 38 | `binary_result_rows_are_decoded_from_the_wire` | Binary result rows decode to text | `pgsql_robustness.rs` |
| 39 | `binary_decode_errors_drain_to_ready_for_query` | A binary decode error drains to `ReadyForQuery` | `pgsql_robustness.rs` |
| 40 | `portal_suspension_keeps_rows_and_the_session_open` | Portal suspension keeps rows and the session open | `pgsql_robustness.rs` |
| 41 | `binary_parameters_are_bound_as_bytes` | Binary parameters bind as raw bytes | `pgsql_robustness.rs` |
| 42 | `selects_one_row_from_a_live_server` | `SELECT 1` tag, column name, cell and close | `pgsql_live.rs` |
| 43 | `reports_server_error_code_and_message` | `42P01` code and `missing_table` message | `pgsql_live.rs` |

The one local unit test that did not survive in place is the old
`interrupted_rename_leaves_either_the_old_or_the_new_shard`: its write path is
now `database-storage`'s `FileShard`, which owns the atomic-replace contract
and its own crash tests. Two local tests were added instead
(`flush_removes_one_namespace_and_keeps_the_revision_counter` and
`namespace_validation_stays_on_the_binding_side`), so the eighteen local unit
tests arrive upstream as fourteen `store.rs` tests, two `postmaster.rs` tests
and three `psql.rs` tests.

## Upstream run evidence

```
cargo test -p database-protocol-pgsql   -> 25 passed; 0 failed; 0 ignored
cargo test -p database-client           -> 45 passed; 0 failed; 0 ignored
cargo test -p database-client --test pgsql_robustness -> 16 passed; 0 failed
POSTGRES_TEST_PORT=55433 cargo test -p database-client --test pgsql_live -> 2 passed; 0 failed
```

The live pair ran against PostgreSQL 16.9 on `127.0.0.1:55433`. The
`database.rs` `check-rust.yml` now has a `postgres-live` job that starts a
`postgres:16` service and runs `pgsql_live` with the `POSTGRES_TEST_*`
variables.

The protocol crate now holds the 23 mapped tests plus 2 authentication tests
(`md5`/`SCRAM-SHA-256`) added by the deduplication line. The client crate holds
the 2 mapped tests plus 6 authentication tests.

## Conclusion and floor calibration

- All 25 disappeared tests exist upstream and pass, byte-identical where the
  module was shared. Nothing was "no longer meaningful" and nothing is missing.
- The 18 integration tests moved to `database.client/tests`, where 16 run
  always and 2 run in the `postgres-live` job against a `postgres:16` service.
- The crate itself was deleted. The two bindings now depend on `database-client`
  and `database-protocol-pgsql` directly, pinned to one `database.rs` revision.
- This workspace's `rust` stage runs `cargo test -p postgres-napi -p postgres-pyo3`,
  which executes 0 tests, so the count fell from 60 to 0.
- `stages/rust.mjs` therefore sets `floor: 0`, citing this ledger. The Rust
  test gate moved to `cargo test --workspace` in `database.rs`.

Recurring rule: **the floor may only move with per-item attribution.** Any
commit that changes the executable test count must record which tests
disappeared or appeared and where each one went before the floor is recalibrated.
