/** Error codes and statuses from SPECIFICATIONS §5.4. */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'CART_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'QUOTE_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'INSUFFICIENT_STOCK'
  | 'COUPON_ALREADY_REDEEMED'
  | 'QUOTE_STALE'
  | 'NO_ELIGIBLE_MILESTONE'
  | 'EMPTY_CART'
  | 'COUPON_INVALID'
  | 'TRANSIENT_CONFLICT'
  | 'INTERNAL_ERROR'
  // Not in §5.4; proposed spec addition.
  | 'ROUTE_NOT_FOUND';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly statusCode: number,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export interface StockShortfall {
  productId: string;
  requested: number;
  available: number;
}

export interface PriceChange {
  productId: string;
  quotedPaise: number;
  currentPaise: number;
}

export type QuoteStaleDetails =
  | { reason: 'CART_CHANGED' }
  | { reason: 'PRICE_CHANGED'; changes: PriceChange[] };

export interface NoEligibleMilestoneDetails {
  placedOrders: number;
  rewardedMilestones: number;
  nextMilestoneAtOrder: number;
}

export const Errors = {
  validation: (details: unknown, message = 'Request validation failed') =>
    new DomainError('VALIDATION_ERROR', 400, message, details),
  cartNotFound: () => new DomainError('CART_NOT_FOUND', 404, 'Cart not found'),
  productNotFound: () => new DomainError('PRODUCT_NOT_FOUND', 404, 'Product not found'),
  quoteNotFound: () => new DomainError('QUOTE_NOT_FOUND', 404, 'Quote not found for this cart'),
  orderNotFound: () => new DomainError('ORDER_NOT_FOUND', 404, 'Order not found'),
  cartAlreadyCheckedOut: () =>
    new DomainError('CART_ALREADY_CHECKED_OUT', 409, 'Cart has already been checked out'),
  insufficientStock: (shortfalls: StockShortfall[]) =>
    new DomainError('INSUFFICIENT_STOCK', 409, 'Not enough stock for one or more items', shortfalls),
  couponAlreadyRedeemed: () =>
    new DomainError('COUPON_ALREADY_REDEEMED', 409, 'Coupon has already been redeemed'),
  quoteStale: (details: QuoteStaleDetails) =>
    new DomainError(
      'QUOTE_STALE',
      409,
      details.reason === 'CART_CHANGED'
        ? 'Cart changed after the quote was created'
        : 'Prices changed after the quote was created',
      details,
    ),
  noEligibleMilestone: (details: NoEligibleMilestoneDetails) =>
    new DomainError('NO_ELIGIBLE_MILESTONE', 409, 'No milestone is waiting for a coupon', details),
  emptyCart: () => new DomainError('EMPTY_CART', 422, 'Cart has no items'),
  couponInvalid: () => new DomainError('COUPON_INVALID', 422, 'Coupon code does not exist'),
  transientConflict: () =>
    new DomainError('TRANSIENT_CONFLICT', 503, 'Temporary conflict, please retry'),
  internal: (details: unknown = null) =>
    new DomainError('INTERNAL_ERROR', 500, 'Internal server error', details),
  routeNotFound: (method: string, url: string) =>
    new DomainError('ROUTE_NOT_FOUND', 404, 'Route not found', { method, url }),
} as const;
