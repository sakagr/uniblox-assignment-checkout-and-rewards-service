import { randomBytes } from 'node:crypto';

/** Crockford base32: no I, L, O, U. Must match the CHECK on coupons.code. */
export const COUPON_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const COUPON_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** 12 symbols x 5 bits = 60 bits. 256 % 32 == 0, so `b & 31` has no modulo bias. */
export function generateCouponCode(): string {
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => COUPON_ALPHABET[b & 31]).join('');
}

export function normalizeCouponCode(input: string): string {
  return input.trim().toUpperCase();
}
