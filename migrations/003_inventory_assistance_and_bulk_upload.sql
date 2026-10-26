-- ============================================================================
-- StockSense Migration 003: Inventory Setup Assistance & Bulk Product Upload
-- ============================================================================

-- 1. Create Staff Permissions Table
-- ----------------------------------------------------------------------------
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

-- 2. Helper function: has_staff_permission
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_staff_permission(p_user_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Owner has all staff permissions
    IF is_platform_owner(p_user_id) THEN
        RETURN TRUE;
    END IF;

    -- Check explicit staff permissions for staff members (admin or moderator)
    RETURN EXISTS (
        SELECT 1 FROM public.staff_permissions sp
        JOIN public.platform_roles r ON r.user_id = sp.user_id
        WHERE sp.user_id = p_user_id
          AND sp.permission = p_permission
          AND r.role IN ('owner', 'admin', 'moderator')
    );
END;
$$;

-- 3. Staff Permission Management RPC
-- ----------------------------------------------------------------------------
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

    -- Verify target user is a staff member (owner, admin, moderator)
    SELECT role INTO v_target_role FROM public.platform_roles WHERE user_id = p_target_user_id;
    IF v_target_role IS NULL THEN
        RAISE EXCEPTION 'Cannot assign staff permissions to an ordinary user. Assign a staff role (admin or moderator) first.';
    END IF;

    -- Admin cannot modify Owner permissions
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

-- 4. Secure Staff Bulk Import Products RPC
-- ----------------------------------------------------------------------------
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
    
    -- 1. Security Check: Caller must have bulk_product_upload permission
    IF NOT has_staff_permission(v_caller, 'bulk_product_upload') THEN
        RAISE EXCEPTION 'Access denied: You do not possess the bulk_product_upload permission.';
    END IF;

    -- 2. Target Account Verification
    SELECT is_suspended INTO v_target_suspended FROM public.profiles WHERE id = p_target_user_id;
    IF v_target_suspended IS TRUE THEN
        RAISE EXCEPTION 'Cannot import products into a suspended customer account.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id) THEN
        RAISE EXCEPTION 'Target customer account does not exist.';
    END IF;

    -- 3. Process each submitted product row
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

        -- Row validation
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

        -- Check for SKU collision in customer's catalog
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

        -- Insert product
        INSERT INTO public.products (
            user_id, name, sku, category, unit_cost, selling_price, quantity, minimum_stock, emoji, supplier
        ) VALUES (
            p_target_user_id, v_name, v_sku, v_category, v_unit_cost, v_selling_price, v_quantity, v_minimum_stock, v_emoji, v_supplier
        ) RETURNING id INTO v_product_id;

        -- Record initial stock movement if quantity > 0
        IF v_quantity > 0 THEN
            INSERT INTO public.stock_movements (
                user_id, product_id, movement_type, quantity, quantity_before, quantity_after, note
            ) VALUES (
                p_target_user_id, v_product_id, 'Restock', v_quantity, 0, v_quantity, 'Initial stock imported via StockSense Setup Assistance'
            );
        END IF;

        v_success_count := v_success_count + 1;
    END LOOP;

    -- 4. Record Audit Log
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
