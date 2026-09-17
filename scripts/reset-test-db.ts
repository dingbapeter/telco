// Drops every table in the test database and rebuilds it from the
// migrations. Refuses to touch a database whose name does not end in _test.
import pg from "pg";
import { migrate } from "../src/migrate.ts";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is not set.");
const dbName = new URL(url).pathname.slice(1);
if (!dbName.endsWith("_test")) throw new Error(`Refusing to reset ${dbName}: only databases named *_test are reset.`);

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await migrate(client);
// Prove every migration is safe to run twice by running them all again.
await client.query("DELETE FROM schema_migrations");
await migrate(client);
await client.end();
console.log(`Reset ${dbName} and applied the migrations twice.`);
