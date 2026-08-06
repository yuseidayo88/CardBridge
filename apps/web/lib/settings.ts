import 'server-only';
import { appSettings, getDb } from '@cardbridge/db';
import {
  DEFAULT_SETTINGS,
  appSettingsSchema,
  readSafetyInterlocksFromEnv,
  type AppSettings,
} from '@cardbridge/core';

/**
 * Load settings from the database, falling back to defaults.
 *
 * The safety interlocks get special treatment: whatever the database says, the
 * environment can only make them stricter, never looser. So a compromised or
 * mistakenly-edited settings row cannot by itself enable production publishing —
 * DRY_RUN must also be explicitly "false" in the environment.
 */
export async function loadSettings(): Promise<AppSettings> {
  const db = getDb();
  const rows = await db.select().from(appSettings);

  const fromDb: Record<string, unknown> = {};
  for (const row of rows) {
    fromDb[row.key] = row.value;
  }

  const parsed = appSettingsSchema.safeParse(fromDb);
  const settings = parsed.success ? parsed.data : DEFAULT_SETTINGS;

  const env = readSafetyInterlocksFromEnv();
  return {
    ...settings,
    // Logical AND in the safe direction: either source can keep dry run on.
    dryRun: settings.dryRun || env.dryRun,
    allowProductionPublish: settings.allowProductionPublish && env.allowProductionPublish,
    maxPublishPerRun: Math.min(settings.maxPublishPerRun, env.maxPublishPerRun),
  };
}
