-- Schema DDL from SPECIFICATIONS.md §3, verbatim, minus the outer
-- BEGIN/COMMIT: src/db/migrate.ts wraps this whole file (together with
-- its schema_migrations row) in its own transaction, so a COMMIT here
-- would break that atomicity.

-- ─────────────────────────────────────────────────────────────
-- Products
-- ─────────────────────────────────────────────────────────────
CREATE TABLE products (
  id                text        PRIMARY KEY CHECK (id ~ '^sku-[a-z0-9-]+$'),
  name              text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  unit_price_paise  bigint      NOT NULL CHECK (unit_price_paise > 0),
  stock             integer     NOT NULL CHECK (stock >= 0),                      -- I1
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────
-- Carts
-- ─────────────────────────────────────────────────────────────
CREATE TABLE carts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CHECKED_OUT')),
  version     integer     NOT NULL DEFAULT 0 CHECK (version >= 0),               -- I12: bumped on every real item change
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  cart_id     uuid        NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id  text        NOT NULL REFERENCES products(id),                      -- I11
  quantity    integer     NOT NULL CHECK (quantity BETWEEN 1 AND 1000),          -- I11
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, product_id)
);

-- ─────────────────────────────────────────────────────────────
-- Coupons (FKs to orders are added at the end: circular reference)
-- Crockford base32 alphabet: 0-9 A-H J K M N P-T V-Z (no I, L, O, U)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE coupons (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text        NOT NULL UNIQUE CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  percent             smallint    NOT NULL CHECK (percent BETWEEN 1 AND 100),    -- snapshot of x at generation
  milestone           integer     NOT NULL UNIQUE CHECK (milestone > 0),         -- I6: one coupon per milestone
  milestone_order_id  uuid        NOT NULL UNIQUE,                               -- order with placement_number = milestone * n
  source              text        NOT NULL CHECK (source IN ('AUTO', 'ADMIN')),
  redeemed_order_id   uuid        UNIQUE,                                        -- I5 backstop
  redeemed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupons_redeemed_fields_together CHECK ((redeemed_order_id IS NULL) = (redeemed_at IS NULL)),
  CONSTRAINT coupons_not_spent_by_earning_order CHECK (redeemed_order_id IS DISTINCT FROM milestone_order_id)  -- an order cannot spend the coupon it earned
);

-- ─────────────────────────────────────────────────────────────
-- Checkout quotes
-- ─────────────────────────────────────────────────────────────
CREATE TABLE checkout_quotes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id         uuid        NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  cart_version    integer     NOT NULL,
  coupon_id       uuid        REFERENCES coupons(id),
  coupon_percent  smallint    CHECK (coupon_percent BETWEEN 1 AND 100),
  subtotal_paise  bigint      NOT NULL CHECK (subtotal_paise > 0),
  discount_paise  bigint      NOT NULL CONSTRAINT checkout_quotes_discount_within_subtotal CHECK (discount_paise >= 0 AND discount_paise <= subtotal_paise),
  total_paise     bigint      NOT NULL CONSTRAINT checkout_quotes_total_consistent CHECK (total_paise = subtotal_paise - discount_paise),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_quotes_coupon_fields_together CHECK ((coupon_id IS NULL) = (coupon_percent IS NULL)),
  CONSTRAINT checkout_quotes_discount_requires_coupon CHECK (coupon_id IS NOT NULL OR discount_paise = 0),
  UNIQUE (id, cart_id)                                                           -- target for orders' composite FK
);
CREATE INDEX checkout_quotes_cart_idx ON checkout_quotes (cart_id);

CREATE TABLE quote_lines (
  quote_id          uuid    NOT NULL REFERENCES checkout_quotes(id) ON DELETE CASCADE,
  product_id        text    NOT NULL REFERENCES products(id),
  product_name      text    NOT NULL,
  unit_price_paise  bigint  NOT NULL CHECK (unit_price_paise > 0),
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  line_total_paise  bigint  NOT NULL CONSTRAINT quote_lines_line_total_consistent CHECK (line_total_paise = unit_price_paise * quantity),
  PRIMARY KEY (quote_id, product_id)
);

-- ─────────────────────────────────────────────────────────────
-- Orders (insert-only; I7)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                uuid        PRIMARY KEY,                                     -- generated by the app before coupon redeem
  cart_id           uuid        NOT NULL UNIQUE REFERENCES carts(id),            -- I3 / idempotency key
  quote_id          uuid        NOT NULL UNIQUE,
  placement_number  integer     NOT NULL UNIQUE CHECK (placement_number > 0),    -- I9
  subtotal_paise    bigint      NOT NULL CHECK (subtotal_paise > 0),
  coupon_code       text,                                                        -- snapshot, not FK (authority is coupons.redeemed_order_id)
  coupon_percent    smallint    CHECK (coupon_percent BETWEEN 1 AND 100),
  discount_paise    bigint      NOT NULL CONSTRAINT orders_discount_within_subtotal CHECK (discount_paise >= 0 AND discount_paise <= subtotal_paise),  -- I8
  total_paise       bigint      NOT NULL CONSTRAINT orders_total_consistent CHECK (total_paise = subtotal_paise - discount_paise),             -- I8
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_coupon_fields_together CHECK ((coupon_code IS NULL) = (coupon_percent IS NULL)),
  CONSTRAINT orders_discount_requires_coupon CHECK (coupon_code IS NOT NULL OR discount_paise = 0),
  FOREIGN KEY (quote_id, cart_id) REFERENCES checkout_quotes (id, cart_id)      -- the quote must belong to this cart
);

CREATE TABLE order_lines (
  order_id          uuid    NOT NULL REFERENCES orders(id),
  product_id        text    NOT NULL REFERENCES products(id),
  product_name      text    NOT NULL,                                            -- snapshot
  unit_price_paise  bigint  NOT NULL CHECK (unit_price_paise > 0),               -- snapshot
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  line_total_paise  bigint  NOT NULL CONSTRAINT order_lines_line_total_consistent CHECK (line_total_paise = unit_price_paise * quantity),  -- I8
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX order_lines_product_idx ON order_lines (product_id);

-- ─────────────────────────────────────────────────────────────
-- Placement counter (single row; I9)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE store_stats (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),                    -- enforces exactly one row
  placed_orders  integer NOT NULL DEFAULT 0 CHECK (placed_orders >= 0)
);
INSERT INTO store_stats DEFAULT VALUES;

-- ─────────────────────────────────────────────────────────────
-- Coupon → order FKs (added last to break the circular dependency)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE coupons
  ADD CONSTRAINT coupons_redeemed_order_fk
  FOREIGN KEY (redeemed_order_id) REFERENCES orders(id)
  DEFERRABLE INITIALLY DEFERRED;                                                 -- coupon is redeemed before the order row exists (D4)

ALTER TABLE coupons
  ADD CONSTRAINT coupons_milestone_order_fk
  FOREIGN KEY (milestone_order_id) REFERENCES orders(id);

