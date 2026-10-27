-- ============================================================================
-- StockSense Migration 005: Verified Supabase Auth User Deletion
-- "Know Your Stock. Grow Your Business."
-- ============================================================================
-- Target Supabase Project: https://fjwpzuaaxuwdbwwqfvdp.supabase.co
-- Permanent Protected Platform Owner: ezeoforchioma2@gmail.com
--
-- WHY THIS EXISTS
--   Previously, if the deletion RPC failed or encountered constraints,
--   the client fell back to deleting only public.profiles or hiding the user
--   in localStorage. The underlying Supabase Auth user (auth.users) was
--   never deleted. As a result, subsequent registration attempts with the same
--   email returned "An account with that email already exists. Please sign in."
--
-- WHAT THIS DOES
--   1. Replaces public.admin_delete_user(p_target_user_id UUID):
--      - Enforces platform administrator authorization on the server.
--      - Locks and checks the actual auth.users record.
--      - Hard-protects the Owner account (ezeoforchioma2@gmail.com).
--      - Prevents self-deletion and non-owner deletion of administrators.
--      - Cleans up child inventory, permissions, and roles in exact dependency order.
--      - Preserves feedback and audit logs with actor/user set to NULL.
--      - Permanently deletes from auth.users.
--      - Verifies that auth.users and auth.identities rows are gone; if not,
--        raises an exception and rolls back the ENTIRE transaction.
--   2. Adds public.admin_delete_user_by_email(p_target_email TEXT):
--      - Resolves the user by email and safely delegates to admin_delete_user.
--   3. Secures permissions: REVOKE from public/anon, GRANT only to authenticated.
--   4. Provides diagnostic queries to identify any orphaned auth users without profiles.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. HARDENED ADMIN DELETE USER (BY UUID)
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

    -- 3. Owner protection (role, owner function, and hard-pinned email).
    IF v_target_role = 'owner'
       OR is_platform_owner(p_target_user_id)
       OR LOWER(COALESCE(v_target_email, '')) = c_owner_email THEN
        RAISE EXCEPTION 'Cannot delete the Platform Owner account (ezeoforchioma2@gmail.com).';
    END IF;

    -- 4. Hierarchy: only the Owner can delete an Administrator.
    IF v_target_role = 'admin' AND v_caller_role IS DISTINCT FROM 'owner' THEN
        RAISE EXCEPTION 'Only the Platform Owner can delete an Administrator account.';
    END IF;

    -- 5. Audit entry (retained: actor is caller, target stored as text).
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

    -- 6. Related records, mirroring the schema's FK retention rules.
    --    Retained (ON DELETE SET NULL): feedback, audit logs, settings updated_by.
    IF to_regclass('public.feedback') IS NOT NULL THEN
        EXECUTE 'UPDATE public.feedback SET user_id = NULL WHERE user_id = $1' USING p_target_user_id;
        GET DIAGNOSTICS v_feedback = ROW_COUNT;
    END IF;
    UPDATE public.platform_roles SET assigned_by = NULL WHERE assigned_by = p_target_user_id;
    IF to_regclass('public.platform_settings') IS NOT NULL THEN
        EXECUTE 'UPDATE public.platform_settings SET updated_by = NULL WHERE updated_by = $1' USING p_target_user_id;
    END IF;
    IF to_regclass('public.staff_permissions') IS NOT NULL THEN
        EXECUTE 'UPDATE public.staff_permissions SET granted_by = NULL WHERE granted_by = $1' USING p_target_user_id;
    END IF;

    --    Removed (ON DELETE CASCADE): user's own stock movements, products, permissions, roles, profiles.
    DELETE FROM public.stock_movements
    WHERE user_id = p_target_user_id
       OR product_id IN (SELECT id FROM public.products WHERE user_id = p_target_user_id);
    GET DIAGNOSTICS v_movements = ROW_COUNT;

    DELETE FROM public.products WHERE user_id = p_target_user_id;
    GET DIAGNOSTICS v_products = ROW_COUNT;

    IF to_regclass('public.staff_permissions') IS NOT NULL THEN
        EXECUTE 'DELETE FROM public.staff_permissions WHERE user_id = $1' USING p_target_user_id;
        GET DIAGNOSTICS v_permissions = ROW_COUNT;
    END IF;

    DELETE FROM public.platform_roles WHERE user_id = p_target_user_id;
    GET DIAGNOSTICS v_roles = ROW_COUNT;

    DELETE FROM public.profiles WHERE id = p_target_user_id;
    GET DIAGNOSTICS v_profiles = ROW_COUNT;

    -- 7. Delete the Supabase Auth account itself (cascades to GoTrue sessions and identities).
    DELETE FROM auth.users WHERE id = p_target_user_id;
    GET DIAGNOSTICS v_auth_deleted = ROW_COUNT;

    -- 8. Verification: must delete exactly 1 auth row and no identity should remain.
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

-- ----------------------------------------------------------------------------
-- 2. HARDENED ADMIN DELETE USER (BY EMAIL)
-- ----------------------------------------------------------------------------
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

    -- Delegate to the primary deletion procedure
    RETURN public.admin_delete_user(v_target_id);
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. PERMISSIONS & SECURITY
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_delete_user(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_delete_user(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_delete_user_by_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_delete_user_by_email(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_user_by_email(TEXT) TO authenticated;

-- ============================================================================
-- 4. DIAGNOSTIC QUERY: FIND ORPHANED AUTH USERS
-- ============================================================================
-- Run this in the Supabase SQL Editor to check if any test user accounts
-- exist in auth.users without a matching public.profiles row:
/*
SELECT 
    u.id AS auth_user_id,
    u.email,
    u.created_at,
    u.last_sign_in_at,
    (p.id IS NOT NULL) AS has_profile,
    (r.role) AS platform_role
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
LEFT JOIN public.platform_roles r ON r.user_id = u.id
WHERE LOWER(u.email) <> 'ezeoforchioma2@gmail.com'
ORDER BY u.created_at DESC;
*/

-- ============================================================================
-- 5. STANDALONE SAFE ONE-OFF CLEANUP SCRIPT (FOR A SPECIFIC TEST EMAIL)
-- ============================================================================
-- If you need to clean up one specific test email (e.g. 'test@example.com')
-- directly in the Supabase SQL Editor without affecting other users:
/*
DO $$
DECLARE
    v_clean_email CONSTANT TEXT := 'ENTER_TEST_EMAIL_HERE';
    v_user_id UUID;
    v_owner_email CONSTANT TEXT := 'ezeoforchioma2@gmail.com';
BEGIN
    IF LOWER(v_clean_email) = v_owner_email THEN
        RAISE EXCEPTION 'ABORT: Cannot clean up the Owner account!';
    END IF;

    SELECT id INTO v_user_id FROM auth.users WHERE LOWER(email) = LOWER(v_clean_email);
    IF v_user_id IS NULL THEN
        RAISE NOTICE 'No auth user found with email %', v_clean_email;
        RETURN;
    END IF;

    -- Delete inventory and related records
    DELETE FROM public.stock_movements WHERE user_id = v_user_id;
    DELETE FROM public.products WHERE user_id = v_user_id;
    IF to_regclass('public.staff_permissions') IS NOT NULL THEN
        EXECUTE 'DELETE FROM public.staff_permissions WHERE user_id = $1' USING v_user_id;
    END IF;
    DELETE FROM public.platform_roles WHERE user_id = v_user_id;
    DELETE FROM public.profiles WHERE id = v_user_id;
    DELETE FROM auth.users WHERE id = v_user_id;

    RAISE NOTICE 'SUCCESS: Successfully removed % (ID: %) from auth.users and all related tables.', v_clean_email, v_user_id;
END;
$$;
*/
