#!/usr/bin/env node
// Split an EROFS image into <=20 MiB chunks in OUT_DIR (within Cloudflare
// Pages' 25 MiB per-file limit) and write its chunk manifest JSON to
// MANIFEST_JSON (e.g. src/alpine.erofs.json).
//
// Usage: node scripts/chunk-unkernel.mjs <INPUT_EROFS> <MANIFEST_JSON> [OUT_DIR]

import fs from 'node:fs/promises';
import path from 'node:path';

const CHUNK_SIZE = 20 * 1024 * 1024;    // 20 MiB (block- and 1 MiB prefetch-aligned)
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MiB Cloudflare Pages limit

const [inputArg, manifestArg, outDirArg] = process.argv.slice(2);
if (!inputArg || !manifestArg) {
  console.error('Usage: node scripts/chunk-unkernel.mjs <INPUT_EROFS> <MANIFEST_JSON> [OUT_DIR]');
  process.exit(2);
}

const imagePath = path.resolve(inputArg);
const manifestPath = path.resolve(manifestArg);
const outDir = path.resolve(outDirArg || 'public/unkernel');
const imageFile = path.basename(imagePath);

async function readExact(fd, buffer, offset) {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await fd.read(buffer, filled, buffer.length - filled, offset + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(path.dirname(manifestPath), { recursive: true });

// Remove stale numbered chunks for this image only so other images stay intact.
const chunkPattern = new RegExp(`^${imageFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+$`);
for (const entry of await fs.readdir(outDir)) {
  if (chunkPattern.test(entry)) {
    await fs.rm(path.join(outDir, entry), { force: true });
  }
}

const stat = await fs.stat(imagePath);
const totalSize = stat.size;

const chunks = [];
const fd = await fs.open(imagePath, 'r');
try {
  let offset = 0;
  let index = 0;
  while (offset < totalSize) {
    const want = Math.min(CHUNK_SIZE, totalSize - offset);
    const buffer = Buffer.allocUnsafe(want);
    const read = await readExact(fd, buffer, offset);
    if (read !== want) {
      throw new Error(`Short read on ${imagePath} at offset ${offset}: got ${read}, expected ${want}`);
    }
    const chunkFile = `${imageFile}.${index}`;
    const chunkPath = path.join(outDir, chunkFile);
    await fs.writeFile(chunkPath, buffer);
    if (read >= MAX_FILE_SIZE) {
      throw new Error(`${chunkPath} is ${read} bytes (>= ${MAX_FILE_SIZE} byte Cloudflare Pages limit)`);
    }
    chunks.push({ file: chunkFile, start: offset, end: offset + read });
    offset += read;
    index++;
  }
} finally {
  await fd.close();
}

const manifest = {
  file: imageFile,
  size: totalSize,
  chunks,
};

await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `Chunked ${imageFile} (${(totalSize / 1048576).toFixed(2)} MiB) into ${chunks.length} part(s) in ${outDir} -> ${manifestPath}`,
);
