# Performance — measured, not assumed

Owed since Phase 2 and paid in Phase 8. Every number here came from
`EXPLAIN (ANALYZE, BUFFERS)` against the real development database, not from a
guess about what the planner *should* do.

**Dataset at time of measurement** (2026-09-05), grown by five phases of tests:

```
mandates 444 · mandate_versions 500 · payments 188
decisions 542 · rule_evaluations 7,046 · audit_events 2,603
```

Small. Every conclusion below is therefore about **plan shape**, not about
throughput: the useful question at this size is "does the planner use the index
we built for this, or is it hiding a sequential scan behind a fast machine?"

---

## 1. `loadForAuthorization` — the hot path

Runs on **every authorization**. One query, via `JOIN LATERAL`.

```
Nested Loop Left Join                       0.212 ms   shared hit=9
  -> Nested Loop                            0.062 ms   hit=6
     -> Index Scan mandates_pkey            0.032 ms   hit=3
     -> Limit
        -> Index Scan mandate_versions_current_idx     rows=1
  -> Aggregate
     -> Index Only Scan mandate_version_merchants_pkey rows=2  Heap Fetches: 0
Execution Time: 0.321 ms
```

**What this confirms.**

- **Three index scans, no sequential scan.** `mandate_versions_current_idx`
  is `(mandate_id, version DESC)`, and the plan shows `Limit → Index Scan` —
  the planner walks straight to the newest version and stops. It never sorts.
  That is the entire reason the current version is *derived* rather than stored
  (migration 0003): a stored pointer could drift; this cannot.
- **`Heap Fetches: 0`** on the allowlist means an **index-only scan** — the
  composite primary key `(mandate_id, version, merchant_id)` covers the query,
  so the table itself is never touched.
- **9 buffer hits, 0 reads.** The whole hot path is nine 8 KB pages, all in
  cache.

**Planning time (1.7 ms) exceeds execution time (0.3 ms).** That is normal for a
small, well-indexed query and is exactly what prepared statements exist to
remove. Worth knowing before anyone "optimises" the execution.

---

## 2. The spend query — under the row lock

Runs on every authorization, inside the transaction holding the mandate lock,
so **its duration is lock-hold time** and therefore the ceiling on
per-mandate throughput.

```
Aggregate                                   0.081 ms   shared hit=3
  -> Index Scan payments_spend_window_idx   rows=2
Execution Time: 0.149 ms
```

`payments_spend_window_idx` is `(mandate_id, captured_at DESC) WHERE status =
'captured'` — a **partial** index. The plan needs no `Filter` on `status`,
because rows that are not captured are not in the index at all.

**Consequence for concurrency.** Authorizations for one mandate serialise for
~0.15 ms of query time. Different mandates never contend. Throughput therefore
scales with the number of distinct mandates, not with total traffic — which for
consumer mandates (a handful of payments a day) is free.

---

## 3. Audit chain verification — one page

```
Limit                                       1.095 ms   shared hit=188
  -> Index Scan audit_events_pkey           rows=500
     Index Cond: (seq > 0)
     Filter: (chain_id = 'main')
     Rows Removed by Filter: 171
```

**A finding, and it is the interesting one on this page.** The planner chose
`audit_events_pkey` (`seq`) and *filtered* `chain_id`, discarding 171 rows —
rather than using `audit_events_chain_seq_idx` on `(chain_id, seq)`, which
exists precisely for this.

At 2,603 rows that is the right call: scanning `seq` in order and dropping a few
hundred rows is cheaper than a second index's overhead. **It will stop being the
right call** once one chain is a small fraction of the table — with per-merchant
chains (the `chain_id` column exists for exactly that), the filter would discard
almost everything it read.

We are **not** adding a hint or forcing the index. The index is already there;
the planner will switch when the statistics justify it. What we are doing is
writing the number down, so that when verification gets slow nobody has to
rediscover why.

---

## What would change at scale, in order

Only after measuring, and only when a measurement says so.

1. **Verify from the last checkpoint, not from genesis.** `streamChain` already
   accepts `fromSeq`, and checkpoints already record a verified position. Turns
   O(total events) into O(events since the last anchor). This is the main
   *performance* reason checkpoints earn their place, on top of the security
   one.
2. **Per-merchant audit chains.** Removes the filter above, and removes the
   per-chain advisory-lock contention on `appendAuditEvent`, which is the first
   thing that would bind under load.
3. **A per-mandate rollup counter**, maintained in the same transaction, so the
   spend query stops summing payments. Only if the sum ever stops being three
   buffer hits.
4. **Time-partition `audit_events`**, and move the seven-year retention tier to
   WORM object storage.
5. **A cache — last, and probably never.** A cache is a second source of truth
   for a *security* limit. Same trade we rejected for Redis in ADR-0005.

## How to re-measure

```
psql atl_india_dev -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) <query>;"
```

`BUFFERS` matters more than timing on a laptop: `shared hit` vs `read` tells you
whether you measured the database or the page cache. Timings on a machine also
running a test suite are noise; **plan shape is not**.
