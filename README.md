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

Someone who can read the database but doesn't have the key can therefore see how many invoices each
(anonymous) user row got, for how much, and when, but can't tell which address or wallet that row is.

Retention:

- **Unpaid invoices** are deleted about 10 minutes after they expire.
- **Paid invoices** are deleted `INVOICE_RETENTION_DAYS` (default 7) after payment.
- An invoice whose status can't be checked (for example while Spark is unreachable) stays pending and is
  kept until a check succeeds, so a late payment is never missed.

How payment is detected: a background watcher asks Spark for the status of each pending invoice, often
right after it is created and less often later. An invoice counts as paid only when Spark reports the
payment as received **and** returns a preimage whose SHA-256 matches the payment hash.

With `SPARK_WEBHOOK_SECRET` set (and an https `PUBLIC_BASE_URL`), the server registers
`PUBLIC_BASE_URL/webhooks/spark` with Spark on startup for `SPARK_LIGHTNING_RECEIVE_FINISHED` events.
A delivery whose `X-Spark-Signature` matches only makes that invoice due for a check right away; the check
itself still asks Spark and verifies the preimage, so a forged or replayed webhook can't mark anything
paid. Polling keeps running as a backstop for missed deliveries, but slowly (30 s, then every 2 min).
If registration fails at startup the server falls back to the normal polling schedule.

Nothing about payers is stored, and the app's own log lines don't include usernames, pubkeys, invoices or
amounts.
