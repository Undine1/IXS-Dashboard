# RPC reliability and checkpoint integrity

The September 2026 changes preserve hourly refreshes, provider fallback, and the
deployment-baked dashboard snapshots. No packages or provider plans change.

## Implementation plan and acceptance conditions

| Improvement | Implementation | Required evidence |
| --- | --- | --- |
| Reject malformed results | Validate RPC envelopes, method results, event identities, ranges, and pagination before committing a window. | Invalid/missing arrays cannot advance a checkpoint; duplicate events cannot increase totals twice. |
| Protect holder state | Retry restoration; distinguish a confirmed absent ref from failed access; validate the state; require explicit bootstrap; persist using an expected-ref lease. | Network errors never start a historical rebuild; concurrent/ref-conflicting writes never overwrite newer state. |
| Bound requests and work | One abortable deadline covers headers and body; scan budgets stop at recoverable boundaries before workflow deadlines. | Hung requests reach fallback; completed work survives an interrupted run; incomplete work is replayed exactly once. |
| Preserve completed windows | Snapshot and roll back only the active Alchemy window when falling back to logs. | If window 1 succeeds and window 2 fails, fallback starts at window 2. |
| Cool down failing providers | After exhausted transient failures, prefer healthy alternatives temporarily; retain recovering providers at the end of the fallback list. | A healthy backup avoids repeated failing calls, while failure of the backup still permits primary recovery. |
| Redact diagnostics | Remove full RPC URLs and known credential values before logging or saving errors. | Fake keys never appear in saved diagnostics; error codes remain usable for retry decisions. |
| Recover recent reorgs | Keep a hash-verified finalized baseline and replay the newer tail from that baseline, replacing the previous tail. | Unchanged reruns are idempotent; replaced tail events are removed; finalized-anchor disagreement stops publication. |
| Explicit pacing headroom | Optionally cap the requested target with a dashboard-specific CU/s allocation. | The allocation caps every Alchemy chain in the process and survives the legacy fixed-interval override. |

## Audit fixes and acceptance conditions

| Improvement | Implementation | Required evidence |
| --- | --- | --- |
| Reject reported fork events | Compare log hashes with canonical headers; compare indexed transfers with the exact multiset of token logs requested by block hash before applying a window. | Orphan events, inconsistent amounts, missing events within a reported block, and conflicting log indices fail before totals advance. |
| Keep reconciliation on the same fork | Use EIP-1898 `blockHash` with `requireCanonical` for balance calls and their individual fallback. | A partially scanned range reconciles at its actual checkpoint hash, not its original target. |
| Accept documented terminal pagination | Accept Alchemy's empty-string terminal page key; continue rejecting malformed tokens and cycles. | A valid empty terminal key completes without redundant fallback. |
| Retain usable range recovery | Preserve an aggregate provider range ceiling even when another provider returns a malformed response. | Shrinking can recover the request; locally conflicting events still fail without publication. |
| Pin pool units and identity | Store chain, pool, token, and decimals with each raw finalized total; validate legacy metadata before adoption. | Configuration changes cannot silently rescale an existing raw total; ambiguous legacy units stop safely. |
| Keep providers at cooldown expiry | Classify all providers against one clock reading. | A provider whose cooldown expires during ordering remains available exactly once. |

The holder Alchemy path caps verified windows at 20,000 blocks, preserving any
smaller configured window. All pages and canonical checks complete before applying
that window, so an interrupted verification leaves the prior checkpoint intact.
Headers and hash-bound logs are cached within a scan; failures are not cached as
successful evidence. The caches are discarded between holder phases/runs and pool
refreshes.

These checks cost additional RPC: at most one header per distinct reported block
in a scan, plus one hash-bound token-log read for each distinct block/token checked
on the indexed path, excluding retries. Empty reported windows do not trigger a
full block crawl. Existing pacing, provider fallback, and run deadlines apply.

### What canonical verification proves

Standard log scans check that reported events name the canonical hash returned by
the header provider. Alchemy scans additionally compare event multiplicity,
transaction, endpoints, and raw amount with hash-bound standard logs for every
reported block. Self-transfers and repeated delivery cannot add volume twice.

This depends on honest canonical headers and complete RPC results. A range/indexed
provider omitting an entire transfer-bearing block is not detected by these checks;
nor does a standard log scan independently prove completeness. Proving absence
would require an independent completeness source or scanning every relevant block,
which would materially increase RPC usage. The changes close the observed fork
inclusion and counting gaps without claiming that stronger guarantee.

The block-hash filters follow [EIP-234](https://eips.ethereum.org/EIPS/eip-234),
balance reads follow [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898), and empty
terminal keys match the [Alchemy Transfers response example](https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers).

## Counting invariants

1. The checkpoint and the balances/volume it describes are persisted together.
2. A durable window includes all pages; a page token is never reused across runs.
3. Normal continuation begins at `lastScannedBlock + 1`.
4. Retrying a partial window restores its starting state before applying events.
5. Reorg replay first restores the finalized baseline; it never adds a replayed
   tail to totals that already include that tail.
6. Interrupted canonical scans retain completed progress. A stored target hash
   must still match before that progress can be resumed or promoted.
7. A failed state save or inconsistent provider result cannot be treated as a
   successful refresh.

## Migration and reorg limits

Existing pool totals and v2 holder balances are preserved. A saved checkpoint becomes the initial
baseline only after the chain's `finalized` head covers it and its block hash can
be read. History before that checkpoint is not fetched or added again. If finality
has not yet caught up, the updater keeps the prior data and retries later.

Production holder state is already v2. The separate pre-existing v1 accuracy
migration still rebuilds v1 balances; these changes do not alter that migration.

This migration cannot retrospectively prove that old, unhashed checkpoints were
never affected by a reorg. From migration onward, finalized anchors are verified
before reuse. A mismatch at/before an anchor, unavailable finality, or conflicting
headers stops the affected update rather than guessing an undo amount. Recovery
from confirmed deep corruption requires a separately reviewed rebuild.

The dashboard continues to include the latest successfully scanned tail. Replaying
that tail and checking reported events adds RPC work and allows observed reorgs to
be corrected while retaining current freshness, subject to the provider assumptions
above.

## Operational settings

- `RPC_REQUEST_TIMEOUT_MS`: request plus body deadline, default 15,000 ms,
  maximum 120,000 ms.
- `RPC_PROVIDER_COOLDOWN_MS`: default 30,000 ms, maximum 300,000 ms. Cooldown
  changes provider preference, not the requested data or the availability of fallback.
- `RPC_RUN_BUDGET_MS`: workflow sets separate cooperative budgets for the pool
  and holder scans, leaving time for persistence and the other snapshots.
- `RPC_ALCHEMY_TARGET_CUPS`: requested pacing target, existing default 600.
- `RPC_ALCHEMY_BUDGET_CUPS`: optional CU/s allocation for this dashboard after
  reserving capacity for other account users. Effective target is the smaller of
  this value and the requested target. An invalid explicit allocation fails safely.
  When set, a faster `RPC_MIN_INTERVAL_MS` cannot bypass it. Requested, allocated,
  and effective values are included in the existing RPC usage artifact.

The repository cannot infer account capacity from an API key. No live account
limit is assumed or changed. Alchemy enforces [account-wide throughput over a
rolling window](https://www.alchemy.com/docs/reference/throughput), so independent
apps/processes still need an appropriately reserved allocation. The process-local
limiter is not a distributed account-wide quota service.

## Verification and rollout

Run the offline test suite, ESLint, application and scheduler typechecks, and the
Next production build. Review the final diff specifically for transaction/window
boundaries and migration behavior, then push the verified revision and verify its
Vercel production deployment. An hourly updater run verifies the scheduled path;
the production APIs continue to serve the previous committed snapshots until that
run publishes fresh data.

Audit-fix validation on September 6: all 250 offline tests, ESLint, application and
scheduler typechecks, and the production build passed. A read-only live replay of
saved holder history matched the exact balances, checkpoints, and event counts on
Ethereum (397 blocks / 14 events), Base (2,398 / 7), and Polygon (3,199 / 3).
Repeating every tail was idempotent. The replay used 81 RPC requests, estimated at
2,940 Alchemy CU, and wrote no state or public files. This sample started from a
trusted legacy baseline and used history that is now finalized; it did not
exercise live failover or balance reconciliation.

Pool checks replayed both current saved tails and a nonempty historical Base tail
twice. Exact totals/raw anchors and idempotence held, and the existing untagged
USDC anchors adopted their six-decimal identities without changing history. The
nonempty sample contained one 6,248,823-raw-unit transfer. These read-only checks
used 34 RPC requests and an estimated 1,840 Alchemy CU, with filesystem writes
blocked.

All three configured primary chains also accepted `balanceOf` calls with
`{blockHash, requireCanonical: true}` at saved finalized checkpoints: six RPC
requests including headers, estimated at 138 Alchemy CU. This confirms parameter
compatibility; no live reorg or orphan-hash rejection was induced.
