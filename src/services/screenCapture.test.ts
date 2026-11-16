import { describe, expect, it } from 'vitest';
import { KWIN_GAMMA_INVERSE } from './screenCapture';

describe('KWIN_GAMMA_INVERSE', () => {
  it('undoes the KWin screencast curve measured on Plasma 6.8', () => {
    // [captured, sent] from a pattern of known greys captured through the portal
    const measured = [
      [0, 0],
      [24, 17],
      [40, 34],
      [54, 51],
      [70, 68],
      [86, 85],
      [102, 102],
      [153, 153],
      [202, 204],
      [255, 255],
    ];
    for (const [captured, sent] of measured) expect(Math.abs(KWIN_GAMMA_INVERSE[captured] - sent)).toBeLessThanOrEqual(2);
  });
});
