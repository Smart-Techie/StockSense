-- ============================================================================
-- StockSense Migration 004: Owner Safeguards & Non-Owner User Cleanup
-- "Know Your Stock. Grow Your Business."
-- ============================================================================
-- Target Supabase Project: https://fjwpzuaaxuwdbwwqfvdp.supabase.co
-- Permanent Protected Platform Owner: ezeoforchioma2@gmail.com
--
-- This migration:
-- 1. Hardens Owner protection in is_platform_owner, admin_toggle_suspension,
--    admin_assign_role, and admin_delete_user by hard-pinning the Owner email
--    'ezeoforchioma2@gmail.com' at the database kernel level.
-- 2. Provides safe pre-cleanup backup queries to export all user & inventory data.
-- 3. Provides an administrative RPC public.admin_cleanup_non_owner_accounts().
-- 4. Provides a standalone transactional script for the Supabase SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. HARDEN PLATFORM OWNER CHECK
-- ----------------------------------------------------------------------------
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
-- 2. HARDEN ADMIN SUSPENSION WITH OWNER EMAIL CHECK
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_toggle_suspension(
    p_target_user_id UUID,
    p_suspend BOOLEAN,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
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
    IF to_regclass('public.admin_audit_logs') IS NOT NULL THEN
        INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
        VALUES (
            v_caller,
            CASE WHEN p_suspend THEN 'USER_SUSPENDED' ELSE 'USER_REACTIVATED' END,
            'user',
            p_target_user_id::text,
            jsonb_build_object('reason', p_reason, 'email', v_target_email)
        );
    END IF;

    RETURN jsonb_build_object('success', TRUE, 'is_suspended', p_suspend);
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. HARDEN ROLE ASSIGNMENT WITH OWNER EMAIL CHECK
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_assign_role(
    p_target_user_id UUID,
    p_role TEXT -- 'admin', 'moderator', or 'none' to revoke
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller UUID;
    v_current_target_role TEXT;
    v_target_email TEXT;
    v_owner_count BIGINT;
BEGIN
    v_caller := auth.uid();
    IF NOT is_platform_owner(v_caller) THEN
        RAISE EXCEPTION 'Access denied: Only the Platform Owner can assign or revoke administrative roles.';
    END IF;

    SELECT email INTO v_target_email FROM auth.users WHERE id = p_target_user_id;
    SELECT role INTO v_current_target_role FROM public.platform_roles WHERE user_id = p_target_user_id;

    -- Privilege check: prevent removing or demoting the Platform Owner
    IF LOWER(COALESCE(v_target_email, '')) = 'ezeoforchioma2@gmail.com' AND p_role <> 'owner' THEN
        RAISE EXCEPTION 'Cannot remove or demote the Platform Owner account (ezeoforchioma2@gmail.com).';
    END IF;

    IF v_current_target_role = 'owner' AND p_role <> 'owner' THEN
        SELECT count(*) INTO v_owner_count FROM public.platform_roles WHERE role = 'owner';
        IF v_owner_count <= 1 THEN
            RAISE EXCEPTION 'Cannot remove the last remaining Platform Owner. Transfer ownership first.';
        END IF;
    END IF;

    IF p_role = 'none' OR p_role IS NULL THEN
        DELETE FROM public.platform_roles WHERE user_id = p_target_user_id;
        
        IF to_regclass('public.admin_audit_logs') IS NOT NULL THEN
            INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
            VALUES (v_caller, 'ROLE_REVOKED', 'user', p_target_user_id::text, jsonb_build_object('previous_role', v_current_target_role, 'email', v_target_email));
        END IF;
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

        IF to_regclass('public.admin_audit_logs') IS NOT NULL THEN
            INSERT INTO public.admin_audit_logs (actor_id, action, target_type, target_id, details)
            VALUES (v_caller, 'ROLE_ASSIGNED', 'user', p_target_user_id::text, jsonb_build_object('new_role', p_role, 'previous_role', v_current_target_role, 'email', v_target_email));
        END IF;
    END IF;

    RETURN jsonb_build_object('success', TRUE, 'role', p_role);
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. HARDEN ADMIN DELETE USER WITH OWNER EMAIL CHECK
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_user(
    p_target_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_caller UUID;
    v_caller_role TEXT;
    v_target_role TEXT;
    v_target_email TEXT;
    v_target_name TEXT;
BEGIN
    v_caller := auth.uid();
    IF NOT is_platform_admin(v_caller) THEN
        RAISE EXCEPTION 'Access denied: Platform administrator privileges required.';
    END IF;

    -- Self-deletion prevention
    IF v_caller = p_target_user_id THEN
        RAISE EXCEPTION 'You cannot delete your own administrator account.';
    END IF;

    -- Fetch target details
    SELECT email INTO v_target_email FROM auth.users WHERE id = p_target_user_id;
    SELECT full_name INTO v_target_name FROM public.profiles WHERE id = p_target_user_id;
    SELECT role INTO v_target_role FROM public.platform_roles WHERE user_id = p_target_user_id;
    v_caller_role := get_user_role(v_caller);

    -- Owner protection: Nobody can delete the Owner (checked both by role and by hard-pinned email)
    IF v_target_role = 'owner' OR LOWER(COALESCE(v_target_email, '')) = 'ezeoforchioma2@gmail.com' THEN
        RAISE EXCEPTION 'Cannot delete the Platform Owner account (ezeoforchioma2@gmail.com).';
    END IF;

    -- Hierarchy check: Only the Owner can delete other Admins
    IF v_target_role = 'admin' AND v_caller_role <> 'owner' THEN
        RAISE EXCEPTION 'Only the Platform Owner can delete an Administrator account.';
    END IF;

    -- Pre-deletion Audit Log
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

    -- Clear references where ON DELETE SET NULL applies
    IF to_regclass('public.feedback') IS NOT NULL THEN
        EXECUTE 'UPDATE public.feedback SET user_id = NULL WHERE user_id = $1' USING p_target_user_id;
    END IF;

    IF to_regclass('public.platform_roles') IS NOT NULL THEN
        UPDATE public.platform_roles SET assigned_by = NULL WHERE assigned_by = p_target_user_id;
    END IF;

    IF to_regclass('public.staff_permissions') IS NOT NULL THEN
        EXECUTE 'UPDATE public.staff_permissions SET granted_by = NULL WHERE granted_by = $1' USING p_target_user_id;
        EXECUTE 'DELETE FROM public.staff_permissions WHERE user_id = $1' USING p_target_user_id;
    END IF;

    IF to_regclass('public.platform_settings') IS NOT NULL THEN
        UPDATE public.platform_settings SET updated_by = NULL WHERE updated_by = p_target_user_id;
    END IF;

    -- Explicitly delete user stock movements and products in proper dependency order
    IF to_regclass('public.stock_movements') IS NOT NULL THEN
        DELETE FROM public.stock_movements WHERE user_id = p_target_user_id;
        IF to_regclass('public.products') IS NOT NULL THEN
            DELETE FROM public.stock_movements WHERE product_id IN (SELECT id FROM public.products WHERE user_id = p_target_user_id);
        END IF;
    END IF;

    IF to_regclass('public.products') IS NOT NULL THEN
        DELETE FROM public.products WHERE user_id = p_target_user_id;
    END IF;

    IF to_regclass('public.platform_roles') IS NOT NULL THEN
        DELETE FROM public.platform_roles WHERE user_id = p_target_user_id;
    END IF;

    IF to_regclass('public.profiles') IS NOT NULL THEN
        DELETE FROM public.profiles WHERE id = p_target_user_id;
    END IF;

    -- Delete from auth.users (Cascades to GoTrue session records)
    DELETE FROM auth.users WHERE id = p_target_user_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'deleted_user_id', p_target_user_id,
        'email', v_target_email
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. ADMINISTRATIVE NON-OWNER CLEANUP RPC
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

-- Grant execution permissions
GRANT EXECUTE ON FUNCTION public.is_platform_owner(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_toggle_suspension(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_role(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cleanup_non_owner_accounts() TO authenticated;

-- ============================================================================
-- 6. STANDALONE SUPABASE SQL EDITOR DIRECT EXECUTION SCRIPT
-- ============================================================================
-- The following block can be copied and pasted directly into the Supabase
-- SQL Editor (https://supabase.com/dashboard/project/fjwpzuaaxuwdbwwqfvdp/sql)
-- by an Administrator to immediately inspect, back up, and wipe non-owner users.

/*
-- A. PRE-CLEANUP AUDIT & BACKUP EXPORT
SELECT json_build_object(
    'backup_timestamp', NOW(),
    'users', (SELECT json_agg(u) FROM auth.users u),
    'profiles', (SELECT json_agg(p) FROM public.profiles p),
    'platform_roles', (SELECT json_agg(r) FROM public.platform_roles r),
    'products', (SELECT json_agg(pr) FROM public.products pr),
    'stock_movements', (SELECT json_agg(sm) FROM public.stock_movements sm)
) AS full_backup_snapshot;

-- B. SAFE TRANSACTIONAL CLEANUP SCRIPT
DO $$
DECLARE
    v_owner_email CONSTANT TEXT := 'ezeoforchioma2@gmail.com';
    v_owner_id UUID;
    v_purged_count INTEGER := 0;
    v_rec RECORD;
BEGIN
    -- 1. Verify owner account exists
    SELECT id INTO v_owner_id FROM auth.users WHERE LOWER(email) = v_owner_email;
    IF v_owner_id IS NULL THEN
        RAISE EXCEPTION 'ABORT: Owner account % not found in auth.users! Aborting cleanup.', v_owner_email;
    END IF;

    -- 2. Ensure owner has Platform Owner role
    INSERT INTO public.platform_roles (user_id, role, assigned_at, assigned_by)
    VALUES (v_owner_id, 'owner', NOW(), v_owner_id)
    ON CONFLICT (user_id) DO UPDATE SET role = 'owner', assigned_at = NOW();

    -- 3. Delete non-owner inventory data
    DELETE FROM public.stock_movements 
    WHERE user_id <> v_owner_id 
       OR product_id IN (SELECT id FROM public.products WHERE user_id <> v_owner_id);

    DELETE FROM public.products WHERE user_id <> v_owner_id;

    -- 4. Clear staff and audit references
    IF to_regclass('public.staff_permissions') IS NOT NULL THEN
        DELETE FROM public.staff_permissions WHERE user_id <> v_owner_id;
        UPDATE public.staff_permissions SET granted_by = v_owner_id WHERE granted_by <> v_owner_id;
    END IF;

    IF to_regclass('public.feedback') IS NOT NULL THEN
        UPDATE public.feedback SET user_id = NULL WHERE user_id <> v_owner_id;
    END IF;

    DELETE FROM public.platform_roles WHERE user_id <> v_owner_id;
    DELETE FROM public.profiles WHERE id <> v_owner_id;

    -- 5. Delete from auth.users (Cascading to GoTrue sessions)
    DELETE FROM auth.users WHERE LOWER(email) <> v_owner_email;
    GET DIAGNOSTICS v_purged_count = ROW_COUNT;

    RAISE NOTICE 'SUCCESS: Successfully removed % non-owner user accounts.', v_purged_count;
    RAISE NOTICE 'SUCCESS: Owner account % (ID: %) is verified and active.', v_owner_email, v_owner_id;
END;
$$;
*/
