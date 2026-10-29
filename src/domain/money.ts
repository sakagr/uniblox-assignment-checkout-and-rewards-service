/**
 * All money is integer paise (DECISIONS §5). This module is the only place
 * money arithmetic happens.
 */

export type Paise = number & { readonly __brand: 'Paise' };

export function paise(n: number): Paise {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`invalid paise amount: ${n}`);
  }
  return n as Paise;
}

export interface PricedLine {
  unitPricePaise: Paise;
  quantity: number;
}

export interface Totals<L extends PricedLine> {
  lines: Array<L & { lineTotalPaise: Paise }>;
  subtotalPaise: Paise;
  discountPaise: Paise;
  totalPaise: Paise;
}

function safeProduct(a: number, b: number, what: string): number {
  const product = a * b;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`${what} overflows a safe integer`);
  }
  return product;
}

/**
 * lineTotal = unitPrice * quantity; subtotal = Σ lineTotal;
 * discount = floor(subtotal * percent / 100); total = subtotal - discount.
 * Floor plus percent <= 100 guarantees 0 <= discount <= subtotal (I8).
 */
export function calculateTotals<L extends PricedLine>(
  lines: readonly L[],
  percent: number | null,
): Totals<L> {
  if (percent !== null && (!Number.isInteger(percent) || percent < 1 || percent > 100)) {
    throw new RangeError(`invalid coupon percent: ${percent}`);
  }

  let subtotal = 0;
  const priced = lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 1000) {
      throw new RangeError(`invalid quantity: ${line.quantity}`);
    }
    const lineTotal = safeProduct(line.unitPricePaise, line.quantity, 'line total');
    subtotal += lineTotal;
    if (!Number.isSafeInteger(subtotal)) {
      throw new RangeError('subtotal overflows a safe integer');
    }
    return { ...line, lineTotalPaise: paise(lineTotal) };
  });

  const discount =
    percent === null ? 0 : Math.floor(safeProduct(subtotal, percent, 'discount base') / 100);

  return {
    lines: priced,
    subtotalPaise: paise(subtotal),
    discountPaise: paise(discount),
    totalPaise: paise(subtotal - discount),
  };
}

const rupeeFormat = new Intl.NumberFormat('en-IN');

/** "₹1,299.00". Rupees and paise are split with integer maths, never floats. */
export function formatInr(amount: Paise): string {
  const rupees = Math.floor(amount / 100);
  const remainder = amount % 100;
  return `₹${rupeeFormat.format(rupees)}.${String(remainder).padStart(2, '0')}`;
}
