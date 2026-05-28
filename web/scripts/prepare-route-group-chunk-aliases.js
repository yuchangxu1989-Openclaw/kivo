#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const appChunksDir = path.join(process.cwd(), '.next', 'static', 'chunks', 'app');
const aliases = new Map([
  ['(auth)', 'auth'],
  ['(dashboard)', 'dashboard'],
  ['(public)', 'public'],
]);

function copyDirectory(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

let copied = 0;
for (const [sourceName, aliasName] of aliases) {
  const source = path.join(appChunksDir, sourceName);
  const alias = path.join(appChunksDir, aliasName);
  if (copyDirectory(source, alias)) copied += 1;
}

console.log(`Prepared ${copied} Next.js route-group static chunk aliases.`);
