-- GENERATED FILE - do not edit by hand.
-- Source: pos_db.html (BCNF design)
-- Regenerate: npm run db:plan
--
-- Postgres port of the MariaDB design. See tools/ddl.ts for the type mapping rationale.

create extension if not exists pgcrypto;

-- Enum types (one per ENUM column, preserving the MariaDB CHECK semantics).
create type products_kind_enum as enum ('raw_material', 'packaging', 'finished', 'trade', 'fee');
create type products_sale_mode_enum as enum ('unit', 'weighted');
create type product_costs_cost_basis_enum as enum ('purchase', 'production', 'manual');
create type product_barcodes_barcode_type_enum as enum ('ean13', 'code128', 'internal');
create type stock_move_types_direction_enum as enum ('in', 'out', 'either', 'qty_change');
create type batch_allocations_allocation_type_enum as enum ('sale', 'writeoff', 'transfer');
create type stock_takes_status_enum as enum ('open', 'counting', 'posted', 'cancelled');
create type stock_takes_scope_enum as enum ('full', 'category', 'cycle');
create type sales_status_enum as enum ('completed', 'partially_refunded', 'refunded', 'voided');
create type sales_sync_status_enum as enum ('pending', 'synced', 'failed', 'conflict');
create type sale_items_kind_enum as enum ('item', 'bottle_fee');
create type sale_items_status_enum as enum ('active', 'voided');
create type refund_lines_condition_enum as enum ('resellable', 'damaged', 'expired');
create type cash_movements_movement_type_enum as enum ('float_in', 'cash_in', 'cash_out', 'bank_drop', 'petty_cash', 'refund_payout');
create type customer_credit_entries_entry_type_enum as enum ('invoice', 'settlement', 'adjustment', 'write_off');
create type purchase_orders_status_enum as enum ('draft', 'sent', 'partial', 'received', 'cancelled');
create type production_runs_status_enum as enum ('draft', 'drying', 'grinding', 'packing', 'closed', 'cancelled');
create type production_inputs_stage_enum as enum ('raw', 'packaging');
create type notification_types_severity_enum as enum ('info', 'warning', 'critical');
create type monthly_summaries_status_enum as enum ('draft', 'posted', 'locked');

-- 1. stores (category A)
-- One row per branch. Root of every tenant-scoped relation.
create table if not exists "stores" (
  "store_id" uuid not null primary key default gen_random_uuid(),
  "code" varchar(16),
  "name" varchar(120),
  "legal_name" varchar(160),
  "vat_no" varchar(32),
  "address_line1" varchar(160),
  "address_line2" varchar(160),
  "city" varchar(64),
  "postal_code" varchar(16),
  "phone" varchar(32),
  "currency_code" char(3),
  "timezone" varchar(64),
  "prices_include_tax" boolean,
  "is_active" boolean,
  "created_at" timestamptz,
  "updated_at" timestamptz
);
create unique index if not exists "stores_code_uq" on "stores" ("code");
create index if not exists "stores_is_active_ix" on "stores" ("is_active");

-- 3. roles (category A)
-- A role is a named bundle of permissions. Replaces the fixed user_role enum, which could not express "supervisor at branch 1, cashier at branch 2".
create table if not exists "roles" (
  "role_id" smallint not null primary key check ("role_id" >= 0),
  "code" varchar(32),
  "name" varchar(64),
  "rank" smallint
);
create unique index if not exists "roles_code_uq" on "roles" ("code");

-- 4. permissions (category A)
-- The catalogue of actions that can be granted. Any action that appears in an approval dialog or an audit row must exist here, so the set of privileged operations is enumerable rather than scattered in code.
create table if not exists "permissions" (
  "permission_id" smallint not null primary key check ("permission_id" >= 0),
  "code" varchar(64),
  "description" varchar(190)
);
create unique index if not exists "permissions_code_uq" on "permissions" ("code");

-- 14. weight_labels (category B)
-- Removes the label → weight_g dependency. "250 g" is a presentation of 250 grams and now exists exactly once, so two pack sizes can never disagree about what a 250 g packet is.
create table if not exists "weight_labels" (
  "weight_g" integer not null primary key,
  "label" varchar(16),
  "sort_order" smallint
);
create unique index if not exists "weight_labels_label_uq" on "weight_labels" ("label");

-- 18. stock_move_types (category C)
-- Lookup for movement kinds. Replaces the stock_move_type enum so a new reason can be added without a schema migration, and lets each type declare its effect on stock as data.
create table if not exists "stock_move_types" (
  "move_type_id" smallint not null primary key check ("move_type_id" >= 0),
  "code" varchar(32),
  "direction" stock_move_types_direction_enum,
  "affects_cost" boolean
);
create unique index if not exists "stock_move_types_code_uq" on "stock_move_types" ("code");

-- 24. payment_methods (category D)
-- Lookup replacing the pay_method enum, with the attributes the till actually needs: whether a reference is mandatory, whether it settles immediately, and whether it may be used offline.
create table if not exists "payment_methods" (
  "method_id" smallint not null primary key check ("method_id" >= 0),
  "code" varchar(16),
  "name" varchar(48),
  "requires_reference" boolean,
  "settles_immediately" boolean
);
create unique index if not exists "payment_methods_code_uq" on "payment_methods" ("code");

-- 35. bottle_event_types (category G)
-- Lookup for ledger event kinds, replacing the bottle_event enum. delta_full and delta_empty let a reporting view compute bottle counts without hardcoding event names in SQL.
create table if not exists "bottle_event_types" (
  "event_type_id" smallint not null primary key check ("event_type_id" >= 0),
  "code" varchar(32),
  "delta_full" smallint,
  "delta_empty" smallint
);
create unique index if not exists "bottle_event_types_code_uq" on "bottle_event_types" ("code");

-- 37. suppliers (category H)
-- Who goods are bought from. A supplier can serve several branches, so the relationship is store-scoped through the purchase orders rather than baked into the supplier row.
create table if not exists "suppliers" (
  "supplier_id" uuid not null primary key default gen_random_uuid(),
  "code" varchar(24),
  "name" varchar(120),
  "contact_name" varchar(120),
  "phone" varchar(32),
  "email" varchar(190),
  "vat_no" varchar(32),
  "payment_terms_days" smallint,
  "default_lead_time_days" smallint,
  "is_active" boolean,
  "created_at" timestamptz
);
create unique index if not exists "suppliers_code_uq" on "suppliers" ("code");
create index if not exists "suppliers_name_ix" on "suppliers" ("name");

-- 47. notification_types (category J)
-- Lookup for alert kinds, replacing the notification_type enum and pairing each type with the message template the app renders.
create table if not exists "notification_types" (
  "notification_type_id" smallint not null primary key check ("notification_type_id" >= 0),
  "code" varchar(32),
  "severity" notification_types_severity_enum,
  "template" varchar(255)
);
create unique index if not exists "notification_types_code_uq" on "notification_types" ("code");

-- 2. store_settings (category A)
-- Typed 1:1 replacement for the settings key/value table. Every knob is a real column with a CHECK, so a bad value is rejected instead of being accepted as a valid JSON string.
create table if not exists "store_settings" (
  "store_id" uuid not null primary key references "stores"("store_id"),
  "max_cashier_discount_bp" integer,
  "bottle_fee_cents" bigint,
  "pack_low_stock_qty" numeric(12,3),
  "allow_sell_out_of_stock" boolean default true,
  "offline_max_hours" smallint,
  "rounding_step_cents" integer,
  "custom_weight_enabled" boolean,
  "receipt_footer" varchar(255),
  "loyalty_enabled" boolean,
  "updated_at" timestamptz
);

-- 5. role_permissions (category A)
-- Junction resolving the many-to-many between roles and permissions. The optional ceiling lives here because it is a fact about the pair, not about the role or the permission alone.
create table if not exists "role_permissions" (
  "role_id" smallint references "roles"("role_id") check ("role_id" >= 0),
  "permission_id" smallint references "permissions"("permission_id") check ("permission_id" >= 0),
  "limit_cents" bigint,
  primary key ("role_id", "permission_id")
);

-- 6. staff (category A)
-- A human being. Holds person-only facts; deliberately no store, role, staff code or PIN. Note what is absent: staff_code moved to store_memberships, because the code 3 is scoped to a branch, not to a person.
create table if not exists "staff" (
  "staff_id" uuid not null primary key default gen_random_uuid(),
  "full_name" varchar(120),
  "email" varchar(190),
  "phone" varchar(32),
  "default_store_id" uuid references "stores"("store_id"),
  "hired_on" date,
  "is_active" boolean,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "created_by_staff_id" uuid references "staff"("staff_id")
);
create unique index if not exists "staff_email_uq" on "staff" ("email");
create index if not exists "staff_full_name_ix" on "staff" ("full_name");
create index if not exists "staff_is_active_ix" on "staff" ("is_active");

-- 9. devices (category A)
-- A till, separate from the person using it. Needed for per-device receipt series, per-device offline limits, and a sync queue that can be audited per terminal.
create table if not exists "devices" (
  "device_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "device_code" varchar(16),
  "name" varchar(64),
  "api_key_hash" varchar(255),
  "receipt_prefix" varchar(8),
  "last_seen_at" timestamptz,
  "last_sync_at" timestamptz,
  "is_active" boolean,
  "created_at" timestamptz
);
create unique index if not exists "devices_device_code_uq" on "devices" ("device_code");
create index if not exists "devices_store_id_ix" on "devices" ("store_id");
create index if not exists "devices_is_active_ix" on "devices" ("is_active");

-- 10. categories (category B)
-- Product grouping for the picture grid tabs. Self-referencing to allow a parent category.
create table if not exists "categories" (
  "category_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "name" varchar(64),
  "parent_category_id" uuid references "categories"("category_id"),
  "sort_order" smallint,
  "color" varchar(16),
  "is_active" boolean
);
create unique index if not exists "categories_name_uq" on "categories" ("name");
create index if not exists "categories_store_id_ix" on "categories" ("store_id");

-- 11. tax_classes (category B)
-- The VAT rate as a fact about the class, held once. A rate change is one UPDATE here, not a sweep over every product â€” which is what caused the update anomaly in the current schema.
create table if not exists "tax_classes" (
  "tax_class_id" smallint not null primary key check ("tax_class_id" >= 0),
  "store_id" uuid references "stores"("store_id"),
  "code" varchar(32),
  "name" varchar(64),
  "rate_bp" integer,
  "is_inclusive" boolean
);
create unique index if not exists "tax_classes_code_uq" on "tax_classes" ("code");

-- 33. customers (category F)
-- Optional record attached to a sale; walk-in customers have none. A credit limit is only meaningful with a customer, so it lives here rather than on the sale.
create table if not exists "customers" (
  "customer_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "code" varchar(24),
  "name" varchar(120),
  "phone" varchar(32),
  "email" varchar(190),
  "address" varchar(255),
  "credit_limit_cents" bigint,
  "credit_terms_days" smallint,
  "is_blocked" boolean,
  "notes" varchar(255),
  "created_at" timestamptz
);
create unique index if not exists "customers_code_uq" on "customers" ("code");
create index if not exists "customers_store_id_ix" on "customers" ("store_id");
create index if not exists "customers_name_ix" on "customers" ("name");
create index if not exists "customers_phone_ix" on "customers" ("phone");

-- 50. monthly_summaries (category K)
-- The month-end document: sales, VAT collected against input VAT paid, production cost and bottle fees, in one row the owner can export. Immutable once posted, because it is the basis of a tax filing.
create table if not exists "monthly_summaries" (
  "summary_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "period_year" smallint,
  "period_month" smallint,
  "status" monthly_summaries_status_enum,
  "gross_sales_cents" bigint,
  "discounts_cents" bigint,
  "refunds_cents" bigint,
  "net_sales_cents" bigint,
  "output_vat_cents" bigint,
  "input_vat_cents" bigint,
  "vat_payable_cents" bigint,
  "cogs_cents" bigint,
  "gross_profit_cents" bigint,
  "bottle_fees_cents" bigint,
  "generated_at" timestamptz
);
create unique index if not exists "monthly_summaries_store_id_uq" on "monthly_summaries" ("store_id");
create unique index if not exists "monthly_summaries_period_year_uq" on "monthly_summaries" ("period_year");
create unique index if not exists "monthly_summaries_period_month_uq" on "monthly_summaries" ("period_month");
create index if not exists "monthly_summaries_status_ix" on "monthly_summaries" ("status");

-- 7. staff_credentials (category A)
-- Secrets, isolated so GRANT SELECT (â€¦) can exclude this table from every role the app uses. This is the column-level replacement for Postgres's per-column grants.
create table if not exists "staff_credentials" (
  "staff_id" uuid not null primary key references "staff"("staff_id"),
  "pin_hash" varchar(255),
  "badge_hash" varchar(255),
  "failed_attempts" smallint,
  "locked_until" timestamptz,
  "must_change_pin" boolean,
  "pin_updated_at" timestamptz
);
create index if not exists "staff_credentials_locked_until_ix" on "staff_credentials" ("locked_until");

-- 8. store_memberships (category A)
-- This table is the fix for the single-store ceiling. A person may hold several memberships, one per branch, each with its own staff code and role. The current profiles.auth_user_id UNIQUE makes this impossible.
create table if not exists "store_memberships" (
  "store_id" uuid references "stores"("store_id"),
  "staff_id" uuid references "staff"("staff_id"),
  "staff_code" varchar(16),
  "role_id" smallint references "roles"("role_id") check ("role_id" >= 0),
  "is_active" boolean,
  "joined_on" date,
  "created_at" timestamptz,
  "created_by_staff_id" uuid references "staff"("staff_id"),
  primary key ("store_id", "staff_id")
);
create unique index if not exists "store_memberships_staff_code_uq" on "store_memberships" ("staff_code");
create index if not exists "store_memberships_is_active_ix" on "store_memberships" ("is_active");

-- 12. products (category B)
-- The catalogue entry. No stock_on_hand (derived from the ledger), and no tax_rate_pct (referenced from tax_classes). price_cents applies only when sale_mode = 'unit'; weighted products price per pack size.
create table if not exists "products" (
  "product_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "sku" varchar(64),
  "name" varchar(190),
  "category_id" uuid references "categories"("category_id"),
  "tax_class_id" smallint references "tax_classes"("tax_class_id") check ("tax_class_id" >= 0),
  "kind" products_kind_enum,
  "sale_mode" products_sale_mode_enum,
  "price_cents" bigint,
  "price_per_kg_cents" bigint,
  "is_returnable_bottle" boolean,
  "has_expiry" boolean,
  "shelf_life_days" smallint,
  "reorder_level" numeric(12,3),
  "lead_time_days" smallint,
  "is_favourite" boolean,
  "color" varchar(16),
  "image_path" varchar(255),
  "is_active" boolean,
  "archived_at" timestamptz,
  "archived_by_id" uuid,
  "created_at" timestamptz,
  "updated_at" timestamptz
);
create unique index if not exists "products_store_id_uq" on "products" ("store_id");
create unique index if not exists "products_sku_uq" on "products" ("sku");
create index if not exists "products_name_ix" on "products" ("name");
create index if not exists "products_is_favourite_ix" on "products" ("is_favourite");

-- 22. stock_takes (category C)
-- A physical count session. The ledger guard forbids editing stock directly, so a count must be a document that produces adjustment movements â€” otherwise there is no explanation for a variance.
create table if not exists "stock_takes" (
  "stock_take_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "reference" varchar(32),
  "status" stock_takes_status_enum,
  "scope" stock_takes_scope_enum,
  "started_by_staff_id" uuid references "staff"("staff_id"),
  "posted_by_staff_id" uuid references "staff"("staff_id"),
  "started_at" timestamptz,
  "posted_at" timestamptz,
  "notes" varchar(255)
);
create unique index if not exists "stock_takes_reference_uq" on "stock_takes" ("reference");
create index if not exists "stock_takes_store_id_ix" on "stock_takes" ("store_id");
create index if not exists "stock_takes_status_ix" on "stock_takes" ("status");

-- 30. shifts (category E)
-- A cashier's session on one till, from opening float to counted close. The variance columns are generated, so the reported shortage is always the arithmetic of its own inputs.
create table if not exists "shifts" (
  "shift_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "device_id" uuid references "devices"("device_id"),
  "cashier_staff_id" uuid references "staff"("staff_id"),
  "shift_no" integer,
  "opened_at" timestamptz,
  "closed_at" timestamptz,
  "is_open" smallint,
  "opening_float_cents" bigint,
  "cash_sales_cents" bigint,
  "cash_refunds_cents" bigint,
  "expected_cash_cents" bigint,
  "counted_cash_cents" bigint,
  "variance_cents" bigint,
  "opened_by_staff_id" uuid references "staff"("staff_id"),
  "closed_by_staff_id" uuid references "staff"("staff_id"),
  "notes" varchar(255)
);
create unique index if not exists "shifts_shift_no_uq" on "shifts" ("shift_no");
create index if not exists "shifts_store_id_ix" on "shifts" ("store_id");
create index if not exists "shifts_cashier_staff_id_ix" on "shifts" ("cashier_staff_id");
create index if not exists "shifts_is_open_ix" on "shifts" ("is_open");

-- 32. receipt_sequences (category E)
-- Gapless per-device receipt numbering, replacing the single global receipt_no_seq. A gapless series per terminal is what a VAT inspector expects, and it makes two branches' numbering independent. Allocation happens inside the sale transaction under SELECT … FOR UPDATE.
create table if not exists "receipt_sequences" (
  "device_id" uuid not null primary key references "devices"("device_id"),
  "series_code" varchar(8),
  "next_value" bigint check ("next_value" >= 0),
  "last_issued_at" timestamptz,
  "is_exhausted" boolean
);
create unique index if not exists "receipt_sequences_series_code_uq" on "receipt_sequences" ("series_code");

-- 38. purchase_orders (category H)
-- A commitment to buy. Status is a lifecycle, and expected_on supports both recurring schedules and ad-hoc orders â€” the mix the shop actually uses.
create table if not exists "purchase_orders" (
  "purchase_order_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "supplier_id" uuid references "suppliers"("supplier_id"),
  "po_no" varchar(24),
  "status" purchase_orders_status_enum,
  "ordered_on" timestamptz,
  "expected_on" date,
  "is_recurring" boolean,
  "recurrence_rule" varchar(64),
  "subtotal_cents" bigint,
  "tax_cents" bigint,
  "total_cents" bigint,
  "created_by_staff_id" uuid references "staff"("staff_id"),
  "notes" varchar(255),
  "created_at" timestamptz
);
create unique index if not exists "purchase_orders_po_no_uq" on "purchase_orders" ("po_no");
create index if not exists "purchase_orders_store_id_ix" on "purchase_orders" ("store_id");
create index if not exists "purchase_orders_supplier_id_ix" on "purchase_orders" ("supplier_id");
create index if not exists "purchase_orders_status_ix" on "purchase_orders" ("status");
create index if not exists "purchase_orders_expected_on_ix" on "purchase_orders" ("expected_on");

-- 45. approvals (category J)
-- A one-shot proof that a supervisor authorised a specific action. action_code now references permissions, so an approval cannot be minted for an action the system does not know about.
create table if not exists "approvals" (
  "approval_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "permission_id" smallint references "permissions"("permission_id") check ("permission_id" >= 0),
  "approver_staff_id" uuid references "staff"("staff_id"),
  "requested_by_staff_id" uuid references "staff"("staff_id"),
  "device_id" uuid references "devices"("device_id"),
  "subject_id" uuid,
  "expires_at" timestamptz,
  "used_at" timestamptz,
  "created_at" timestamptz
);
create index if not exists "approvals_store_id_ix" on "approvals" ("store_id");
create index if not exists "approvals_expires_at_ix" on "approvals" ("expires_at");

-- 46. audit_log (category J)
-- Append-only, immutable. before_state and after_state are JSON for opaque snapshots only; anything queried is a real column. Written by every privileged procedure.
create table if not exists "audit_log" (
  "audit_id" bigint not null primary key check ("audit_id" >= 0),
  "store_id" uuid references "stores"("store_id"),
  "action_code" varchar(64),
  "entity_table" varchar(32),
  "entity_id" uuid,
  "requested_by_staff_id" uuid references "staff"("staff_id"),
  "approved_by_staff_id" uuid references "staff"("staff_id"),
  "device_id" uuid references "devices"("device_id"),
  "reason" varchar(190),
  "before_state" jsonb,
  "after_state" jsonb,
  "created_at" timestamptz
);
create index if not exists "audit_log_store_id_ix" on "audit_log" ("store_id");
create index if not exists "audit_log_action_code_ix" on "audit_log" ("action_code");
create index if not exists "audit_log_entity_id_ix" on "audit_log" ("entity_id");
create index if not exists "audit_log_created_at_ix" on "audit_log" ("created_at");

-- 13. product_costs (category B)
-- Cost separated from price so GRANT can deny it to every till-facing database role. store_id is dropped: it was transitively determined by product_id.
create table if not exists "product_costs" (
  "product_id" uuid not null primary key references "products"("product_id"),
  "cost_cents" bigint,
  "cost_basis" product_costs_cost_basis_enum,
  "updated_at" timestamptz
);

-- 15. pack_sizes (category B)
-- One sellable packet size. Each is its own stock and its own price, which is why a 50 g and a 1 kg packet of the same spice are separate rows. label and packets_on_hand are gone.
create table if not exists "pack_sizes" (
  "pack_size_id" uuid not null primary key default gen_random_uuid(),
  "product_id" uuid references "products"("product_id"),
  "weight_g" integer references "weight_labels"("weight_g"),
  "price_cents" bigint,
  "packaging_product_id" uuid references "products"("product_id"),
  "reorder_level" numeric(12,3),
  "sort_order" smallint,
  "is_active" boolean
);
create unique index if not exists "pack_sizes_product_id_uq" on "pack_sizes" ("product_id");

-- 25. sales (category D)
-- One completed bill. The primary key is the client-generated UUID, which is what makes offline sync idempotent: a retried upload hits a duplicate key instead of double-counting.
create table if not exists "sales" (
  "sale_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "device_id" uuid references "devices"("device_id"),
  "shift_id" uuid references "shifts"("shift_id"),
  "receipt_no" bigint check ("receipt_no" >= 0),
  "local_receipt_no" bigint check ("local_receipt_no" >= 0),
  "cashier_staff_id" uuid references "staff"("staff_id"),
  "customer_id" uuid references "customers"("customer_id"),
  "status" sales_status_enum,
  "subtotal_cents" bigint,
  "discount_cents" bigint,
  "total_cents" bigint,
  "tax_included_cents" bigint,
  "bottles_returned" integer,
  "bottle_fee_cents" bigint,
  "rounding_cents" integer,
  "created_at" timestamptz,
  "received_at" timestamptz,
  "void_reason" varchar(190),
  "voided_by_staff_id" uuid,
  "sync_status" sales_sync_status_enum,
  "sync_error" varchar(255)
);
create unique index if not exists "sales_receipt_no_uq" on "sales" ("receipt_no");
create index if not exists "sales_store_id_ix" on "sales" ("store_id");
create index if not exists "sales_shift_id_ix" on "sales" ("shift_id");
create index if not exists "sales_cashier_staff_id_ix" on "sales" ("cashier_staff_id");
create index if not exists "sales_status_ix" on "sales" ("status");
create index if not exists "sales_created_at_ix" on "sales" ("created_at");

-- 31. cash_movements (category E)
-- Every non-sale change to the drawer: float top-ups, bank drops, petty cash, refund pay-outs. Keeping these separate from payments is what makes the shift variance explainable line by line.
create table if not exists "cash_movements" (
  "cash_movement_id" bigint not null primary key check ("cash_movement_id" >= 0),
  "shift_id" uuid references "shifts"("shift_id"),
  "store_id" uuid references "stores"("store_id"),
  "movement_type" cash_movements_movement_type_enum,
  "amount_cents" bigint,
  "reason" varchar(190),
  "created_by_staff_id" uuid references "staff"("staff_id"),
  "created_at" timestamptz
);
create index if not exists "cash_movements_shift_id_ix" on "cash_movements" ("shift_id");

-- 40. goods_receipts (category H)
-- What actually arrived, which is rarely exactly what was ordered. Receiving is where batches are born and where input VAT is captured.
create table if not exists "goods_receipts" (
  "goods_receipt_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "purchase_order_id" uuid references "purchase_orders"("purchase_order_id"),
  "supplier_invoice_no" varchar(64),
  "received_on" date,
  "subtotal_cents" bigint,
  "input_vat_cents" bigint,
  "total_cents" bigint,
  "received_by_staff_id" uuid references "staff"("staff_id"),
  "notes" varchar(255),
  "created_at" timestamptz
);
create unique index if not exists "goods_receipts_supplier_invoice_no_uq" on "goods_receipts" ("supplier_invoice_no");
create index if not exists "goods_receipts_store_id_ix" on "goods_receipts" ("store_id");
create index if not exists "goods_receipts_purchase_order_id_ix" on "goods_receipts" ("purchase_order_id");
create index if not exists "goods_receipts_received_on_ix" on "goods_receipts" ("received_on");

-- 42. production_runs (category I)
-- One batch of manufacturing, closed as a single transaction. Yield is generated from the recorded raw-in and finished-out weights, so the loss figure cannot be typed in by hand.
create table if not exists "production_runs" (
  "production_run_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "run_no" varchar(24),
  "product_id" uuid references "products"("product_id"),
  "status" production_runs_status_enum,
  "started_on" date,
  "closed_on" date,
  "raw_issued_kg" numeric(12,3),
  "finished_kg" numeric(12,3),
  "yield_pct" numeric(6,2),
  "extra_cost_cents" bigint,
  "closed_by_staff_id" uuid references "staff"("staff_id"),
  "batch_no" varchar(64),
  "notes" varchar(255),
  "created_at" timestamptz
);
create unique index if not exists "production_runs_run_no_uq" on "production_runs" ("run_no");
create index if not exists "production_runs_store_id_ix" on "production_runs" ("store_id");
create index if not exists "production_runs_status_ix" on "production_runs" ("status");

-- 16. product_barcodes (category B)
-- A product or a pack size can carry several barcodes. store_id is dropped; global uniqueness is kept instead, with internal codes drawn from a reserved prefix so two branches cannot collide.
create table if not exists "product_barcodes" (
  "barcode_id" uuid not null primary key default gen_random_uuid(),
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "barcode" varchar(64),
  "barcode_type" product_barcodes_barcode_type_enum,
  "is_primary" boolean
);
create unique index if not exists "product_barcodes_barcode_uq" on "product_barcodes" ("barcode");

-- 17. product_price_history (category B)
-- Append-only price trail for the audit screen and margin analysis. A product-level change has pack_size_id NULL; a pack change sets it.
create table if not exists "product_price_history" (
  "price_change_id" bigint not null primary key check ("price_change_id" >= 0),
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "old_price_cents" bigint,
  "new_price_cents" bigint,
  "reason" varchar(190),
  "changed_by_staff_id" uuid references "staff"("staff_id"),
  "changed_at" timestamptz
);
create index if not exists "product_price_history_product_id_ix" on "product_price_history" ("product_id");

-- 26. sale_items (category D)
-- One bill line, including struck-through voided portions â€” nothing is deleted, because a void is an event that must remain visible. line_total_cents and tax_cents are generated, so they cannot contradict qty &times; unit_price.
create table if not exists "sale_items" (
  "sale_item_id" uuid not null primary key default gen_random_uuid(),
  "sale_id" uuid references "sales"("sale_id"),
  "line_no" smallint check ("line_no" >= 0),
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "kind" sale_items_kind_enum,
  "name_snapshot" varchar(190),
  "label_snapshot" varchar(32),
  "qty" numeric(12,3),
  "unit_price_cents" bigint,
  "line_total_cents" bigint,
  "tax_class_id" smallint references "tax_classes"("tax_class_id") check ("tax_class_id" >= 0),
  "tax_rate_bp" integer,
  "tax_cents" bigint,
  "status" sale_items_status_enum,
  "void_reason" varchar(190),
  "voided_by_name" varchar(120),
  "voided_at" timestamptz,
  "discount_cents" bigint
);
create unique index if not exists "sale_items_line_no_uq" on "sale_items" ("line_no");
create index if not exists "sale_items_sale_id_ix" on "sale_items" ("sale_id");
create index if not exists "sale_items_product_id_ix" on "sale_items" ("product_id");

-- 27. payments (category D)
-- One tender against a sale. Split payments are multiple rows, which is why the amount cannot live on sales. Negative amounts are rejected so a refund cannot be smuggled in as a payment.
create table if not exists "payments" (
  "payment_id" uuid not null primary key default gen_random_uuid(),
  "sale_id" uuid references "sales"("sale_id"),
  "method_id" smallint references "payment_methods"("method_id") check ("method_id" >= 0),
  "amount_cents" bigint,
  "tendered_cents" bigint,
  "change_cents" bigint,
  "reference" varchar(64),
  "received_at" timestamptz,
  "shift_id" uuid references "shifts"("shift_id")
);
create index if not exists "payments_sale_id_ix" on "payments" ("sale_id");

-- 28. refunds (category D)
-- Reversal of a paid sale. A refund is its own document, never a mutation of the original, so the audit trail stays intact and the original invoice remains valid evidence.
create table if not exists "refunds" (
  "refund_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "sale_id" uuid references "sales"("sale_id"),
  "shift_id" uuid references "shifts"("shift_id"),
  "refund_no" bigint check ("refund_no" >= 0),
  "reason_code" varchar(32),
  "amount_cents" bigint,
  "tax_refunded_cents" bigint,
  "restock" boolean,
  "approved_by_staff_id" uuid references "staff"("staff_id"),
  "created_by_staff_id" uuid references "staff"("staff_id"),
  "created_at" timestamptz
);
create unique index if not exists "refunds_refund_no_uq" on "refunds" ("refund_no");
create index if not exists "refunds_store_id_ix" on "refunds" ("store_id");
create index if not exists "refunds_sale_id_ix" on "refunds" ("sale_id");

-- 34. customer_credit_entries (category F)
-- Append-only receivable ledger. A credit sale debits, a settlement credits, and the balance is always SUM(amount_cents) â€” so a concurrent settlement cannot overwrite a concurrent sale.
create table if not exists "customer_credit_entries" (
  "credit_entry_id" bigint not null primary key check ("credit_entry_id" >= 0),
  "store_id" uuid references "stores"("store_id"),
  "customer_id" uuid references "customers"("customer_id"),
  "entry_type" customer_credit_entries_entry_type_enum,
  "sale_id" uuid references "sales"("sale_id"),
  "amount_cents" bigint,
  "due_on" date,
  "method_id" smallint references "payment_methods"("method_id") check ("method_id" >= 0),
  "created_by_staff_id" uuid references "staff"("staff_id"),
  "created_at" timestamptz
);
create index if not exists "customer_credit_entries_store_id_ix" on "customer_credit_entries" ("store_id");
create index if not exists "customer_credit_entries_customer_id_ix" on "customer_credit_entries" ("customer_id");
create index if not exists "customer_credit_entries_due_on_ix" on "customer_credit_entries" ("due_on");

-- 36. bottle_ledger (category G)
-- Append-only bottle movement log. amount_cents is now generated from qty &times; fee_unit_cents, so the fee charged always matches the fee that was in force at the time of sale.
create table if not exists "bottle_ledger" (
  "bottle_event_id" bigint not null primary key check ("bottle_event_id" >= 0),
  "store_id" uuid references "stores"("store_id"),
  "product_id" uuid references "products"("product_id"),
  "sale_id" uuid references "sales"("sale_id"),
  "event_type_id" smallint references "bottle_event_types"("event_type_id") check ("event_type_id" >= 0),
  "qty" integer,
  "fee_unit_cents" bigint,
  "amount_cents" bigint,
  "created_by_staff_id" uuid,
  "created_at" timestamptz
);
create index if not exists "bottle_ledger_store_id_ix" on "bottle_ledger" ("store_id");
create index if not exists "bottle_ledger_sale_id_ix" on "bottle_ledger" ("sale_id");

-- 39. purchase_order_lines (category H)
-- What was ordered, in what quantity. qty_received is tracked here so a partial delivery is visible without reading every receipt.
create table if not exists "purchase_order_lines" (
  "po_line_id" bigint not null primary key check ("po_line_id" >= 0),
  "purchase_order_id" uuid references "purchase_orders"("purchase_order_id"),
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "qty_ordered" numeric(12,3),
  "qty_received" numeric(12,3),
  "unit_cost_cents" bigint,
  "line_total_cents" bigint
);
create index if not exists "purchase_order_lines_purchase_order_id_ix" on "purchase_order_lines" ("purchase_order_id");

-- 48. notifications (category J)
-- An alert instance. title/body are no longer copied product names; the row stores params and the template renders the text, so renaming a product does not leave stale wording.
create table if not exists "notifications" (
  "notification_id" bigint not null primary key check ("notification_id" >= 0),
  "store_id" uuid references "stores"("store_id"),
  "notification_type_id" smallint references "notification_types"("notification_type_id") check ("notification_type_id" >= 0),
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "params" jsonb,
  "is_read" boolean,
  "created_at" timestamptz,
  "resolved_at" timestamptz,
  "resolved_by_staff_id" uuid references "staff"("staff_id"),
  "delivered_email_at" timestamptz,
  "delivered_push_at" timestamptz
);
create index if not exists "notifications_store_id_ix" on "notifications" ("store_id");
create index if not exists "notifications_product_id_ix" on "notifications" ("product_id");
create index if not exists "notifications_is_read_ix" on "notifications" ("is_read");
create index if not exists "notifications_created_at_ix" on "notifications" ("created_at");

-- 49. daily_sales_rollup (category K)
-- One row per store, day and product. The grain is stated explicitly because a rollup's key is its contract; anything finer belongs in sale_items, anything coarser in the monthly summary.
create table if not exists "daily_sales_rollup" (
  "store_id" uuid references "stores"("store_id"),
  "business_date" date,
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "qty_sold" numeric(14,3),
  "gross_cents" bigint,
  "discount_cents" bigint,
  "net_cents" bigint,
  "tax_cents" bigint,
  "cogs_cents" bigint,
  "qty_refunded" numeric(14,3),
  "qty_voided" numeric(14,3),
  "bill_count" integer,
  "rebuilt_at" timestamptz,
  primary key ("store_id", "business_date", "product_id", "pack_size_id")
);

-- 29. refund_lines (category D)
-- Partial returns, line by line. The quantity guard is enforced with CHECK plus a procedure check against the original line, so the same unit cannot be refunded twice.
create table if not exists "refund_lines" (
  "refund_line_id" bigint not null primary key check ("refund_line_id" >= 0),
  "refund_id" uuid references "refunds"("refund_id"),
  "sale_item_id" uuid references "sale_items"("sale_item_id"),
  "qty" numeric(12,3),
  "unit_price_cents" bigint,
  "amount_cents" bigint,
  "condition" refund_lines_condition_enum
);
create index if not exists "refund_lines_refund_id_ix" on "refund_lines" ("refund_id");
create index if not exists "refund_lines_sale_item_id_ix" on "refund_lines" ("sale_item_id");

-- 41. goods_receipt_lines (category H)
-- One delivered product, with the batch and expiry it arrived under. Posting these lines is what writes purchase stock movements and creates product_batches rows in one transaction.
create table if not exists "goods_receipt_lines" (
  "receipt_line_id" bigint not null primary key check ("receipt_line_id" >= 0),
  "goods_receipt_id" uuid references "goods_receipts"("goods_receipt_id"),
  "po_line_id" bigint references "purchase_order_lines"("po_line_id") check ("po_line_id" >= 0),
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "qty_received" numeric(12,3),
  "qty_rejected" numeric(12,3),
  "unit_cost_cents" bigint,
  "batch_no" varchar(64),
  "expires_on" date,
  "line_total_cents" bigint
);
create index if not exists "goods_receipt_lines_goods_receipt_id_ix" on "goods_receipt_lines" ("goods_receipt_id");

-- 20. product_batches (category C)
-- Expiry tracking per batch (FEFO). Currently defined but never populated â€” receiving and packing were never built, so the expiry alert path is dead code. Category H and I are what light it up.
create table if not exists "product_batches" (
  "batch_id" uuid not null primary key default gen_random_uuid(),
  "store_id" uuid references "stores"("store_id"),
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "batch_no" varchar(64),
  "manufactured_on" date,
  "expires_on" date,
  "qty_received" numeric(12,3),
  "qty_remaining" numeric(12,3),
  "unit_cost_cents" bigint,
  "source_receipt_line_id" bigint references "goods_receipt_lines"("receipt_line_id") check ("source_receipt_line_id" >= 0),
  "received_at" timestamptz
);
create unique index if not exists "product_batches_batch_no_uq" on "product_batches" ("batch_no");
create index if not exists "product_batches_store_id_ix" on "product_batches" ("store_id");
create index if not exists "product_batches_product_id_ix" on "product_batches" ("product_id");
create index if not exists "product_batches_expires_on_ix" on "product_batches" ("expires_on");

-- 19. stock_movements (category C)
-- Append-only ledger. Every quantity change in the system is a row here â€” there is no other way to change stock. Partitioned monthly by created_at; this is the highest-volume table after sale_items.
create table if not exists "stock_movements" (
  "movement_id" bigint not null primary key check ("movement_id" >= 0),
  "store_id" uuid references "stores"("store_id"),
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "batch_id" uuid references "product_batches"("batch_id"),
  "move_type_id" smallint references "stock_move_types"("move_type_id") check ("move_type_id" >= 0),
  "qty_change" numeric(12,3),
  "unit_cost_cents" bigint,
  "ref_table" varchar(32),
  "ref_id" uuid,
  "reason" varchar(190),
  "created_by_staff_id" uuid references "staff"("staff_id"),
  "created_at" timestamptz
);
create index if not exists "stock_movements_store_id_ix" on "stock_movements" ("store_id");
create index if not exists "stock_movements_product_id_ix" on "stock_movements" ("product_id");
create index if not exists "stock_movements_ref_id_ix" on "stock_movements" ("ref_id");
create index if not exists "stock_movements_created_at_ix" on "stock_movements" ("created_at");

-- 21. batch_allocations (category C)
-- Which batch a sale line actually consumed. Without this the FEFO rule is a suggestion: you can say "sell the oldest first" but you cannot prove which packet left the shelf.
create table if not exists "batch_allocations" (
  "allocation_id" bigint not null primary key check ("allocation_id" >= 0),
  "batch_id" uuid references "product_batches"("batch_id"),
  "sale_item_id" uuid references "sale_items"("sale_item_id"),
  "qty" numeric(12,3),
  "allocated_at" timestamptz,
  "allocation_type" batch_allocations_allocation_type_enum
);
create index if not exists "batch_allocations_batch_id_ix" on "batch_allocations" ("batch_id");
create index if not exists "batch_allocations_sale_item_id_ix" on "batch_allocations" ("sale_item_id");

-- 23. stock_take_lines (category C)
-- One counted product. expected_qty is snapshotted at count time, so the variance stays meaningful even after later sales post.
create table if not exists "stock_take_lines" (
  "stock_take_line_id" bigint not null primary key check ("stock_take_line_id" >= 0),
  "stock_take_id" uuid references "stock_takes"("stock_take_id"),
  "product_id" uuid references "products"("product_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "batch_id" uuid references "product_batches"("batch_id"),
  "expected_qty" numeric(12,3),
  "counted_qty" numeric(12,3),
  "variance_qty" numeric(12,3)
);
create index if not exists "stock_take_lines_stock_take_id_ix" on "stock_take_lines" ("stock_take_id");

-- 43. production_inputs (category I)
-- Raw material and packaging consumed by a run. Each row is the justification for one production_in stock movement.
create table if not exists "production_inputs" (
  "production_input_id" bigint not null primary key check ("production_input_id" >= 0),
  "production_run_id" uuid references "production_runs"("production_run_id"),
  "product_id" uuid references "products"("product_id"),
  "stage" production_inputs_stage_enum,
  "qty_kg" numeric(12,3),
  "unit_cost_cents" bigint,
  "batch_id" uuid references "product_batches"("batch_id")
);
create index if not exists "production_inputs_production_run_id_ix" on "production_inputs" ("production_run_id");

-- 44. production_outputs (category I)
-- Finished packets, split by size. Also covers a pure packing session where bulk powder is turned into branded packets outside a full production run.
create table if not exists "production_outputs" (
  "production_output_id" bigint not null primary key check ("production_output_id" >= 0),
  "production_run_id" uuid references "production_runs"("production_run_id"),
  "pack_size_id" uuid references "pack_sizes"("pack_size_id"),
  "qty_packets" numeric(12,3),
  "wastage_g" numeric(12,3),
  "unit_cost_cents" bigint,
  "batch_id" uuid references "product_batches"("batch_id"),
  "expires_on" date
);
create index if not exists "production_outputs_production_run_id_ix" on "production_outputs" ("production_run_id");
