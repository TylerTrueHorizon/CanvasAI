import { describe, expect, it } from 'vitest';
import { XYScanner, isPairInBounds } from './xyScanner.js';

const blk = { r: 0, g: 0, b: 0 };

describe('XYScanner', () => {
  it('parses x,y with optional ,#hex tail before newline', () => {
    const s = new XYScanner();
    expect(s.feed('0,0,#ff00aa\n1,1,#00ff00\n')).toEqual([
      { x: 0, y: 0, r: 0xff, g: 0x00, b: 0xaa },
      { x: 1, y: 1, r: 0x00, g: 0xff, b: 0x00 },
    ]);
    expect(s.finalize()).toEqual([]);
  });

  it('parses newline-separated pairs as black', () => {
    const s = new XYScanner();
    expect(s.feed('0,0\n10,20\n3,4\n')).toEqual([
      { x: 0, y: 0, ...blk },
      { x: 10, y: 20, ...blk },
      { x: 3, y: 4, ...blk },
    ]);
    expect(s.finalize()).toEqual([]);
  });

  it('parses consecutive pairs (finalize flushes tail)', () => {
    const s = new XYScanner();
    expect(s.feed('1,2,3,4')).toEqual([{ x: 1, y: 2, ...blk }]);
    expect(s.finalize()).toEqual([{ x: 3, y: 4, ...blk }]);
    expect(s.finalize()).toEqual([]);
  });

  it('allows arbitrary junk between pairs', () => {
    const s = new XYScanner();
    expect(s.feed('12,340 foo\n(bar) 1,2,,,  99,100')).toEqual([
      { x: 12, y: 340, ...blk },
      { x: 1, y: 2, ...blk },
    ]);
    expect(s.finalize()).toEqual([{ x: 99, y: 100, ...blk }]);
  });

  it('carries incomplete x,y across chunks', () => {
    const s = new XYScanner();
    expect(s.feed('12,3')).toEqual([]);
    expect(s.feed('40,1,0')).toEqual([{ x: 12, y: 340, ...blk }]);
    expect(s.finalize()).toEqual([{ x: 1, y: 0, ...blk }]);
  });

  it('carries incomplete pair after comma', () => {
    const s = new XYScanner();
    expect(s.feed('1,')).toEqual([]);
    expect(s.feed('2')).toEqual([]);
    expect(s.finalize()).toEqual([{ x: 1, y: 2, ...blk }]);
  });

  it('resets independently', () => {
    const s = new XYScanner();
    s.feed('5,5');
    s.reset();
    expect(s.feed('2,2\n')).toEqual([{ x: 2, y: 2, ...blk }]);
  });

  it('parses three-digit hex shorthand', () => {
    const s = new XYScanner();
    expect(s.feed('0,0,#f00\n')).toEqual([{ x: 0, y: 0, r: 0xff, g: 0, b: 0 }]);
  });
});

describe('isPairInBounds', () => {
  it('accepts corners', () => {
    expect(isPairInBounds({ x: 0, y: 0 }, 10, 10)).toBe(true);
    expect(isPairInBounds({ x: 9, y: 9 }, 10, 10)).toBe(true);
  });

  it('rejects OOB', () => {
    expect(isPairInBounds({ x: 10, y: 0 }, 10, 10)).toBe(false);
    expect(isPairInBounds({ x: 0, y: 10 }, 10, 10)).toBe(false);
    expect(isPairInBounds({ x: -1, y: 0 }, 10, 10)).toBe(false);
  });
});
