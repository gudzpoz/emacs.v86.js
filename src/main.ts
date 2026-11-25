import debounce from 'debounce';
import { createKernel, DEFAULT_WISP_SERVERS, wispBackend, type Pty } from 'unkernel';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { controlChar, XTERM_SKIPPED_KEYS } from './keys';

import UNKERNEL_WASM from 'unkernel/unkernel.wasm?url';

import ALPINE from './alpine.erofs.json';
import NORMAL from './readme.erofs.json';
import DOOM from './doom.erofs.json';
import SPACEMACS from './spacemacs.erofs.json';
import '@xterm/xterm/css/xterm.css';
import download from 'downloadjs';


const terminal = new Terminal({
  allowProposedApi: true,
  scrollback: 0,
  fontSize: 12,
  fontFamily: '"FiraCode Nerd Font", monospace',
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
const INDICATOR_FS = document.getElementById('fs')!;
const restoreFSIndicator = debounce(() => {
  INDICATOR_FS.style.color = 'inherit';
}, 100);

const rawFetch = window.fetch;
const CHUNKS: Record<string, typeof ALPINE> = Object.fromEntries([
  ALPINE,
  NORMAL,
  DOOM,
  SPACEMACS,
].map(spec => [spec.file, spec]));
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
        initChunk.headers['range'] = `bytes=${Math.max(0, relStart)}-${Math.min(relEnd, end - start) - 1}`;
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

  PROGRESS.textContent = 'Loading VM state...';

  const vm = await createKernel({
    kernel: UNKERNEL_WASM,
    distro: {
      kind: 'http',
      url: ALPINE.file,
    },
    disks: [
      CURRENT_VARIANT === 'doom' ? DOOM
      : CURRENT_VARIANT === 'spac' ? SPACEMACS
      : NORMAL
    ].map((spec) => ({
      kind: 'http',
      url: spec.file,
    })),
    net: wispBackend(DEFAULT_WISP_SERVERS),
  });

  await vm.exec('sh', ['-c', [
    'mkdir -p /mnt/home-ro /tmp/home-ov/upper /tmp/home-ov/work',
    'chown 1000:1000 /tmp/home-ov/upper',
    'mount -t erofs -o ro /dev/wdb /mnt/home-ro',
    `mount -t overlay overlay -o \
lowerdir=/mnt/home-ro,upperdir=/tmp/home-ov/upper,workdir=/tmp/home-ov/work,\
redirect_dir=off,index=off,xino=off,metacopy=off /home/user`,
  ].join(' && ')], { user: 0 });

  const args = CURRENT_VARIANT === 'mini' ? ['-Q']
    : CURRENT_VARIANT === 'orgm' ? ['/home/user/README.org']
    : [];
  let emulator = await start();
  async function listenTo(e: Pty) {
    const reader = e.output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || e !== emulator) {
          break;
        }
        terminal.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  async function start() {
    const e= await vm.spawn('emacs', args, {
      cols: terminal.cols,
      rows: terminal.rows,
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

  PROGRESS.textContent = '';

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

  // Files:
  const EXPLORER = document.getElementById('explorer')!;
  const OPEN = document.getElementById('open')!;
  OPEN.addEventListener('click', () => EXPLORER.style.display = 'flex');
  const EXIT = document.getElementById('exit')!;
  EXIT.addEventListener('click', () => EXPLORER.style.display = 'none');
  const PATH = document.getElementById('path')! as HTMLInputElement;
  const ENTRIES = document.getElementById('entries')!;
  function normalize(path: string) {
    const url = new URL(path, 'http://example.com');
    return url.pathname.replace(/\/+/g, '/');
  }
  let currentDir = '/';
  async function updatePath(path?: string) {
    let dir = path ?? PATH.value;
    dir = normalize(`${dir}/`);
    const res = (await vm.exec('ls', ['-ap', '--', dir], { encoding: 'utf8' }));
    if (res.exitCode !== 0) {
      alert(res.stderr);
      return;
    }
    PATH.value = dir;
    currentDir = dir;
    ENTRIES.innerHTML = '';
    res.stdout.trim().split('\n').forEach(entry => {
      const li = document.createElement('li');
      const file = `${dir}${entry}`;
      if (entry.endsWith('/')) {
        const a = document.createElement('a');
        a.href = '#';
        a.innerText = entry;
        a.addEventListener('click', () => updatePath(file));
        li.appendChild(a);
      } else {
        const button = document.createElement('button');
        button.innerText = '📥';
        button.addEventListener('click', async () => {
          const cat = await vm.exec('cat', ['--', file], { encoding: 'buffer', user: 0 });
          download(cat.stdout, entry);
        });
        li.appendChild(button);
        li.appendChild(document.createTextNode(entry));
      }
      ENTRIES.appendChild(li);
    });
  }
  updatePath('/home/user');
  const GO = document.getElementById('go')!;
  GO.addEventListener('click', () => updatePath());

  const UPLOAD = document.getElementById('upload')!;
  UPLOAD.addEventListener('click', async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      if (!input.files) {
        return;
      }
      await Promise.all([...input.files].map(async (f) => {
        const file = `${currentDir}${f.name}`;
        await vm.exec('tee', ['--', file], {
          input: await f.bytes(),
          user: 0,
        });
        await vm.exec('chown', ['1000:1000', file], { user: 0 });
      }));
      updatePath(currentDir);
    };
    input.click();
  });

})();
