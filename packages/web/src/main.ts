import { XYScanner, type Pixel } from '@canvas-ai/shared';
import './style.css';

const MAX_GRID = 2048;
const RENDER_EVERY_N = 512;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | number | undefined>,
  ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) {
      continue;
    }
    if (k === 'className') {
      node.setAttribute('class', String(v));
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const ch of children) {
    node.append(typeof ch === 'string' ? document.createTextNode(ch) : ch);
  }
  return node;
}

const app = document.querySelector('#app');
if (!app) {
  throw new Error('#app missing');
}

const COLLAPSE_KEY = 'canvas-ai-chat-collapsed';

const canvas = el('canvas', {
  className: 'canvas',
}) as HTMLCanvasElement;
const canvasWrap = el('div', { className: 'canvas-wrap' }, canvas);
const canvasStage = el('div', { className: 'canvas-stage' }, canvasWrap);

const chatPanel = el('aside', {
  className: 'chat-panel',
  id: 'chat-panel',
});
const chatToggle = el('button', {
  type: 'button',
  className: 'chat-collapse',
  title: 'Collapse chat',
  'aria-expanded': 'true',
  'aria-controls': 'chat-panel-inner',
});
chatToggle.textContent = 'Hide chat';

const chatInner = el('div', {
  className: 'chat-panel-inner',
  id: 'chat-panel-inner',
});

const chatLog = el('div', { className: 'chat-log' });

const promptInput = el('textarea', {
  className: 'prompt',
  rows: '3',
  placeholder: 'Describe pixels to add (e.g. a 20×20 square at top-left)…',
});
promptInput.value = 'Fill a 32×32 solid square starting at 0,0';

const widthInput = el('input', {
  className: 'grid-input',
  type: 'number',
  min: '1',
  max: String(MAX_GRID),
  value: '128',
});
const heightInput = el('input', {
  className: 'grid-input',
  type: 'number',
  min: '1',
  max: String(MAX_GRID),
  value: '128',
});

const runBtn = el('button', { type: 'button', className: 'primary' }, 'Send');
const stopBtn = el('button', { type: 'button', className: 'secondary' }, 'Stop');
stopBtn.disabled = true;

const clearCanvasBtn = el('button', { type: 'button', className: 'ghost' }, 'Clear canvas');

const countEl = el('span', { className: 'meta-inline' }, 'Pixels: 0 · skipped: 0');

const chatForm = el(
  'div',
  { className: 'chat-form' },
  promptInput,
  el(
    'div',
    { className: 'grid-row' },
    el('label', {}, 'W ', widthInput),
    el('label', {}, 'H ', heightInput),
  ),
  el(
    'div',
    { className: 'actions' },
    runBtn,
    stopBtn,
    clearCanvasBtn,
    countEl,
  ),
);

chatInner.append(
  el('div', { className: 'chat-header' }, 'Chat'),
  chatLog,
  chatForm,
);

chatPanel.append(chatToggle, chatInner);
app.append(el('div', { className: 'layout' }, canvasStage, chatPanel));

let abort: AbortController | null = null;
let imageData: ImageData | null = null;
let pixelCount = 0;
let rejectedCount = 0;
let rafPending = false;
let pendingFlush = false;

function recountStats(gridW: number, gridH: number): void {
  if (!imageData) {
    return;
  }
  let filled = 0;
  const d = imageData.data;
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const i = 4 * (y * gridW + x);
      const w =
        d[i] === 255 &&
        d[i + 1] === 255 &&
        d[i + 2] === 255 &&
        d[i + 3] === 255;
      if (!w) {
        filled++;
      }
    }
  }
  pixelCount = filled;
  countEl.textContent = `Pixels: ${pixelCount} · skipped: ${rejectedCount}`;
}

/**
 * Prepare canvas for size (w,h). Preserves overlapping pixels when resizing; never clears on mere redraw.
 */
function ensureCanvas(w: number, h: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2d context');
  }

  if (imageData && canvas.width === w && canvas.height === h) {
    return;
  }

  const prev = imageData;
  canvas.width = w;
  canvas.height = h;

  const next = ctx.createImageData(w, h);
  const nd = next.data;
  for (let i = 0; i < nd.length; i += 4) {
    nd[i] = 255;
    nd[i + 1] = 255;
    nd[i + 2] = 255;
    nd[i + 3] = 255;
  }

  if (prev) {
    const ow = Math.min(prev.width, w);
    const oh = Math.min(prev.height, h);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const si = 4 * (y * prev.width + x);
        const di = 4 * (y * w + x);
        nd.set(prev.data.subarray(si, si + 4), di);
      }
    }
  }

  imageData = next;
  ctx.putImageData(imageData, 0, 0);
  recountStats(w, h);
}

function clearCanvasFully(): void {
  const w = Number(widthInput.value);
  const h = Number(heightInput.value);
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 1 ||
    h < 1 ||
    w > MAX_GRID ||
    h > MAX_GRID
  ) {
    return;
  }
  imageData = null;
  ensureCanvas(w, h);
  rejectedCount = 0;
  countEl.textContent = `Pixels: ${pixelCount} · skipped: ${rejectedCount}`;
}

function paintPixel(px: Pixel, gridW: number, gridH: number): void {
  if (
    !Number.isInteger(px.x) ||
    !Number.isInteger(px.y) ||
    px.x < 0 ||
    px.y < 0 ||
    px.x >= gridW ||
    px.y >= gridH
  ) {
    rejectedCount++;
    return;
  }
  if (!imageData) {
    return;
  }
  const idx = 4 * (px.y * gridW + px.x);
  const d = imageData.data;
  d[idx] = px.r;
  d[idx + 1] = px.g;
  d[idx + 2] = px.b;
  d[idx + 3] = 255;
  pendingFlush = true;
}

function flushCanvas(): void {
  if (!imageData) {
    return;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.putImageData(imageData, 0, 0);
  recountStats(canvas.width, canvas.height);
  pendingFlush = false;
}

function scheduleFlush(): void {
  if (!pendingFlush || rafPending) {
    return;
  }
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    flushCanvas();
  });
}

let batchSinceFlush = 0;
function considerBatchFlush(): void {
  batchSinceFlush++;
  if (batchSinceFlush >= RENDER_EVERY_N) {
    batchSinceFlush = 0;
    flushCanvas();
  }
}

function scrollChatToBottom(): void {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setCollapsed(collapsed: boolean): void {
  chatPanel.classList.toggle('collapsed', collapsed);
  chatToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  chatToggle.textContent = collapsed ? 'Chat' : 'Hide chat';
  chatToggle.title = collapsed ? 'Expand chat' : 'Collapse chat';
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

chatToggle.addEventListener('click', () => {
  setCollapsed(!chatPanel.classList.contains('collapsed'));
});

try {
  setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
} catch {
  /* ignore */
}

async function run(): Promise<void> {
  const width = Number(widthInput.value);
  const height = Number(heightInput.value);
  const prompt = promptInput.value.trim();

  if (!prompt) {
    return;
  }
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height > MAX_GRID ||
    height < 1 ||
    width > MAX_GRID
  ) {
    const err = el(
      'div',
      { className: 'chat-msg chat-msg-assistant' },
      `Width and height must be integers from 1 to ${MAX_GRID}.`,
    );
    chatLog.append(err);
    scrollChatToBottom();
    return;
  }

  abort?.abort();
  abort = new AbortController();
  runBtn.disabled = true;
  stopBtn.disabled = false;

  chatLog.append(
    el('div', { className: 'chat-msg chat-msg-user' }, prompt),
  );

  const reply = el('div', {
    className: 'chat-msg chat-msg-assistant is-streaming',
  });
  reply.textContent = 'Streaming pixels…';
  chatLog.append(reply);
  scrollChatToBottom();

  ensureCanvas(width, height);
  rejectedCount = 0;
  const scanner = new XYScanner();
  batchSinceFlush = 0;
  let nonBlackInStream = 0;

  try {
    const res = await fetch('/api/draw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, width, height }),
      signal: abort.signal,
    });

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) {
          detail = j.error;
        }
      } catch {
        /* ignore */
      }
      reply.classList.remove('is-streaming');
      reply.textContent = `Error: ${detail}`;
      scrollChatToBottom();
      return;
    }

    if (!res.body) {
      reply.classList.remove('is-streaming');
      reply.textContent = 'No response body.';
      scrollChatToBottom();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        received += value.byteLength;
        const chunk = decoder.decode(value, { stream: true });
        for (const px of scanner.feed(chunk)) {
          if (px.r !== 0 || px.g !== 0 || px.b !== 0) {
            nonBlackInStream++;
          }
          paintPixel(px, width, height);
          considerBatchFlush();
        }
        scheduleFlush();
      }
      if (done) {
        break;
      }
    }

    const tail = decoder.decode();
    if (tail) {
      for (const px of scanner.feed(tail)) {
        if (px.r !== 0 || px.g !== 0 || px.b !== 0) {
          nonBlackInStream++;
        }
        paintPixel(px, width, height);
        considerBatchFlush();
      }
    }

    for (const px of scanner.finalize()) {
      if (px.r !== 0 || px.g !== 0 || px.b !== 0) {
        nonBlackInStream++;
      }
      paintPixel(px, width, height);
      considerBatchFlush();
    }

    flushCanvas();
    reply.classList.remove('is-streaming');
    reply.textContent = `Done — ${received} bytes. Canvas pixels (non-white): ${pixelCount}. This stream: ${nonBlackInStream} lines with non-black RGB (rest #000000 or omitted). Skipped (OOB): ${rejectedCount}.`;
    scrollChatToBottom();
  } catch (e) {
    reply.classList.remove('is-streaming');
    if (e instanceof Error && e.name === 'AbortError') {
      reply.textContent = 'Stopped.';
    } else {
      reply.textContent = e instanceof Error ? e.message : 'Request failed';
    }
    scrollChatToBottom();
  } finally {
    runBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

runBtn.addEventListener('click', () => void run());
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void run();
  }
});
stopBtn.addEventListener('click', () => {
  abort?.abort();
});
clearCanvasBtn.addEventListener('click', () => {
  clearCanvasFully();
  flushCanvas();
});

ensureCanvas(Number(widthInput.value), Number(heightInput.value));
