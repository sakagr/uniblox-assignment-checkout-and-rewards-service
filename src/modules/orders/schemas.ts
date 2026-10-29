import { Type } from '@fastify/type-provider-typebox';

export const OrderParams = Type.Object({ orderId: Type.String({ format: 'uuid' }) });

const OrderLine = Type.Object({
  productId: Type.String(),
  name: Type.String(),
  unitPricePaise: Type.Integer(),
  quantity: Type.Integer(),
  lineTotalPaise: Type.Integer(),
});

export const EarnedCoupon = Type.Object({
  code: Type.String(),
  percent: Type.Integer(),
  milestone: Type.Integer(),
});

// Nullable explicitly: fast-json-stringify turns null into "" for a plain string type.
export const Order = Type.Object({
  id: Type.String({ format: 'uuid' }),
  cartId: Type.String({ format: 'uuid' }),
  quoteId: Type.String({ format: 'uuid' }),
  placementNumber: Type.Integer(),
  lines: Type.Array(OrderLine),
  subtotalPaise: Type.Integer(),
  couponApplied: Type.Union([Type.Object({ code: Type.String(), percent: Type.Integer() }), Type.Null()]),
  discountPaise: Type.Integer(),
  totalPaise: Type.Integer(),
  earnedCoupon: Type.Union([EarnedCoupon, Type.Null()]),
  currency: Type.Literal('INR'),
  createdAt: Type.String({ format: 'date-time' }),
});
