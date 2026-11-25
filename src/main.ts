import debounce from 'debounce';
import { createKernel, type Pty } from 'unkernel';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { controlChar, XTERM_SKIPPED_KEYS } from './keys';

import UNKERNEL_WASM from 'unkernel/unkernel.wasm?url';

import ALPINE from './alpine.erofs.json';
import '@xterm/xterm/css/xterm.css';


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


const INDICATOR_FS = document.getElementById('fs')!;
const restoreFSIndicator = debounce(() => {
  INDICATOR_FS.style.color = 'inherit';
}, 100);

const rawFetch = window.fetch;
const CHUNKS: Record<string, typeof ALPINE> = Object.fromEntries([
  ALPINE,
].map(spec => [spec.file, ALPINE]));
window.fetch = async (input, init) => {
  if (typeof input === 'string' && CHUNKS[input]) {
    const range = (init?.headers as unknown as { range?: string }).range;
    if (range && range.startsWith('bytes=')) {
      const [absStart, absLast] = range.substring('bytes='.length).split('-').map(
        (s) => parseInt(s, 10),
      );
      const absEnd = absLast + 1;

      INDICATOR_FS.style.color = 'cyan';

      const { size, chunks }= CHUNKS[input];
      const blob = new Blob(await Promise.all(chunks.flatMap(({ file, start, end }) => {
        if (absEnd <= start || absStart >= end) {
          return [];
        }
        const relStart = absStart - start;
        const relEnd = absEnd - start;
        const initChunk = { ...init! };
        initChunk.headers = { ...init!.headers as object };
        initChunk.headers['range'] = `bytes=${Math.max(0, relStart)}-${Math.min(relEnd, end) - 1}`;
        return [rawFetch(`/unkernel/${file}`, initChunk).then(res => res.bytes())];
      })));

      restoreFSIndicator();

      return new Response(blob, {
        status: 206,
        headers: { 'content-range': `bytes ${absStart}-${absLast}/${size}` },
      });
    }
  }
  return rawFetch(input, init);
};


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
  alert(`An Emacs playground running on unkernel in your browser.

1. Browsers prevent us from capturing Ctrl+q/n/t/w, etc.
   So, instead, you might need to use the "Ctrl" checkbox
   in the header. You may press Ctrl to toggle it.
2. If you want mouse support, run M-x xterm-mouse-mode.
`);
  terminal.focus();
});


(async () => {

  const vm = await createKernel({
    kernel: UNKERNEL_WASM,
    distro: {
      kind: 'http',
      url: ALPINE.file,
    },
  });

  const args = CURRENT_VARIANT === 'mini' ? ['-Q'] : [];
  let emulator = await start();
  async function listenTo(e: Pty) {
    for await (const bytes of e.output) {
      if (e !== emulator) {
        return;
      }
      terminal.write(bytes);
    }
  }
  async function start() {
    const e= await vm.spawn('emacs', args, {
      cols: terminal.cols,
      rows: terminal.cols,
      term: 'xterm-256color',
      env: { COLORTERM: 'truecolor', LANG: 'C.UTF-8' },
    });
    void listenTo(e);
    e.ended.then(async () => {
      terminal.reset();
      emulator = await start();
      emulator.resize(terminal.cols, terminal.rows);
    });
    return e;
  }

  terminal.onData((data) => {
    emulator.write(data);
  });
  terminal.onBinary((data) => {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      bytes[i] = data.charCodeAt(i);
    }
    emulator.write(bytes);
  });

  // Resizing:
  const syncResize = debounce(() => {
    fitAddon.fit();
    emulator.resize(terminal.cols, terminal.rows);
  }, 100);
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

    // Ctrl assistance #2:
    if (event.type === 'keydown' && CTRL.checked) {
      CTRL.checked = false;
      if (event.key.length === 1) {
        const escaped = controlChar(event.key.charCodeAt(0));
        emulator.write(new Uint8Array([escaped]));
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

    // Modifier + ; or : etc.
    if (XTERM_SKIPPED_KEYS.includes(event.key)) {
      if (event.ctrlKey || event.altKey) {
        if (event.type === 'keydown') {
          const ctrl = event.ctrlKey || CTRL.checked;
          CTRL.checked = false;
          let key = event.key.charCodeAt(0);
          if (ctrl) {
            key = controlChar(key);
          }
          emulator.write(new Uint8Array(
            event.altKey ? [0x1b, key] : [key],
          ));
        }
        return false;
      }
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
      emulator.write(new TextEncoder().encode(pasted));
    }
    terminal.focus();
  });

})();
