import { V86 } from 'v86';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import v86wasm from 'v86/build/v86.wasm?url';
import v86bios from '../v86/bios/seabios.bin?url';
import v86vgabios from '../v86/bios/vgabios.bin?url';

import '@xterm/xterm/css/xterm.css';
import './style.css';

// Now that we use initialied states, this cmdline may not be needed.
const CMDLINE = 'rw root=host9p rootfstype=9p'
  + ' rootflags=trans=virtio,cache=loose modules=virtio_pci'
  + ' tsc=reliable';

const COMPRESSIONS: CompressionFormat[] = import.meta.env.DEV ? [] : [
  'brotli' as CompressionFormat,
  'gzip',
];

async function fetch_maybe_gzip(url: string) {
  if (window.DecompressionStream) {
    for (const compression of COMPRESSIONS) {
      try {
        const decompressor = new DecompressionStream(compression);
        const response = await fetch(`${url}.${compression}`);
        const stream = response.body!.pipeThrough(decompressor);
        return new Response(stream, response).arrayBuffer();
      } catch (e) {
        console.log(`Failed to ${compression}-decompress ${url}, falling back`, e);
      }
    }
  }
  return fetch(url).then(r => r.arrayBuffer());
}

const terminal = new Terminal();
const fitAddon = new FitAddon();
const container = document.getElementById('app')!;
terminal.loadAddon(fitAddon);
terminal.open(container);
if (!import.meta.env.DEV) {
  window.addEventListener('beforeunload', (event) => {
    event.preventDefault();
  });
}

const FULL = false;

(async () => {

  const init = await fetch_maybe_gzip(FULL ? '/state-full.bin' : '/state-mini.bin');
  const emulator = new V86({
    wasm_path: v86wasm,
    bios: { url: v86bios, size: void 0 as unknown as number },
    vga_bios: { url: v86vgabios, size: void 0 as unknown as number },
    autostart: false,
    memory_size: 512 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    cmdline: CMDLINE,
    bzimage_initrd_from_filesystem: true,
    filesystem: {
      baseurl: '/rootfs',
      basefs: '/rootfs.json',
    },
    initial_state: { buffer: init },

    serial_console: void 0 as unknown as { type: 'none' },
    virtio_console: void 0 as unknown as { type: 'none' },

    uart1: true,
  } as any);
  emulator.add_listener('serial0-output-byte', (byte: number) => {
    terminal.write(new Uint8Array([byte]));
  });
  terminal.onData((data) => {
    emulator.serial0_send(data);
  });
  terminal.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      bytes[i] = data.charCodeAt(i);
    }
    emulator.serial_send_bytes(0, bytes);
  });

  // order: ready -> run() -> started -> loaded -> (responsive) -> run "fg"
  emulator.add_listener('emulator-loaded', () => {
    emulator.serial0_send('fg\n');

    function syncResize() {
      fitAddon.fit();
      const cmd = `stty -F /dev/ttyS0 cols ${terminal.cols} rows ${terminal.rows}\n`;
      emulator.serial_send_bytes(1, new TextEncoder().encode(cmd));
    }
    syncResize();
    window.addEventListener('resize', syncResize);
  });
  emulator.add_listener('emulator-ready', () => {
    if (!emulator.is_running()) {
      emulator.run();
    }
  });

})();
