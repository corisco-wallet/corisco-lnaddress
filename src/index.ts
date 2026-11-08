import { serve } from "@hono/node-server";
import { createPool } from "mysql2/promise";
import { createApp } from "./app";
import { ChallengeStore } from "./challenge";
import { loadConfig } from "./config";
import { createDataCipher } from "./crypto";
import { createSparkLightning } from "./invoices";
import { runMigrations } from "./migrations";
import { MysqlInvoiceStore } from "./mysql-invoice-store";
import { MysqlUserStore } from "./mysql-store";
import { SettlementWatcher, backstopCheckDelay, nextCheckDelay } from "./settlement";
import { ZapPublisher } from "./zap-publisher";
import { ZapSigner } from "./zaps";

const config = loadConfig();
const pool = createPool({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.name,
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
});

await runMigrations(pool);
const cipher = createDataCipher(config.dataKey);
const users = new MysqlUserStore(pool, cipher);
await users.verifyKey();
const invoiceStore = new MysqlInvoiceStore(pool, cipher);

const spark = await createSparkLightning(config.serverMnemonic, config.network);

/** A fresh hostname may not resolve on Spark's side yet, so retry a few times before giving up on webhooks. */
async function registerWebhook({ url, secret }: { url: string; secret: string }): Promise<boolean> {
  for (const waitMs of [0, 5_000, 15_000, 45_000]) {
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    try {
      await spark.registerWebhook(url, secret);
      return true;
    } catch (err) {
      console.error("spark webhook registration failed:", err);
    }
  }
  return false;
}

const settlement = new SettlementWatcher({
  store: invoiceStore,
  source: spark,
  retentionDays: config.invoiceRetentionDays,
  schedule: nextCheckDelay,
});

const zaps = config.nostrSecretKey && {
  signer: new ZapSigner(config.nostrSecretKey),
  // Local relays are only reachable on regtest; on mainnet only public wss:// relays are dialled.
  policy: { allowPrivate: config.network === "REGTEST" },
};
const zapPublisher = zaps && new ZapPublisher({ store: invoiceStore, ...zaps });
if (zapPublisher) {
  settlement.onSettled(() => zapPublisher.kick());
  zapPublisher.start();
}
settlement.start();

const app = createApp({
  config,
  users,
  challenges: new ChallengeStore(),
  invoices: spark,
  invoiceStore,
  firstCheckDelayMs: () => settlement.firstCheckDelayMs,
  // The route stays up even if registration failed, so deliveries to an earlier registration still land.
  sparkWebhook: config.sparkWebhook && {
    secret: config.sparkWebhook.secret,
    checkSoon: (id) => settlement.checkSoon(id),
  },
  zaps,
});

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => console.log(`listening on :${port}`));

// Register only once listening, since Spark may call the URL while registering; poll quickly until then.
if (config.sparkWebhook) {
  void registerWebhook(config.sparkWebhook).then((active) => {
    if (active) settlement.useSchedule(backstopCheckDelay);
    else console.warn("spark webhook unavailable; polling for settlement instead");
  });
}

process.on("SIGTERM", () => {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  void Promise.all([closed, settlement.stop(), zapPublisher?.stop()])
    .then(() => users.close())
    .finally(() => process.exit(0));
});
