#!/usr/bin/env node

// Load environment from .env.local
require('dotenv').config({ path: '.env.local' });

console.log('==========================================');
console.log('Configuration Check');
console.log('==========================================\n');

// Check database URLs
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;
const monitoringPassword = process.env.MONITORING_DB_PASSWORD;

console.log('Environment Variables:');
console.log('');

if (targetUrl) {
  // Hide password
  const sanitized = targetUrl.replace(/:[^:@]+@/, ':***@');
  console.log('  ✓ TARGET_DATABASE_URL:', sanitized);
} else {
  console.log('  ❌ TARGET_DATABASE_URL: NOT SET');
}

if (sourceUrl) {
  const sanitized = sourceUrl.replace(/:[^:@]+@/, ':***@');
  console.log('  ✓ SOURCE_DATABASE_URL:', sanitized);
} else {
  console.log('  ⚠️  SOURCE_DATABASE_URL: NOT SET (optional)');
}

if (monitoringPassword) {
  console.log('  ✓ MONITORING_DB_PASSWORD: ***');
} else {
  console.log('  ❌ MONITORING_DB_PASSWORD: NOT SET');
}

console.log('');
console.log('==========================================');
console.log('Diagnosis');
console.log('==========================================\n');

if (!targetUrl && !sourceUrl) {
  console.log('❌ PROBLEM: No database URLs configured!');
  console.log('');
  console.log('This is why you see no tables.');
  console.log('');
  console.log('SOLUTION:');
  console.log('Add this to .env.local:');
  console.log('');
  console.log('TARGET_DATABASE_URL=postgresql://postgres:PASSWORD@10.107.240.2:5432/reya');
  console.log('');
  console.log('Get the full URL from K8s:');
  console.log('  kubectl get secret -n postgres-replication postgres-replication-secrets \\');
  console.log('    -o jsonpath=\'{.data.destination-database-url}\' | base64 -d');
  console.log('');
} else if (targetUrl || sourceUrl) {
  console.log('✓ Database URL(s) are configured');
  console.log('');
  console.log('If you still don\'t see tables:');
  console.log('  1. Restart the dashboard: npm run dev');
  console.log('  2. Open http://localhost:3002/tables');
  console.log('  3. Check browser console (F12) for errors');
  console.log('  4. Test the connection manually:');
  if (targetUrl) {
    const url = targetUrl.split('@')[1] || '...';
    console.log(`     psql "${targetUrl.replace(/:([^:@]+)@/, ':PASSWORD@')}" -c "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public';"`);
  }
}

if (!monitoringPassword) {
  console.log('');
  console.log('⚠️  WARNING: Monitoring database password not set');
  console.log('   The dashboard may not work properly');
}

console.log('');
console.log('==========================================');




