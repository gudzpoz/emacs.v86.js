#!/usr/bin/env node
// Split the built unkernel Alpine EROFS image into <=20 MiB chunks in
// public/unkernel/ (within Cloudflare Pages' 25 MiB per-file limit), and copy
// distros.json + unkernel.wasm alongside a JSON chunk manifest.

import fs from 'node:fs/promises';
import path from 'node:path';

const CHUNK_SIZE = 20 * 1024 * 1024;    // 20 MiB (block- and 1 MiB prefetch-aligned)
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MiB Cloudflare Pages limit

const DISTRO_NAME = process.env.UNKERNEL_DISTRO_NAME || 'alpine';
const DISTRO_DIR = path.resolve(process.env.KW_DISTRO_OUT || 'build/unkernel-distro');
const BASE_DIR = path.resolve(process.env.KW_BASE_OUT || 'build/unkernel-base');
const OUT_DIR = path.resolve(process.env.UNKERNEL_PUBLIC_DIR || 'public/unkernel');

const imageFile = `${DISTRO_NAME}.erofs`;
const imagePath = path.join(DISTRO_DIR, imageFile);
const idPath = path.join(DISTRO_DIR, `${DISTRO_NAME}.id`);
const distrosJsonPath = path.join(DISTRO_DIR, 'distros.json');
const wasmPath = path.join(BASE_DIR, 'unkernel.wasm');

async function readExact(fd, buffer, offset) {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await fd.read(buffer, filled, buffer.length - filled, offset + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

await fs.mkdir(OUT_DIR, { recursive: true });

// Remove stale chunks for this image so a smaller rebuild never leaves orphans.
const existing = await fs.readdir(OUT_DIR);
for (const entry of existing) {
  if (entry.startsWith(`${imageFile}.`)) {
    await fs.rm(path.join(OUT_DIR, entry), { force: true });
  }
}

const stat = await fs.stat(imagePath);
const totalSize = stat.size;
const imageId = (await fs.readFile(idPath, 'utf8')).trim();

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
    await fs.writeFile(path.join(OUT_DIR, chunkFile), buffer);
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

const manifestPath = path.join(OUT_DIR, `${imageFile}.json`);
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await fs.copyFile(distrosJsonPath, path.join(OUT_DIR, 'distros.json'));
await fs.copyFile(wasmPath, path.join(OUT_DIR, 'unkernel.wasm'));

// Enforce Cloudflare Pages' 25 MiB per-file limit across all outputs.
for (const entry of await fs.readdir(OUT_DIR)) {
  const full = path.join(OUT_DIR, entry);
  const s = await fs.stat(full);
  if (s.isFile() && s.size >= MAX_FILE_SIZE) {
    throw new Error(`${full} is ${s.size} bytes (>= ${MAX_FILE_SIZE} byte Cloudflare Pages limit)`);
  }
}

console.log(
  `Chunked ${imageFile} (${(totalSize / 1048576).toFixed(2)} MiB, ${imageId}) into ${chunks.length} parts in ${OUT_DIR}`,
);
