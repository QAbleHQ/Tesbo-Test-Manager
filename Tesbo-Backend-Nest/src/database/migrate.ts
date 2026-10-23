import * as crypto from "crypto";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Pool, PoolClient } from "pg";

type MigrationFile = {
  version: number;
  name: string;
  filename: string;
  path: string;
  checksum: string;
};

const MIGRATION_LOCK_KEY = 87261042;

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
}

function normalizeDatabaseUrl(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("jdbc:postgresql://")) return value.slice("jdbc:".length);
  if (value.startsWith("jdbc:postgres://")) return value.slice("jdbc:".length);
  return value;
}

// Migrations take a session-level advisory lock and run DDL, neither of which is safe through a
// transaction-mode pooler (Neon's `-pooler` host): the lock can land on a different server connection
// than the one running the migration, so a leaked lock makes the next run block with no way out.
// Use the direct endpoint. MIGRATION_DATABASE_URL overrides it for any other topology.
function migrationDatabaseUrl(): string {
  const override = process.env.MIGRATION_DATABASE_URL?.trim();
  if (override) return normalizeDatabaseUrl(override);
  const url = normalizeDatabaseUrl(process.env.DATABASE_URL ?? "postgresql://localhost:5432/tesbo");
  return url.replace(/(@ep-[a-z0-9-]+)-pooler(\.)/i, "$1$2");
}

// Fail in seconds with a clear message instead of waiting on a lock until the connection is dropped
// (lock_timeout defaults to 0 = wait forever).
const LOCK_TIMEOUT_MS = Number.parseInt(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? "60000", 10);

function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "migrations");
}

function parseMigrationFilename(filename: string): { version: number; name: string } | null {
  const match = /^V(\d+)_(.+)\.sql$/i.exec(filename);
  if (!match) return null;
  return { version: Number.parseInt(match[1], 10), name: match[2] };
}

function readMigrations(): MigrationFile[] {
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  return fs
    .readdirSync(dir)
    .filter((filename) => filename.toLowerCase().endsWith(".sql"))
    .map((filename) => {
      const parsed = parseMigrationFilename(filename);
      if (!parsed) {
        throw new Error(`Invalid migration filename "${filename}". Expected V<number>_<name>.sql`);
      }
      const filePath = path.join(dir, filename);
      const sql = fs.readFileSync(filePath, "utf8");
      return {
        ...parsed,
        filename,
        path: filePath,
        checksum: crypto.createHash("sha256").update(sql).digest("hex")
      };
    })
    .sort((left, right) => left.version - right.version || left.filename.localeCompare(right.filename));
}

async function ensureMigrationTable(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      execution_time_ms INT NOT NULL
    )
  `);
}

async function bootstrapFromLegacyChangelog(client: PoolClient, migrations: MigrationFile[]) {
  const existing = await client.query<{ count: string }>("SELECT COUNT(*) AS count FROM schema_migrations");
  if (Number.parseInt(existing.rows[0]?.count ?? "0", 10) > 0) return;

  const legacyTable = await client.query<{ exists: string | null }>("SELECT to_regclass('public.databasechangelog') AS exists");
  if (!legacyTable.rows[0]?.exists) return;

  const changelog = await client.query<{ filename: string }>(
    "SELECT filename FROM databasechangelog ORDER BY orderexecuted ASC"
  );
  const appliedFilenames = new Set(changelog.rows.map((row) => path.basename(row.filename)));
  const appliedMigrations = migrations.filter((migration) => appliedFilenames.has(migration.filename));

  if (appliedMigrations.length === 0) return;

  for (const migration of appliedMigrations) {
    await client.query(
      `INSERT INTO schema_migrations (version, name, filename, checksum, execution_time_ms)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (version) DO NOTHING`,
      [migration.version, migration.name, migration.filename, migration.checksum]
    );
  }
  console.log(`Bootstrapped ${appliedMigrations.length} migration record(s) from the legacy changelog.`);
}

function indexMigrations(migrations: MigrationFile[]) {
  return {
    byVersion: new Map(migrations.map((migration) => [migration.version, migration])),
    byFilename: new Map(migrations.map((migration) => [migration.filename, migration])),
    byChecksum: new Map(migrations.map((migration) => [migration.checksum, migration]))
  };
}

async function validateAppliedChecksums(client: PoolClient, migrations: MigrationFile[]) {
  const applied = await client.query<{ version: number; filename: string; checksum: string }>(
    "SELECT version, filename, checksum FROM schema_migrations"
  );
  const { byVersion, byFilename, byChecksum } = indexMigrations(migrations);

  for (const row of applied.rows) {
    const sameVersion = byVersion.get(row.version);
    if (!sameVersion) {
      // Stage applied V78 from a branch that never merged the SQL file.
      console.warn(
        `Skipping unknown applied migration version ${row.version} (${row.filename}).`
      );
      continue;
    }
    if (sameVersion.checksum === row.checksum) continue;

    // Stage and prod reused V76 for different files (password_reset vs admin_plan_override).
    // If this DB row is a known file under another version, do not block deploy.
    if (byChecksum.has(row.checksum) || byFilename.has(row.filename)) {
      console.warn(
        `Skipping version fork at ${row.version}: DB has ${row.filename}, this image has ${sameVersion.filename}.`
      );
      continue;
    }

    throw new Error(
      `Checksum mismatch for migration ${sameVersion.filename}. Create a new migration instead of editing an applied one.`
    );
  }
}

function pendingMigrations(
  migrations: MigrationFile[],
  applied: { version: number; filename: string; checksum: string }[]
) {
  const appliedVersions = new Set(applied.map((row) => row.version));
  const appliedFilenames = new Set(applied.map((row) => row.filename));
  const appliedChecksums = new Set(applied.map((row) => row.checksum));
  return migrations.filter(
    (migration) =>
      !appliedVersions.has(migration.version) &&
      !appliedFilenames.has(migration.filename) &&
      !appliedChecksums.has(migration.checksum)
  );
}

async function applyMigration(client: PoolClient, migration: MigrationFile) {
  const sql = fs.readFileSync(migration.path, "utf8");
  const started = Date.now();

  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (version, name, filename, checksum, execution_time_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [migration.version, migration.name, migration.filename, migration.checksum, Date.now() - started]
    );
    await client.query("COMMIT");
    console.log(`Applied ${migration.filename}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  loadEnv();
  const migrations = readMigrations();
  const databaseUrl = migrationDatabaseUrl();
  const pool = new Pool({
    connectionString: databaseUrl,
    user: process.env.DATABASE_USER || undefined,
    password: process.env.DATABASE_PASSWORD || undefined,
    max: 1
  });

  const client = await pool.connect();
  // A connection dropped between queries is emitted as an 'error' event, not a rejected query, and
  // would otherwise crash the process with an unattributed stack trace.
  client.on("error", (error) => {
    console.error(`Database connection lost during migration: ${error.message}`);
    process.exit(1);
  });

  try {
    await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await ensureMigrationTable(client);
    await bootstrapFromLegacyChangelog(client, migrations);
    await validateAppliedChecksums(client, migrations);

    const applied = await client.query<{ version: number; filename: string; checksum: string }>(
      "SELECT version, filename, checksum FROM schema_migrations"
    );
    const pending = pendingMigrations(migrations, applied.rows);

    if (pending.length === 0) {
      console.log("Database schema is up to date.");
      return;
    }

    for (const migration of pending) {
      await applyMigration(client, migration);
    }
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
