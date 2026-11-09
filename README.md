# corisco-lnaddress

Lightning address server for the Corisco wallet. A wallet registers its Spark identity key and gets a
random username (`keenviper124@<domain>`). Payments to that address are LNURL-pay invoices minted by a
server-side Spark wallet with the user's identity key as the receiver, so the server never holds funds.

## Running

```sh
cp .env.example .env   # fill in SERVER_MNEMONIC, DB_*, DATA_ENCRYPTION_KEY
npm install
npm run dev
```

`docker compose up --build -d` runs the app with MySQL. `npm test` runs the tests; set
`TEST_MYSQL_URL=mysql://user:password@host:port/database` to also run the MySQL tests (they drop that
database's tables).

## Privacy: what is stored

The server keeps as little as it can, encrypts what it keeps, and deletes it when it is no longer needed.
Fields are encrypted with AES-256-GCM using keys derived from `DATA_ENCRYPTION_KEY`. Each ciphertext is
bound to its row, so it can't be copied into another row and still decrypt.

**Users** (`users`), kept while the address exists:

| Data | Stored as |
| --- | --- |
| Username, identity pubkey | Encrypted, plus a keyed hash (HMAC) of each for lookups |
| Created at, active flag | Plain |

**Invoices** (`invoices`), one row for each invoice the callback hands out, so the server can tell
whether it was paid:

| Data | Stored as |
| --- | --- |
| BOLT11 invoice, preimage | Encrypted |
| Payment hash, Spark receive request id | Plain (the hash is public in the invoice; the id is needed to ask Spark for the status) |
| Receiving user | The `users` row id, not the pubkey |
| Amount, created/expiry/settled times, status | Plain |
| Zap request and the published zap receipt (zaps only) | Encrypted |
| Zap receipt state, attempts, next attempt time | Plain |

Someone who can read the database but doesn't have the key can therefore see how many invoices each
(anonymous) user row got, for how much, and when, but can't tell which address or wallet that row is.

Retention:

- **Unpaid invoices** are deleted about 10 minutes after they expire.
- **Paid invoices** are deleted `INVOICE_RETENTION_DAYS` (default 7) after payment, but a paid zap is kept
  until its receipt is published or given up on.
- An invoice whose status can't be checked (for example while Spark is unreachable) stays pending and is
  kept until a check succeeds, so a late payment is never missed.

How payment is detected: a background watcher asks Spark for the status of each pending invoice, often
right after it is created and less often later. An invoice counts as paid only when Spark reports the
payment as received **and** returns a preimage whose SHA-256 matches the payment hash.

With `SPARK_WEBHOOK_SECRET` set, the server registers `API_BASE_URL/webhooks/spark` with Spark on
startup for `SPARK_LIGHTNING_RECEIVE_FINISHED` events. `API_BASE_URL` is the host that serves the API
(registration and webhooks) when it differs from the LNURL host; it defaults to `PUBLIC_BASE_URL` and
must be https.
A delivery whose `X-Spark-Signature` matches only makes that invoice due for a check right away; the check
itself still asks Spark and verifies the preimage, so a forged or replayed webhook can't mark anything
paid. Polling keeps running as a backstop for missed deliveries, but slowly (30 s, then every 2 min).
If registration fails at startup the server falls back to the normal polling schedule.

## Nostr zaps (NIP-57)

Set `NOSTR_SECRET_KEY` (an `nsec1…` or 64 hex characters) to accept zaps. Each address then advertises
`allowsNostr: true` and a `nostrPubkey`, and the callback accepts a signed kind-9734 zap request in the
`nostr` parameter. The request is checked per NIP-57 (signature, one `p` tag, at most one `e` tag, a
matching `amount`, a `P` tag naming the receipt signer if present, and at least one usable relay), and
the invoice's description hash is the SHA-256 of the zap request instead of the LNURL metadata.

Once the invoice is paid, a kind-9735 receipt is signed and published to the relays the zap request lists
(at most 10). It is retried with backoff (30 s, growing to hourly) until a relay accepts it, for up to 14
days after payment. A paid zap is queued for its receipt in the same row update that marks it paid, so a
restart never loses one.

- **Each address has its own receipt key**, derived from `NOSTR_SECRET_KEY` and the user's identity pubkey,
  so one user's receipts never validate for another address. **Never change `NOSTR_SECRET_KEY`**: clients
  check receipts against the key an address advertises now, so a new key makes every past receipt invalid.
- **Relays are chosen by the payer**, so on MAINNET only `wss://` relays on public addresses are dialled
  (the resolved IP is checked too); REGTEST also allows `ws://` and local relays for development.
- **Testing on regtest:** `npm run dev:zap` registers a fresh address, sends invalid and valid zap
  requests, pays the invoice from `PAYER_MNEMONIC` and checks the receipt the way a client would. Point it
  at a deployment with `BASE_URL` (registration) and `LNURL_BASE_URL` (LNURL endpoints, if served elsewhere), e.g.
  `BASE_URL=https://api.test.corisco.org LNURL_BASE_URL=https://test.corisco.org LNADDRESS_DOMAIN=test.corisco.org`; the receipt
  goes to `RELAY_URLS` (comma-separated, default Damus and Primal, with throwaway keys).
- **Zaps are public.** A receipt tells anyone reading those relays that this address received an amount
  at a given time, from the zap sender's Nostr key. That is how zaps work; payments without a zap request
  publish nothing.

Nothing about payers is stored, and the app's own log lines don't include usernames, pubkeys, invoices or
amounts. A zap receipt that no relay accepts is logged with the relays' hosts and reasons; those relays are
chosen by the payer, not the receiving user.
