#!/usr/bin/env node
/**
 * Target Synchronization Script
 * Synchronizes production monitors from data/production-monitors.json into SQLite.
 */
const path = require('path');
const fs = require('fs');
const { db, queries } = require('../server/db');

const configPath = path.join(__dirname, '..', 'data', 'production-monitors.json');

if (!fs.existsSync(configPath)) {
  console.error(`Config file not found at: ${configPath}`);
  process.exit(1);
}

const targets = JSON.parse(fs.readFileSync(configPath, 'utf8'));

console.log(`[Sync] Found ${targets.length} targets in production-monitors.json`);

// Clean up old demo seeds if they exist
const demoUrls = [
  'https://en.wikipedia.org',
  'https://www.githubstatus.com',
  'https://archive.org',
  'http://localhost:3000/api/mock/flaky'
];

for (const demoUrl of demoUrls) {
  const row = db.prepare('SELECT id FROM monitors WHERE url = ?').get(demoUrl);
  if (row) {
    db.prepare('DELETE FROM monitors WHERE id = ?').run(row.id);
    console.log(`[Sync] Removed demo seed target: ${demoUrl}`);
  }
}

// Upsert production monitors
let added = 0;
let updated = 0;

const upsert = db.transaction(() => {
  for (const target of targets) {
    const existing = db.prepare('SELECT id FROM monitors WHERE url = ?').get(target.url);

    if (existing) {
      db.prepare(`
        UPDATE monitors SET
          name = @name,
          method = @method,
          interval_seconds = @interval_seconds,
          timeout_ms = @timeout_ms,
          expected_status = @expected_status,
          keyword_check = @keyword_check,
          ssl_check_enabled = @ssl_check_enabled,
          group_tag = @group_tag,
          is_active = @is_active,
          custom_headers = @custom_headers,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
      `).run({
        id: existing.id,
        custom_headers: '',
        ...target
      });
      updated++;
    } else {
      queries.createMonitor.run({
        custom_headers: '',
        ...target
      });
      added++;
    }
  }
});

upsert();

console.log(`[Sync] Complete: ${added} added, ${updated} updated.`);
console.log(`[Sync] Total active monitors now in database:`, db.prepare('SELECT count(*) as c FROM monitors').get().c);
