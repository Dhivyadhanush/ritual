#!/usr/bin/env node
import crypto from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('usage: node scripts/hash-password.mjs "new password"');
  console.error('Then set AUTH_PASSWORD_HASH to the printed value and restart.');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 32);
console.log(`scrypt:${salt.toString('base64')}:${hash.toString('base64')}`);
