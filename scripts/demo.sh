#!/usr/bin/env bash
# End-to-end demo against a locally running app (npm run start:dev, .env from .env.example).
# Everything below the HTTP layer is simulated: NIP via NipSimulatorClient, the bank webhook is signed locally.
set -euo pipefail
BASE=${BASE:-http://localhost:3000}
K="x-api-key: ${API_KEY:-dev-api-key}"
SECRET=${BANK_WEBHOOK_SECRET:-change-me}
J='content-type: application/json'

echo "== health";  curl -s "$BASE/health"; echo
echo "== allocate a virtual NUBAN for rider_7"
ACC=$(curl -s -XPOST "$BASE/virtual-accounts" -H "$K" -H "$J" \
  -d '{"ownerType":"rider","ownerId":"rider_7","displayName":"Tunde"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accountNumber"])')
echo "$ACC"

SID="000013$(date -u +%y%m%d%H%M%S)$(printf '%012d' $RANDOM$RANDOM)"
BODY="{\"sessionId\":\"$SID\",\"accountNumber\":\"$ACC\",\"amount\":\"5,000.00\"}"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha512 -hmac "$SECRET" | awk '{print $NF}')
echo "== signed bank inflow (sent twice: second is a duplicate)"
for _ in 1 2; do curl -s -XPOST "$BASE/webhooks/bank/inflow" -H "$J" -H "x-bank-signature: $SIG" -d "$BODY"; echo; done

echo "== resolve beneficiary (masked name)"
curl -s "$BASE/banks/000013/accounts/0123456785" -H "$K"; echo
echo "== NIP payout ₦1,500"
curl -s -XPOST "$BASE/payouts" -H "$K" -H "idempotency-key: demo-$SID" -H "$J" \
  -d '{"ownerType":"rider","ownerId":"rider_7","amountMinor":150000,"bankCode":"000013","accountNumber":"0123456785"}'; echo
echo "== trial balance"
curl -s "$BASE/ledger/trial-balance" -H "$K"; echo
