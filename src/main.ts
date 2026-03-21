import debounce from 'debounce';
import { V86 } from 'v86';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { controlChar } from './keys';

import v86wasm from 'v86/build/v86.wasm?url';
import v86bios from '../v86/bios/seabios.bin?url';
import v86vgabios from '../v86/bios/vgabios.bin?url';

import CHUNKS_UNTYPED from './states.json';
import '@xterm/xterm/css/xterm.css';

// Now that we use initialied states, this cmdline may not be needed.
const CMDLINE = 'rw root=host9p rootfstype=9p'
  + ' rootflags=trans=virtio,cache=loose modules=virtio_pci'
  + ' tsc=reliable';

const COMPRESSIONS: CompressionFormat[] = import.meta.env.DEV ? [] : [
  'brotli' as CompressionFormat,
  'gzip',
];
const CHUNKS: Record<string, number[]> = CHUNKS_UNTYPED;


async function fetchMaybeChunked(url: string) {
  const name = url.substring(url.lastIndexOf('/') + 1);
  const entry = CHUNKS[name];
  if (!entry) {
    return fetch(url);
  }

  const buffers = await Promise.all([...new Array(entry.length)].map(async (_, i) => {
    const chunkUrl = `${url}.${i}`;
    return (await fetch(chunkUrl)).arrayBuffer();
  }));
  return new Response(new Blob(buffers));
}
async function fetchMaybeCompressed(url: string) {
  if (window.DecompressionStream) {
    for (const compression of COMPRESSIONS) {
      try {
        const decompressor = new DecompressionStream(compression);
        const response = await fetchMaybeChunked(`${url}.${compression}`);
        const stream = response.body!.pipeThrough(decompressor);
        return new Response(stream, response).arrayBuffer();
      } catch (e) {
        console.log(`Failed to ${compression}-decompress ${url}, falling back`, e);
      }
    }
  }
  return fetchMaybeChunked(url).then(r => r.arrayBuffer());
}


const terminal = new Terminal({
  allowProposedApi: true,
  scrollback: 0,
  fontSize: 12,
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
const unicode11Addon = new Unicode11Addon();
terminal.loadAddon(unicode11Addon);
terminal.unicode.activeVersion = '11';
const container = document.getElementById('term')!;
terminal.open(container);
if (!import.meta.env.DEV) {
  window.addEventListener('beforeunload', (event) => {
    event.preventDefault();
  });
}


const PROGRESS = document.getElementById('progress')!;
PROGRESS.textContent = '...';
const INDICATOR_CPU = document.getElementById('cpu')!;
const INDICATOR_FS = document.getElementById('fs')!;


const VARIANT_SELECTOR = document.querySelector<HTMLSelectElement>('#variant')!;
const VARIANTS = [...VARIANT_SELECTOR?.options].map((o) => o.value);
const CURRENT_VARIANT = [
  ...VARIANTS
    .filter((i) => location.search.includes(i)),
  VARIANTS[0],
][0];
VARIANT_SELECTOR.value = CURRENT_VARIANT;
VARIANT_SELECTOR.addEventListener('change', () => {
  location.search = VARIANT_SELECTOR.value;
});


const CTRL = document.getElementById('ctrl')! as HTMLInputElement;
CTRL.checked = false;


const QUESTION = document.getElementById('question')!;
QUESTION.addEventListener('click', () => {
  alert(`An Emacs playground running on v86 in your browser.

0. v86 runs a virtual machine, so expect it to be slow.
1. Browsers prevent us from capturing Ctrl+q/n/t/w, etc.
   So, instead, you might need to use the "Ctrl" checkbox
   in the header. You may press Ctrl to toggle it.

The source code is at https://github.com/gudzpoz/emacs.v86.js
`);
  terminal.focus();
});


(async () => {

  PROGRESS.textContent = 'Loading VM state...';
  const [bios, vgabios, init] = await Promise.all([
    fetch(v86bios).then(r => r.arrayBuffer()),
    fetch(v86vgabios).then(r => r.arrayBuffer()),
    fetchMaybeCompressed(`/state-${CURRENT_VARIANT}.bin`),
  ]);

  const emulator = new V86({
    wasm_path: v86wasm,
    bios: { buffer: bios },
    vga_bios: { buffer: vgabios },
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
  let acc = 0;
  emulator.add_listener('serial0-output-byte', (byte: number) => {
    terminal.write(new Uint8Array([byte]));
    acc++;
    if (acc > 256) {
      PROGRESS.textContent = '';
    }
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

  // Indicators:
  emulator.add_listener('9p-read-start', () => {
    INDICATOR_FS.style.color = 'cyan';
  });
  const restoreFSIndicator = debounce(() => {
    INDICATOR_FS.style.color = 'inherit';
  }, 100);
  emulator.add_listener('9p-read-end', () => {
    restoreFSIndicator();
  });
  emulator.add_listener('9p-write-end', () => {
    INDICATOR_FS.style.color = 'red';
    restoreFSIndicator();
  });
  const restoreCPUIndicator = debounce(() => {
    INDICATOR_CPU.style.color = 'inherit';
  }, 500);
  let insCount = 0;
  setInterval(() => {
    const last = insCount;
    insCount = emulator.get_instruction_counter();
    // empirically:
    if (insCount - last > 800_000) {
      INDICATOR_CPU.style.color = 'orange';
      restoreCPUIndicator();
    }
  }, 500);

  // order: ready -> run() -> started -> loaded -> (responsive) -> run "fg"
  emulator.add_listener('emulator-loaded', () => {
    // We've send "fg" over when building the states, so let's trigger it:
    PROGRESS.textContent = 'Restoring Emacs...';
    emulator.serial0_send('\n');
    terminal.focus();
    initThings();
  });
  emulator.add_listener('emulator-ready', () => {
    if (!emulator.is_running()) {
      PROGRESS.textContent = 'Starting VM...';
      emulator.run();
    }
  });

  function initThings() {
    // Resizing:
    const syncResize = debounce(() => {
      fitAddon.fit();
      const cmd = `stty -F /dev/ttyS0 cols ${terminal.cols} rows ${terminal.rows}\n`;
      emulator.serial_send_bytes(1, new TextEncoder().encode(cmd));
    }, 500);
    syncResize();
    window.addEventListener('resize', syncResize);

    // Tons of hacks to pass keys correctly:
    let capturedDown: string | null = null;
    let lastIsCtrlDown = false;
    CTRL.addEventListener('change', () => terminal.focus());
    terminal.attachCustomKeyEventHandler((event) => {
      // Ctrl assistance #1:
      if (event.key === 'Control') {
        if (event.type === 'keydown') {
          lastIsCtrlDown = true;
          return true;
        }
        if (event.type === 'keyup' && lastIsCtrlDown) {
          CTRL.checked = !CTRL.checked;
        }
      }
      lastIsCtrlDown = false;

      // Ctrl assistance #1:
      if (event.type === 'keydown' && CTRL.checked) {
        CTRL.checked = false;
        if (event.key.length === 1) {
          const escaped = controlChar(event.key.charCodeAt(0));
          console.log(escaped);
          emulator.serial_send_bytes(0, new Uint8Array([escaped]));
          capturedDown = event.key;
          return false;
        }
      }
      if (event.type === 'keypress' && capturedDown === event.key) {
        return false;
      }
      if (event.type === 'keyup' && capturedDown === event.key) {
        capturedDown = null;
        return false;
      }

      return true;
    });

    // Pasting:
    const PASTE = document.getElementById('paste')!;
    PASTE.addEventListener('click', () => {
      const pasted = prompt(
        'Xterm.js has trouble pasting Unicode texts. Paste texts here to send to the serial console:',
      );
      if (pasted) {
        emulator.serial_send_bytes(0, new TextEncoder().encode(pasted));
      }
      terminal.focus();
    });
  }

})();
