-- ============================================================================
-- StockSense Migration 002: Customer Feedback System
-- Safe, repeatable, and idempotent migration script
-- ============================================================================

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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON public.feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON public.feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON public.feedback(status);

-- 1. Any authenticated user can submit feedback
DROP POLICY IF EXISTS "feedback_insert_authenticated" ON public.feedback;
CREATE POLICY "feedback_insert_authenticated" ON public.feedback
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

-- 2. Users can only select their own feedback; platform admins/owners can view all
DROP POLICY IF EXISTS "feedback_select_own" ON public.feedback;
CREATE POLICY "feedback_select_own" ON public.feedback
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id OR is_platform_admin(auth.uid()));

-- 3. Only platform admins/owners can update feedback status
DROP POLICY IF EXISTS "feedback_update_admin" ON public.feedback;
CREATE POLICY "feedback_update_admin" ON public.feedback
    FOR UPDATE TO authenticated
    USING (is_platform_admin(auth.uid()))
    WITH CHECK (is_platform_admin(auth.uid()));

-- 4. Only platform admins/owners can delete feedback
DROP POLICY IF EXISTS "feedback_delete_admin" ON public.feedback;
CREATE POLICY "feedback_delete_admin" ON public.feedback
    FOR DELETE TO authenticated
    USING (is_platform_admin(auth.uid()));
