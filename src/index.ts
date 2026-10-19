import { serve } from "@hono/node-server";
import { createPool } from "mysql2/promise";
import { createApp } from "./app";
import { ChallengeStore } from "./challenge";
import { loadConfig } from "./config";
import { createDataCipher } from "./crypto";
import { createSparkInvoiceCreator } from "./invoices";
import { runMigrations } from "./migrations";
import { MysqlUserStore } from "./mysql-store";

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
const users = new MysqlUserStore(pool, createDataCipher(config.dataKey));
await users.verifyKey();

const invoices = await createSparkInvoiceCreator(config.serverMnemonic, config.network);
const app = createApp({ config, users, challenges: new ChallengeStore(), invoices });

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => console.log(`listening on :${port}`));

process.on("SIGTERM", () => {
  server.close();
  void users.close().finally(() => process.exit(0));
});
