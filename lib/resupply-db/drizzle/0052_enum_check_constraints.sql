-- D-06: Enforce conversations.priority enum at DB level.
-- D-07: Enforce messages.sender_role enum at DB level.
-- D-11: Enforce shop_order_items.quantity >= 1 at DB level.
--
-- These constraints guard against raw-SQL inserts or ORM bugs that
-- bypass application-layer validation. All three columns already hold
-- only valid values in every existing row (enforced by Drizzle TS
-- enums and Zod validation since their respective initial migrations),
-- so no data backfill is required before adding the CHECKs.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."conversations"
  ADD CONSTRAINT "conversations_priority_enum"
    CHECK (priority IN ('low','normal','high','urgent'));

ALTER TABLE "resupply"."messages"
  ADD CONSTRAINT "messages_sender_role_enum"
    CHECK (sender_role IN ('patient','customer','admin','agent','system'));

ALTER TABLE "resupply"."shop_order_items"
  ADD CONSTRAINT "shop_order_items_quantity_positive"
    CHECK (quantity >= 1);
