import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: '../../supabase/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@localhost:54322/postgres',
  },
  verbose: true,
  strict: true,
});
