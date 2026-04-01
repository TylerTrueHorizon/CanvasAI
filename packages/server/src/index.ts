import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import OpenAI from 'openai';
import {
  XYScanner,
  formatPixelLine,
  isPairInBounds,
  type Pixel,
} from '@canvas-ai/shared';

const MAX_GRID = 2048;
const DEFAULT_PORT = 3000;

/** Max `x,y` pairs to print per request (avoid megabyte logs). Use COORD_DEBUG_MAX=0 for no limit. */
function coordDebugMax(): number {
  const v = process.env.COORD_DEBUG_MAX;
  if (v === '0') {
    return Number.POSITIVE_INFINITY;
  }
  const n = Number(v ?? '8000');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8000;
}

function countRawHexSnippets(raw: string): number {
  const m = raw.match(/#[0-9a-fA-F]{3}(?![0-9a-fA-F])|#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g);
  return m?.length ?? 0;
}

function logLlmCoordinatesDebug(opts: {
  prompt: string;
  width: number;
  height: number;
  rawAssistantText: string;
  validatedPixels: Pixel[];
}): void {
  const max = coordDebugMax();
  const { prompt, width, height, rawAssistantText, validatedPixels } = opts;

  console.log('\n========== [draw] LLM finished ==========');
  console.log(
    'Prompt:',
    prompt.length > 160 ? `${prompt.slice(0, 160)}…` : prompt,
  );
  console.log('Grid:', `${width}×${height}`);
  console.log('Raw assistant text length:', rawAssistantText.length);

  const rawHexSnippets = countRawHexSnippets(rawAssistantText);
  if (rawHexSnippets === 0) {
    console.log(
      'Raw text: no #RGB/#RRGGBB-like snippets detected (model likely omitted hex colors).',
    );
  } else {
    console.log(
      'Raw text: #RGB/#RRGGBB-like snippets (regex count):',
      rawHexSnippets,
    );
  }

  const prev = Number(process.env.COORD_DEBUG_RAW_PREVIEW ?? '600');
  const rawCap = Number.isFinite(prev) && prev >= 0 ? prev : 600;
  if (rawAssistantText.length > 0 && rawCap > 0) {
    console.log(
      'Raw preview:\n',
      rawAssistantText.slice(0, rawCap) +
        (rawAssistantText.length > rawCap ? '\n…(truncated)' : ''),
    );
  }
  const n = validatedPixels.length;
  const nonBlack = validatedPixels.filter(
    (p) => p.r !== 0 || p.g !== 0 || p.b !== 0,
  ).length;
  console.log(
    'Validated in-bounds pixels:',
    n,
    `(${nonBlack} non-black after parse, ${n - nonBlack} black #000000)`,
  );

  if (n === 0) {
    console.log('========== [draw] end ==========\n');
    return;
  }

  const fmt = (pixels: Pixel[]) => pixels.map(formatPixelLine).join('\n');
  if (n <= max) {
    console.log('Coordinates (one x,y,#rrggbb per line):\n', fmt(validatedPixels));
  } else {
    const half = Math.floor(max / 2);
    const head = validatedPixels.slice(0, half);
    const tail = validatedPixels.slice(-half);
    console.log(
      `Coordinates (first ${half} + last ${half} of ${n}; raise COORD_DEBUG_MAX or set 0 for full dump):\n`,
      `${fmt(head)}\n…(${n - 2 * half} omitted)…\n${fmt(tail)}`,
    );
  }
  console.log('========== [draw] end ==========\n');
}

const app = new Hono();

app.use(
  '/*',
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }),
);

function systemPrompt(width: number, height: number): string {
  return [
    'You are a professional senior illustrator drawing on a 2D raster canvas.',
    'Your job is to translate the user request into strong visual decisions, not just literal minimal marks.',
    `Grid size: ${width} wide × ${height} tall.`,
    'Origin (0,0) is the top-left corner; x increases right, y increases down.',
    `Valid x is 0..${width - 1}, valid y is 0..${height - 1}.`,
    'Draw with intent, proportion, silhouette, internal detail, shading, and color where appropriate.',
    'Add natural detail when it improves the result: curvature in grass, tapered strokes, small edge flicks, highlights, shadows, texture, and subtle variation.',
    'When drawing people or faces, infer plausible skin tones, hair, facial structure, eyes, lips, nose shape, lighting, and shading from the request unless the user specifies otherwise.',
    'When drawing objects, infer sensible local color and form: leaves should vary in green, metal may use highlights, wood may use warm browns, sky may use gradients, etc.',
    'Prefer visually coherent, recognizable drawings over sparse symbolic outlines.',
    'Each line is ONE pixel: x,y then optional color as a comma and hex RGB.',
    'Format: x,y,#RRGGBB (six hex digits) or x,y,#RGB (three hex digits, shorthand). Use lowercase hex.',
    'Examples — black: 4,10,#000000 or omit color (same as black). Red: 4,10,#ff0000. White: 20,30,#ffffff.',
    'Whenever the user names a color (red, blue, skin tone, etc.), you MUST output the matching #RRGGBB on every affected pixel line.',
    'If the user does not name colors, choose them intelligently from context rather than defaulting everything to black.',
    'Use enough pixels to make the subject read clearly at the requested resolution; do not underdraw.',
    'ONE pixel per line. Separate lines with a newline only. Do not put commas between pixels (only the comma between x and y, and before # if you include a color).',
    'No spaces, no parentheses, no JSON, no markdown, no code fences, no commentary — only digit/comma/#/a-f lines.',
    'For filled regions, enumerate in row-major order when practical.',
    'Do not refuse ordinary drawing requests just because they involve people, faces, anatomy, or realistic detail; comply when allowed by platform policy.',
  ].join(' ');
}

app.post('/api/draw', async (c) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'Missing OPENAI_API_KEY' }, 500);
  }

  let body: { prompt?: string; width?: number; height?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const width = Number(body.width);
  const height = Number(body.height);

  if (!prompt) {
    return c.json({ error: 'prompt is required' }, 400);
  }
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_GRID ||
    height > MAX_GRID
  ) {
    return c.json(
      {
        error: `width and height must be integers 1..${MAX_GRID}`,
      },
      400,
    );
  }

  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const openai = new OpenAI({ apiKey });

  return stream(c, async (streamController) => {
    const scanner = new XYScanner();
    const rawAssistantParts: string[] = [];
    const validatedPixels: Pixel[] = [];

    try {
      const openaiStream = await openai.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt(width, height) },
            { role: 'user', content: prompt },
          ],
          stream: true,
        },
        { signal: c.req.raw.signal },
      );

      for await (const chunk of openaiStream) {
        const text = chunk.choices[0]?.delta?.content ?? '';
        if (!text) {
          continue;
        }
        rawAssistantParts.push(text);
        const pixels = scanner.feed(text);
        for (const px of pixels) {
          if (isPairInBounds(px, width, height)) {
            validatedPixels.push(px);
            await streamController.writeln(formatPixelLine(px));
          }
        }
      }
      for (const px of scanner.finalize()) {
        if (isPairInBounds(px, width, height)) {
          validatedPixels.push(px);
          await streamController.writeln(formatPixelLine(px));
        }
      }

      logLlmCoordinatesDebug({
        prompt,
        width,
        height,
        rawAssistantText: rawAssistantParts.join(''),
        validatedPixels,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      console.error('Draw stream error:', err);
    }
  });
});

/** Dev-friendly root + health */
app.get('/', (c) => c.text('Canvas AI draw API — POST /api/draw'));

const port = Number(process.env.PORT) || DEFAULT_PORT;
console.log(`Draw API listening on http://localhost:${port}`);

serve({ fetch: app.fetch, port });
