export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** One pixel: position and 8-bit RGB (defaults to black when hex is omitted). */
export interface Pixel {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
}

export type XYPair = Pick<Pixel, 'x' | 'y'>;

const BLACK: RGB = { r: 0, g: 0, b: 0 };

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isHex(c: string): boolean {
  return (
    isDigit(c) ||
    (c >= 'a' && c <= 'f') ||
    (c >= 'A' && c <= 'F')
  );
}

type TailOk = { kind: 'ok'; next: number; rgb: RGB };
type TailIncomplete = { kind: 'incomplete' };
type TailResult = TailOk | TailIncomplete;

/**
 * Parse `#RRGGBB` or `#RGB` starting at hashIdx (which must point at `#`).
 */
function parseHexAt(
  s: string,
  hashIdx: number,
  eof: boolean,
): { ok: true; rgb: RGB; end: number } | { ok: false; incomplete: boolean; end: number } {
  let p = hashIdx + 1;
  const start = p;
  while (p < s.length && isHex(s[p]!)) {
    p++;
  }
  const L = p - start;
  if (!eof && (L === 0 || (L > 0 && L < 3) || (L > 3 && L < 6))) {
    return { ok: false, incomplete: true, end: hashIdx };
  }
  if (L === 6) {
    const r = Number.parseInt(s.slice(start, start + 2), 16);
    const g = Number.parseInt(s.slice(start + 2, start + 4), 16);
    const b = Number.parseInt(s.slice(start + 4, start + 6), 16);
    return { ok: true, rgb: { r, g, b }, end: p };
  }
  if (L === 3) {
    const r = Number.parseInt(s[start]! + s[start]!, 16);
    const g = Number.parseInt(s[start + 1]! + s[start + 1]!, 16);
    const b = Number.parseInt(s[start + 2]! + s[start + 2]!, 16);
    return { ok: true, rgb: { r, g, b }, end: p };
  }
  return { ok: false, incomplete: false, end: p };
}

function skipRestOfLine(s: string, from: number): number {
  let j = from;
  while (j < s.length && s[j] !== '\n' && s[j] !== '\r') {
    j++;
  }
  while (j < s.length && (s[j] === '\n' || s[j] === '\r')) {
    j++;
  }
  return j;
}

/**
 * After y digits end at index i: optional whitespace, optional `,#hex` / `#hex`, then newlines.
 * Comma + digit at i means packed next pair — do not consume.
 */
function parseTailAfterY(s: string, i: number, eof: boolean): TailResult {
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    j++;
  }
  if (j >= s.length) {
    return { kind: 'ok', next: j, rgb: BLACK };
  }
  if (s[j] === ',' && j + 1 < s.length && isDigit(s[j + 1]!)) {
    return { kind: 'ok', next: j, rgb: BLACK };
  }

  let rgb = BLACK;

  if (s[j] === '#') {
    const h = parseHexAt(s, j, eof);
    if (h.ok === false && h.incomplete) {
      return { kind: 'incomplete' };
    }
    if (h.ok) {
      rgb = h.rgb;
      j = skipRestOfLine(s, h.end);
    } else {
      j = skipRestOfLine(s, j);
    }
  } else if (s[j] === ',' && j + 1 < s.length && s[j + 1] === '#') {
    const h = parseHexAt(s, j + 1, eof);
    if (h.ok === false && h.incomplete) {
      return { kind: 'incomplete' };
    }
    if (h.ok) {
      rgb = h.rgb;
      j = skipRestOfLine(s, h.end);
    } else {
      j = skipRestOfLine(s, j);
    }
  } else {
    while (j < s.length && (s[j] === '\n' || s[j] === '\r')) {
      j++;
    }
  }

  return { kind: 'ok', next: j, rgb };
}

/**
 * Incrementally scans a text stream for `x,y` plus optional `,#RRGGBB` / `#RGB` on the same line.
 * Comma-packed `x,y,x,y` is accepted (implicit black for each).
 */
export class XYScanner {
  private buffer = '';

  feed(chunk: string): Pixel[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  finalize(): Pixel[] {
    const out = this.drain(true);
    this.buffer = '';
    return out;
  }

  private drain(eof: boolean): Pixel[] {
    const pairs: Pixel[] = [];
    let i = 0;
    const s = this.buffer;

    while (true) {
      while (i < s.length && !isDigit(s[i]!)) {
        i++;
      }
      if (i >= s.length) {
        this.buffer = '';
        return pairs;
      }
      const xStart = i;
      while (i < s.length && isDigit(s[i]!)) {
        i++;
      }
      const xEnd = i;
      if (i >= s.length) {
        this.buffer = s.slice(xStart);
        return pairs;
      }
      if (s[i] !== ',') {
        i = xStart + 1;
        continue;
      }
      i++;
      const yStart = i;
      if (i >= s.length) {
        this.buffer = s.slice(xStart);
        return pairs;
      }
      while (i < s.length && isDigit(s[i]!)) {
        i++;
      }
      if (i === yStart) {
        this.buffer = s.slice(xStart);
        return pairs;
      }

      if (i < s.length) {
        const tail = parseTailAfterY(s, i, eof);
        if (tail.kind === 'incomplete') {
          this.buffer = s.slice(xStart);
          return pairs;
        }
        const x = Number(s.slice(xStart, xEnd));
        const y = Number(s.slice(yStart, i));
        pairs.push({ x, y, r: tail.rgb.r, g: tail.rgb.g, b: tail.rgb.b });
        i = tail.next;
        continue;
      }

      if (eof) {
        const x = Number(s.slice(xStart, xEnd));
        const y = Number(s.slice(yStart, i));
        pairs.push({ x, y, r: 0, g: 0, b: 0 });
        this.buffer = '';
        return pairs;
      }

      this.buffer = s.slice(xStart);
      return pairs;
    }
  }

  reset(): void {
    this.buffer = '';
  }
}

export function isPairInBounds(
  pair: XYPair,
  width: number,
  height: number,
): boolean {
  return (
    Number.isInteger(pair.x) &&
    Number.isInteger(pair.y) &&
    pair.x >= 0 &&
    pair.y >= 0 &&
    pair.x < width &&
    pair.y < height
  );
}

export function formatPixelLine(p: Pixel): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `${p.x},${p.y},#${h(p.r)}${h(p.g)}${h(p.b)}`;
}
