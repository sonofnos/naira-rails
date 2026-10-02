# naira-rails

Payments backend for a Nigerian food-delivery marketplace (customers, restaurants, riders), built around the problems that come up when you move naira: NIP interbank transfers that time out, bank webhooks that arrive more than once, a ledger that has to stay balanced under concurrency, and an end-of-day bank statement that has to match the books.

**NestJS · TypeScript · PostgreSQL 16 · Redis 7 · TypeORM · Jest + Testcontainers · GitHub Actions**

> **What's simulated.** This is a portfolio project. I have no NIBSS, sponsor bank, card processor or custody credentials, so every third party is a documented interface with a deterministic in-process fake. I haven't faked a live integration anywhere. The fakes copy the parts of each contract that affect correctness (NIP session IDs, name enquiry before transfer, TSQ answering from what NIBSS actually recorded), and that's what the tests run against.

| Area | Real in this repo | Simulated |
|---|---|---|
| Double-entry ledger, locking, idempotency constraints | Yes: Postgres, tested under real concurrency | — |
| NIP name enquiry / funds transfer / TSQ | Client interface, requery state machine, response-code policy | `NipSimulatorClient`, in-process (no NIBSS) |
| Bank list, NUBAN validation, virtual NUBAN issuance | NIBSS institution codes, CBN check-digit algorithm | Partner bank (account numbers are valid NUBANs, but no bank issued them) |
| Pay-in webhooks | HMAC-SHA512 verification over raw bytes, idempotent crediting | The bank sending them (tests and `scripts/demo.sh` sign locally) |
| Reconciliation | CSV parsing, matching, persisted runs | The statement file (modelled on NIBSS/bank settlement report fields) |
| Cards | Tokenization flow, PAN masking/redaction, OTP step-up, attempt limits | `FakeCardProcessor` (no processor, sandbox or scheme) |
| Stablecoin off-ramp | Interface, confirmation/quote checks, idempotent NGN credit | `FakeOffRampClient`. **No blockchain, custody or liquidity provider.** It shows the integration shape only |

## What it does

```
src/
  ledger/            double-entry posting engine, chart of accounts, trial balance
  nip/               NipClient interface, NipSimulatorClient, response-code policy, requery executor, name enquiry (+ Redis cache)
  banks/             NIBSS institution codes + CBN NUBAN check digit
  payouts/           wallet -> bank payouts over NIP (state machine, requery sweeper, manual resolution)
  virtual-accounts/  dedicated virtual NUBAN per customer/merchant/rider + signed inflow webhook
  marketplace/       per-order split: merchant / rider / platform, in one journal
  cards/             tokenize, charge, OTP step-up
  offramp/           VirtualAssetOffRampClient (stablecoin -> NGN) + fake
  reconciliation/    statement parser, classifier, persisted runs
  migrations/        hand-written SQL schema + advisory-locked migration runner
```

### 1. NIP transfers: requery, never retry

Payouts (merchant settlements, rider earnings) follow NIP's real call sequence: **name enquiry** (NE, returns the beneficiary name and an NE session), then **funds transfer** (FT) with a 30-digit **session ID** (6-digit institution code + `yyMMddHHmmss` in Lagos time + 12 unique digits), then **transaction status query** (TSQ) on that same session ID when the FT outcome isn't clear.

The rule that drives the design: **a timeout is not a failure.** If an FT times out, the rider may already have been paid. Refunding the wallet at that point loses money, and re-sending the FT pays the rider twice. So:

- `NipTransferExecutor.send()` calls FT **exactly once**. Every non-definitive result (transport timeout, `01`, `09`, `91`, `94`, `96`, `97`, any unknown code) becomes `unknown`. Only `00` counts as success, and only codes that prove nothing happened (`51`, `07`, `08`, `05`…) count as failure.
- The only follow-up to `unknown` is `requery()`, which sends a TSQ with the same session ID. A TSQ `25 Unable to locate record` counts as failure only after a grace window (NIBSS may not have recorded the FT yet). After `NIP_MAX_REQUERIES` inconclusive answers the payout goes to `needs_review`, never to an automatic refund. An operator then resolves it with evidence (e.g. the settlement report) via `POST /payouts/:id/resolve`.
- Every state change is a compare-and-set `UPDATE ... WHERE status = ...`. The `pending → processing` CAS is the at-most-once guarantee: only the worker that wins it may call FT for that payout. A worker that crashes after the flip leaves the payout `processing`, which the sweeper requeries rather than re-sends.

Money flow: create posts `DR wallet / CR TRANSFERS_IN_FLIGHT`. Success posts `DR IN_FLIGHT / CR SETTLEMENT_BANK`. Failure posts `DR IN_FLIGHT / CR wallet`. While the outcome is unknown, nothing moves and the reserve stays in flight.

Name enquiries are billable, so the service validates the NUBAN check digit locally (for deposit money banks) before spending one, and caches successful NE results in Redis for 10 minutes. Redis is only a cache. Losing it means paying for extra name enquiries, but it never affects correctness.

### 2. Virtual-account pay-ins

Each owner gets one dedicated NUBAN under the partner bank's range (Wema by default). The serial comes from a Postgres sequence and the 10th digit is a real CBN check digit. The partner bank's inflow webhook is verified with HMAC-SHA512 over the **raw** request bytes. The credit is idempotent on `UNIQUE (provider, provider_reference)`, where the reference is the NIP session ID. Duplicates are claimed with `INSERT ... ON CONFLICT DO NOTHING` inside the same transaction as the journal. Money sent to an account number we don't recognise goes to `SUSPENSE`. It is never dropped, because it's already in our pool.

### 3. Double-entry ledger

`LedgerService.post()` claims the journal's idempotency key (unique), locks every account the journal touches with `SELECT ... FOR UPDATE` in ascending id order, applies the deltas, enforces no-overdraft, and writes the lines. The database also enforces the invariants on its own:

- a **deferred constraint trigger** re-checks `sum(debit) = sum(credit)` per journal at COMMIT, so even raw SQL can't commit an unbalanced journal;
- `journal_entries` is **append-only** (a trigger rejects UPDATE/DELETE);
- `CHECK (allow_negative OR balance_minor >= 0)` backs up the funds check.

`GET /ledger/trial-balance` checks total debits = total credits and that each account's cached balance equals the sum of its own lines. Every integration test ends by asserting this.

### 4. Reconciliation

`POST /reconciliation/runs` takes a business date and a settlement statement CSV (`SESSION_ID,TRAN_DATE,DIRECTION,AMOUNT,...`, Lagos time, naira amounts like `"2,500.00"`). It matches the statement on (session ID, direction) against journal lines on `SYS:SETTLEMENT_BANK`. A ledger debit on our bank asset is money in, which the bank's statement shows as CR. Each line ends up in one of these buckets:

`matched` · `amount_mismatch` · `missing_in_ledger` · `missing_in_statement` · `duplicate_in_statement`

Details:
- Amounts are parsed as decimal strings into bigint kobo. Floats are never used (`parseFloat("1234.56") * 100` is `123455.99999999999`).
- Ledger lines from the day before and after are loaded too, so a credit the bank stamped at 23:59:58 that we posted at 00:00:01 is reported as `matched` with a `cross_day` note instead of two breaks.
- A statement DR whose session ID belongs to a payout still being requeried gets an `unresolved_payout` note. The statement proves the money left the pool, which is the evidence ops needs to close a `needs_review` payout.
- Runs are idempotent on `UNIQUE (business_date, file_sha256)`.

### 5. Marketplace split

`POST /orders/:orderId/settlement` debits the customer wallet for the order total and credits the merchant (food − commission), the rider (their share of the delivery fee) and platform revenue (commission + service fee + delivery remainder), all in **one journal**. Shares are integer kobo. Rounding floors the commission and the rider share and gives the remainder to the platform, so the shares always sum to the total; a 5,000-case randomized unit test plus a DB `CHECK` back this up. It's idempotent on `UNIQUE (order_id)`, so a repeated "delivered" event never splits twice.

### 6. Cards

`POST /cards` sends the PAN to the processor once and stores only the token, BIN, last4, brand, expiry and a keyed (HMAC) fingerprint. The PAN and CVV are never stored. `POST /cards/charges` either succeeds right away or steps up to OTP: Verve cards always do, as they do in Nigeria. The rest follows the 3DS challenge pattern in a lighter form; the full 3DS2 flow is in the sibling repo `payment-rail-gateway`. OTP attempts are counted with a CAS **before** the processor is called, so 10 parallel guesses use at most 3 attempts. A redaction layer masks any Luhn-valid 12–19 digit sequence in logs and error responses. A test dumps every table with `row_to_json` and captures every log line, then checks that the PAN appears in neither.

In production the PAN would go from the client straight to the processor's hosted fields, and this service would never see it. It's accepted server-side here only so the "never logged, never stored" property can be tested.

### 7. "NIBSS to virtual assets": stablecoin off-ramp (interface only)

`VirtualAssetOffRampClient` shows the shape: quote a rate, confirm an on-chain deposit (per-network confirmation thresholds), credit NGN at the quote (`DR VIRTUAL_ASSET_CUSTODY / CR wallet`). Credits are idempotent on `UNIQUE (network, tx_hash)` and each quote can be used once (`UNIQUE (quote_id)`). EVM/Tron hashes are hex and case-insensitive, so they're lower-cased before hitting the constraint; otherwise re-casing a hash would get past it. Solana signatures are case-sensitive and stay as they are. **The only implementation is a deterministic fake with a made-up ₦1,550/USDT rate.** Nothing here touches a chain.

## Idempotency: one constraint per money-moving path

| Path | Enforced by |
|---|---|
| Every journal | `journal_transactions UNIQUE (idempotency_key)` + request hash (same key, different lines → 409) |
| `POST /payouts` (`Idempotency-Key` header) | `payouts UNIQUE (idempotency_key)`, `UNIQUE (session_id)` |
| Bank inflow webhook | `inbound_credits UNIQUE (provider, provider_reference)` |
| `POST /orders/:id/settlement` | `order_settlements UNIQUE (order_id)` |
| `POST /cards/charges` | `card_charges UNIQUE (idempotency_key)` |
| `POST /offramp/credits` | `offramp_credits UNIQUE (network, tx_hash)`, `UNIQUE (quote_id)` |
| Reconciliation upload | `recon_runs UNIQUE (business_date, file_sha256)` |

The application never does a read-then-insert check. Every path claims its key with `INSERT ... ON CONFLICT DO NOTHING`, and the unique index is what serialises concurrent duplicates.

## Proving the races are closed

The integration suite runs against real Postgres and Redis containers and fires requests in parallel over a 40-connection pool, so each request runs on its own connection:

- 50 concurrent debits racing for one balance → exactly the 33 affordable ones succeed, and the balance never goes negative
- 40 opposite-direction transfers between two wallets → no deadlocks
- 25 parallel deliveries of the same bank webhook → one credit, 24 `duplicate`
- 12 parallel payout requests with one idempotency key → one payout, one FT, one debit
- 10 *different* payouts from one wallet at once → no deadlocks
- 15 parallel "delivered" events for one order → one split
- 10 parallel first-time off-ramp credits for one tx → one credit
- 10 parallel OTP guesses → at most 3 attempts
- 8 concurrent sweepers on one unknown payout → finalized once
- a crashed-before-send payout recovered by 8 racing workers → sent once
- 3 app instances migrating a fresh database at the same time → all start

**Mutation-checked**: for each guard I removed it and confirmed the test fails, so the tests aren't passing by accident.

| Guard removed | Result |
|---|---|
| `inbound_credits` unique constraint | webhook replay test fails: every replay inserts its own `inbound_credits` row and reports `credited` (only the journal's unique key still stops a double credit) |
| `inbound_credits` + journal-key unique | webhook replay test fails |
| `order_settlements` unique + journal-key unique | parallel-split and 409 tests fail |
| `payouts` idempotency unique | 12-parallel-same-key test fails |
| `pending → processing` CAS in `dispatch()` | crash-recovery race test fails (see below) |
| `FOR UPDATE` in `LedgerService.post` | 50-debit race and opposite-direction tests fail |
| advisory lock in `migrateWithLock` | concurrent-boot test fails |

## Bugs found while building

1. **Concurrent payouts from the same wallet deadlocked.** Ten different payouts from one rider wallet, fired together: 9 of 10 failed with `deadlock detected`, consistently, even with the bounded retry on `40P01`. The account locks were already taken in a fixed order, so lock ordering wasn't the cause. The cause was the `payouts.wallet_account_id` **foreign key**: inserting the payout row makes Postgres take `FOR KEY SHARE` on the referenced wallet row, and `LedgerService.post()` then asks for `FOR UPDATE` on that same row. Two transactions that each hold KEY SHARE and each want to upgrade wait for each other. Fix: `LedgerService.lockAccounts()` takes the posting's `FOR UPDATE` locks (same sorted order) **before** the FK-bearing insert. Now pinned by `10 different payouts from one wallet at once`. I found it while mutation-testing the idempotency constraint: removing it let 12 same-key payouts insert and hit exactly this deadlock.

2. **Two out of three instances crashed when booting together.** TypeORM's `migrationsRun: true` takes no lock. Starting three DataSources against a fresh database at the same time (what a rolling deploy or scale-out does) gave one success and two `duplicate key value violates unique constraint "pg_class_relname_nsp_index"`. For a payments service that's a deploy-time outage. Fix: `migrateWithLock()` runs migrations under a Postgres advisory lock, wired in through `dataSourceFactory` so nothing gets a DataSource before the schema is ready. Pinned by `test/migrations.e2e-spec.ts`, and that test fails when the lock is removed.

3. **Reconciliation runs were labelled with the previous day.** node-postgres parses a `DATE` column into a JS `Date` at *local* midnight. On my machine (Lagos, UTC+1) `business_date = 2026-10-02` was serialised as `2026-10-01T23:00:00.000Z`. On a UTC CI runner it would have looked correct, so the bug only shows up in the timezone the business runs in. Fix: `pg.types.setTypeParser(DATE, v => v)`, since a calendar date has no timezone.

4. **A test gap found by mutation testing.** Removing the `pending → processing` CAS from `dispatch()` left every payout test green. The only caller was the request that created the payout, so nothing ever raced on it. In production the sweeper also dispatches payouts that were left `pending` (the process died after the reserve committed but before the FT went out). I added a crash-recovery test that stubs `dispatch` once to simulate the crash, then runs 4 sweepers and 4 direct dispatchers against the stuck payout. With the CAS the FT is sent once; without it, more than once.

Also handled (known going in, so not counted as found bugs, but each one is pinned by a test):
- TypeORM's `manager.query()` returns `[rows, rowCount]` for `UPDATE`/`DELETE` on Postgres, so `result.length` on an `UPDATE ... RETURNING` is 2 even when nothing matched, which makes every compare-and-set look like a win. All raw SQL goes through `rows()` (QueryRunner structured result). `test/ledger.e2e-spec.ts` pins both behaviours.
- `pg` is passed to TypeORM explicitly (`driver: pg`) because of a ts-jest export-map problem with TypeORM's dynamic require that I hit in an earlier NestJS repo.
- supertest given a non-listening server calls `listen()` per request, which piled listeners onto one server (`MaxListenersExceededWarning`) during the 25-way webhook test. The test app now listens on port 0.

## Running it

Requirements: Node ≥ 22.22, Docker.

```bash
npm ci
npm test            # 47 unit tests, no Docker needed
npm run test:e2e    # 44 integration tests; starts Postgres 16 + Redis 7 via Testcontainers
```

Local app:

```bash
cp .env.example .env
docker compose up -d --wait     # Postgres on :5441, Redis on :6385 (avoids clashing with other local stacks)
npm run start:dev
./scripts/demo.sh               # VA -> signed inflow (+ duplicate) -> masked name enquiry -> NIP payout -> trial balance
```

The simulator seeds demo beneficiaries: GTBank (`000013`) `0123456785`, Access (`000014`) `0690000032`, Moniepoint (`090405`) `8012345678`. All non-webhook endpoints require `x-api-key`. Money-moving POSTs require `Idempotency-Key`.

Main endpoints: `GET /banks`, `GET /banks/:code/accounts/:number`, `POST /virtual-accounts`, `POST /webhooks/bank/inflow`, `POST /payouts`, `GET /payouts/:id`, `POST /payouts/requery`, `POST /payouts/:id/resolve`, `POST /orders/:orderId/settlement`, `POST /cards`, `POST /cards/charges`, `POST /cards/charges/:id/otp`, `POST /offramp/quotes`, `POST /offramp/credits`, `POST /reconciliation/runs`, `GET /ledger/wallets/:type/:id`, `GET /ledger/trial-balance`, `GET /health`.

CI (GitHub Actions, `ubuntu-latest`) runs lint, typecheck, build, unit tests and the Testcontainers suite. There's no `services:` block: the tests start their own containers.

## Known limits

- **Hot accounts.** Every pay-in locks `SYS:SETTLEMENT_BANK` and every payout locks `SYS:TRANSFERS_IN_FLIGHT`, so writes to each one are serialized. That's fine at this scale. At high volume the usual fix is to shard system accounts into N sub-accounts or to post them asynchronously from an outbox.
- Lagos time is a fixed UTC+1 offset (Nigeria has no DST).
- Auth is a single service API key: this API is meant to sit behind the super-app's own backend. There is no per-user auth.
- The bank list is a static snapshot of NIBSS institution codes. A real integration would refresh it from the provider.
- Raw SQL rather than TypeORM entities on the money paths, on purpose: the locking and `ON CONFLICT` behaviour is visible in the code instead of hidden behind ORM calls.
