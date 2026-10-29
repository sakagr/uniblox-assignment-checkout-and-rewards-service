-- Seed data from SPECIFICATIONS.md §4, verbatim.

INSERT INTO products (id, name, unit_price_paise, stock) VALUES
  ('sku-tshirt',          'Cotton T-Shirt',         49900, 100),
  ('sku-mug',             'Ceramic Mug',            29900,  50),
  ('sku-notebook',        'A5 Notebook',            19900, 200),
  ('sku-hoodie',          'Fleece Hoodie',         149900,  25),
  ('sku-sticker-pack',    'Sticker Pack',            9900, 500),
  ('sku-limited-sneaker', 'Limited Edition Sneaker', 899900,  2);   -- limited inventory
