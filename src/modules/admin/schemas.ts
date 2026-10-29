import { Type } from '@fastify/type-provider-typebox';

// Nullable explicitly: fast-json-stringify turns null into "" for a plain string type.
export const Coupon = Type.Object({
  code: Type.String(),
  percent: Type.Integer(),
  milestone: Type.Integer(),
  milestoneOrderId: Type.String({ format: 'uuid' }),
  source: Type.Union([Type.Literal('AUTO'), Type.Literal('ADMIN')]),
  status: Type.Union([Type.Literal('AVAILABLE'), Type.Literal('REDEEMED')]),
  redeemedOrderId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  redeemedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const GenerateCouponResponse = Type.Object({
  coupon: Coupon,
  pendingMilestones: Type.Integer(),
});
