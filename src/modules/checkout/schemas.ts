import { Type } from '@fastify/type-provider-typebox';
import { CartLine } from '../carts/schemas.js';

// No code pattern: an unknown or malformed code reaches the database and answers 422, not 400.
export const QuoteBody = Type.Object(
  { couponCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) },
  { additionalProperties: false },
);

// A quote line has the same shape as a cart line (SPECIFICATIONS §5.2).
const QuoteLine = CartLine;

export const Quote = Type.Object({
  quoteId: Type.String({ format: 'uuid' }),
  cartId: Type.String({ format: 'uuid' }),
  cartVersion: Type.Integer(),
  lines: Type.Array(QuoteLine),
  subtotalPaise: Type.Integer(),
  couponApplied: Type.Union([
    Type.Object({ code: Type.String(), percent: Type.Integer() }),
    Type.Null(),
  ]),
  discountPaise: Type.Integer(),
  totalPaise: Type.Integer(),
  currency: Type.Literal('INR'),
  createdAt: Type.String({ format: 'date-time' }),
});
