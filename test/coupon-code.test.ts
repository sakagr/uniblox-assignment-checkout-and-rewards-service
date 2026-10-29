import { describe, expect, it } from 'vitest';
import {
  COUPON_ALPHABET,
  COUPON_CODE_PATTERN,
  generateCouponCode,
  normalizeCouponCode,
} from '../src/domain/coupon-code.js';

describe('generateCouponCode', () => {
  const codes = Array.from({ length: 10_000 }, generateCouponCode);

  it('matches the DB CHECK pattern (12 Crockford base32 symbols)', () => {
    expect(codes.every((c) => COUPON_CODE_PATTERN.test(c))).toBe(true);
  });

  it('never repeats across 10k codes', () => {
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses every symbol of the alphabet and never I, L, O or U', () => {
    const seen = new Set(codes.join(''));
    expect(seen.size).toBe(32);
    expect([...seen].sort().join('')).toBe(COUPON_ALPHABET);
    for (const c of 'ILOU') expect(seen.has(c)).toBe(false);
  });
});

describe('normalizeCouponCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeCouponCode('  7kq2m9xhv3pa\n')).toBe('7KQ2M9XHV3PA');
  });
});
