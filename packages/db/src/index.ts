import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export * from './schema/index';
export { schema };

let client: postgres.Sql | undefined;

/**
 * Database handle.
 *
 * Server-side only. This uses SUPABASE_DB_URL (a direct Postgres connection
 * with the service role), which is why every reference to it must stay inside
 * Server Actions, Route Handlers or the worker — never in a component that
 * could be bundled for the browser.
 */
export function getDb() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error('SUPABASE_DB_URL is not set');
  }
  client ??= postgres(url, {
    max: 10,
    idle_timeout: 20,
    // Postgres numeric comes back as a string so it can go straight into
    // Money.fromString() without ever being a double.
    types: {},
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof getDb>;
