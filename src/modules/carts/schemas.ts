import { Type } from '@fastify/type-provider-typebox';

export const CartParams = Type.Object({ cartId: Type.String({ format: 'uuid' }) });

// No `sku-` pattern: an unknown id should reach the database and answer 404, not 400.
export const ItemParams = Type.Object({
  cartId: Type.String({ format: 'uuid' }),
  productId: Type.String({ minLength: 1, maxLength: 200 }),
});

export const SetQuantityBody = Type.Object(
  { quantity: Type.Integer({ minimum: 0, maximum: 1000 }) },
  { additionalProperties: false },
);

const CartLine = Type.Object({
  productId: Type.String(),
  name: Type.String(),
  unitPricePaise: Type.Integer(),
  quantity: Type.Integer(),
  lineTotalPaise: Type.Integer(),
  availableStock: Type.Integer(),
  sufficientStock: Type.Boolean(),
});

// Nullable explicitly: fast-json-stringify turns null into "" for a plain string type.
export const CartView = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: Type.Union([Type.Literal('OPEN'), Type.Literal('CHECKED_OUT')]),
  version: Type.Integer(),
  orderId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  lines: Type.Array(CartLine),
  subtotalPaise: Type.Integer(),
  currency: Type.Literal('INR'),
});
