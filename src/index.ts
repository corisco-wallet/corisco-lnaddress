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
import { SettlementWatcher } from "./settlement";

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
const settlement = new SettlementWatcher({ store: invoiceStore, source: spark, retentionDays: config.invoiceRetentionDays });
settlement.start();

const app = createApp({ config, users, challenges: new ChallengeStore(), invoices: spark, invoiceStore });

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => console.log(`listening on :${port}`));

process.on("SIGTERM", () => {
  server.close();
  void settlement
    .stop()
    .then(() => users.close())
    .finally(() => process.exit(0));
});
