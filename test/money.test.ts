import { describe, expect, it } from 'vitest';
import { calculateTotals, formatInr, paise } from '../src/domain/money.js';

const line = (price: number, quantity: number) => ({ unitPricePaise: paise(price), quantity });

describe('T1 calculateTotals', () => {
  const cases: Array<{
    name: string;
    lines: ReturnType<typeof line>[];
    percent: number | null;
    subtotal: number;
    discount: number;
    total: number;
  }> = [
    { name: 'no coupon', lines: [line(29900, 2)], percent: null, subtotal: 59800, discount: 0, total: 59800 },
    { name: '10%', lines: [line(29900, 2)], percent: 10, subtotal: 59800, discount: 5980, total: 53820 },
    { name: '100%', lines: [line(19900, 1)], percent: 100, subtotal: 19900, discount: 19900, total: 0 },
    { name: 'floor rounding', lines: [line(999, 1)], percent: 10, subtotal: 999, discount: 99, total: 900 },
    {
      name: 'several lines',
      lines: [line(49900, 1), line(9900, 3), line(899900, 2)],
      percent: 15,
      subtotal: 1879400,
      discount: 281910,
      total: 1597490,
    },
  ];

  it.each(cases)('$name', ({ lines, percent, subtotal, discount, total }) => {
    const result = calculateTotals(lines, percent);
    expect(result.subtotalPaise).toBe(subtotal);
    expect(result.discountPaise).toBe(discount);
    expect(result.totalPaise).toBe(total);
    expect(result.lines.map((l) => l.lineTotalPaise)).toEqual(
      lines.map((l) => l.unitPricePaise * l.quantity),
    );
  });

  it('keeps extra fields on lines', () => {
    const [first] = calculateTotals([{ ...line(100, 1), productId: 'sku-x' }], null).lines;
    expect(first?.productId).toBe('sku-x');
  });

  it('rejects invalid quantity', () => {
    for (const q of [0, 1001, 1.5, -1]) {
      expect(() => calculateTotals([line(100, q)], null)).toThrow(RangeError);
    }
  });

  it('rejects invalid percent', () => {
    for (const p of [0, 101, 1.5, -5]) {
      expect(() => calculateTotals([line(100, 1)], p)).toThrow(RangeError);
    }
  });

  it('rejects overflow past the safe-integer range', () => {
    expect(() => calculateTotals([line(Number.MAX_SAFE_INTEGER, 2)], null)).toThrow(/overflows/);
    expect(() => calculateTotals([line(2 ** 52, 1)], 100)).toThrow(/overflows/);
  });
});

describe('paise()', () => {
  it('accepts non-negative safe integers', () => {
    expect(paise(0)).toBe(0);
    expect(paise(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([-1, 1.5, 2 ** 53, NaN, Infinity])('rejects %s', (n) => {
    expect(() => paise(n)).toThrow(RangeError);
  });
});

describe('formatInr', () => {
  it.each([
    [0, '₹0.00'],
    [5, '₹0.05'],
    [129900, '₹1,299.00'],
    [12345678905, '₹12,34,56,789.05'],
  ])('%i -> %s', (amount, expected) => {
    expect(formatInr(paise(amount))).toBe(expected);
  });
});
