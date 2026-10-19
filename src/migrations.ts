import type { Pool, RowDataPacket } from "mysql2/promise";

const LOCK_NAME = "corisco_lnaddress_migrations";
const LOCK_TIMEOUT_SECONDS = 60;

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001-create-users",
    sql: `CREATE TABLE users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username_hash BINARY(32) NOT NULL,
      pubkey_hash BINARY(32) NOT NULL,
      username_enc VARBINARY(128) NOT NULL,
      pubkey_enc VARBINARY(128) NOT NULL,
      created_at BIGINT NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      CONSTRAINT uq_username_hash UNIQUE (username_hash),
      CONSTRAINT uq_pubkey_hash UNIQUE (pubkey_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  },
];

export async function runMigrations(pool: Pool): Promise<void> {
  const connection = await pool.getConnection();
  try {
    const [[lock]] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(?, ?) AS acquired", [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    if (lock.acquired !== 1) throw new Error("could not acquire the migration lock");
    await connection.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(100) NOT NULL PRIMARY KEY, applied_at BIGINT NOT NULL) ENGINE=InnoDB",
    );
    const [applied] = await connection.query<RowDataPacket[]>("SELECT id FROM schema_migrations");
    const done = new Set(applied.map((row) => row.id as string));
    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await connection.query(migration.sql);
      await connection.query("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", [migration.id, Date.now()]);
    }
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]).catch(() => {});
    connection.release();
  }
}
