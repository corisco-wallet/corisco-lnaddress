import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { ChallengeStore } from "./challenge";
import { loadConfig } from "./config";
import { UserStore } from "./db";
import { createSparkInvoiceCreator } from "./invoices";

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });
const invoices = await createSparkInvoiceCreator(config.serverMnemonic, config.network);
const app = createApp({ config, users: new UserStore(config.dbPath), challenges: new ChallengeStore(), invoices });

serve({ fetch: app.fetch, port: config.port }, ({ port }) => console.log(`listening on :${port}`));
