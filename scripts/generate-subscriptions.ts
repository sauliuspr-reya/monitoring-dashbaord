#!/usr/bin/env ts-node

/**
 * Generate subscription groups from the current publication
 * Organizes 104 tables into logical subscription groups
 */

import { generateSubscriptions, organizeTables, TABLE_GROUPS } from './organize-tables-by-domain.js';

// Get all tables from publication (you can pass this as an argument or read from DB)
const allTables = process.argv.slice(2);

if (allTables.length === 0) {
  console.error('Usage: generate-subscriptions.ts <table1> <table2> ...');
  console.error('Or pipe from psql:');
  console.error('  psql ... -t -A -c "SELECT tablename FROM pg_publication_tables WHERE pubname = \'reya_replication\' ORDER BY tablename;" | xargs ts-node generate-subscriptions.ts');
  process.exit(1);
}

const { grouped, ungrouped } = organizeTables(allTables);
const subscriptions = generateSubscriptions(allTables);

console.log('=========================================');
console.log('Subscription Organization');
console.log('=========================================\n');

console.log(`Total tables: ${allTables.length}`);
console.log(`Grouped: ${allTables.length - ungrouped.length}`);
console.log(`Ungrouped: ${ungrouped.length}\n`);

console.log('=========================================');
console.log('Subscription Groups');
console.log('=========================================\n');

for (const sub of subscriptions) {
  console.log(`📦 ${sub.subscriptionName}`);
  console.log(`   Publication: ${sub.publicationName}`);
  console.log(`   Slot: ${sub.slotName}`);
  console.log(`   Priority: ${sub.priority}`);
  console.log(`   Tables: ${sub.tables.length}`);
  console.log(`   Description: ${sub.description}`);
  console.log(`   Tables:`);
  sub.tables.forEach(table => {
    console.log(`     - ${table}`);
  });
  console.log('');
}

if (ungrouped.length > 0) {
  console.log('=========================================');
  console.log('Ungrouped Tables');
  console.log('=========================================\n');
  ungrouped.forEach(table => {
    console.log(`  - ${table}`);
  });
  console.log('');
}

console.log('=========================================');
console.log('SQL Commands to Create Publications');
console.log('=========================================\n');

for (const sub of subscriptions) {
  const tableList = sub.tables.map(t => `  "${t}"`).join(',\n');
  console.log(`-- ${sub.description}`);
  console.log(`CREATE PUBLICATION ${sub.publicationName} FOR TABLE\n${tableList};`);
  console.log('');
}

console.log('=========================================');
console.log('SQL Commands to Create Subscriptions');
console.log('=========================================\n');

for (const sub of subscriptions) {
  console.log(`-- ${sub.description}`);
  console.log(`CREATE SUBSCRIPTION ${sub.subscriptionName}`);
  console.log(`  CONNECTION 'host=<source-host> port=5432 dbname=reya user=postgres password=<password>'`);
  console.log(`  PUBLICATION ${sub.publicationName}`);
  console.log(`  WITH (`);
  console.log(`    create_slot = true,`);
  console.log(`    slot_name = '${sub.slotName}',`);
  console.log(`    copy_data = false,`);
  console.log(`    enabled = true,`);
  console.log(`    streaming = parallel`);
  console.log(`  );`);
  console.log('');
}

