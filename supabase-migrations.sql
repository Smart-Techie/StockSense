-- ============================================================================
-- StockSense Version 1.0 — Complete Database Schema & Security Migration
-- Project: StockSense (Inventory Intelligence)
-- Safe, repeatable, and idempotent migration script
-- ============================================================================

-- 1. PROFILES TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL DEFAULT '',
    is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    suspension_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 2. PLATFORM ROLES TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'moderator')),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.platform_roles ENABLE ROW LEVEL SECURITY;

-- 3. ADMIN AUDIT LOGS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- 4. PLATFORM SETTINGS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Seed default settings if not exists
INSERT INTO public.platform_settings (key, value, description)
VALUES 
    ('system_settings', '{"platform_name": "StockSense", "currency_symbol": "₦", "currency_code": "NGN", "maintenance_mode": false, "allow_registration": true, "low_stock_default": 5}'::jsonb, 'Core StockSense platform configuration')
ON CONFLICT (key) DO NOTHING;

-- 5. PRODUCTS TABLE (Ensure columns and user-scoped unique SKU)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sku TEXT,
    category TEXT NOT NULL DEFAULT 'Other',
    unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    selling_price NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    minimum_stock INTEGER NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
    emoji TEXT DEFAULT '📦',
    supplier TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

-- Drop legacy global unique constraint on SKU if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname IN ('products_sku_key', 'products_sku_unique')
    ) THEN
        ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_sku_key;
        ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_sku_unique;
    END IF;
END $$;

-- Create user-scoped unique index for SKU (case-insensitive, ignoring null or empty)
CREATE UNIQUE INDEX IF NOT EXISTS products_user_sku_idx
ON public.products (user_id, lower(sku))
WHERE sku IS NOT NULL AND trim(sku) <> '';

-- 6. STOCK MOVEMENTS TABLE (Ensure columns and immutability)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    movement_type TEXT NOT NULL CHECK (movement_type IN ('Sale', 'Restock', 'Adjustment')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    quantity_before INTEGER NOT NULL CHECK (quantity_before >= 0),
    quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_user_id ON public.products(user_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_user_id ON public.stock_movements(user_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_id ON public.stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON public.stock_movements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON public.admin_audit_logs(created_at DESC);

-- ----------------------------------------------------------------------------
-- 7. SECURITY FUNCTIONS (SECURITY DEFINER with safe search_path)
-- ----------------------------------------------------------------------------

-- Check if user is suspended
CREATE OR REPLACE FUNCTION public.is_user_suspended(p_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT COALESCE(
        (SELECT is_suspended FROM public.profiles WHERE id = p_uid),
        FALSE
    );
$$;

-- Get user role
CREATE OR REPLACE FUNCTION public.get_user_role(p_uid UUID)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT role FROM public.platform_roles WHERE user_id = p_uid LIMIT 1;
$$;

-- Check if caller is platform admin or owner
CREATE OR REPLACE FUNCTION public.is_platform_admin(p_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT COALESCE(get_user_role(p_uid) IN ('owner', 'admin'), FALSE);
$$;

-- Check if caller is platform owner (hardened with permanent owner email protection)
CREATE OR REPLACE FUNCTION public.is_platform_owner(p_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
STABLE
AS $$
    SELECT (
        COALESCE(get_user_role(p_uid) = 'owner', FALSE)
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = p_uid AND LOWER(u.email) = 'ezeoforchioma2@gmail.com'
        )
    );
$$;

-- ----------------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------

-- Profiles Policies
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
    FOR SELECT TO authenticated
    USING (auth.uid() = id OR is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE TO authenticated
    USING (auth.uid() = id OR is_platform_admin(auth.uid()))
    WITH CHECK (
        -- Regular users can only update their full_name, not is_suspended
        (auth.uid() = id AND is_suspended = (SELECT is_suspended FROM public.profiles WHERE id = auth.uid()))
        OR is_platform_admin(auth.uid())
    );

DROP POLICY IF EXISTS "profiles_delete_admin" ON public.profiles;
CREATE POLICY "profiles_delete_admin" ON public.profiles
    FOR DELETE TO authenticated
    USING (is_platform_admin(auth.uid()));

-- Platform Roles Policies
DROP POLICY IF EXISTS "roles_select_own" ON public.platform_roles;
CREATE POLICY "roles_select_own" ON public.platform_roles
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id OR is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "roles_all_owner" ON public.platform_roles;
CREATE POLICY "roles_all_owner" ON public.platform_roles
    FOR ALL TO authenticated
    USING (is_platform_owner(auth.uid()))
    WITH CHECK (is_platform_owner(auth.uid()));

-- Admin Audit Logs Policies
DROP POLICY IF EXISTS "audit_select_admin" ON public.admin_audit_logs;
CREATE POLICY "audit_select_admin" ON public.admin_audit_logs
    FOR SELECT TO authenticated
    USING (is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "audit_insert_admin" ON public.admin_audit_logs;
CREATE POLICY "audit_insert_admin" ON public.admin_audit_logs
    FOR INSERT TO authenticated
    WITH CHECK (is_platform_admin(auth.uid()) OR auth.uid() IS NOT NULL);

-- Platform Settings Policies
DROP POLICY IF EXISTS "settings_select" ON public.platform_settings;
CREATE POLICY "settings_select" ON public.platform_settings
    FOR SELECT TO authenticated
    USING (TRUE);

DROP POLICY IF EXISTS "settings_update_admin" ON public.platform_settings;
CREATE POLICY "settings_update_admin" ON public.platform_settings
    FOR UPDATE TO authenticated
    USING (is_platform_admin(auth.uid()))
    WITH CHECK (is_platform_admin(auth.uid()));

-- Products Policies
DROP POLICY IF EXISTS "products_select_own" ON public.products;
CREATE POLICY "products_select_own" ON public.products
    FOR SELECT TO authenticated
    USING (user_id = auth.uid() AND NOT is_user_suspended(auth.uid()));

DROP POLICY IF EXISTS "products_insert_own" ON public.products;
CREATE POLICY "products_insert_own" ON public.products
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() AND NOT is_user_suspended(auth.uid()));

DROP POLICY IF EXISTS "products_update_own" ON public.products;
CREATE POLICY "products_update_own" ON public.products
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid() AND NOT is_user_suspended(auth.uid()))
    WITH CHECK (user_id = auth.uid() AND NOT is_user_suspended(auth.uid()));

DROP POLICY IF EXISTS "products_delete_own" ON public.products;
CREATE POLICY "products_delete_own" ON public.products
    FOR DELETE TO authenticated
    USING (user_id = auth.uid() AND NOT is_user_suspended(auth.uid()));

-- Stock Movements Policies
DROP POLICY IF EXISTS "movements_select_own" ON public.stock_movements;
CREATE POLICY "movements_select_own" ON public.stock_movements
    FOR SELECT TO authenticated
    USING (user_id = auth.uid() AND NOT is_user_suspended(auth.uid()));

DROP POLICY IF EXISTS "movements_insert_own" ON public.stock_movements;
CREATE POLICY "movements_insert_own" ON public.stock_movements
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid() AND NOT is_user_suspended(auth.uid()));

-- Note: No UPDATE or DELETE policy on stock_movements — movement records are immutable!

-- ----------------------------------------------------------------------------
-- 9. USER CREATION TRIGGER (Auto-create Profile)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, created_at, updated_at)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        NOW(),
        NOW()
    )
    ON CONFLICT (id) DO UPDATE
    SET full_name = EXCLUDED.full_name,
        updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill existing auth.users into profiles if any exist without profile
INSERT INTO public.profiles (id, full_name, created_at, updated_at)
SELECT id, COALESCE(raw_user_meta_data->>'full_name', split_part(email, '@', 1)), created_at, now()
FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 10. ATOMIC CONCURRENCY-SAFE STOCK OPERATION RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_stock_movement(
    p_product_id UUID,
    p_movement_type TEXT,
    p_quantity INTEGER,
    p_note TEXT DEFAULT NULL,
    p_direction TEXT DEFAULT 'add'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_current_stock INTEGER;
    v_new_stock INTEGER;
    v_product_name TEXT;
    v_movement_id UUID;
    v_actual_change INTEGER;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required to record stock movements.';
    END IF;

    IF is_user_suspended(v_user_id) THEN
        RAISE EXCEPTION 'Your account has been suspended by an administrator.';
    END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be a positive integer greater than zero.';
    END IF;

    IF p_movement_type NOT IN ('Sale', 'Restock', 'Adjustment') THEN
        RAISE EXCEPTION 'Invalid movement type: %. Allowed types are Sale, Restock, Adjustment.', p_movement_type;
    END IF;

    -- Row lock on product to prevent concurrent race conditions
    SELECT quantity, name INTO v_current_stock, v_product_name
    FROM public.products
    WHERE id = p_product_id AND user_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Product with ID % not found or does not belong to you.', p_product_id;
    END IF;

    IF p_movement_type = 'Sale' THEN
        IF v_current_stock < p_quantity THEN
            RAISE EXCEPTION 'Insufficient stock available. Current stock is %, requested sale is %.', v_current_stock, p_quantity;
        END IF;
        v_new_stock := v_current_stock - p_quantity;
        v_actual_change := p_quantity;

    ELSIF p_movement_type = 'Restock' THEN
        v_new_stock := v_current_stock + p_quantity;
        v_actual_change := p_quantity;

    ELSIF p_movement_type = 'Adjustment' THEN
        IF p_direction = 'subtract' THEN
            IF v_current_stock < p_quantity THEN
                RAISE EXCEPTION 'Cannot adjust stock below zero. Current stock is %, reduction requested is %.', v_current_stock, p_quantity;
            END IF;
            v_new_stock := v_current_stock - p_quantity;
        ELSE
            v_new_stock := v_current_stock + p_quantity;
        END IF;
        v_actual_change := p_quantity;
    END IF;

    -- Update product quantity atomically
    UPDATE public.products
    SET quantity = v_new_stock,
        updated_at = NOW()
    WHERE id = p_product_id AND user_id = v_user_id;

    -- Create corresponding immutable movement history record
    INSERT INTO public.stock_movements (
        user_id,
        product_id,
        movement_type,
        quantity,
        quantity_before,
        quantity_after,
        note,
        created_at
    ) VALUES (
        v_user_id,
        p_product_id,
        p_movement_type,
        v_actual_change,
        v_current_stock,
        v_new_stock,
        NULLIF(trim(p_note), ''),
        NOW()
    ) RETURNING id INTO v_movement_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'product_id', p_product_id,
        'product_name', v_product_name,
        'movement_id', v_movement_id,
        'movement_type', p_movement_type,
        'quantity', v_actual_change,
        'quantity_before', v_current_stock,
        'quantity_after', v_new_stock
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. ADMIN DASHBOARD RPCS (SECURITY DEFINER with privilege checks)
-- ----------------------------------------------------------------------------

-- Admin Overview Metrics
CREATE OR REPLACE FUNCTION public.admin_get_overview()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
    v_total_users BIGINT;
    v_new_users_7d BIGINT;
    v_new_users_30d BIGINT;
    v_active_users_30d BIGINT;
    v_total_products BIGINT;
    v_total_movements BIGINT;
    v_recent_logs JSONB;
BEGIN
    v_caller := auth.uid();
    IF NOT is_platform_admin(v_caller) THEN
        RAISE EXCEPTION 'Access denied: Platform administrator privileges required.';
    END IF;

    SELECT count(*) INTO v_total_users FROM auth.users;
    SELECT count(*) INTO v_new_users_7d FROM auth.users WHERE created_at >= NOW() - INTERVAL '7 days';
    SELECT count(*) INTO v_new_users_30d FROM auth.users WHERE created_at >= NOW() - INTERVAL '30 days';
    
    -- Active users defined as distinct users who recorded stock movements in last 30 days
    SELECT count(DISTINCT user_id) INTO v_active_users_30d
    FROM public.stock_movements
    WHERE created_at >= NOW() - INTERVAL '30 days';

    SELECT count(*) INTO v_total_products FROM public.products;
    SELECT count(*) INTO v_total_movements FROM public.stock_movements;

    SELECT COALESCE(jsonb_agg(l), '[]'::jsonb) INTO v_recent_logs
    FROM (
        SELECT id, action, target_type, target_id, details, created_at
        FROM public.admin_audit_logs
        ORDER BY created_at DESC
        LIMIT 10
    ) l;

    RETURN jsonb_build_object(
        'total_users', v_total_users,
        'new_users_7d', v_new_users_7d,
        'new_users_30d', v_new_users_30d,
        'active_users_30d', v_active_users_30d,
        'total_products', v_total_products,
        'total_movements', v_total_movements,
        'recent_logs', v_recent_logs
    );
END;
$$;

-- Admin Get Users Table (Paginated & Filterable, Exposes NO Passwords)
CREATE OR REPLACE FUNCTION public.admin_get_users(
    p_search TEXT DEFAULT '',
    p_role TEXT DEFAULT 'all',
    p_status TEXT DEFAULT 'all',
    p_limit INTEGER DEFAULT 20,
    p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
    v_total BIGINT;
    v_users JSONB;
BEGIN
    v_caller := auth.uid();
    IF NOT is_platform_admin(v_caller) THEN
        RAISE EXCEPTION 'Access denied: Platform administrator privileges required.';
    END IF;

    SELECT count(*) INTO v_total
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    LEFT JOIN public.platform_roles r ON r.user_id = u.id
    WHERE (p_search = '' OR u.email ILIKE '%' || p_search || '%' OR COALESCE(p.full_name, '') ILIKE '%' || p_search || '%')
      AND (p_role = 'all' OR (p_role = 'none' AND r.role IS NULL) OR r.role = p_role)
      AND (p_status = 'all' OR (p_status = 'active' AND COALESCE(p.is_suspended, FALSE) = FALSE) OR (p_status = 'suspended' AND p.is_suspended = TRUE));

    SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb) INTO v_users
    FROM (
        SELECT 
            u.id,
            u.email,
            COALESCE(p.full_name, split_part(u.email, '@', 1)) AS full_name,
            COALESCE(p.is_suspended, FALSE) AS is_suspended,
            p.suspension_reason,
            r.role,
            u.created_at,
            u.last_sign_in_at
        FROM auth.users u
        LEFT JOIN public.profiles p ON p.id = u.id
        LEFT JOIN public.platform_roles r ON r.user_id = u.id
        WHERE (p_search = '' OR u.email ILIKE '%' || p_search || '%' OR COALESCE(p.full_name, '') ILIKE '%' || p_search || '%')
          AND (p_role = 'all' OR (p_role = 'none' AND r.role IS NULL) OR r.role = p_role)
          AND (p_status = 'all' OR (p_status = 'active' AND COALESCE(p.is_suspended, FALSE) = FALSE) OR (p_status = 'suspended' AND p.is_suspended = TRUE))
        ORDER BY u.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) row_data;

    RETURN jsonb_build_object(
        'total', v_total,
        'users', v_users
    );
END;
$$;

-- Admin Toggle Suspension
CREATE OR REPLACE FUNCTION public.admin_toggle_suspension(
    p_target_user_id UUID,
    p_suspend BOOLEAN,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
    v_target_role TEXT;
    v_target_email TEXT;
BEGIN
    v_caller := auth.uid();
    IF NOT is_platform_admin(v_caller) THEN
        RAISE EXCEPTION 'Access denied: Platform administrator privileges required.';
    END IF;

    -- Fetch target email
    SELECT email INTO v_target_email FROM auth.users WHERE id = p_target_user_id;

    -- Protection: Cannot suspend Owner (by role or hard-pinned email)
    SELECT role INTO v_target_role FROM public.platform_roles WHERE user_id = p_target_user_id;
    IF v_target_role = 'owner' OR LOWER(COALESCE(v_target_email, '')) = 'ezeoforchioma2@gmail.com' THEN
        RAISE EXCEPTION 'Cannot suspend the Platform Owner account (ezeoforchioma2@gmail.com).';
    END IF;

    -- Update or create profile record
    INSERT INTO public.profiles (id, is_suspended, suspension_reason, updated_at)
    VALUES (p_target_user_id, p_suspend, NULLIF(trim(p_reason), ''), NOW())
    ON CONFLICT (id) DO UPDATE
    SET is_suspended = p_suspend,
        suspension_reason = NULLIF(trim(p_reason), ''),
        updated_at = NOW();

    -- Audit Log
    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
    VALUES (
        v_caller,
        CASE WHEN p_suspend THEN 'USER_SUSPENDED' ELSE 'USER_REACTIVATED' END,
        'user',
        p_target_user_id::text,
        jsonb_build_object('reason', p_reason)
    );

    RETURN jsonb_build_object('success', TRUE, 'is_suspended', p_suspend);
END;
$$;

-- Admin Role Assignment (Only Platform Owner can appoint/revoke roles)
CREATE OR REPLACE FUNCTION public.admin_assign_role(
    p_target_user_id UUID,
    p_role TEXT -- 'admin', 'moderator', or 'none' to revoke
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
    v_current_target_role TEXT;
    v_owner_count BIGINT;
BEGIN
    v_caller := auth.uid();
    IF NOT is_platform_owner(v_caller) THEN
        RAISE EXCEPTION 'Access denied: Only the Platform Owner can assign or revoke administrative roles.';
    END IF;

    SELECT role INTO v_current_target_role FROM public.platform_roles WHERE user_id = p_target_user_id;

    -- Privilege check: prevent accidentally removing the last owner
    IF v_current_target_role = 'owner' AND p_role <> 'owner' THEN
        SELECT count(*) INTO v_owner_count FROM public.platform_roles WHERE role = 'owner';
        IF v_owner_count <= 1 THEN
            RAISE EXCEPTION 'Cannot remove the last remaining Platform Owner. Transfer ownership first.';
        END IF;
    END IF;

    IF p_role = 'none' OR p_role IS NULL THEN
        DELETE FROM public.platform_roles WHERE user_id = p_target_user_id;
        
        INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
        VALUES (v_caller, 'ROLE_REVOKED', 'user', p_target_user_id::text, jsonb_build_object('previous_role', v_current_target_role));
    ELSE
        IF p_role NOT IN ('owner', 'admin', 'moderator') THEN
            RAISE EXCEPTION 'Invalid role: %. Allowed roles are owner, admin, moderator.', p_role;
        END IF;

        INSERT INTO public.platform_roles (user_id, role, assigned_at, assigned_by)
        VALUES (p_target_user_id, p_role, NOW(), v_caller)
        ON CONFLICT (user_id) DO UPDATE
        SET role = p_role,
            assigned_at = NOW(),
            assigned_by = v_caller;

        INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
        VALUES (v_caller, 'ROLE_ASSIGNED', 'user', p_target_user_id::text, jsonb_build_object('new_role', p_role, 'previous_role', v_current_target_role));
    END IF;

    RETURN jsonb_build_object('success', TRUE, 'role', p_role);
END;
$$;

-- ----------------------------------------------------------------------------
-- 12. INITIAL OWNER BOOTSTRAP PROCEDURE
-- ----------------------------------------------------------------------------
-- This function allows the initial platform owner to designate themselves as
-- Owner ONLY if NO owner currently exists in the platform. Once an owner exists,
-- it permanently rejects any subsequent bootstrap attempts.
CREATE OR REPLACE FUNCTION public.bootstrap_initial_owner()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
    v_existing_owners BIGINT;
    v_caller_email TEXT;
BEGIN
    v_caller := auth.uid();
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required to bootstrap platform owner.';
    END IF;

    SELECT count(*) INTO v_existing_owners FROM public.platform_roles WHERE role = 'owner';
    IF v_existing_owners > 0 THEN
        RAISE EXCEPTION 'Initial owner has already been bootstrapped. Contact an existing Owner for role assignment.';
    END IF;

    SELECT email INTO v_caller_email FROM auth.users WHERE id = v_caller;

    INSERT INTO public.platform_roles (user_id, role, assigned_at, assigned_by)
    VALUES (v_caller, 'owner', NOW(), v_caller)
    ON CONFLICT (user_id) DO UPDATE
    SET role = 'owner',
        assigned_at = NOW(),
        assigned_by = v_caller;

    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
    VALUES (v_caller, 'INITIAL_OWNER_BOOTSTRAP', 'user', v_caller::text, jsonb_build_object('email', v_caller_email));

    RETURN jsonb_build_object('success', TRUE, 'role', 'owner', 'user_id', v_caller);
END;
$$;

-- ----------------------------------------------------------------------------
-- 12b. ADMIN DELETE USER PROCEDURE
-- ----------------------------------------------------------------------------
-- Permanently deletes a user account, their catalog, and stock movements,
-- logging an immutable audit record before executing the cascading wipe.
CREATE OR REPLACE FUNCTION public.admin_delete_user(
    p_target_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    c_owner_email CONSTANT TEXT := 'ezeoforchioma2@gmail.com';
    v_caller        UUID := auth.uid();
    v_caller_role   TEXT;
    v_target_role   TEXT;
    v_target_email  TEXT;
    v_target_name   TEXT;
    v_movements     INTEGER := 0;
    v_products      INTEGER := 0;
    v_permissions   INTEGER := 0;
    v_roles         INTEGER := 0;
    v_profiles      INTEGER := 0;
    v_feedback      INTEGER := 0;
    v_auth_deleted  INTEGER := 0;
BEGIN
    -- 1. Authenticate + authorize the caller on the server.
    IF v_caller IS NULL OR NOT is_platform_admin(v_caller) THEN
        RAISE EXCEPTION 'Access denied: Platform administrator privileges required.';
    END IF;

    IF p_target_user_id IS NULL THEN
        RAISE EXCEPTION 'A target user id is required.';
    END IF;

    -- Self-deletion prevention
    IF v_caller = p_target_user_id THEN
        RAISE EXCEPTION 'You cannot delete your own administrator account.';
    END IF;

    -- 2. Resolve (and lock) the REAL Supabase Auth account. No row = no success.
    SELECT u.email INTO v_target_email
    FROM auth.users u
    WHERE u.id = p_target_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No Supabase Auth account exists for user id %. Nothing was deleted.', p_target_user_id;
    END IF;

    SELECT full_name INTO v_target_name FROM public.profiles WHERE id = p_target_user_id;
    SELECT role INTO v_target_role FROM public.platform_roles WHERE user_id = p_target_user_id;
    v_caller_role := get_user_role(v_caller);

    -- 3. Owner protection: Nobody can delete the Owner (checked by role, helper, and hard-pinned email)
    IF v_target_role = 'owner'
       OR is_platform_owner(p_target_user_id)
       OR LOWER(COALESCE(v_target_email, '')) = c_owner_email THEN
        RAISE EXCEPTION 'Cannot delete the Platform Owner account (ezeoforchioma2@gmail.com).';
    END IF;

    -- 4. Hierarchy check: Only the Owner can delete other Admins
    IF v_target_role = 'admin' AND v_caller_role IS DISTINCT FROM 'owner' THEN
        RAISE EXCEPTION 'Only the Platform Owner can delete an Administrator account.';
    END IF;

    -- 5. Pre-deletion Audit Log
    IF to_regclass('public.admin_audit_logs') IS NOT NULL THEN
        INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
        VALUES (
            v_caller,
            'USER_DELETED',
            'user',
            p_target_user_id::text,
            jsonb_build_object(
                'email', v_target_email,
                'full_name', v_target_name,
                'role', COALESCE(v_target_role, 'member'),
                'deleted_at', NOW()
            )
        );
    END IF;

    -- 6. Clear references where ON DELETE SET NULL applies (defensive to_regclass checks)
    IF to_regclass('public.feedback') IS NOT NULL THEN
        EXECUTE 'UPDATE public.feedback SET user_id = NULL WHERE user_id = $1' USING p_target_user_id;
        GET DIAGNOSTICS v_feedback = ROW_COUNT;
    END IF;

    IF to_regclass('public.platform_roles') IS NOT NULL THEN
        UPDATE public.platform_roles SET assigned_by = NULL WHERE assigned_by = p_target_user_id;
    END IF;

    IF to_regclass('public.staff_permissions') IS NOT NULL THEN
        EXECUTE 'UPDATE public.staff_permissions SET granted_by = NULL WHERE granted_by = $1' USING p_target_user_id;
        EXECUTE 'DELETE FROM public.staff_permissions WHERE user_id = $1' USING p_target_user_id;
        GET DIAGNOSTICS v_permissions = ROW_COUNT;
    END IF;

    IF to_regclass('public.platform_settings') IS NOT NULL THEN
        EXECUTE 'UPDATE public.platform_settings SET updated_by = NULL WHERE updated_by = $1' USING p_target_user_id;
    END IF;

    -- Explicitly delete user stock movements and products in proper dependency order
    IF to_regclass('public.stock_movements') IS NOT NULL THEN
        DELETE FROM public.stock_movements WHERE user_id = p_target_user_id;
        IF to_regclass('public.products') IS NOT NULL THEN
            DELETE FROM public.stock_movements WHERE product_id IN (SELECT id FROM public.products WHERE user_id = p_target_user_id);
        END IF;
        GET DIAGNOSTICS v_movements = ROW_COUNT;
    END IF;

    IF to_regclass('public.products') IS NOT NULL THEN
        DELETE FROM public.products WHERE user_id = p_target_user_id;
        GET DIAGNOSTICS v_products = ROW_COUNT;
    END IF;

    IF to_regclass('public.platform_roles') IS NOT NULL THEN
        DELETE FROM public.platform_roles WHERE user_id = p_target_user_id;
        GET DIAGNOSTICS v_roles = ROW_COUNT;
    END IF;

    IF to_regclass('public.profiles') IS NOT NULL THEN
        DELETE FROM public.profiles WHERE id = p_target_user_id;
        GET DIAGNOSTICS v_profiles = ROW_COUNT;
    END IF;

    -- 7. Delete from auth.users (Cascades to GoTrue session records and identities)
    DELETE FROM auth.users WHERE id = p_target_user_id;
    GET DIAGNOSTICS v_auth_deleted = ROW_COUNT;

    -- 8. Verify deletion: must delete exactly 1 row from auth.users and no identity remains
    IF v_auth_deleted <> 1 THEN
        RAISE EXCEPTION 'Supabase Auth account % was not deleted (rows affected: %). All changes were rolled back.',
            p_target_user_id, v_auth_deleted;
    END IF;

    IF EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id)
       OR EXISTS (SELECT 1 FROM auth.identities WHERE user_id = p_target_user_id) THEN
        RAISE EXCEPTION 'Supabase Auth account % still exists after deletion. All changes were rolled back.',
            p_target_user_id;
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE,
        'auth_user_deleted', TRUE,
        'deleted_user_id', p_target_user_id,
        'email', v_target_email,
        'removed', jsonb_build_object(
            'stock_movements', v_movements,
            'products', v_products,
            'staff_permissions', v_permissions,
            'platform_roles', v_roles,
            'profiles', v_profiles
        ),
        'retained_anonymised', jsonb_build_object(
            'feedback', v_feedback
        )
    );
END;
$$;

-- By-email variant for administrator convenience
CREATE OR REPLACE FUNCTION public.admin_delete_user_by_email(
    p_target_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_target_id UUID;
BEGIN
    IF p_target_email IS NULL OR trim(p_target_email) = '' THEN
        RAISE EXCEPTION 'An email address is required.';
    END IF;

    SELECT id INTO v_target_id
    FROM auth.users
    WHERE LOWER(email) = LOWER(trim(p_target_email));

    IF v_target_id IS NULL THEN
        RAISE EXCEPTION 'No user account found with email: %', p_target_email;
    END IF;

    RETURN public.admin_delete_user(v_target_id);
END;
$$;

-- Grant execution permissions
GRANT EXECUTE ON FUNCTION public.is_user_suspended(UUID) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_user_role(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_platform_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_platform_owner(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_stock_movement(UUID, TEXT, INTEGER, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_users(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_toggle_suspension(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_role(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_initial_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user_by_email(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cleanup_non_owner_accounts() TO authenticated;

-- ----------------------------------------------------------------------------
-- 13. CUSTOMER FEEDBACK TABLE & POLICIES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    feedback_type TEXT NOT NULL CHECK (feedback_type IN ('Suggestion', 'Bug Report', 'General Feedback')),
    message TEXT NOT NULL CHECK (char_length(trim(message)) >= 5 AND char_length(message) <= 2000),
    contact_email TEXT,
    status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Reviewed', 'Resolved')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON public.feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON public.feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON public.feedback(status);

DROP POLICY IF EXISTS "feedback_insert_authenticated" ON public.feedback;
CREATE POLICY "feedback_insert_authenticated" ON public.feedback
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "feedback_select_own" ON public.feedback;
CREATE POLICY "feedback_select_own" ON public.feedback
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id OR is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "feedback_update_admin" ON public.feedback;
CREATE POLICY "feedback_update_admin" ON public.feedback
    FOR UPDATE TO authenticated
    USING (is_platform_admin(auth.uid()))
    WITH CHECK (is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS "feedback_delete_admin" ON public.feedback;
CREATE POLICY "feedback_delete_admin" ON public.feedback
    FOR DELETE TO authenticated
    USING (is_platform_admin(auth.uid()));

-- ============================================================================
-- 14. STAFF PERMISSIONS & BULK PRODUCT UPLOAD ACCESS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.staff_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('bulk_product_upload')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT staff_permissions_user_perm_unique UNIQUE (user_id, permission)
);

ALTER TABLE public.staff_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_permissions_select" ON public.staff_permissions;
CREATE POLICY "staff_permissions_select" ON public.staff_permissions
    FOR SELECT USING (
        auth.uid() = user_id OR public.is_admin()
    );

DROP POLICY IF EXISTS "staff_permissions_manage" ON public.staff_permissions;
CREATE POLICY "staff_permissions_manage" ON public.staff_permissions
    FOR ALL USING (
        public.is_admin()
    );

CREATE OR REPLACE FUNCTION public.has_staff_permission(p_user_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF is_platform_owner(p_user_id) THEN
        RETURN TRUE;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.staff_permissions sp
        JOIN public.platform_roles r ON r.user_id = sp.user_id
        WHERE sp.user_id = p_user_id
          AND sp.permission = p_permission
          AND r.role IN ('owner', 'admin', 'moderator')
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_staff_permission(
    p_target_user_id UUID,
    p_permission TEXT,
    p_granted BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
    v_target_role TEXT;
BEGIN
    v_caller := auth.uid();
    IF NOT (is_platform_owner(v_caller) OR is_platform_admin(v_caller)) THEN
        RAISE EXCEPTION 'Access denied: Platform administrator privileges required to manage staff permissions.';
    END IF;

    IF p_permission NOT IN ('bulk_product_upload') THEN
        RAISE EXCEPTION 'Invalid permission name: %', p_permission;
    END IF;

    SELECT role INTO v_target_role FROM public.platform_roles WHERE user_id = p_target_user_id;
    IF v_target_role IS NULL THEN
        RAISE EXCEPTION 'Cannot assign staff permissions to an ordinary user. Assign a staff role (admin or moderator) first.';
    END IF;

    IF v_target_role = 'owner' AND NOT is_platform_owner(v_caller) THEN
        RAISE EXCEPTION 'Access denied: Only the Platform Owner can manage Owner permissions.';
    END IF;

    IF p_granted THEN
        INSERT INTO public.staff_permissions (user_id, permission, granted_at, granted_by)
        VALUES (p_target_user_id, p_permission, NOW(), v_caller)
        ON CONFLICT (user_id, permission) DO NOTHING;

        INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
        VALUES (v_caller, 'STAFF_PERMISSION_GRANTED', 'user', p_target_user_id::text, jsonb_build_object('permission', p_permission, 'target_role', v_target_role));
    ELSE
        DELETE FROM public.staff_permissions
        WHERE user_id = p_target_user_id AND permission = p_permission;

        INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
        VALUES (v_caller, 'STAFF_PERMISSION_REVOKED', 'user', p_target_user_id::text, jsonb_build_object('permission', p_permission, 'target_role', v_target_role));
    END IF;

    RETURN jsonb_build_object('success', TRUE, 'permission', p_permission, 'granted', p_granted);
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_bulk_import_products(
    p_target_user_id UUID,
    p_products JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
    v_target_suspended BOOLEAN;
    v_item JSONB;
    v_product_id UUID;
    v_name TEXT;
    v_sku TEXT;
    v_category TEXT;
    v_selling_price NUMERIC;
    v_unit_cost NUMERIC;
    v_quantity INTEGER;
    v_minimum_stock INTEGER;
    v_supplier TEXT;
    v_emoji TEXT;
    v_success_count INTEGER := 0;
    v_failed_rows JSONB := '[]'::jsonb;
    v_row_idx INTEGER := 0;
    v_sku_exists BOOLEAN;
BEGIN
    v_caller := auth.uid();
    
    IF NOT has_staff_permission(v_caller, 'bulk_product_upload') THEN
        RAISE EXCEPTION 'Access denied: You do not possess the bulk_product_upload permission.';
    END IF;

    SELECT is_suspended INTO v_target_suspended FROM public.profiles WHERE id = p_target_user_id;
    IF v_target_suspended IS TRUE THEN
        RAISE EXCEPTION 'Cannot import products into a suspended customer account.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id) THEN
        RAISE EXCEPTION 'Target customer account does not exist.';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_products)
    LOOP
        v_row_idx := v_row_idx + 1;
        v_name := trim(COALESCE(v_item->>'name', ''));
        v_sku := NULLIF(trim(COALESCE(v_item->>'sku', '')), '');
        v_category := NULLIF(trim(COALESCE(v_item->>'category', '')), '');
        IF v_category IS NULL THEN v_category := 'Other'; END IF;
        
        v_selling_price := COALESCE((v_item->>'selling_price')::NUMERIC, 0);
        v_unit_cost := COALESCE((v_item->>'unit_cost')::NUMERIC, 0);
        v_quantity := COALESCE((v_item->>'quantity')::INTEGER, 0);
        v_minimum_stock := COALESCE((v_item->>'minimum_stock')::INTEGER, 0);
        v_supplier := NULLIF(trim(COALESCE(v_item->>'supplier', '')), '');
        v_emoji := NULLIF(trim(COALESCE(v_item->>'emoji', '')), '');
        IF v_emoji IS NULL THEN v_emoji := '📦'; END IF;

        IF v_name = '' THEN
            v_failed_rows := v_failed_rows || jsonb_build_object('row', v_row_idx, 'reason', 'Product name is required');
            CONTINUE;
        END IF;

        IF v_selling_price < 0 OR v_unit_cost < 0 THEN
            v_failed_rows := v_failed_rows || jsonb_build_object('row', v_row_idx, 'reason', 'Prices cannot be negative');
            CONTINUE;
        END IF;

        IF v_quantity < 0 OR v_minimum_stock < 0 THEN
            v_failed_rows := v_failed_rows || jsonb_build_object('row', v_row_idx, 'reason', 'Stock quantities cannot be negative');
            CONTINUE;
        END IF;

        IF v_sku IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM public.products
                WHERE user_id = p_target_user_id AND lower(sku) = lower(v_sku)
            ) INTO v_sku_exists;

            IF v_sku_exists THEN
                v_failed_rows := v_failed_rows || jsonb_build_object('row', v_row_idx, 'reason', 'SKU "' || v_sku || '" already exists in customer catalog');
                CONTINUE;
            END IF;
        END IF;

        INSERT INTO public.products (
            user_id, name, sku, category, unit_cost, selling_price, quantity, minimum_stock, emoji, supplier
        ) VALUES (
            p_target_user_id, v_name, v_sku, v_category, v_unit_cost, v_selling_price, v_quantity, v_minimum_stock, v_emoji, v_supplier
        ) RETURNING id INTO v_product_id;

        IF v_quantity > 0 THEN
            INSERT INTO public.stock_movements (
                user_id, product_id, movement_type, quantity, quantity_before, quantity_after, note
            ) VALUES (
                p_target_user_id, v_product_id, 'Restock', v_quantity, 0, v_quantity, 'Initial stock imported via StockSense Setup Assistance'
            );
        END IF;

        v_success_count := v_success_count + 1;
    END LOOP;

    INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
    VALUES (
        v_caller,
        'BULK_PRODUCT_IMPORT',
        'user',
        p_target_user_id::text,
        jsonb_build_object(
            'total_submitted', jsonb_array_length(p_products),
            'imported_count', v_success_count,
            'failed_count', jsonb_array_length(v_failed_rows),
            'failed_rows', v_failed_rows
        )
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'total_submitted', jsonb_array_length(p_products),
        'imported_count', v_success_count,
        'failed_count', jsonb_array_length(v_failed_rows),
        'failed_rows', v_failed_rows
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 15. ADMINISTRATIVE NON-OWNER USER PURGE
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_cleanup_non_owner_accounts()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller UUID;
    v_target RECORD;
    v_deleted_count INTEGER := 0;
    v_deleted_emails JSONB := '[]'::jsonb;
    v_owner_found BOOLEAN := FALSE;
    v_owner_id UUID;
BEGIN
    v_caller := auth.uid();
    IF NOT is_platform_owner(v_caller) THEN
        RAISE EXCEPTION 'Access denied: Only the Platform Owner can execute non-owner account cleanup.';
    END IF;

    -- Verify the owner account exists
    SELECT id INTO v_owner_id FROM auth.users WHERE LOWER(email) = 'ezeoforchioma2@gmail.com';
    IF v_owner_id IS NOT NULL THEN
        v_owner_found := TRUE;
        -- Ensure owner role is present in public.platform_roles
        INSERT INTO public.platform_roles (user_id, role, assigned_at, assigned_by)
        VALUES (v_owner_id, 'owner', NOW(), v_owner_id)
        ON CONFLICT (user_id) DO UPDATE SET role = 'owner', assigned_at = NOW();
    END IF;

    -- Iterate through all non-owner users
    FOR v_target IN
        SELECT id, email FROM auth.users
        WHERE LOWER(email) <> 'ezeoforchioma2@gmail.com'
    LOOP
        -- Pre-cleanup Audit Log
        IF to_regclass('public.admin_audit_logs') IS NOT NULL THEN
            INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
            VALUES (
                v_caller,
                'USER_PURGE_CLEANUP',
                'user',
                v_target.id::text,
                jsonb_build_object('email', v_target.email, 'purged_at', NOW())
            );
        END IF;

        -- Clear nullable references
        IF to_regclass('public.feedback') IS NOT NULL THEN
            UPDATE public.feedback SET user_id = NULL WHERE user_id = v_target.id;
        END IF;
        IF to_regclass('public.platform_roles') IS NOT NULL THEN
            UPDATE public.platform_roles SET assigned_by = NULL WHERE assigned_by = v_target.id;
        END IF;
        IF to_regclass('public.staff_permissions') IS NOT NULL THEN
            DELETE FROM public.staff_permissions WHERE user_id = v_target.id;
            UPDATE public.staff_permissions SET granted_by = NULL WHERE granted_by = v_target.id;
        END IF;
        IF to_regclass('public.platform_settings') IS NOT NULL THEN
            UPDATE public.platform_settings SET updated_by = NULL WHERE updated_by = v_target.id;
        END IF;

        -- Cascading delete of inventory data
        IF to_regclass('public.stock_movements') IS NOT NULL THEN
            DELETE FROM public.stock_movements WHERE user_id = v_target.id;
            IF to_regclass('public.products') IS NOT NULL THEN
                DELETE FROM public.stock_movements WHERE product_id IN (SELECT id FROM public.products WHERE user_id = v_target.id);
            END IF;
        END IF;
        IF to_regclass('public.products') IS NOT NULL THEN
            DELETE FROM public.products WHERE user_id = v_target.id;
        END IF;
        IF to_regclass('public.platform_roles') IS NOT NULL THEN
            DELETE FROM public.platform_roles WHERE user_id = v_target.id;
        END IF;
        IF to_regclass('public.profiles') IS NOT NULL THEN
            DELETE FROM public.profiles WHERE id = v_target.id;
        END IF;

        -- Delete from auth.users
        DELETE FROM auth.users WHERE id = v_target.id;

        v_deleted_count := v_deleted_count + 1;
        v_deleted_emails := v_deleted_emails || jsonb_build_array(v_target.email);
    END LOOP;

    RETURN jsonb_build_object(
        'success', TRUE,
        'purged_count', v_deleted_count,
        'purged_emails', v_deleted_emails,
        'owner_verified', v_owner_found,
        'owner_id', v_owner_id
    );
END;
$$;
