import fs from 'node:fs';
fs.cpSync(new URL('../src/migrations/', import.meta.url), new URL('../dist/migrations/', import.meta.url), { recursive: true });
