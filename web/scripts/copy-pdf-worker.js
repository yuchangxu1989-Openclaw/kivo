#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const src = path.join(
  process.cwd(),
  'node_modules',
  'pdfjs-dist',
  'build',
  'pdf.worker.min.mjs',
);
const destDir = path.join(process.cwd(), 'public');
const dest = path.join(destDir, 'pdf.worker.min.mjs');

if (!fs.existsSync(src)) {
  console.error(`pdf.worker.min.mjs not found at ${src}`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);

console.log(`Copied pdf.worker.min.mjs to public/`);
