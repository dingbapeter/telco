import pg from "pg";

// bigint columns come back as strings by default. Every amount in this system
// is integer kobo well inside the safe integer range, so parse them as numbers
// once here rather than at every call site.
pg.types.setTypeParser(20, (v) => Number(v));

export type Queryable = pg.Pool | pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. It is the Postgres connection string, and it " +
          "belongs in the service's environment file on the server, never in the repository.",
      );
    }
    pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

// Every write happens inside one of these, with the actor named, so the audit
// trigger in the database knows who did it without any code remembering to say.
export async function withActor<T>(
  actor: string,
  fn: (client: pg.PoolClient) => Promise<T>,
  db: pg.Pool = getPool(),
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor', $1, true)", [actor]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
