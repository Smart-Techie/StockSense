# StockSense Version 1.0 — Database Migrations

This folder contains the complete, production-ready database migrations for **StockSense Version 1.0**.

## Applying the Migration

1. Log into your [Supabase Dashboard](https://supabase.com/dashboard/project/fjwpzuaaxuwdbwwqfvdp).
2. Navigate to the **SQL Editor** tab from the left sidebar.
3. Open or copy the contents of `001_stocksense_v1_0.sql` (or `../supabase-migrations.sql`).
4. Click **Run**.
5. The migration is idempotent and safe to run multiple times.

## What This Migration Does

- **`profiles` table**: Extends `auth.users` with `full_name`, `is_suspended`, `suspension_reason`, and timestamps.
- **`platform_roles` table**: Stores authoritative role assignments (`owner`, `admin`, `moderator`) with audit timestamps.
- **`admin_audit_logs` table**: Immutable log for administrative actions (role changes, suspensions, reactivations).
- **`platform_settings` table**: Global platform configuration.
- **User-Scoped SKU Constraint**: Replaces any global unique constraint with `(user_id, lower(sku))` unique index so multiple businesses can use standard manufacturer SKUs without collisions.
- **Row Level Security (RLS)**: Enforces multi-tenant data isolation on all tables.
- **Concurrency-Safe RPC (`process_stock_movement`)**: Uses PostgreSQL `FOR UPDATE` row-locking to atomically validate available stock, update inventory, and write movement logs in a single transaction.
- **Administrative RPCs**: Provides secure administrative endpoints for overview stats, user management, suspensions, role assignments, and initial owner bootstrapping without exposing database credentials to clients.
