import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hand-written schema (no `synchronize`, same convention as ledger-api).
 * Every money-moving table carries a UNIQUE constraint on its idempotency
 * key; the application relies on those constraints (INSERT ... ON CONFLICT
 * DO NOTHING), never on a read-then-insert check.
 */
export class InitSchema1759363200000 implements MigrationInterface {
  name = 'InitSchema1759363200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE ledger_accounts (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code            text NOT NULL UNIQUE,
        kind            text NOT NULL CHECK (kind IN ('asset','liability','revenue','expense')),
        normal_side     text NOT NULL CHECK (normal_side IN ('debit','credit')),
        owner_type      text NULL CHECK (owner_type IN ('customer','merchant','rider')),
        owner_id        text NULL,
        currency        char(3) NOT NULL DEFAULT 'NGN',
        allow_negative  boolean NOT NULL DEFAULT false,
        balance_minor   bigint NOT NULL DEFAULT 0,
        created_at      timestamptz NOT NULL DEFAULT now(),
        -- DB backstop for the application's funds check.
        CONSTRAINT ledger_accounts_no_overdraft CHECK (allow_negative OR balance_minor >= 0)
      );

      CREATE TABLE journal_transactions (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key  text NOT NULL,
        kind             text NOT NULL,
        reference        text NULL,
        request_hash     text NOT NULL,
        description      text NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT journal_transactions_idempotency_key_uq UNIQUE (idempotency_key)
      );
      CREATE INDEX journal_transactions_reference_idx ON journal_transactions (reference);

      CREATE TABLE journal_entries (
        id                   bigserial PRIMARY KEY,
        transaction_id       uuid NOT NULL REFERENCES journal_transactions(id),
        account_id           uuid NOT NULL REFERENCES ledger_accounts(id),
        direction            text NOT NULL CHECK (direction IN ('debit','credit')),
        amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
        balance_after_minor  bigint NOT NULL,
        created_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX journal_entries_account_created_idx ON journal_entries (account_id, created_at);
      CREATE INDEX journal_entries_transaction_idx ON journal_entries (transaction_id);

      -- Balanced-journal invariant enforced by the database at COMMIT, not
      -- only by LedgerService: a deferred constraint trigger re-sums every
      -- journal touched by the transaction.
      CREATE FUNCTION assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE d bigint; c bigint;
      BEGIN
        SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0),
               COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0)
          INTO d, c
          FROM journal_entries WHERE transaction_id = NEW.transaction_id;
        IF d <> c THEN
          RAISE EXCEPTION 'journal % is unbalanced: debits % <> credits %', NEW.transaction_id, d, c
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER journal_entries_balanced
        AFTER INSERT ON journal_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

      -- Journal lines are append-only: corrections are new reversing journals.
      CREATE FUNCTION forbid_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'journal_entries is append-only' USING ERRCODE = 'insufficient_privilege';
      END $$;
      CREATE TRIGGER journal_entries_append_only
        BEFORE UPDATE OR DELETE ON journal_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_journal_mutation();

      -- System accounts (chart of accounts). Asset accounts may run negative:
      -- e.g. a card-funded wallet paid out before the acquirer settles leaves
      -- the bank pool temporarily short — a liquidity fact the ledger should
      -- show, not hide. Liability/revenue accounts may not.
      INSERT INTO ledger_accounts (code, kind, normal_side, allow_negative) VALUES
        ('SYS:SETTLEMENT_BANK',          'asset',     'debit',  true),
        ('SYS:CARD_RECEIVABLE',          'asset',     'debit',  true),
        ('SYS:VIRTUAL_ASSET_CUSTODY',    'asset',     'debit',  true),
        ('SYS:TRANSFERS_IN_FLIGHT',      'liability', 'credit', false),
        ('SYS:SUSPENSE',                 'liability', 'credit', false),
        ('SYS:PLATFORM_REVENUE',         'revenue',   'credit', false);

      -- Pay-ins: dedicated virtual NUBANs ------------------------------------
      CREATE SEQUENCE virtual_account_serial START 1;
      CREATE TABLE virtual_accounts (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_type          text NOT NULL,
        owner_id            text NOT NULL,
        account_number      char(10) NOT NULL,
        bank_nip_code       char(6) NOT NULL,
        account_name        text NOT NULL,
        wallet_account_id   uuid NOT NULL REFERENCES ledger_accounts(id),
        created_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT virtual_accounts_owner_uq UNIQUE (owner_type, owner_id),
        CONSTRAINT virtual_accounts_number_uq UNIQUE (bank_nip_code, account_number)
      );

      CREATE TABLE inbound_credits (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider             text NOT NULL,
        provider_reference   text NOT NULL,
        account_number       char(10) NOT NULL,
        virtual_account_id   uuid NULL REFERENCES virtual_accounts(id),
        amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
        originator_name      text NULL,
        originator_bank      text NULL,
        narration            text NULL,
        status               text NOT NULL CHECK (status IN ('credited','suspense')),
        journal_id           uuid NULL REFERENCES journal_transactions(id),
        bank_timestamp       timestamptz NULL,
        created_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT inbound_credits_provider_ref_uq UNIQUE (provider, provider_reference)
      );

      -- Payouts over NIP ------------------------------------------------------
      CREATE TABLE payouts (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key      text NOT NULL,
        request_hash         text NOT NULL,
        owner_type           text NOT NULL,
        owner_id             text NOT NULL,
        wallet_account_id    uuid NOT NULL REFERENCES ledger_accounts(id),
        amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
        bank_nip_code        char(6) NOT NULL,
        account_number       char(10) NOT NULL,
        account_name         text NOT NULL,
        name_enquiry_ref     text NOT NULL,
        narration            text NULL,
        session_id           char(30) NOT NULL,
        status               text NOT NULL CHECK (status IN
                               ('pending','processing','unknown','successful','failed','needs_review')),
        last_response_code   text NULL,
        requery_count        int NOT NULL DEFAULT 0,
        next_requery_at      timestamptz NULL,
        sent_at              timestamptz NULL,
        finalized_at         timestamptz NULL,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payouts_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT payouts_session_id_uq UNIQUE (session_id)
      );
      CREATE INDEX payouts_requery_idx ON payouts (next_requery_at)
        WHERE status IN ('pending','processing','unknown');

      -- Marketplace split -----------------------------------------------------
      CREATE TABLE order_settlements (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id          text NOT NULL,
        request_hash      text NOT NULL,
        customer_id       text NOT NULL,
        merchant_id       text NOT NULL,
        rider_id          text NOT NULL,
        total_minor       bigint NOT NULL,
        merchant_minor    bigint NOT NULL,
        rider_minor       bigint NOT NULL,
        platform_minor    bigint NOT NULL,
        journal_id        uuid NULL REFERENCES journal_transactions(id),
        created_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT order_settlements_order_uq UNIQUE (order_id),
        CONSTRAINT order_settlements_sums CHECK (merchant_minor + rider_minor + platform_minor = total_minor)
      );

      -- Cards -----------------------------------------------------------------
      -- No PAN, no CVV: only the processor token, BIN, last4 and a keyed
      -- fingerprint (to spot the same card on two accounts).
      CREATE TABLE cards (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id    text NOT NULL,
        token          text NOT NULL UNIQUE,
        bin            char(6) NOT NULL,
        last4          char(4) NOT NULL,
        brand          text NOT NULL,
        exp_month      smallint NOT NULL,
        exp_year       smallint NOT NULL,
        fingerprint    text NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cards_customer_fingerprint_uq UNIQUE (customer_id, fingerprint)
      );

      CREATE TABLE card_charges (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key     text NOT NULL,
        request_hash        text NOT NULL,
        card_id             uuid NOT NULL REFERENCES cards(id),
        customer_id         text NOT NULL,
        amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
        status              text NOT NULL CHECK (status IN
                              ('initiated','pending_otp','successful','failed')),
        processor_reference text NULL,
        otp_attempts        int NOT NULL DEFAULT 0,
        failure_reason      text NULL,
        journal_id          uuid NULL REFERENCES journal_transactions(id),
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT card_charges_idempotency_key_uq UNIQUE (idempotency_key)
      );

      -- Virtual-asset off-ramp ----------------------------------------------
      CREATE TABLE offramp_credits (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        network         text NOT NULL,
        tx_hash         text NOT NULL,
        quote_id        text NOT NULL,
        asset           text NOT NULL,
        amount_units    numeric(78,0) NOT NULL,
        rate_kobo_per_unit bigint NOT NULL,
        ngn_minor       bigint NOT NULL CHECK (ngn_minor > 0),
        owner_type      text NOT NULL,
        owner_id        text NOT NULL,
        journal_id      uuid NULL REFERENCES journal_transactions(id),
        created_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT offramp_credits_tx_uq UNIQUE (network, tx_hash),
        CONSTRAINT offramp_credits_quote_uq UNIQUE (quote_id)
      );

      -- Reconciliation ------------------------------------------------------
      CREATE TABLE recon_runs (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_date   date NOT NULL,
        file_sha256     char(64) NOT NULL,
        summary         jsonb NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT recon_runs_file_uq UNIQUE (business_date, file_sha256)
      );
      CREATE TABLE recon_items (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id            uuid NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
        status            text NOT NULL,
        session_id        text NOT NULL,
        statement_minor   bigint NULL,
        ledger_minor      bigint NULL,
        direction         text NULL,
        note              text NULL
      );
      CREATE INDEX recon_items_run_idx ON recon_items (run_id, status);
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP TABLE IF EXISTS recon_items, recon_runs, offramp_credits, card_charges, cards,
        order_settlements, payouts, inbound_credits, virtual_accounts, journal_entries,
        journal_transactions, ledger_accounts CASCADE;
      DROP SEQUENCE IF EXISTS virtual_account_serial;
      DROP FUNCTION IF EXISTS assert_journal_balanced, forbid_journal_mutation;
    `);
  }
}
