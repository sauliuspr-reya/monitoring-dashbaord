#!/usr/bin/env node

// Verify .env.local is being read correctly
const fs = require('fs');
const path = require('path');

console.log('==========================================');
console.log('Verifying .env.local');
console.log('==========================================\n');

const envPath = path.join(process.cwd(), '.env.local');

if (!fs.existsSync(envPath)) {
  console.log('❌ .env.local file not found!');
  console.log(`   Expected at: ${envPath}`);
  process.exit(1);
}

console.log(`✓ Found .env.local at: ${envPath}\n`);

// Read and parse the file
const envContent = fs.readFileSync(envPath, 'utf8');
const lines = envContent.split('\n');

console.log('Checking for database URLs:\n');

let hasSource = false;
let hasTarget = false;
let hasDestination = false;

for (const line of lines) {
  const trimmed = line.trim();
  
  // Skip comments and empty lines
  if (!trimmed || trimmed.startsWith('#')) continue;
  
  if (trimmed.startsWith('SOURCE_DATABASE_URL=')) {
    hasSource = true;
    const value = trimmed.split('=').slice(1).join('=');
    const sanitized = value.replace(/:[^:@]+@/, ':***@');
    console.log(`  ✓ SOURCE_DATABASE_URL: ${sanitized.substring(0, 60)}...`);
  }
  
  if (trimmed.startsWith('TARGET_DATABASE_URL=')) {
    hasTarget = true;
    const value = trimmed.split('=').slice(1).join('=');
    const sanitized = value.replace(/:[^:@]+@/, ':***@');
    console.log(`  ✓ TARGET_DATABASE_URL: ${sanitized.substring(0, 60)}...`);
  }
  
  if (trimmed.startsWith('DESTINATION_DATABASE_URL=')) {
    hasDestination = true;
    const value = trimmed.split('=').slice(1).join('=');
    const sanitized = value.replace(/:[^:@]+@/, ':***@');
    console.log(`  ✓ DESTINATION_DATABASE_URL: ${sanitized.substring(0, 60)}...`);
  }
}

console.log('');

if (!hasSource && !hasTarget && !hasDestination) {
  console.log('❌ No database URL variables found in .env.local!');
  console.log('');
  console.log('Add at least one of:');
  console.log('  TARGET_DATABASE_URL=postgresql://user:pass@host:5432/dbname');
  console.log('  SOURCE_DATABASE_URL=postgresql://user:pass@host:5432/dbname');
  process.exit(1);
}

if (!hasTarget && !hasDestination) {
  console.log('⚠️  TARGET_DATABASE_URL not found (but SOURCE_DATABASE_URL is set)');
  console.log('   This is OK, but TARGET_DATABASE_URL is recommended');
}

console.log('==========================================');
console.log('Next Steps:');
console.log('==========================================\n');
console.log('1. Make sure the server is FULLY restarted (not just hot reload)');
console.log('   - Stop with Ctrl+C');
console.log('   - Start with: npm run dev');
console.log('');
console.log('2. Visit http://localhost:3002/tables');
console.log('');
console.log('3. Check the terminal output for:');
console.log('   [tables/all] Environment variables check:');
console.log('   This will show if Next.js is reading the variables');
console.log('');




