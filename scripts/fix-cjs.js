import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cjsPkg = resolve(__dirname, '..', 'dist', 'cjs', 'package.json');
writeFileSync(cjsPkg, '{"type":"commonjs"}\n');
