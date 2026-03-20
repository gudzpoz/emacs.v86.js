#!/usr/bin/env node

// Copyright (c) 2012, The v86 contributors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

import path from 'node:path';
import fs from 'node:fs/promises';
import url from 'node:url';
import { V86 } from 'v86';

if (process.argv.length < 6) {
    console.error(`Usage: ${process.argv[1]} <fs_json> <fs_root> <output_file> [cmds...]`);
    process.exit(1);
}

const PROJECT = path.join(url.fileURLToPath(new URL('.', import.meta.url)), '..');
const V86_REPO = path.join(PROJECT, 'v86');
const V86_JSON = process.argv[2];
const V86_ROOT = process.argv[3];
const OUTPUT_FILE = process.argv[4];
const CMDS = process.argv.slice(5);

var emulator = new V86({
    wasm_path: path.join(PROJECT, 'node_modules/v86/build/v86.wasm'),
    bios: { url: path.join(V86_REPO, 'bios/seabios.bin') },
    vga_bios: { url: path.join(V86_REPO, 'bios/vgabios.bin') },
    autostart: true,
    memory_size: 512 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    network_relay_url: '<UNUSED>',
    bzimage_initrd_from_filesystem: true,
    cmdline: 'rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci tsc=reliable init_on_free=on',
    filesystem: {
        baseurl: V86_ROOT,
        basefs: V86_JSON,
    },
});

console.log('Now booting, please stand by ...');

const END = 'localhost:~# ';
let serial_text = '';
let resolve = () => {};
emulator.add_listener("serial0-output-byte", (byte) => {
    const c = String.fromCharCode(byte);
    process.stdout.write(c);
    serial_text += c;

    if (serial_text.endsWith(END)) {
        serial_text = '';
        resolve();
    }
});

/**
 * @param {string} cmd
 */
function run(cmd) {
    return new Promise((r) => {
        resolve = r;
        if (cmd !== '') {
            emulator.serial0_send(cmd + '\n');
        }
    });
}

await run('');
console.log('Booted');

for (const cmd of CMDS) {
    await run(cmd);
}

await run('sync;echo 3 >/proc/sys/vm/drop_caches');
await new Promise((resolve) => setTimeout(resolve, 5 * 1000));

const s = await emulator.save_state();
await fs.writeFile(OUTPUT_FILE, new Uint8Array(s));
console.log(`Saved as ${OUTPUT_FILE}`);
emulator.destroy();
process.exit(0);
