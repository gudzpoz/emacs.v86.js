#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';

const OUTPUT_MANIFEST = process.argv[2];
const INPUT_FILES = process.argv.slice(3);

if (!OUTPUT_MANIFEST || INPUT_FILES.length === 0) {
  console.error("Usage: node chunkify.js <chunk-info.json> <files...>");
  process.exit(1);
}

const MAX_SIZE = 25 * 1024 * 1024;   // 25 MB
const CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB

const manifest = {};

async function splitFile(filePath) {
  const stat = await fs.stat(filePath);
  const size = stat.size;

  if (size <= MAX_SIZE) {
    return;
  }

  const fd = await fs.open(filePath, 'r');
  const base = path.basename(filePath);
  const dir = path.dirname(filePath);

  const chunks = [];
  let offset = 0;
  let index = 0;

  while (offset < size) {
    const remaining = size - offset;
    const chunkSize = Math.min(CHUNK_SIZE, remaining);

    const buffer = Buffer.allocUnsafe(chunkSize);
    await fd.read(buffer, 0, chunkSize, offset);

    const chunkName = `${base}.${index}`;
    const chunkPath = path.join(dir, chunkName);

    await fs.writeFile(chunkPath, buffer);

    chunks.push(chunkSize);
    offset += chunkSize;
    index++;
  }

  await fd.close();

  manifest[base] = chunks;

  console.log(`Chunked ${filePath} into ${chunks.length} parts`);
}

await Promise.all(INPUT_FILES.map(splitFile));
await fs.writeFile(OUTPUT_MANIFEST, JSON.stringify(manifest, null, 2));

console.log(`Wrote manifest to ${OUTPUT_MANIFEST}`);
