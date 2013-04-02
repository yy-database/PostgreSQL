# PostgreSQL client test migration ledger

`postgres-client` dropped its local `src/protocol.rs` (1026 lines), `src/client.rs`
(889 lines) and `src/error.rs` (120 lines) in `5f60187` and now re-exports
`database-protocol-pgsql` plus `database-client`. The `rust` harness stage only
runs `cargo test -p postgres-client`, so its executable test count fell from 60
to 35 while the re-export landed.

This ledger accounts for every disappeared test. It is the basis for the
`floor: 35` value in `stages/rust.mjs`, which cites this file.

## Counts

| Source | Tests before removal | Tests left in this workspace |
|--------|----------------------|-----------------------------|
| `src/protocol.rs` | 23 | 0 (file removed) |
| `src/client.rs` | 2 | 0 (file removed) |
| `src/error.rs` | 0 | 0 (file removed) |
| Other local unit tests | 17 | 17 |
| `tests/roundtrip.rs` + `tests/robustness.rs` | 18 | 18 |
| Total | 60 | 35 |

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

## Upstream run evidence

```
cargo test -p database-protocol-pgsql   -> 25 passed; 0 failed; 0 ignored
cargo test -p database-client           ->  8 passed; 0 failed; 0 ignored
```

The protocol crate now holds the 23 mapped tests plus 2 authentication tests
(`md5`/`SCRAM-SHA-256`) added by the deduplication line. The client crate holds
the 2 mapped tests plus 6 authentication tests.

## Conclusion and floor calibration

- All 25 disappeared tests exist upstream and pass, byte-identical where the
  module was shared. Nothing was "no longer meaningful" and nothing is missing.
- This workspace's `rust` stage only runs `cargo test -p postgres-client`, so
  its executable count legitimately fell from 60 to 35.
- `stages/rust.mjs` therefore sets `floor: 35`, citing this ledger.

Recurring rule: **the floor may only move with per-item attribution.** Any
commit that changes the executable test count must record which tests
disappeared or appeared and where each one went before the floor is recalibrated.
