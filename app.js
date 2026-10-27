/**
 * StockSense Version 1.0 — Core Application & Platform Administration
 * "Know Your Stock. Grow Your Business."
 */

(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Configuration & Supabase Client
    // -------------------------------------------------------------------------
    const SUPABASE_URL = window.SUPABASE_URL || "https://fjwpzuaaxuwdbwwqfvdp.supabase.co";
    const SUPABASE_KEY = window.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_gzpj6caQ257Ah5vLw3c66Q_6aGZGtBk";

    if (!window.supabase) {
        console.error("Supabase client library not loaded. Check CDN script tag.");
    }

    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        }
    });

    // -------------------------------------------------------------------------
    // Application State
    // -------------------------------------------------------------------------
    const state = {
        currentUser: null,
        currentProfile: null,
        currentRole: null, // 'owner', 'admin', 'moderator', or null
        dbReady: false,
        products: [],
        moves: [],
        currentView: 'dashboard',
        adminTab: 'overview',
        adminUsers: [],
        adminTotalUsers: 0,
        adminUserOffset: 0,
        adminUserLimit: 15,
        adminAuditLogs: [],
        staffPermissions: [],
        bulkUploadState: {
            targetCustomer: null,
            parsedProducts: [],
            validProducts: [],
            invalidRows: []
        },
        platformSettings: {
            platform_name: "StockSense",
            currency_symbol: "₦",
            currency_code: "NGN",
            maintenance_mode: false,
            low_stock_default: 5,
            support_whatsapp: ""
        }
    };

    // -------------------------------------------------------------------------
    // Utility Helpers
    // -------------------------------------------------------------------------
    const $ = id => document.getElementById(id);
    const cash = n => (state.platformSettings.currency_symbol || '₦') + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const fmt = n => Number(n || 0).toLocaleString('en-NG');
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    
    function st(p) {
        const qty = Number(p.quantity || 0);
        const min = Number(p.minimum_stock || 0);
        if (qty <= 0) return 'out';
        if (qty <= min) return 'low';
        return 'ok';
    }

    function statusLabel(s) {
        if (s === 'ok') return 'In stock';
        if (s === 'low') return 'Low stock';
        return 'Out of stock';
    }

    function datefmt(d) {
        if (!d) return '—';
        return new Date(d).toLocaleString('en-NG', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function notify(message, type = 'info') {
        const toastEl = $('toast');
        if (!toastEl) return;
        toastEl.innerHTML = `<div class="toast ${type}" role="alert">${esc(message)}</div>`;
        setTimeout(() => {
            if (toastEl.innerHTML.includes(message)) {
                toastEl.innerHTML = '';
            }
        }, 3600);
    }

    function generateUniqueSKU(category, existingProducts) {
        const catMap = {
            'Chargers': 'CHG',
            'Power banks': 'PWR',
            'Audio': 'AUD',
            'Cables': 'CBL',
            'Phone accessories': 'PHN',
            'Computer accessories': 'CMP',
            'Other': 'GEN'
        };
        const prefix = catMap[category] || (category ? category.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X') : 'STK');
        let sku = '';
        let attempts = 0;
        do {
            const randomNum = Math.floor(1000 + Math.random() * 9000);
            sku = `${prefix}-${randomNum}`;
            attempts++;
        } while (existingProducts.some(p => (p.sku || '').toLowerCase() === sku.toLowerCase()) && attempts < 100);
        return sku;
    }

    // -------------------------------------------------------------------------
    // Session Inactivity Tracking (30-minute auto sign-out)
    // -------------------------------------------------------------------------
    const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes in milliseconds
    const INACTIVITY_STORAGE_KEY = 'stocksense_last_activity';
    const INACTIVITY_LAST_EMAIL_KEY = 'stocksense_last_email';
    let isSigningOutDueToTimeout = false;
    let lastActivityThrottle = 0;

    function getLastActivityTimestamp() {
        try {
            const val = localStorage.getItem(INACTIVITY_STORAGE_KEY);
            return val ? parseInt(val, 10) : 0;
        } catch {
            return 0;
        }
    }

    function recordUserActivity() {
        if (!state.currentUser) return;
        const now = Date.now();
        try {
            localStorage.setItem(INACTIVITY_STORAGE_KEY, String(now));
        } catch {
            // Ignore storage access errors
        }
    }

    function onUserInteraction() {
        if (!state.currentUser) return;
        const now = Date.now();
        // Throttle writing to localStorage to at most once every 10 seconds
        if (now - lastActivityThrottle > 10000) {
            lastActivityThrottle = now;
            recordUserActivity();
        }
    }

    async function triggerInactivitySignOut() {
        if (isSigningOutDueToTimeout) return;
        isSigningOutDueToTimeout = true;
        console.warn('[StockSense] Session expired: 30 minutes of inactivity elapsed.');

        const emailToPreserve = state.currentUser?.email || localStorage.getItem(INACTIVITY_LAST_EMAIL_KEY) || '';
        if (emailToPreserve) {
            try {
                localStorage.setItem(INACTIVITY_LAST_EMAIL_KEY, emailToPreserve);
            } catch {}
        }

        try {
            localStorage.removeItem(INACTIVITY_STORAGE_KEY);
        } catch {}

        try {
            await supabase.auth.signOut();
        } catch (err) {
            console.warn('Sign out during timeout:', err);
        }

        state.currentUser = null;
        state.currentProfile = null;
        state.currentRole = null;
        state.products = [];
        state.moves = [];

        showAuthScreen(
            'signin',
            'Your session expired after 30 minutes of inactivity. Please sign in again to continue.',
            'info'
        );

        setTimeout(() => {
            const emailInput = $('signin-email');
            if (emailInput && emailToPreserve) {
                emailInput.value = emailToPreserve;
                $('signin-password')?.focus();
            }
            isSigningOutDueToTimeout = false;
        }, 80);
    }

    async function checkInactivityTimeout() {
        if (!state.currentUser) return;
        const last = getLastActivityTimestamp();
        if (!last) {
            recordUserActivity();
            return;
        }
        const elapsed = Date.now() - last;
        if (elapsed >= INACTIVITY_TIMEOUT_MS) {
            await triggerInactivitySignOut();
        }
    }

    // -------------------------------------------------------------------------
    // Auth & Session Management
    // -------------------------------------------------------------------------
    function getAuthRedirectUrl() {
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        if (isLocalhost) {
            return `${window.location.origin}/auth/verify`;
        }
        if (window.location.origin && !window.location.origin.includes('localhost') && !window.location.origin.includes('127.0.0.1')) {
            return `${window.location.origin}/auth/verify`;
        }
        return 'https://stocksense-psi.vercel.app/auth/verify';
    }

    /**
     * Dev-preview mock mode (localhost only, via ?preview=owner|admin|moderator|member).
     * It never talks to the backend, so it must never be available on a deployed host.
     */
    function isPreviewMode() {
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        return !!(isLocalhost && new URLSearchParams(window.location.search).get('preview'));
    }

    /**
     * Preview-mode only: remembers which MOCK users were "deleted" in the simulated admin list.
     * These helpers are never used against real Supabase data.
     */
    function getDeletedUserIds() {
        try {
            return JSON.parse(localStorage.getItem('stocksense_deleted_user_ids') || '[]');
        } catch {
            return [];
        }
    }

    function markUserAsDeleted(userId) {
        if (!userId) return;
        try {
            const ids = getDeletedUserIds();
            if (!ids.includes(userId)) {
                ids.push(userId);
                localStorage.setItem('stocksense_deleted_user_ids', JSON.stringify(ids));
            }
        } catch {}
    }

    /**
     * Convert a Supabase/Postgres error into a safe, user-facing message.
     * Messages raised deliberately by our SQL functions use SQLSTATE P0001 and are safe to show;
     * anything else (constraint names, internal errors) is logged and replaced by a generic text.
     */
    function friendlyAdminError(err, fallback) {
        if (err && err.code === 'P0001' && err.message) return err.message;
        if (err && (err.code === '42883' || err.code === 'PGRST202')) {
            return 'This administrative action is not available on the server yet. Apply the latest database migration and try again.';
        }
        console.error('Administrative operation failed:', err);
        return fallback;
    }

    async function initSession() {
        showAuthScreen('loading');

        // Check for dev preview parameter (localhost / 127.0.0.1 only)
        const urlParams = new URLSearchParams(window.location.search);
        const previewRole = urlParams.get('preview');
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const isPreviewAllowed = isLocalhost;

        if (isPreviewAllowed && previewRole) {
            recordUserActivity();
            const isOwner = previewRole === 'owner';
            const isAdmin = previewRole === 'admin';
            const isModerator = previewRole === 'moderator';

            const mockUser = {
                id: isOwner ? '00000000-0000-0000-0000-000000000001' : (isAdmin ? '00000000-0000-0000-0000-000000000002' : (isModerator ? '00000000-0000-0000-0000-000000000003' : '00000000-0000-0000-0000-000000000004')),
                email: isOwner ? 'owner@stocksense.io' : (isAdmin ? 'admin@stocksense.io' : (isModerator ? 'moderator@stocksense.io' : 'store@stocksense.io')),
                user_metadata: { full_name: isOwner ? 'Malcolm Jude (Owner)' : (isAdmin ? 'Admin Staff' : (isModerator ? 'Tunde Operations (Staff)' : 'Sarah Business Store')) }
            };
            state.currentUser = mockUser;
            state.currentProfile = {
                id: mockUser.id,
                full_name: mockUser.user_metadata.full_name,
                is_suspended: false
            };
            state.currentRole = isOwner ? 'owner' : (isAdmin ? 'admin' : (isModerator ? 'moderator' : null));

            // Set staff permissions for preview
            if (isOwner || isAdmin) {
                state.staffPermissions = ['bulk_product_upload'];
            } else if (isModerator) {
                state.staffPermissions = urlParams.get('perm') === 'bulk' ? ['bulk_product_upload'] : [];
            } else {
                state.staffPermissions = [];
            }

            const mockUsersKey = 'stocksense_mock_admin_users';
            let initialMockUsers = [
                { id: '00000000-0000-0000-0000-000000000004', email: 'store@stocksense.io', full_name: 'Sarah Business Store', role: 'member', is_suspended: false, created_at: new Date(Date.now() - 30 * 86400000).toISOString(), last_sign_in_at: new Date().toISOString() },
                { id: '00000000-0000-0000-0000-000000000005', email: 'chidi@electronics.ng', full_name: 'Chidi Electronics Lagos', role: 'member', is_suspended: false, created_at: new Date(Date.now() - 20 * 86400000).toISOString(), last_sign_in_at: new Date().toISOString() },
                { id: '00000000-0000-0000-0000-000000000006', email: 'amina@boutique.ng', full_name: 'Amina Fashion & Fabrics', role: 'member', is_suspended: false, created_at: new Date(Date.now() - 15 * 86400000).toISOString(), last_sign_in_at: new Date().toISOString() },
                { id: '00000000-0000-0000-0000-000000000003', email: 'moderator@stocksense.io', full_name: 'Tunde Operations (Staff)', role: 'moderator', is_suspended: false, created_at: new Date(Date.now() - 10 * 86400000).toISOString(), last_sign_in_at: new Date().toISOString() }
            ];
            try {
                const storedMockUsers = localStorage.getItem(mockUsersKey);
                if (storedMockUsers !== null) {
                    initialMockUsers = JSON.parse(storedMockUsers);
                } else {
                    localStorage.setItem(mockUsersKey, JSON.stringify(initialMockUsers));
                }
            } catch {}

            const deletedIds = getDeletedUserIds();
            state.adminUsers = (initialMockUsers || []).filter(u => !deletedIds.includes(u.id));
            state.adminTotalUsers = state.adminUsers.length;

            state.products = [
                { id: 'p1', user_id: mockUser.id, name: 'USB-C Fast Charger', sku: 'CHG-1024', category: 'Chargers', unit_cost: 1500, selling_price: 3500, quantity: 3, minimum_stock: 10, emoji: '🔌', supplier: 'Lagos Tech Dist' },
                { id: 'p2', user_id: mockUser.id, name: '20,000mAh Power Bank', sku: 'PWR-2048', category: 'Power banks', unit_cost: 8500, selling_price: 14000, quantity: 8, minimum_stock: 5, emoji: '🔋', supplier: 'Abuja Gadget Imports' },
                { id: 'p3', user_id: mockUser.id, name: 'Bluetooth Earbuds', sku: 'AUD-3012', category: 'Audio', unit_cost: 6500, selling_price: 11000, quantity: 0, minimum_stock: 6, emoji: '🎧', supplier: 'SoundWave Nigeria' },
                { id: 'p4', user_id: mockUser.id, name: 'Braided Type-C Cable', sku: 'CBL-4096', category: 'Cables', unit_cost: 900, selling_price: 2200, quantity: 24, minimum_stock: 8, emoji: '〰️', supplier: 'Lagos Tech Dist' },
                { id: 'p5', user_id: mockUser.id, name: 'Wireless Ergonomic Mouse', sku: 'CMP-5120', category: 'Computer accessories', unit_cost: 4000, selling_price: 7500, quantity: 2, minimum_stock: 5, emoji: '🖱️', supplier: 'Computer Village Direct' }
            ];
            state.moves = [
                { id: 'm1', product_id: 'p1', movement_type: 'Sale', quantity: 2, quantity_before: 5, quantity_after: 3, note: 'Counter walk-in customer', created_at: new Date(Date.now() - 3600000).toISOString() },
                { id: 'm2', product_id: 'p3', movement_type: 'Sale', quantity: 2, quantity_before: 2, quantity_after: 0, note: 'Out of stock - last units sold', created_at: new Date(Date.now() - 86400000).toISOString() },
                { id: 'm3', product_id: 'p4', movement_type: 'Restock', quantity: 15, quantity_before: 9, quantity_after: 24, note: 'Batch restock delivery', created_at: new Date(Date.now() - 172800000).toISOString() },
                { id: 'm4', product_id: 'p2', movement_type: 'Adjustment', quantity: 1, quantity_before: 7, quantity_after: 8, note: 'Inventory count reconciliation', created_at: new Date(Date.now() - 259200000).toISOString() }
            ];

            updateUserSidebarInfo(mockUser, state.currentProfile, state.currentRole);
            $('auth-screen').style.display = 'none';
            $('app-root').style.display = '';

            if (window.location.hash === '#admin') {
                if (isAdminOrOwner() || canBulkUpload()) {
                    go('admin');
                } else {
                    window.location.hash = '';
                    go('dashboard');
                    notify('Access denied. Administrator privileges required.', 'error');
                }
            } else {
                go('dashboard');
            }
            render();
            recommend();
            notify(`Dev Mode: Loaded as ${previewRole.toUpperCase()}. All features active.`, 'info');
            activatePwaPromptForSession();
            return;
        }

        // 1. Inspect URL parameters and fragments for verification callback or auth errors
        const rawHash = window.location.hash || '';
        const hashParams = new URLSearchParams(rawHash.replace(/^#/, ''));
        const path = window.location.pathname.replace(/\/+$/, '');
        const isVerifyPath = path.endsWith('/auth/verify') || path.endsWith('/auth/verify.html');
        const hasVerifyHash = rawHash.includes('type=signup') || rawHash.includes('type=email_change');
        const hasVerifyQuery = urlParams.get('type') === 'signup' || urlParams.get('type') === 'email_change';

        // Check for error parameters in hash or query (e.g. otp_expired, access_denied, invalid token)
        const authError = hashParams.get('error') || urlParams.get('error') || hashParams.get('error_code') || urlParams.get('error_code');
        const authErrorDesc = hashParams.get('error_description') || urlParams.get('error_description');

        if (authError || (isVerifyPath && (authError || authErrorDesc))) {
            showAuthScreen('verify-invalid', {
                code: authError,
                description: authErrorDesc || 'The verification link may have expired or already been used.'
            });
            try {
                history.replaceState(null, '', isVerifyPath ? '/auth/verify' : '/');
            } catch {}
            return;
        }

        // Check for PKCE exchange code (?code=...)
        const pkceCode = urlParams.get('code');
        if (pkceCode) {
            showAuthScreen('verifying');
            try {
                const { data, error } = await supabase.auth.exchangeCodeForSession(pkceCode);
                if (error) {
                    showAuthScreen('verify-invalid', { code: error.code || 'code_exchange_failed', description: error.message });
                } else if (data && data.session && data.session.user) {
                    showAuthScreen('verify-success', data.session.user);
                } else {
                    showAuthScreen('verify-invalid', { description: 'Could not establish verified session.' });
                }
            } catch (err) {
                showAuthScreen('verify-invalid', { description: err.message });
            }
            try {
                history.replaceState(null, '', isVerifyPath ? '/auth/verify' : '/');
            } catch {}
            return;
        }

        // Check for password recovery hash in URL
        if (rawHash && rawHash.includes('type=recovery')) {
            showAuthScreen('recovery');
            return;
        }

        // Check for email verification via hash or verify route
        if (isVerifyPath || hasVerifyHash) {
            showAuthScreen('verifying');
            // Give client brief moment to parse hash tokens if present
            await new Promise(r => setTimeout(r, 450));
            const { data, error } = await supabase.auth.getSession();
            if (error) {
                showAuthScreen('verify-invalid', { description: error.message });
            } else if (data && data.session && data.session.user) {
                showAuthScreen('verify-success', data.session.user);
            } else {
                // If on /auth/verify without active session or tokens
                showAuthScreen('verify-invalid', { description: 'The verification link may have expired or already been used.' });
            }
            try {
                history.replaceState(null, '', isVerifyPath ? '/auth/verify' : '/');
            } catch {}
            return;
        }

        // Attach listener for async auth events (e.g. hash token resolution)
        supabase.auth.onAuthStateChange(async (event, session) => {
            if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && session?.user) {
                if (isVerifyPath || hasVerifyHash || urlParams.get('type') === 'signup') {
                    showAuthScreen('verify-success', session.user);
                }
            }
        });

        const { data, error } = await supabase.auth.getSession();

        if (error) {
            console.error('Session retrieval error:', error);
            showAuthScreen('signin', 'Could not restore previous session. Please sign in.');
            return;
        }

        if (data && data.session) {
            // Check if user was inactive for >= 30 minutes before returning to browser
            const last = getLastActivityTimestamp();
            if (last && (Date.now() - last) >= INACTIVITY_TIMEOUT_MS) {
                await triggerInactivitySignOut();
                return;
            }
            recordUserActivity();
            await handleAuthenticatedSession(data.session.user);
        } else {
            showAuthScreen('signin');
        }
    }

    async function handleAuthenticatedSession(user) {
        state.currentUser = user;
        recordUserActivity();
        if (user.email) {
            try {
                localStorage.setItem(INACTIVITY_LAST_EMAIL_KEY, user.email);
            } catch {}
        }

        // Fetch or create profile & check suspension
        const profile = await fetchOrCreateProfile(user);
        state.currentProfile = profile;

        if (profile && profile.is_suspended) {
            await supabase.auth.signOut();
            state.currentUser = null;
            state.currentProfile = null;
            state.currentRole = null;
            showAuthScreen('signin', `Your account has been suspended by an administrator. Reason: ${profile.suspension_reason || 'Administrative hold'}. Please contact support.`);
            return;
        }

        // Fetch administrative role & staff permissions
        state.currentRole = await fetchUserRole(user.id);
        state.staffPermissions = await fetchStaffPermissions(user.id);
        if (!state.currentRole) {
            await checkOwnerExists();
        }

        // Update UI
        updateUserSidebarInfo(user, profile, state.currentRole);

        // Load inventory data
        await loadInventoryData(user.id);

        // Transition from auth to application
        $('auth-screen').style.display = 'none';
        $('app-root').style.display = '';

        // Check if navigated directly to #admin
        if (window.location.hash === '#admin') {
            if (isAdminOrOwner() || canBulkUpload()) {
                go('admin');
            } else {
                go('dashboard');
                notify('Administrator privileges required to access Admin Dashboard.', 'error');
            }
        } else {
            go('dashboard');
        }

        // Authentication fully resolved and the app is visible: the install prompt may now be offered.
        activatePwaPromptForSession();
    }

    async function fetchOrCreateProfile(user) {
        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .maybeSingle();

            if (data) return data;

            // If profile does not exist, insert it safely
            const fullName = user.user_metadata?.full_name || user.email.split('@')[0];
            const { data: newProfile, error: insertError } = await supabase
                .from('profiles')
                .insert({
                    id: user.id,
                    full_name: fullName,
                    is_suspended: false
                })
                .select()
                .single();

            if (insertError) {
                console.warn('Profile creation fallback:', insertError.message);
                return { id: user.id, full_name: fullName, is_suspended: false };
            }
            return newProfile;
        } catch (err) {
            console.error('Error in fetchOrCreateProfile:', err);
            return { id: user.id, full_name: user.email.split('@')[0], is_suspended: false };
        }
    }

    async function fetchUserRole(userId) {
        try {
            const { data, error } = await supabase
                .from('platform_roles')
                .select('role')
                .eq('user_id', userId)
                .maybeSingle();

            if (error || !data) return null;
            return data.role;
        } catch (err) {
            return null;
        }
    }

    async function fetchStaffPermissions(userId) {
        if (!userId) return [];
        try {
            const { data, error } = await supabase
                .from('staff_permissions')
                .select('permission')
                .eq('user_id', userId);

            if (error || !data) return [];
            return data.map(x => x.permission);
        } catch {
            return [];
        }
    }

    let hasCheckedInitialOwner = false;
    let initialOwnerExists = true;
    async function checkOwnerExists() {
        if (hasCheckedInitialOwner) return initialOwnerExists;
        try {
            const { count, error } = await supabase.from('platform_roles').select('*', { count: 'exact', head: true }).eq('role', 'owner');
            if (!error) {
                initialOwnerExists = (count || 0) > 0;
                hasCheckedInitialOwner = true;
            }
        } catch {}
        return initialOwnerExists;
    }

    function isAdminOrOwner() {
        if (state.currentRole === 'owner' || state.currentRole === 'admin') return true;
        if (!initialOwnerExists) return true;
        return false;
    }

    function canBulkUpload() {
        if (state.currentRole === 'owner' || state.currentRole === 'admin') return true;
        if (!initialOwnerExists) return true;
        return Array.isArray(state.staffPermissions) && state.staffPermissions.includes('bulk_product_upload');
    }

    function updateUserSidebarInfo(user, profile, role) {
        const nameEl = $('sidebar-user-name');
        const emailEl = $('sidebar-user-email');
        const avatarEl = $('sidebar-user-avatar');
        const adminBtn = $('nav-btn-admin');

        const displayName = profile?.full_name || user.user_metadata?.full_name || user.email.split('@')[0];
        if (nameEl) nameEl.textContent = displayName;
        if (emailEl) emailEl.textContent = user.email;
        if (avatarEl) avatarEl.textContent = (displayName[0] || 'U').toUpperCase();

        if (adminBtn) {
            if (role === 'owner' || role === 'admin' || canBulkUpload()) {
                adminBtn.classList.remove('hide');
                const badgeText = (role === 'owner' || role === 'admin') ? role.toUpperCase() : 'STAFF';
                adminBtn.querySelector('.nav-badge').textContent = badgeText;
            } else if (!initialOwnerExists) {
                adminBtn.classList.remove('hide');
                adminBtn.querySelector('.nav-badge').textContent = 'CLAIM OWNER';
            } else {
                adminBtn.classList.add('hide');
            }
        }
    }

    // -------------------------------------------------------------------------
    // Auth UI View Rendering
    // -------------------------------------------------------------------------
    function showAuthScreen(view, message = '', messageType = 'error') {
        // Any unauthenticated / transitional screen (login, signup, verify, reset, loading)
        // must never show the install prompt.
        deactivatePwaPromptForSession();

        $('auth-screen').style.display = 'flex';
        $('app-root').style.display = 'none';

        const container = $('auth-card-body');
        if (!container) return;

        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

        let noticeHtml = '';
        if (message) {
            noticeHtml = `<div class="auth-notice ${messageType}">${esc(message)}</div>`;
        }

        if (view === 'loading') {
            container.innerHTML = `
                <div style="text-align:center;padding:40px 10px;">
                    <div class="logo" style="margin:0 auto 16px;animation:spin 1.5s infinite linear">S</div>
                    <h3 style="margin:0 0 8px;font-size:18px">Loading StockSense...</h3>
                    <p style="color:var(--muted);font-size:12px">Connecting to your secure workspace.</p>
                </div>
            `;
            return;
        }

        if (view === 'verifying') {
            container.innerHTML = `
                <div class="verify-screen-box">
                    <div class="verify-icon-circle loading">
                        <div class="verify-spinner"></div>
                    </div>
                    <h3 class="verify-heading">Verifying Your Email Address…</h3>
                    <p class="verify-message">Please wait while we confirm your StockSense verification link with our secure authentication servers.</p>
                </div>
            `;
            return;
        }

        if (view === 'verify-success') {
            const user = typeof message === 'object' && message ? message : state.currentUser;
            const hasSession = !!user;
            container.innerHTML = `
                <div class="verify-screen-box">
                    <div class="verify-icon-circle success">✓</div>
                    <h3 class="verify-heading">Email Verified Successfully!</h3>
                    <p class="verify-message">Your email address has been verified. Your StockSense account is ready for you to sign in.</p>
                    <div class="verify-actions">
                        ${hasSession ? `
                            <button class="btn greenbtn" id="btn-verify-continue">Continue to StockSense Dashboard →</button>
                            <button class="btn primary" id="btn-verify-signin">Sign In to StockSense</button>
                        ` : `
                            <button class="btn greenbtn" id="btn-verify-signin">Sign In to StockSense</button>
                        `}
                        <div>
                            <a id="btn-verify-home" href="/">Return to Home</a>
                        </div>
                    </div>
                </div>
            `;
            if ($('btn-verify-continue')) {
                $('btn-verify-continue').onclick = async () => {
                    await handleAuthenticatedSession(user);
                };
            }
            if ($('btn-verify-signin')) {
                $('btn-verify-signin').onclick = () => {
                    showAuthScreen('signin');
                };
            }
            if ($('btn-verify-home')) {
                $('btn-verify-home').onclick = (e) => {
                    e.preventDefault();
                    showAuthScreen('signin');
                    try { history.pushState(null, '', '/'); } catch {}
                };
            }
            return;
        }

        if (view === 'verify-invalid') {
            container.innerHTML = `
                <div class="verify-screen-box">
                    <div class="verify-icon-circle error">✕</div>
                    <h3 class="verify-heading">This Verification Link Is Invalid or Expired</h3>
                    <p class="verify-message">The link may have expired or already been used. You can return to StockSense and request a new verification email if needed.</p>
                    <div class="verify-actions">
                        <button class="btn greenbtn" id="btn-invalid-resend">Resend Verification Email</button>
                        <button class="btn primary" id="btn-invalid-signin">Sign In to StockSense</button>
                        <div>
                            <a id="btn-invalid-home" href="/">Return to Home</a>
                        </div>
                    </div>
                </div>
            `;
            $('btn-invalid-resend').onclick = () => showAuthScreen('resend');
            $('btn-invalid-signin').onclick = () => showAuthScreen('signin');
            $('btn-invalid-home').onclick = (e) => {
                e.preventDefault();
                showAuthScreen('signin');
                try { history.pushState(null, '', '/'); } catch {}
            };
            return;
        }

        if (view === 'signin') {
            container.innerHTML = `
                <div class="auth-tabs">
                    <button class="auth-tab active" type="button">Sign In</button>
                    <button class="auth-tab" type="button" id="tab-to-signup">Create Account</button>
                </div>
                ${noticeHtml}
                <form id="form-signin">
                    <div class="fg" style="margin-bottom:14px">
                        <label for="signin-email">Email address</label>
                        <input class="field" id="signin-email" type="email" required autocomplete="email" placeholder="you@business.com">
                    </div>
                    <div class="fg" style="margin-bottom:14px">
                        <label for="signin-password">Password</label>
                        <div class="pw-wrap">
                            <input class="field" id="signin-password" type="password" required autocomplete="current-password" placeholder="••••••••">
                            <button type="button" class="pw-toggle" data-for="signin-password" aria-label="Toggle password visibility">👁</button>
                        </div>
                    </div>
                    <div class="auth-links">
                        <a id="link-forgot-pw">Forgot password?</a>
                        <a id="link-resend-confirm">Resend confirmation email</a>
                    </div>
                    <button class="btn primary" id="btn-submit-signin" type="submit" style="width:100%;padding:12px">Sign In to StockSense</button>
                    ${isLocalhost ? `
                        <div style="margin-top:16px;padding-top:12px;border-top:1px dashed var(--line);text-align:center;font-size:11px;color:var(--muted)">
                            Local Dev Preview: 
                            <a href="?preview=owner" style="color:var(--lav);font-weight:700;margin-right:12px;text-decoration:none">👑 Platform Owner</a>
                            <a href="?preview=member" style="color:var(--green);font-weight:700;text-decoration:none">🏪 Store Inventory</a>
                        </div>
                    ` : ''}
                </form>
            `;

            $('tab-to-signup').onclick = () => showAuthScreen('signup');
            $('link-forgot-pw').onclick = () => showAuthScreen('forgot');
            $('link-resend-confirm').onclick = () => showAuthScreen('resend');
            attachPasswordToggles();

            $('form-signin').onsubmit = async e => {
                e.preventDefault();
                const btn = $('btn-submit-signin');
                btn.disabled = true;
                btn.textContent = 'Signing in...';

                const email = $('signin-email').value.trim();
                const password = $('signin-password').value;

                const { data, error } = await supabase.auth.signInWithPassword({ email, password });

                if (error) {
                    btn.disabled = false;
                    btn.textContent = 'Sign In to StockSense';
                    let userMsg = error.message;
                    if (error.message.includes('Invalid login credentials')) {
                        userMsg = 'Incorrect email or password. Please verify your details.';
                    } else if (error.message.includes('Email not confirmed')) {
                        userMsg = 'Your email address has not been confirmed yet. Please verify your inbox or click "Resend confirmation email" below.';
                    }
                    showAuthScreen('signin', userMsg, 'error');
                    return;
                }

                if (data && data.session) {
                    await handleAuthenticatedSession(data.session.user);
                }
            };
            return;
        }

        if (view === 'signup') {
            container.innerHTML = `
                <div class="auth-tabs">
                    <button class="auth-tab" type="button" id="tab-to-signin">Sign In</button>
                    <button class="auth-tab active" type="button">Create Account</button>
                </div>
                ${noticeHtml}
                <form id="form-signup">
                    <div class="fg" style="margin-bottom:12px">
                        <label for="signup-name">Full name or business name *</label>
                        <input class="field" id="signup-name" required placeholder="Malcolm Jude">
                    </div>
                    <div class="fg" style="margin-bottom:12px">
                        <label for="signup-email">Email address *</label>
                        <input class="field" id="signup-email" type="email" required autocomplete="email" placeholder="you@business.com">
                    </div>
                    <div class="fg" style="margin-bottom:12px">
                        <label for="signup-password">Password (min. 8 characters, letters & numbers) *</label>
                        <div class="pw-wrap">
                            <input class="field" id="signup-password" type="password" required autocomplete="new-password" placeholder="••••••••">
                            <button type="button" class="pw-toggle" data-for="signup-password" aria-label="Toggle password visibility">👁</button>
                        </div>
                    </div>
                    <div class="fg" style="margin-bottom:16px">
                        <label for="signup-confirm">Confirm password *</label>
                        <div class="pw-wrap">
                            <input class="field" id="signup-confirm" type="password" required autocomplete="new-password" placeholder="••••••••">
                            <button type="button" class="pw-toggle" data-for="signup-confirm" aria-label="Toggle password visibility">👁</button>
                        </div>
                    </div>
                    <button class="btn greenbtn" id="btn-submit-signup" type="submit" style="width:100%;padding:12px">Create StockSense Account</button>
                </form>
            `;

            $('tab-to-signin').onclick = () => showAuthScreen('signin');
            attachPasswordToggles();

            $('form-signup').onsubmit = async e => {
                e.preventDefault();
                const fullName = $('signup-name').value.trim();
                const email = $('signup-email').value.trim();
                const password = $('signup-password').value;
                const confirm = $('signup-confirm').value;

                if (!fullName) {
                    showAuthScreen('signup', 'Please enter your full name or business name.', 'error');
                    return;
                }
                if (password.length < 8) {
                    showAuthScreen('signup', 'Password must be at least 8 characters long.', 'error');
                    return;
                }
                if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
                    showAuthScreen('signup', 'Password must contain both letters and numbers.', 'error');
                    return;
                }
                if (password !== confirm) {
                    showAuthScreen('signup', 'Passwords do not match. Please verify both fields.', 'error');
                    return;
                }

                const btn = $('btn-submit-signup');
                btn.disabled = true;
                btn.textContent = 'Creating account...';

                const { data, error } = await supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        data: { full_name: fullName },
                        emailRedirectTo: getAuthRedirectUrl()
                    }
                });

                if (error) {
                    btn.disabled = false;
                    btn.textContent = 'Create StockSense Account';
                    showAuthScreen('signup', error.message, 'error');
                    return;
                }

                // If user already exists (identities is empty in some Supabase setups)
                if (data.user && data.user.identities && data.user.identities.length === 0) {
                    showAuthScreen('signin', 'An account with that email already exists. Please sign in.', 'info');
                    return;
                }

                // If session is returned immediately (autoconfirm enabled)
                if (data.session) {
                    await handleAuthenticatedSession(data.session.user);
                    return;
                }

                // Email confirmation required
                showAuthScreen('check-email', email);
            };
            return;
        }

        if (view === 'check-email') {
            const email = typeof message === 'string' ? message : '';
            container.innerHTML = `
                <div class="verify-screen-box">
                    <div class="verify-icon-circle" style="background:rgba(168,85,247,0.15);border:2px solid var(--lav);color:var(--lav);box-shadow:0 0 24px rgba(168,85,247,0.25)">✉️</div>
                    <h3 class="verify-heading">Check Your Email</h3>
                    <p class="verify-message">
                        We've sent a verification link to ${email ? `<b style="color:#fff">${esc(email)}</b>` : 'your email address'}. Open the email and click the verification button to activate your StockSense account.
                    </p>
                    <div class="auth-notice info" style="text-align:left;margin-bottom:18px">
                        <b>Next step:</b> Check your inbox and spam folder. Click the verification button in the email to activate your account.
                    </div>
                    <div class="verify-actions">
                        ${email ? `<button class="btn secondary" id="btn-checkemail-resend" type="button">Resend Verification Email</button>` : ''}
                        <button class="btn primary" id="btn-checkemail-signin" type="button">Return to Sign In</button>
                    </div>
                </div>
            `;
            $('btn-checkemail-signin').onclick = () => showAuthScreen('signin');

            if (email && $('btn-checkemail-resend')) {
                const resendBtn = $('btn-checkemail-resend');
                let cooldown = 0;
                let cooldownTimer = null;

                resendBtn.onclick = async () => {
                    if (cooldown > 0) return;
                    resendBtn.disabled = true;
                    resendBtn.textContent = 'Sending...';

                    try {
                        const { error } = await supabase.auth.resend({
                            type: 'signup',
                            email: email,
                            options: {
                                emailRedirectTo: getAuthRedirectUrl()
                            }
                        });

                        if (error) {
                            resendBtn.disabled = false;
                            resendBtn.textContent = 'Resend Verification Email';
                            notify(error.message || 'Could not resend verification email.', 'error');
                            return;
                        }

                        notify(`A fresh verification email has been sent to ${email}.`, 'success');
                        cooldown = 60;
                        resendBtn.disabled = true;
                        resendBtn.textContent = `Resend in ${cooldown}s`;

                        cooldownTimer = setInterval(() => {
                            cooldown--;
                            if (cooldown <= 0) {
                                clearInterval(cooldownTimer);
                                resendBtn.disabled = false;
                                resendBtn.textContent = 'Resend Verification Email';
                            } else {
                                resendBtn.textContent = `Resend in ${cooldown}s`;
                            }
                        }, 1000);
                    } catch (err) {
                        resendBtn.disabled = false;
                        resendBtn.textContent = 'Resend Verification Email';
                        notify('Error resending email. Please try again.', 'error');
                    }
                };
            }
            return;
        }

        if (view === 'forgot') {
            container.innerHTML = `
                <h3 style="margin:0 0 6px;font-size:18px">Reset your password</h3>
                <p style="color:var(--muted);font-size:12px;margin:0 0 16px">Enter your account email to receive a password recovery link.</p>
                ${noticeHtml}
                <form id="form-forgot">
                    <div class="fg" style="margin-bottom:16px">
                        <label for="forgot-email">Account email address</label>
                        <input class="field" id="forgot-email" type="email" required placeholder="you@business.com">
                    </div>
                    <button class="btn primary" id="btn-submit-forgot" type="submit" style="width:100%;padding:12px">Send Reset Link</button>
                    <div style="text-align:center;margin-top:16px">
                        <a id="link-back-signin" style="color:var(--lav);font-size:12px;cursor:pointer">← Back to Sign In</a>
                    </div>
                </form>
            `;
            $('link-back-signin').onclick = () => showAuthScreen('signin');
            $('form-forgot').onsubmit = async e => {
                e.preventDefault();
                const email = $('forgot-email').value.trim();
                const btn = $('btn-submit-forgot');
                btn.disabled = true;
                btn.textContent = 'Sending link...';

                const { error } = await supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: getAuthRedirectUrl()
                });

                if (error) {
                    btn.disabled = false;
                    btn.textContent = 'Send Reset Link';
                    showAuthScreen('forgot', error.message, 'error');
                } else {
                    showAuthScreen('signin', `If an account exists for ${email}, a reset email has been dispatched. Please check your inbox.`, 'success');
                }
            };
            return;
        }

        if (view === 'resend') {
            container.innerHTML = `
                <h3 style="margin:0 0 6px;font-size:18px">Resend confirmation email</h3>
                <p style="color:var(--muted);font-size:12px;margin:0 0 16px">Enter your email address to receive a fresh verification link.</p>
                ${noticeHtml}
                <form id="form-resend">
                    <div class="fg" style="margin-bottom:16px">
                        <label for="resend-email">Account email address</label>
                        <input class="field" id="resend-email" type="email" required placeholder="you@business.com">
                    </div>
                    <button class="btn greenbtn" id="btn-submit-resend" type="submit" style="width:100%;padding:12px">Resend Verification Email</button>
                    <div style="text-align:center;margin-top:16px">
                        <a id="link-back-signin2" style="color:var(--lav);font-size:12px;cursor:pointer">← Back to Sign In</a>
                    </div>
                </form>
            `;
            $('link-back-signin2').onclick = () => showAuthScreen('signin');
            $('form-resend').onsubmit = async e => {
                e.preventDefault();
                const email = $('resend-email').value.trim();
                const btn = $('btn-submit-resend');
                btn.disabled = true;
                btn.textContent = 'Resending...';

                const { error } = await supabase.auth.resend({
                    type: 'signup',
                    email,
                    options: {
                        emailRedirectTo: getAuthRedirectUrl()
                    }
                });

                if (error) {
                    btn.disabled = false;
                    btn.textContent = 'Resend Verification Email';
                    showAuthScreen('resend', error.message, 'error');
                } else {
                    showAuthScreen('signin', `Verification email resent to ${email}. Please check your inbox.`, 'success');
                }
            };
            return;
        }

        if (view === 'recovery') {
            container.innerHTML = `
                <h3 style="margin:0 0 6px;font-size:18px">Choose a new password</h3>
                <p style="color:var(--muted);font-size:12px;margin:0 0 16px">Enter your new secure password below.</p>
                ${noticeHtml}
                <form id="form-recovery">
                    <div class="fg" style="margin-bottom:14px">
                        <label for="recovery-pw">New password (min 8 chars)</label>
                        <div class="pw-wrap">
                            <input class="field" id="recovery-pw" type="password" required placeholder="••••••••">
                            <button type="button" class="pw-toggle" data-for="recovery-pw" aria-label="Toggle password visibility">👁</button>
                        </div>
                    </div>
                    <div class="fg" style="margin-bottom:18px">
                        <label for="recovery-confirm">Confirm new password</label>
                        <div class="pw-wrap">
                            <input class="field" id="recovery-confirm" type="password" required placeholder="••••••••">
                            <button type="button" class="pw-toggle" data-for="recovery-confirm" aria-label="Toggle password visibility">👁</button>
                        </div>
                    </div>
                    <button class="btn primary" id="btn-submit-recovery" type="submit" style="width:100%;padding:12px">Update Password & Continue</button>
                </form>
            `;
            attachPasswordToggles();
            $('form-recovery').onsubmit = async e => {
                e.preventDefault();
                const pw = $('recovery-pw').value;
                const confirm = $('recovery-confirm').value;

                if (pw.length < 8) {
                    showAuthScreen('recovery', 'Password must be at least 8 characters.', 'error');
                    return;
                }
                if (pw !== confirm) {
                    showAuthScreen('recovery', 'Passwords do not match.', 'error');
                    return;
                }

                const btn = $('btn-submit-recovery');
                btn.disabled = true;
                btn.textContent = 'Updating...';

                const { data, error } = await supabase.auth.updateUser({ password: pw });
                if (error) {
                    btn.disabled = false;
                    btn.textContent = 'Update Password & Continue';
                    showAuthScreen('recovery', error.message, 'error');
                } else {
                    window.location.hash = '';
                    notify('Password updated successfully! Welcome back.', 'success');
                    if (data.user) {
                        await handleAuthenticatedSession(data.user);
                    } else {
                        showAuthScreen('signin', 'Password updated. Please sign in.', 'success');
                    }
                }
            };
            return;
        }
    }

    function attachPasswordToggles() {
        document.querySelectorAll('.pw-toggle').forEach(btn => {
            btn.onclick = () => {
                const targetId = btn.dataset.for;
                const input = $(targetId);
                if (!input) return;
                const isPw = input.type === 'password';
                input.type = isPw ? 'text' : 'password';
                btn.textContent = isPw ? '🔒' : '👁';
            };
        });
    }

    // -------------------------------------------------------------------------
    // Inventory & Movement Data Operations
    // -------------------------------------------------------------------------
    async function loadInventoryData(userId) {
        state.dbReady = false;
        try {
            // Fetch Products
            const { data: pData, error: pError } = await supabase
                .from('products')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false });

            if (pError) throw pError;
            state.products = pData || [];

            // Fetch Movements
            const { data: mData, error: mError } = await supabase
                .from('stock_movements')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false });

            if (mError) throw mError;
            state.moves = mData || [];

            state.dbReady = true;
            render();
            recommend();
        } catch (err) {
            console.error('Inventory data loading error:', err);
            notify('Error loading inventory from database: ' + (err.message || 'Check connection'), 'error');
        }
    }

    // Record stock movement (Sale, Restock, Adjustment)
    async function executeStockMovement(productId, type, quantity, note = '', direction = 'add') {
        const product = state.products.find(p => p.id === productId);
        if (!product) throw new Error('Product not found.');

        quantity = Number(quantity);
        if (!Number.isInteger(quantity) || quantity <= 0) {
            throw new Error('Quantity must be a positive whole number.');
        }

        // Try calling atomic RPC first
        try {
            const { data, error } = await supabase.rpc('process_stock_movement', {
                p_product_id: productId,
                p_movement_type: type,
                p_quantity: quantity,
                p_note: note || null,
                p_direction: direction
            });

            if (!error && data && data.success) {
                // Update in-memory state with authoritative server numbers
                product.quantity = data.quantity_after;
                state.moves.unshift({
                    id: data.movement_id,
                    product_id: productId,
                    movement_type: type,
                    quantity: data.quantity,
                    quantity_before: data.quantity_before,
                    quantity_after: data.quantity_after,
                    note: note || null,
                    created_at: new Date().toISOString()
                });
                render();
                return;
            }
            if (error && error.code !== 'PGRST202') { // Not a missing function error
                throw error;
            }
        } catch (rpcErr) {
            if (!rpcErr.message?.includes('schema cache') && !rpcErr.message?.includes('PGRST202')) {
                throw rpcErr;
            }
            // If RPC is not installed in database yet, fall back gracefully to client execution
            console.warn('RPC process_stock_movement not found in database. Executing with client-side fallback.');
        }

        // Client-side fallback if RPC is not deployed yet
        const currentQty = Number(product.quantity || 0);
        let newQty = currentQty;

        if (type === 'Sale') {
            if (currentQty < quantity) {
                throw new Error(`Insufficient stock. Current stock is ${currentQty}, attempted sale is ${quantity}.`);
            }
            newQty = currentQty - quantity;
        } else if (type === 'Restock') {
            newQty = currentQty + quantity;
        } else if (type === 'Adjustment') {
            if (direction === 'subtract') {
                if (currentQty < quantity) {
                    throw new Error(`Cannot adjust stock below zero. Current stock is ${currentQty}.`);
                }
                newQty = currentQty - quantity;
            } else {
                newQty = currentQty + quantity;
            }
        }

        // Update product in Supabase
        const { error: updateErr } = await supabase
            .from('products')
            .update({ quantity: newQty, updated_at: new Date().toISOString() })
            .eq('id', productId)
            .eq('user_id', state.currentUser.id);

        if (updateErr) throw updateErr;

        // Insert stock movement record
        const { data: moveRow, error: moveErr } = await supabase
            .from('stock_movements')
            .insert({
                user_id: state.currentUser.id,
                product_id: productId,
                movement_type: type,
                quantity: quantity,
                quantity_before: currentQty,
                quantity_after: newQty,
                note: note || null
            })
            .select()
            .single();

        if (moveErr) throw moveErr;

        product.quantity = newQty;
        state.moves.unshift(moveRow);
        render();
    }

    // Save product (Add or Edit)
    async function saveProduct(itemData, existingId = null) {
        const isEdit = !!existingId;
        const name = itemData.name.trim();
        let sku = (itemData.sku || '').trim();
        const category = itemData.category.trim() || 'Other';
        const cost = Number(itemData.cost);
        const price = Number(itemData.price);
        const qty = Number(itemData.qty);
        const min = Number(itemData.min);
        const emoji = itemData.emoji || '📦';
        const supplier = (itemData.supplier || '').trim() || null;

        if (!name) throw new Error('Product name is required.');
        if ([cost, price, qty, min].some(n => isNaN(n) || n < 0)) {
            throw new Error('Numeric values must be valid and non-negative.');
        }

        // Auto-generate SKU if omitted
        if (!sku) {
            sku = generateUniqueSKU(category, state.products);
        } else {
            // Validate SKU uniqueness within user's inventory
            const duplicate = state.products.find(p => p.id !== existingId && (p.sku || '').toLowerCase() === sku.toLowerCase());
            if (duplicate) {
                throw new Error(`SKU "${sku}" is already in use by product "${duplicate.name}".`);
            }
        }

        const payload = {
            user_id: state.currentUser.id,
            name,
            sku,
            category,
            unit_cost: cost,
            selling_price: price,
            quantity: qty,
            minimum_stock: min,
            emoji,
            supplier,
            updated_at: new Date().toISOString()
        };

        if (isEdit) {
            const oldProduct = state.products.find(p => p.id === existingId);
            const beforeQty = oldProduct ? oldProduct.quantity : qty;

            const { data, error } = await supabase
                .from('products')
                .update(payload)
                .eq('id', existingId)
                .eq('user_id', state.currentUser.id)
                .select()
                .single();

            if (error) throw error;

            // If quantity changed during edit, log an explicit adjustment
            if (beforeQty !== qty) {
                const diff = Math.abs(qty - beforeQty);
                await supabase.from('stock_movements').insert({
                    user_id: state.currentUser.id,
                    product_id: existingId,
                    movement_type: 'Adjustment',
                    quantity: diff,
                    quantity_before: beforeQty,
                    quantity_after: qty,
                    note: 'Quantity updated during product edit'
                });
            }

            const idx = state.products.findIndex(p => p.id === existingId);
            if (idx !== -1) state.products[idx] = data;
        } else {
            const { data, error } = await supabase
                .from('products')
                .insert(payload)
                .select()
                .single();

            if (error) throw error;

            // If opening quantity > 0, record opening stock movement
            if (qty > 0) {
                await supabase.from('stock_movements').insert({
                    user_id: state.currentUser.id,
                    product_id: data.id,
                    movement_type: 'Adjustment',
                    quantity: qty,
                    quantity_before: 0,
                    quantity_after: qty,
                    note: 'Opening inventory count'
                });
            }

            state.products.unshift(data);
        }

        // Refresh movements to capture any adjustments
        const { data: mData } = await supabase
            .from('stock_movements')
            .select('*')
            .eq('user_id', state.currentUser.id)
            .order('created_at', { ascending: false });
        if (mData) state.moves = mData;

        render();
        recommend();
    }

    // Delete product
    async function deleteProduct(productId) {
        const prod = state.products.find(p => p.id === productId);
        if (!prod) return;

        const confirmed = window.confirm(`Are you sure you want to delete "${prod.name}" (${prod.sku || 'No SKU'})?\n\nThis will remove the product and its recorded movements.`);
        if (!confirmed) return;

        try {
            const { error } = await supabase
                .from('products')
                .delete()
                .eq('id', productId)
                .eq('user_id', state.currentUser.id);

            if (error) throw error;

            state.products = state.products.filter(p => p.id !== productId);
            state.moves = state.moves.filter(m => m.product_id !== productId);

            render();
            recommend();
            notify('Product deleted successfully.', 'info');
        } catch (err) {
            console.error('Delete product error:', err);
            notify('Failed to delete product: ' + err.message, 'error');
        }
    }

    // -------------------------------------------------------------------------
    // Renderers (Dashboard, Inventory, Movements, Reports, Adviser)
    // -------------------------------------------------------------------------
    function card(label, value, ico, cls, foot) {
        return `
            <div class="metric">
                <div class="metric-head">${esc(label)}<span class="mi ${cls}">${ico}</span></div>
                <div class="value">${esc(value)}</div>
                <div class="foot">${esc(foot)}</div>
            </div>
        `;
    }

    function renderMetrics(containerId) {
        const p = state.products;
        const totalUnits = p.reduce((s, x) => s + Number(x.quantity || 0), 0);
        const lowCount = p.filter(x => st(x) === 'low').length;
        const totalVal = p.reduce((s, x) => s + (Number(x.quantity || 0) * Number(x.unit_cost || 0)), 0);

        const html = card('Total Products', fmt(p.length), '📦', '', 'Active catalog products') +
            card('Units in Stock', fmt(totalUnits), '▤', 'g', 'Available inventory units') +
            card('Low-Stock Items', fmt(lowCount), '!', 'o', lowCount === 1 ? '1 item needs attention' : `${lowCount} items need attention`) +
            card('Inventory Value', cash(totalVal), '₦', 'p', 'At recorded purchase cost');

        const el = $(containerId);
        if (el) el.innerHTML = html;
    }

    function renderStockAlertSummary() {
        const el = $('stock-alert-summary');
        if (!el) return;

        const p = state.products;
        const lowProducts = p.filter(x => st(x) === 'low');
        const outProducts = p.filter(x => st(x) === 'out');
        const totalAlerts = lowProducts.length + outProducts.length;

        if (totalAlerts === 0) {
            el.innerHTML = `
                <div class="alert-summary-healthy">
                    <span class="status-dot healthy"></span>
                    <div class="alert-summary-text">
                        <b>Stock Health: All Clear</b>
                        <p>Your stock is looking good. No stock alerts right now.</p>
                    </div>
                </div>
            `;
        } else {
            const parts = [];
            if (outProducts.length > 0) {
                parts.push(`<b style="color:var(--red)">${outProducts.length} ${outProducts.length === 1 ? 'product' : 'products'} out of stock</b>`);
            }
            if (lowProducts.length > 0) {
                parts.push(`<b style="color:var(--orange)">${lowProducts.length} ${lowProducts.length === 1 ? 'product' : 'products'} low on stock</b>`);
            }

            el.innerHTML = `
                <div class="alert-summary-warning">
                    <span class="status-dot warning"></span>
                    <div class="alert-summary-text">
                        <b>Stock Attention Required</b>
                        <p>${parts.join(' and ')} across your catalog.</p>
                    </div>
                    <button class="btn secondary" data-go="inventory" type="button">
                        Review in Product Inventory →
                    </button>
                </div>
            `;
        }
    }

    function renderChart() {
        const labs = ['6d', '5d', '4d', '3d', '2d', '1d', 'Today'];
        const sales = [];
        const rest = [];

        labs.forEach((_, i) => {
            const d = new Date();
            d.setDate(d.getDate() - (6 - i));
            const dayStr = d.toDateString();

            const daySales = state.moves
                .filter(m => m.movement_type === 'Sale' && new Date(m.created_at).toDateString() === dayStr)
                .reduce((s, m) => s + Number(m.quantity || 0), 0);

            const dayRest = state.moves
                .filter(m => m.movement_type === 'Restock' && new Date(m.created_at).toDateString() === dayStr)
                .reduce((s, m) => s + Number(m.quantity || 0), 0);

            sales.push(daySales);
            rest.push(dayRest);
        });

        const maxVal = Math.max(1, ...sales, ...rest);
        $('chart').innerHTML = labs.map((l, i) => `
            <div class="col">
                <div class="bars">
                    <div class="bar" style="height:${Math.max(4, (sales[i] / maxVal) * 100)}%" title="${sales[i]} unit(s) sold"></div>
                    <div class="bar alt" style="height:${Math.max(4, (rest[i] / maxVal) * 100)}%" title="${rest[i]} unit(s) restocked"></div>
                </div>
                <span class="day">${l}</span>
            </div>
        `).join('');
    }

    function renderAlerts() {
        const alerts = state.products
            .filter(p => st(p) !== 'ok')
            .sort((a, b) => Number(a.quantity) - Number(b.quantity))
            .slice(0, 5);

        if (!alerts.length) {
            $('alerts').innerHTML = '<div class="empty">All listed products are above minimum stock thresholds.</div>';
            return;
        }

        $('alerts').innerHTML = alerts.map(p => `
            <div class="item">
                <div class="emoji">${p.emoji || '📦'}</div>
                <div class="item-main">
                    <b>${esc(p.name)}</b>
                    <small>${statusLabel(st(p))} · minimum threshold: ${p.minimum_stock}</small>
                </div>
                <span class="qty">${p.quantity} left</span>
            </div>
        `).join('');
    }

    function renderRecent() {
        const recents = state.moves.slice(0, 5);
        if (!recents.length) {
            $('recent').innerHTML = '<div class="empty">No stock movements recorded yet.</div>';
            return;
        }

        $('recent').innerHTML = recents.map(m => {
            const p = state.products.find(x => x.id === m.product_id);
            const isSale = m.movement_type === 'Sale';
            const isRestock = m.movement_type === 'Restock';
            const iconCls = isSale ? 'o' : isRestock ? 'g' : 'p';
            const symbol = isSale ? '↘' : isRestock ? '↗' : '↔';
            const color = isSale ? 'var(--orange)' : isRestock ? 'var(--green)' : 'var(--lav)';
            const sign = isSale ? '−' : isRestock ? '+' : '±';

            return `
                <div class="item">
                    <div class="mi ${iconCls}">${symbol}</div>
                    <div class="item-main">
                        <b>${esc(p?.name || 'Deleted product')} · ${m.movement_type}</b>
                        <small>${datefmt(m.created_at)} ${m.note ? '· ' + esc(m.note) : ''}</small>
                    </div>
                    <strong style="color:${color}">${sign}${m.quantity}</strong>
                </div>
            `;
        }).join('');
    }

    function renderProducts() {
        const q = ($('search')?.value || '').toLowerCase().trim();
        const fStatus = $('filter')?.value || 'all';
        const fCat = $('catFilter')?.value || 'all';

        let list = state.products.filter(p => {
            const matchesQuery = (p.name || '').toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q);
            const matchesStatus = fStatus === 'all' || st(p) === fStatus;
            const matchesCat = fCat === 'all' || p.category === fCat;
            return matchesQuery && matchesStatus && matchesCat;
        });

        // Update categories dropdown dynamically
        const categories = Array.from(new Set(state.products.map(p => p.category).filter(Boolean))).sort();
        const catSelect = $('catFilter');
        if (catSelect && catSelect.dataset.populated !== 'true') {
            const currentCat = catSelect.value;
            catSelect.innerHTML = '<option value="all">All categories</option>' +
                categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
            catSelect.value = currentCat || 'all';
        }

        const tbody = $('products');
        if (!list.length) {
            tbody.innerHTML = '';
            $('noProducts').classList.remove('hide');
        } else {
            $('noProducts').classList.add('hide');
            tbody.innerHTML = list.map(p => `
                <tr>
                    <td>
                        <b>${p.emoji || '📦'} ${esc(p.name)}</b>
                        <div class="foot">${esc(p.sku || 'No SKU')}</div>
                    </td>
                    <td>${esc(p.category || 'Other')}</td>
                    <td>
                        <b>${p.quantity}</b>
                        <span class="foot"> / min ${p.minimum_stock}</span>
                    </td>
                    <td>${cash(p.unit_cost)}</td>
                    <td>${cash(p.selling_price)}</td>
                    <td><span class="status ${st(p)}">${statusLabel(st(p))}</span></td>
                    <td>
                        <button class="smallbtn" data-act="sale" data-id="${p.id}" title="Record a sale">− Sale</button>
                        <button class="smallbtn" data-act="restock" data-id="${p.id}" title="Record restock">＋ Restock</button>
                        <button class="smallbtn" data-act="adjust" data-id="${p.id}" title="Adjust stock count">↔ Adjust</button>
                        <button class="smallbtn" data-act="edit" data-id="${p.id}" title="Edit product details">Edit</button>
                        <button class="smallbtn del" data-act="delete" data-id="${p.id}" title="Delete product">✕</button>
                    </td>
                </tr>
            `).join('');
        }

        if ($('count')) $('count').textContent = state.products.length;
    }

    function renderMoves() {
        const q = ($('moveSearch')?.value || '').toLowerCase().trim();
        const fType = $('moveFilter')?.value || 'all';

        const list = state.moves.filter(m => {
            const p = state.products.find(x => x.id === m.product_id);
            const matchesQuery = !q || (p?.name || '').toLowerCase().includes(q) || (m.note || '').toLowerCase().includes(q) || (p?.sku || '').toLowerCase().includes(q);
            const matchesType = fType === 'all' || m.movement_type === fType;
            return matchesQuery && matchesType;
        });

        const tbody = $('moves');
        if (!list.length) {
            tbody.innerHTML = '';
            $('noMoves').classList.remove('hide');
        } else {
            $('noMoves').classList.add('hide');
            tbody.innerHTML = list.map(m => {
                const p = state.products.find(x => x.id === m.product_id);
                const isSale = m.movement_type === 'Sale';
                const isRestock = m.movement_type === 'Restock';
                const badgeClass = isSale ? 'low' : isRestock ? 'ok' : 'out';
                const color = isSale ? 'var(--orange)' : isRestock ? 'var(--green)' : 'var(--lav)';
                const sign = isSale ? '−' : isRestock ? '+' : '±';

                return `
                    <tr>
                        <td>${datefmt(m.created_at)}</td>
                        <td>
                            <b>${esc(p?.name || 'Deleted product')}</b>
                            <div class="foot">${esc(p?.sku || '—')}</div>
                        </td>
                        <td><span class="status ${badgeClass}">${esc(m.movement_type)}</span></td>
                        <td style="color:${color};font-weight:700">${sign}${m.quantity}</td>
                        <td><b>${m.quantity_after}</b> <span class="foot">(was ${m.quantity_before})</span></td>
                        <td>${esc(m.note || '—')}</td>
                    </tr>
                `;
            }).join('');
        }
    }

    function reports() {
        const sold = state.moves.filter(m => m.movement_type === 'Sale').reduce((s, m) => s + Number(m.quantity || 0), 0);
        const rest = state.moves.filter(m => m.movement_type === 'Restock').reduce((s, m) => s + Number(m.quantity || 0), 0);
        const val = state.products.reduce((s, p) => s + (Number(p.quantity || 0) * Number(p.unit_cost || 0)), 0);
        const alerts = state.products.filter(p => st(p) !== 'ok').length;

        $('reportsMetrics').innerHTML =
            card('Inventory value', cash(val), '₦', 'p', 'Current quantity × purchase unit cost') +
            card('Recorded units sold', fmt(sold), '↘', 'o', 'Sum across all sales records') +
            card('Units restocked', fmt(rest), '↗', 'g', 'Sum across all restock records') +
            card('Stock alerts', fmt(alerts), '!', 'o', `${alerts} items low or out of stock`);

        // Top recorded sellers
        const salesByProduct = state.products.map(p => {
            const unitsSold = state.moves
                .filter(m => m.product_id === p.id && m.movement_type === 'Sale')
                .reduce((s, m) => s + Number(m.quantity || 0), 0);
            return { ...p, unitsSold };
        }).filter(p => p.unitsSold > 0).sort((a, b) => b.unitsSold - a.unitsSold);

        $('top').innerHTML = salesByProduct.length ? salesByProduct.slice(0, 6).map(p => `
            <div class="item">
                <div class="emoji">${p.emoji || '📦'}</div>
                <div class="item-main">
                    <b>${esc(p.name)}</b>
                    <small>${p.unitsSold} units sold in recorded movements</small>
                </div>
                <strong>${fmt(p.unitsSold)}</strong>
            </div>
        `).join('') : '<div class="empty">Record sales to see top-selling products here.</div>';

        // Stock health status breakdown
        const counts = ['ok', 'low', 'out'];
        const total = state.products.length || 1;
        $('health').innerHTML = counts.map(s => {
            const cnt = state.products.filter(p => st(p) === s).length;
            const pct = Math.round((cnt / total) * 100);
            return `
                <div class="item">
                    <div class="item-main">
                        <b>${statusLabel(s)}</b>
                        <small>${pct}% of your catalogue (${cnt} of ${state.products.length})</small>
                    </div>
                    <span class="status ${s}">${cnt}</span>
                </div>
            `;
        }).join('');
    }

    function recommend() {
        const budgetInput = $('budget');
        const budget = Math.max(0, Number(budgetInput ? budgetInput.value : 20000) || 0);
        let left = budget;

        const candidates = state.products
            .filter(p => st(p) !== 'ok' && Number(p.unit_cost) > 0)
            .map(p => {
                const thirtyDaysAgo = Date.now() - (30 * 86400000);
                const sales = state.moves
                    .filter(m => m.product_id === p.id && m.movement_type === 'Sale' && new Date(m.created_at).getTime() > thirtyDaysAgo)
                    .reduce((s, m) => s + Number(m.quantity || 0), 0);

                const currentQty = Number(p.quantity || 0);
                const minQty = Number(p.minimum_stock || 0);
                const need = Math.max(1, minQty - currentQty);

                // Priority score: out of stock gets highest score, followed by low stock and recent sales velocity
                const score = (currentQty <= 0 ? 50 : 25) + Math.min(sales * 2, 20);

                return {
                    ...p,
                    need,
                    sales,
                    score
                };
            })
            .sort((a, b) => b.score - a.score);

        const plan = [];
        for (const item of candidates) {
            const cost = Number(item.unit_cost);
            const canAfford = Math.floor(left / cost);
            const restockQty = Math.min(item.need, canAfford);

            if (restockQty > 0) {
                const totalCost = restockQty * cost;
                left -= totalCost;
                plan.push({
                    ...item,
                    restockQty,
                    totalCost
                });
            }
        }

        const totalSpent = plan.reduce((s, x) => s + x.totalCost, 0);

        let html = `
            <div class="panel" style="margin-top:16px">
                <h3>Recommended restock plan</h3>
                <p class="sub">Estimated spend: <b style="color:var(--green)">${cash(totalSpent)}</b> · Remaining budget: <b>${cash(budget - totalSpent)}</b></p>
        `;

        if (!candidates.length) {
            html += '<div class="empty">All products are currently stocked at or above minimum threshold levels. No restocking needed!</div>';
        } else if (!plan.length) {
            html += '<div class="empty">Your allocated budget cannot cover even a single unit of the prioritized low-stock items. Please increase the budget or review product unit costs.</div>';
        } else {
            html += plan.map(p => `
                <div class="rec">
                    <b>${p.emoji || '📦'} ${esc(p.name)} 
                        <span style="float:right;color:${p.quantity <= 0 ? 'var(--red)' : 'var(--orange)'};font-size:10px;font-weight:800">
                            ${p.quantity <= 0 ? 'OUT OF STOCK' : 'LOW STOCK'}
                        </span>
                    </b>
                    <small>
                        Current stock: ${p.quantity} · Minimum threshold: ${p.minimum_stock} · Suggested restock: <b>${p.restockQty} unit(s)</b>.
                        ${p.sales > 0 ? `${p.sales} unit(s) sold in the past 30 days.` : 'No sales recorded in the past 30 days; prioritized by inventory threshold.'}
                    </small>
                    <strong>${cash(p.totalCost)} <span style="color:var(--muted);font-weight:400">(${cash(p.unit_cost)} each)</span></strong>
                </div>
            `).join('');
        }

        html += `
            <p class="notice">Recommendations are computed using your current inventory counts, configured minimum stock levels, recorded sales movements, and unit costs. Transparent, rule-based decision support.</p>
            </div>
        `;

        $('recs').innerHTML = html;
    }

    function render() {
        renderMetrics('metrics');
        renderStockAlertSummary();
        renderProducts();
        renderMoves();
        reports();
    }

    // -------------------------------------------------------------------------
    // CSV Export
    // -------------------------------------------------------------------------
    function exportMovementsCSV() {
        if (!state.moves.length) {
            notify('No stock movements available to export.', 'info');
            return;
        }

        const rows = [
            ['Date', 'Product Name', 'SKU', 'Movement Type', 'Quantity Change', 'Quantity Before', 'Quantity After', 'Note']
        ];

        state.moves.forEach(m => {
            const p = state.products.find(x => x.id === m.product_id);
            const isSale = m.movement_type === 'Sale';
            const qtyChange = isSale ? -Number(m.quantity) : Number(m.quantity);
            rows.push([
                m.created_at,
                p?.name || 'Deleted Product',
                p?.sku || '',
                m.movement_type,
                qtyChange,
                m.quantity_before,
                m.quantity_after,
                m.note || ''
            ]);
        });

        downloadCSV(rows, `stocksense-movements-${new Date().toISOString().split('T')[0]}.csv`);
        notify('Stock movements exported successfully.', 'info');
    }

    function exportInventoryCSV() {
        if (!state.products.length) {
            notify('No products available to export.', 'info');
            return;
        }

        const rows = [
            ['Product Name', 'SKU', 'Category', 'Current Stock', 'Min Stock', 'Unit Cost (NGN)', 'Selling Price (NGN)', 'Valuation (NGN)', 'Status', 'Supplier']
        ];

        state.products.forEach(p => {
            const val = Number(p.quantity || 0) * Number(p.unit_cost || 0);
            rows.push([
                p.name,
                p.sku || '',
                p.category || 'Other',
                p.quantity,
                p.minimum_stock,
                p.unit_cost,
                p.selling_price,
                val,
                statusLabel(st(p)),
                p.supplier || ''
            ]);
        });

        downloadCSV(rows, `stocksense-inventory-${new Date().toISOString().split('T')[0]}.csv`);
        notify('Inventory catalogue exported successfully.', 'info');
    }

    function downloadCSV(rows, filename) {
        const csvContent = rows.map(r => r.map(cell => {
            const str = String(cell ?? '').replace(/"/g, '""');
            return `"${str}"`;
        }).join(',')).join('\r\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // -------------------------------------------------------------------------
    // Modals (Product, Movement, Adjust, Admin)
    // -------------------------------------------------------------------------
    function closeModal() {
        $('modal').innerHTML = '';
    }

    function openProductModal(p = null) {
        const isEdit = !!p;
        const d = p || {
            name: '',
            sku: '',
            category: 'Phone accessories',
            unit_cost: '',
            selling_price: '',
            quantity: '',
            minimum_stock: 5,
            emoji: '📦',
            supplier: ''
        };

        $('modal').innerHTML = `
            <div class="modalbg" id="modal-bg">
                <form class="modal" id="form-product">
                    <h2>${isEdit ? 'Edit Product' : 'Add New Product'}</h2>
                    <p>Enter accurate catalogue, cost, and stock threshold details.</p>
                    <div class="formgrid">
                        <div class="fg full">
                            <label>Product Name *</label>
                            <input class="field" name="name" required value="${esc(d.name)}" placeholder="e.g. USB-C 65W Fast Charger">
                        </div>
                        <div class="fg">
                            <label>SKU (Stock Keeping Unit)</label>
                            <div class="sku-input-wrap">
                                <input class="field" name="sku" id="modal-sku-input" value="${esc(d.sku || '')}" placeholder="Leave blank to auto-generate">
                                <button type="button" class="btn secondary" id="btn-gen-sku" title="Generate SKU">⚡ Auto</button>
                            </div>
                        </div>
                        <div class="fg">
                            <label>Category *</label>
                            <select class="field" name="category" id="modal-category">
                                <option value="Chargers">Chargers</option>
                                <option value="Power banks">Power banks</option>
                                <option value="Audio">Audio</option>
                                <option value="Cables">Cables</option>
                                <option value="Phone accessories">Phone accessories</option>
                                <option value="Computer accessories">Computer accessories</option>
                                <option value="Other">Other</option>
                            </select>
                        </div>
                        <div class="fg">
                            <label>Unit Purchase Cost (₦) *</label>
                            <input class="field" name="unit_cost" type="number" min="0" step="0.01" required value="${d.unit_cost}">
                        </div>
                        <div class="fg">
                            <label>Selling Price (₦) *</label>
                            <input class="field" name="selling_price" type="number" min="0" step="0.01" required value="${d.selling_price}">
                        </div>
                        <div class="fg">
                            <label>Quantity in Stock *</label>
                            <input class="field" name="quantity" type="number" min="0" step="1" required value="${d.quantity}">
                        </div>
                        <div class="fg">
                            <label>Minimum Stock Threshold *</label>
                            <input class="field" name="minimum_stock" type="number" min="0" step="1" required value="${d.minimum_stock}">
                        </div>
                        <div class="fg">
                            <label>Product Emoji / Icon</label>
                            <input class="field" name="emoji" maxlength="4" value="${esc(d.emoji || '📦')}" placeholder="📦">
                        </div>
                        <div class="fg">
                            <label>Supplier (optional)</label>
                            <input class="field" name="supplier" value="${esc(d.supplier || '')}" placeholder="e.g. Lagos Tech Wholesale">
                        </div>
                    </div>
                    <div class="actions">
                        <button type="button" class="btn secondary" id="modal-cancel">Cancel</button>
                        <button class="btn primary" id="modal-submit">${isEdit ? 'Save Changes' : 'Create Product'}</button>
                    </div>
                </form>
            </div>
        `;

        if (d.category) {
            $('modal-category').value = d.category;
        }

        $('btn-gen-sku').onclick = () => {
            const cat = $('modal-category').value;
            $('modal-sku-input').value = generateUniqueSKU(cat, state.products);
        };

        $('modal-cancel').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };

        $('form-product').onsubmit = async e => {
            e.preventDefault();
            const btn = $('modal-submit');
            btn.disabled = true;
            btn.textContent = 'Saving...';

            const f = new FormData(e.target);
            const itemData = {
                name: f.get('name'),
                sku: f.get('sku'),
                category: f.get('category'),
                cost: f.get('unit_cost'),
                price: f.get('selling_price'),
                qty: f.get('quantity'),
                min: f.get('minimum_stock'),
                emoji: f.get('emoji'),
                supplier: f.get('supplier')
            };

            try {
                await saveProduct(itemData, p?.id);
                closeModal();
                notify(isEdit ? 'Product updated successfully.' : 'Product created successfully.', 'success');
            } catch (err) {
                console.error(err);
                btn.disabled = false;
                btn.textContent = isEdit ? 'Save Changes' : 'Create Product';
                notify(err.message || 'Error saving product.', 'error');
            }
        };
    }

    function openMovementModal(productId, type) {
        const prod = state.products.find(p => p.id === productId);
        if (!prod) return;

        const isSale = type === 'Sale';
        const currentQty = Number(prod.quantity || 0);

        $('modal').innerHTML = `
            <div class="modalbg" id="modal-bg">
                <form class="modal" id="form-move">
                    <h2>Record ${isSale ? 'a Sale' : 'Restocking'}</h2>
                    <p>${esc(prod.name)} (${esc(prod.sku || 'No SKU')}) · Current Stock: <b>${currentQty}</b></p>
                    <div class="formgrid">
                        <div class="fg full">
                            <label>Quantity *</label>
                            <input class="field" name="qty" id="move-qty" type="number" min="1" ${isSale ? `max="${currentQty}"` : ''} step="1" required placeholder="1">
                        </div>
                        <div class="fg full">
                            <label>Note / Reference (optional)</label>
                            <input class="field" name="note" placeholder="${isSale ? 'e.g. Counter sale #412' : 'e.g. Supplier replenishment invoice'}">
                        </div>
                    </div>
                    <div id="move-preview" style="margin-top:12px;font-size:12px;color:var(--muted)"></div>
                    <div class="actions">
                        <button type="button" class="btn secondary" id="modal-cancel">Cancel</button>
                        <button class="btn ${isSale ? 'primary' : 'greenbtn'}" id="modal-submit">Record ${isSale ? 'Sale' : 'Restock'}</button>
                    </div>
                </form>
            </div>
        `;

        const updatePreview = () => {
            const q = Number($('move-qty').value || 0);
            if (isSale) {
                const total = q * Number(prod.selling_price || 0);
                $('move-preview').innerHTML = `Sale revenue preview: <b>${cash(total)}</b> · Remaining stock will be: <b>${Math.max(0, currentQty - q)}</b>`;
            } else {
                const total = q * Number(prod.unit_cost || 0);
                $('move-preview').innerHTML = `Restocking cost preview: <b>${cash(total)}</b> · Resulting stock will be: <b>${currentQty + q}</b>`;
            }
        };

        $('move-qty').oninput = updatePreview;
        updatePreview();

        $('modal-cancel').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };

        $('form-move').onsubmit = async e => {
            e.preventDefault();
            const q = Number($('move-qty').value);
            const note = e.target.note.value.trim();

            if (!Number.isInteger(q) || q < 1) {
                notify('Please enter a positive whole quantity.', 'error');
                return;
            }
            if (isSale && q > currentQty) {
                notify(`Cannot sell ${q} units. Only ${currentQty} in stock.`, 'error');
                return;
            }

            const btn = $('modal-submit');
            btn.disabled = true;
            btn.textContent = 'Processing...';

            try {
                await executeStockMovement(productId, type, q, note);
                closeModal();
                notify(isSale ? `Sale of ${q} unit(s) recorded.` : `Restock of ${q} unit(s) recorded.`, 'success');
            } catch (err) {
                btn.disabled = false;
                btn.textContent = `Record ${isSale ? 'Sale' : 'Restock'}`;
                notify(err.message || 'Operation failed.', 'error');
            }
        };
    }

    function openAdjustmentModal(productId) {
        const prod = state.products.find(p => p.id === productId);
        if (!prod) return;

        const currentQty = Number(prod.quantity || 0);

        $('modal').innerHTML = `
            <div class="modalbg" id="modal-bg">
                <form class="modal" id="form-adjust">
                    <h2>Record Stock Adjustment</h2>
                    <p>${esc(prod.name)} · Current Stock: <b>${currentQty}</b></p>
                    <div class="formgrid">
                        <div class="fg full">
                            <label>Adjustment Type *</label>
                            <select class="field" id="adj-mode">
                                <option value="add">Add units (+)</option>
                                <option value="subtract">Deduct units (−)</option>
                                <option value="set">Set exact count</option>
                            </select>
                        </div>
                        <div class="fg full">
                            <label id="adj-qty-label">Quantity to adjust *</label>
                            <input class="field" id="adj-qty" type="number" min="1" step="1" required placeholder="1">
                        </div>
                        <div class="fg full">
                            <label>Reason / Note (required) *</label>
                            <input class="field" id="adj-note" required placeholder="e.g. Audit discrepancy, damaged stock, shrinkage">
                        </div>
                    </div>
                    <div id="adj-preview" style="margin-top:12px;font-size:12px;color:var(--muted)"></div>
                    <div class="actions">
                        <button type="button" class="btn secondary" id="modal-cancel">Cancel</button>
                        <button class="btn primary" id="modal-submit">Commit Adjustment</button>
                    </div>
                </form>
            </div>
        `;

        const updatePreview = () => {
            const mode = $('adj-mode').value;
            const q = Number($('adj-qty').value || 0);
            let resulting = currentQty;

            if (mode === 'add') {
                resulting = currentQty + q;
                $('adj-qty-label').textContent = 'Units to add *';
            } else if (mode === 'subtract') {
                resulting = currentQty - q;
                $('adj-qty-label').textContent = 'Units to deduct *';
            } else if (mode === 'set') {
                resulting = q;
                $('adj-qty-label').textContent = 'New target stock count *';
            }

            const isNegative = resulting < 0;
            $('adj-preview').innerHTML = `Resulting stock level: <b style="color:${isNegative ? 'var(--red)' : 'var(--lav)'}">${resulting}</b> ${isNegative ? '(Negative stock is not permitted)' : ''}`;
        };

        $('adj-mode').onchange = updatePreview;
        $('adj-qty').oninput = updatePreview;
        updatePreview();

        $('modal-cancel').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };

        $('form-adjust').onsubmit = async e => {
            e.preventDefault();
            const mode = $('adj-mode').value;
            const qInput = Number($('adj-qty').value);
            const note = $('adj-note').value.trim();

            if (!note) {
                notify('Please provide an explanatory note for this adjustment.', 'error');
                return;
            }

            let delta = 0;
            let direction = 'add';

            if (mode === 'add') {
                delta = qInput;
                direction = 'add';
            } else if (mode === 'subtract') {
                if (qInput > currentQty) {
                    notify(`Cannot deduct ${qInput} units. Only ${currentQty} in stock.`, 'error');
                    return;
                }
                delta = qInput;
                direction = 'subtract';
            } else if (mode === 'set') {
                if (qInput < 0) {
                    notify('Stock count cannot be negative.', 'error');
                    return;
                }
                if (qInput === currentQty) {
                    notify('Target count matches current count. No change needed.', 'info');
                    return;
                }
                delta = Math.abs(qInput - currentQty);
                direction = qInput > currentQty ? 'add' : 'subtract';
            }

            const btn = $('modal-submit');
            btn.disabled = true;
            btn.textContent = 'Processing...';

            try {
                await executeStockMovement(productId, 'Adjustment', delta, note, direction);
                closeModal();
                notify('Stock adjustment recorded successfully.', 'success');
            } catch (err) {
                btn.disabled = false;
                btn.textContent = 'Commit Adjustment';
                notify(err.message || 'Adjustment failed.', 'error');
            }
        };
    }

    // -------------------------------------------------------------------------
    // Platform Administration Dashboard Module
    // -------------------------------------------------------------------------
    async function loadAdminData() {
        if (!isAdminOrOwner()) {
            notify('Access denied. Administrator privileges required.', 'error');
            go('dashboard');
            return;
        }

        try {
            // Attempt to call admin_get_overview RPC
            const { data: ovData, error: ovError } = await supabase.rpc('admin_get_overview');

            if (!ovError && ovData) {
                state.adminData = ovData;
                renderAdminOverview(ovData);
            } else {
                console.warn('admin_get_overview RPC not present, calculating fallback admin metrics.');
                await loadAdminOverviewFallback();
            }

            // Hide bootstrap panel if user is already owner
            const bootstrapPanel = $('admin-panel-bootstrap-owner');
            if (bootstrapPanel) {
                bootstrapPanel.style.display = (state.currentRole === 'owner') ? 'none' : '';
            }

            // Load Users table
            await loadAdminUsers();

            // Load Settings
            await loadPlatformSettings();
        } catch (err) {
            console.error('Error loading admin data:', err);
            notify('Error loading platform administration data: ' + err.message, 'error');
        }
    }

    async function loadAdminOverviewFallback() {
        // Fallback calculation using direct queries
        const { count: userCount } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
        const { count: prodCount } = await supabase.from('products').select('*', { count: 'exact', head: true });
        const { count: moveCount } = await supabase.from('stock_movements').select('*', { count: 'exact', head: true });

        const ovData = {
            total_users: userCount || 1,
            new_users_7d: 1,
            new_users_30d: 1,
            active_users_30d: 1,
            total_products: prodCount || state.products.length,
            total_movements: moveCount || state.moves.length,
            recent_logs: []
        };
        state.adminData = ovData;
        renderAdminOverview(ovData);
    }

    function renderAdminOverview(ov) {
        $('admin-metrics').innerHTML =
            card('Registered users', fmt(ov.total_users), '👥', '', 'Total platform accounts') +
            card('New users (30d)', fmt(ov.new_users_30d), '✨', 'g', 'Registered past 30 days') +
            card('Active users (30d)', fmt(ov.active_users_30d), '⚡', 'o', 'Recorded movements past 30d') +
            card('Total products', fmt(ov.total_products), '📦', 'p', 'Across all client inventories') +
            card('Stock movements', fmt(ov.total_movements), '↔', 'g', 'Traceable movements processed');

        // Recent administrative audit events
        const logsContainer = $('admin-recent-logs');
        if (logsContainer) {
            const logs = ov.recent_logs || [];
            if (!logs.length) {
                logsContainer.innerHTML = '<div class="empty">No administrative actions logged recently.</div>';
            } else {
                logsContainer.innerHTML = logs.map(l => `
                    <div class="item">
                        <div class="mi p">🛡</div>
                        <div class="item-main">
                            <b>${esc(l.action)}</b>
                            <small>${datefmt(l.created_at)} · Target: ${esc(l.target_type || 'system')} (${esc(l.target_id || 'all')})</small>
                        </div>
                    </div>
                `).join('');
            }
        }
    }

    /**
     * Which user-management actions the signed-in administrator may see for a target row.
     * The UI mirrors, but never replaces, the server-side rules enforced inside the
     * admin_toggle_suspension / admin_delete_user / admin_assign_role SQL functions.
     */
    function getAdminUserActions(u) {
        const targetRole = u.role || 'member';
        const targetIsOwner = targetRole === 'owner';
        const targetIsSelf = u.id === state.currentUser?.id;
        const callerIsOwner = state.currentRole === 'owner';
        const callerIsStaffAdmin = callerIsOwner || state.currentRole === 'admin';
        // Admins may manage ordinary members and moderators; only the Owner may act on Administrators.
        const mayActOnTarget = callerIsStaffAdmin && !targetIsOwner && !targetIsSelf &&
            (callerIsOwner || targetRole !== 'admin');
        return {
            canSuspend: mayActOnTarget,
            canDelete: mayActOnTarget,
            canSetRole: callerIsOwner && !targetIsOwner && !targetIsSelf,
            protectedReason: targetIsOwner ? 'Platform Owner is protected' : (targetIsSelf ? 'This is your account' : '')
        };
    }

    async function loadAdminUsers() {
        const search = ($('admin-user-search')?.value || '').trim();
        const role = $('admin-user-role-filter')?.value || 'all';
        const status = $('admin-user-status-filter')?.value || 'all';

        if (isPreviewMode() && state.adminUsers) {
            // Dev preview (localhost only): filter the simulated user list in memory.
            const deletedIds = getDeletedUserIds();
            let filtered = state.adminUsers.filter(u => !deletedIds.includes(u.id));
            if (search) {
                const s = search.toLowerCase();
                filtered = filtered.filter(u => (u.full_name || '').toLowerCase().includes(s) || (u.email || '').toLowerCase().includes(s) || (u.id || '').toLowerCase().includes(s));
            }
            if (role !== 'all') {
                filtered = filtered.filter(u => (role === 'none' ? !u.role || u.role === 'member' : u.role === role));
            }
            if (status !== 'all') {
                filtered = filtered.filter(u => (status === 'active' ? !u.is_suspended : u.is_suspended));
            }
            renderAdminUsersTable(filtered);
            return;
        }

        try {
            // The server is the single source of truth: list straight from auth.users via the RPC.
            const { data, error } = await supabase.rpc('admin_get_users', {
                p_search: search,
                p_role: role,
                p_status: status,
                p_limit: state.adminUserLimit,
                p_offset: state.adminUserOffset
            });

            if (error) throw error;

            state.adminUsers = (data && data.users) || [];
            state.adminTotalUsers = Number((data && data.total) || 0);

            // If the last user on a later page was removed, step back to the previous page.
            if (!state.adminUsers.length && state.adminUserOffset > 0 && state.adminTotalUsers > 0) {
                state.adminUserOffset = Math.max(0, state.adminUserOffset - state.adminUserLimit);
                return loadAdminUsers();
            }
            renderAdminUsersTable();
        } catch (err) {
            // Never fabricate rows from a partial source: show the failure instead.
            state.adminUsers = [];
            state.adminTotalUsers = 0;
            renderAdminUsersTable([], friendlyAdminError(err, 'Could not load user accounts from the server. Please try again.'));
        }
    }

    function renderAdminUsersTable(userList = state.adminUsers, errorMessage = '') {
        const tbody = $('admin-users-table');
        if (!tbody) return;

        const users = userList || [];
        const pageSpan = $('admin-users-pagination-info');
        const pageControls = $('admin-users-pagination-controls');

        if (errorMessage) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty error-state">${esc(errorMessage)}</td></tr>`;
            if (pageSpan) pageSpan.textContent = 'Users could not be loaded';
            if (pageControls) pageControls.innerHTML = '';
            return;
        }

        if (!users.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty">No matching users found.</td></tr>';
            if (pageSpan) pageSpan.textContent = 'Showing 0 users';
            if (pageControls) pageControls.innerHTML = '';
            return;
        }

        tbody.innerHTML = users.map(u => {
            const isSuspended = u.is_suspended;
            const role = u.role || 'member';
            const actions = getAdminUserActions(u);
            const uid = esc(u.id);

            return `
                <tr data-user-row="${uid}">
                    <td data-label="Name &amp; ID">
                        <b>${esc(u.full_name || 'Unnamed User')}</b>
                        <div class="foot user-id-cell">${uid}</div>
                    </td>
                    <td data-label="Email" class="cell-email">${esc(u.email || '—')}</td>
                    <td data-label="Role"><span class="role-badge ${esc(role)}">${esc(role)}</span></td>
                    <td data-label="Status"><span class="status ${isSuspended ? 'out' : 'ok'}">${isSuspended ? 'Suspended' : 'Active'}</span></td>
                    <td data-label="Registered">${datefmt(u.created_at)}</td>
                    <td data-label="Last active">${datefmt(u.last_sign_in_at)}</td>
                    <td data-label="Actions" class="cell-actions">
                        <div class="row-actions">
                            <button class="smallbtn" data-admin-act="details" data-uid="${uid}">Details</button>
                            ${actions.canSuspend ? `
                                <button class="smallbtn ${isSuspended ? '' : 'del'}" data-admin-act="toggle-suspend" data-uid="${uid}" data-suspended="${isSuspended ? 'true' : 'false'}">
                                    ${isSuspended ? 'Reactivate' : 'Suspend'}
                                </button>
                            ` : ''}
                            ${actions.canSetRole ? `
                                <button class="smallbtn" data-admin-act="assign-role" data-uid="${uid}" data-role="${esc(role)}">
                                    Set Role
                                </button>
                            ` : ''}
                            ${actions.canDelete ? `
                                <button class="smallbtn danger-solid" data-admin-act="delete-user" data-uid="${uid}" title="Permanently delete user account">
                                    🗑 Delete
                                </button>
                            ` : ''}
                            ${actions.protectedReason ? `<span class="protected-note" title="${esc(actions.protectedReason)}">🔒 ${esc(actions.protectedReason)}</span>` : ''}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        // Pagination summary and controls (server-side pagination in live mode)
        const live = !isPreviewMode();
        const total = live ? Math.max(state.adminTotalUsers, users.length) : users.length;
        const offset = live ? state.adminUserOffset : 0;
        const start = total > 0 ? offset + 1 : 0;
        const end = live ? Math.min(offset + users.length, total) : users.length;
        if (pageSpan) {
            pageSpan.textContent = `Showing ${start}-${end} of ${total} users`;
        }
        if (pageControls) {
            pageControls.innerHTML = (live && total > state.adminUserLimit) ? `
                <button class="btn secondary btn-sm" data-admin-page="prev" ${offset <= 0 ? 'disabled' : ''}>← Previous</button>
                <button class="btn secondary btn-sm" data-admin-page="next" ${end >= total ? 'disabled' : ''}>Next →</button>
            ` : '';
        }
    }

    function openUserDetailsModal(userId) {
        const user = state.adminUsers.find(u => u.id === userId);
        if (!user) return;

        const role = user.role || 'member';
        const canDelete = getAdminUserActions(user).canDelete;

        $('modal').innerHTML = `
            <div class="modalbg" id="modal-bg">
                <div class="modal">
                    <h2>User Account Information</h2>
                    <p>Administrative metadata for user ${esc(user.id)}</p>
                    <div class="formgrid">
                        <div class="fg full">
                            <label>Full Name</label>
                            <input class="field" readonly value="${esc(user.full_name)}">
                        </div>
                        <div class="fg full">
                            <label>Email Address</label>
                            <input class="field" readonly value="${esc(user.email)}">
                        </div>
                        <div class="fg">
                            <label>Role</label>
                            <input class="field" readonly value="${esc((user.role || 'Member').toUpperCase())}">
                        </div>
                        <div class="fg">
                            <label>Account Status</label>
                            <input class="field" readonly value="${user.is_suspended ? 'SUSPENDED' : 'ACTIVE'}">
                        </div>
                        ${user.is_suspended ? `
                            <div class="fg full">
                                <label>Suspension Reason</label>
                                <textarea class="field" readonly rows="2">${esc(user.suspension_reason || 'No reason specified')}</textarea>
                            </div>
                        ` : ''}
                        <div class="fg">
                            <label>Registration Date</label>
                            <input class="field" readonly value="${datefmt(user.created_at)}">
                        </div>
                        <div class="fg">
                            <label>Last Activity</label>
                            <input class="field" readonly value="${datefmt(user.last_sign_in_at)}">
                        </div>
                    </div>
                    <div class="actions" style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:12px;margin-top:16px">
                        ${canDelete ? `
                            <button type="button" class="btn dangerbtn" id="modal-details-delete-btn" style="background:#ef4444;border-color:#ef4444;color:#fff;font-weight:700">
                                🗑 Delete User Account
                            </button>
                        ` : '<div></div>'}
                        <button type="button" class="btn secondary" id="modal-close-btn">Close</button>
                    </div>
                </div>
            </div>
        `;
        $('modal-close-btn').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };
        const detailsDelBtn = $('modal-details-delete-btn');
        if (detailsDelBtn) {
            detailsDelBtn.onclick = () => {
                closeModal();
                openDeleteUserModal(userId);
            };
        }
    }

    function openSuspendModal(userId, isCurrentlySuspended) {
        const user = state.adminUsers.find(u => u.id === userId);
        if (!user) return;

        const actionWord = isCurrentlySuspended ? 'Reactivate' : 'Suspend';

        $('modal').innerHTML = `
            <div class="modalbg" id="modal-bg">
                <form class="modal" id="form-suspend">
                    <h2>${actionWord} User Account</h2>
                    <p>${actionWord} account access for <b>${esc(user.full_name)}</b> (${esc(user.email)})</p>
                    ${!isCurrentlySuspended ? `
                        <div class="fg full" style="margin-bottom:14px">
                            <label>Suspension Reason (documented in audit log) *</label>
                            <textarea class="field" id="suspend-reason" required rows="3" placeholder="e.g. Violation of terms, payment issue, requested hold"></textarea>
                        </div>
                        <p class="muted" style="margin-bottom:14px">Suspending blocks this user from signing in, revokes their active sessions and removes access to their inventory data. Nothing is deleted, and you can reactivate the account at any time.</p>
                    ` : `
                        <p style="color:var(--green)">Reactivating this account will restore the user's access to their inventory.</p>
                    `}
                    <div class="auth-notice error" id="suspend-modal-error" style="display:none;margin-bottom:14px;font-size:12.5px"></div>
                    <div class="actions">
                        <button type="button" class="btn secondary" id="modal-cancel">Cancel</button>
                        <button class="btn ${isCurrentlySuspended ? 'greenbtn' : 'dangerbtn'}" id="modal-submit">${actionWord} Account</button>
                    </div>
                </form>
            </div>
        `;

        $('modal-cancel').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };

        $('form-suspend').onsubmit = async e => {
            e.preventDefault();
            const reason = isCurrentlySuspended ? null : $('suspend-reason').value.trim();
            const btn = $('modal-submit');
            const cancelBtn = $('modal-cancel');
            const errBox = $('suspend-modal-error');
            btn.disabled = true;
            if (cancelBtn) cancelBtn.disabled = true;
            btn.textContent = isCurrentlySuspended ? 'Reactivating...' : 'Suspending...';
            if (errBox) errBox.style.display = 'none';

            try {
                if (isPreviewMode()) {
                    // Dev preview (localhost only): simulate against the mock list, never the backend.
                    user.is_suspended = !isCurrentlySuspended;
                    user.suspension_reason = reason;
                    closeModal();
                    notify(`Preview only: user ${isCurrentlySuspended ? 'reactivated' : 'suspended'} in the simulated list (no real account changed).`, 'info');
                    await loadAdminUsers();
                    return;
                }

                // Server-side authorization, Owner protection and auth-level blocking all happen in the RPC.
                const { data, error } = await supabase.rpc('admin_toggle_suspension', {
                    p_target_user_id: userId,
                    p_suspend: !isCurrentlySuspended,
                    p_reason: reason
                });

                if (error) throw error;
                if (!data || data.success !== true || data.is_suspended !== !isCurrentlySuspended) {
                    throw new Error('The server did not confirm the change.');
                }

                closeModal();
                notify(`User ${isCurrentlySuspended ? 'reactivated' : 'suspended'} successfully.`, 'success');
                await loadAdminUsers();
            } catch (err) {
                btn.disabled = false;
                if (cancelBtn) cancelBtn.disabled = false;
                btn.textContent = `${actionWord} Account`;
                const msg = friendlyAdminError(err, `Could not ${actionWord.toLowerCase()} this account. No changes were made.`);
                if (errBox) {
                    errBox.textContent = msg;
                    errBox.style.display = 'block';
                }
                notify(msg, 'error');
            }
        };
    }

    function openDeleteUserModal(userId) {
        const user = state.adminUsers.find(u => u.id === userId);
        if (!user) return;

        // Privilege and safety checks
        if (user.id === state.currentUser?.id) {
            notify('You cannot delete your own administrator account.', 'error');
            return;
        }
        if (user.role === 'owner') {
            notify('Cannot delete the Platform Owner account.', 'error');
            return;
        }
        if (user.role === 'admin' && state.currentRole !== 'owner') {
            notify('Only the Platform Owner can delete an Administrator account.', 'error');
            return;
        }

        const displayName = user.full_name || user.email || 'this user';

        $('modal').innerHTML = `
            <div class="modalbg" id="modal-bg">
                <form class="modal" id="form-delete-user" style="max-width:480px">
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
                        <div style="width:42px;height:42px;border-radius:10px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.35);color:#ef4444;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">
                            ⚠️
                        </div>
                        <div>
                            <h2 style="color:#ef4444;margin:0 0 2px;font-size:19px">Delete User Account</h2>
                            <p class="sub" style="margin:0;font-size:12px">Permanent administrative account removal</p>
                        </div>
                    </div>

                    <div class="auth-notice error" style="margin-bottom:16px;line-height:1.5;font-size:12.5px">
                        <b>Warning:</b> You are about to permanently delete the account of <b style="color:#fff">${esc(displayName)}</b> (<code>${esc(user.email || user.id)}</code>).
                        <br><br>
                        This permanently removes their sign-in account, profile, role and staff permissions, registered products and recorded stock movements. Feedback they submitted is kept anonymously and administrative audit entries are preserved. <b>This action is irreversible and cannot be undone.</b>
                    </div>

                    <div class="auth-notice error" id="delete-user-modal-error" style="display:none;margin-bottom:14px;line-height:1.4;font-size:12.5px"></div>

                    <div class="fg full" style="margin-bottom:16px">
                        <label style="font-size:12px">To confirm permanent deletion, type <b style="color:#ef4444;letter-spacing:1px">DELETE</b> below:</label>
                        <input class="field" id="delete-user-confirm-input" placeholder="Type DELETE to confirm" autocomplete="off" required style="font-family:monospace;font-size:13px">
                    </div>

                    <div class="actions">
                        <button type="button" class="btn secondary" id="modal-cancel">Cancel</button>
                        <button class="btn dangerbtn" id="modal-submit-delete" type="submit" disabled style="background:#ef4444;border-color:#ef4444;color:#fff">
                            Permanently Delete User
                        </button>
                    </div>
                </form>
            </div>
        `;

        $('modal-cancel').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };

        const confirmInput = $('delete-user-confirm-input');
        const submitBtn = $('modal-submit-delete');
        const cancelBtn = $('modal-cancel');
        const errBox = $('delete-user-modal-error');

        confirmInput.oninput = () => {
            submitBtn.disabled = confirmInput.value.trim() !== 'DELETE';
            if (errBox) errBox.style.display = 'none';
        };

        $('form-delete-user').onsubmit = async e => {
            e.preventDefault();
            if (confirmInput.value.trim() !== 'DELETE') return;

            // 1. Prevent repeated clicks and display loading state
            submitBtn.disabled = true;
            submitBtn.textContent = 'Deleting user account...';
            if (cancelBtn) cancelBtn.disabled = true;
            confirmInput.disabled = true;
            if (errBox) errBox.style.display = 'none';

            try {
                if (isPreviewMode()) {
                    // Dev preview (localhost only): simulate against the mock list, never the backend.
                    markUserAsDeleted(userId);
                    state.adminUsers = state.adminUsers.filter(u => u.id !== userId);
                    state.adminTotalUsers = Math.max(0, state.adminTotalUsers - 1);
                    try {
                        localStorage.setItem('stocksense_mock_admin_users', JSON.stringify(state.adminUsers));
                    } catch {}
                    closeModal();
                    notify(`Preview only: "${displayName}" was removed from the simulated list (no real account was deleted).`, 'info');
                    renderAdminUsersTable();
                    return;
                }

                // 2. Trusted server-side deletion: re-checks the caller's role, protects the Owner,
                //    removes dependent rows and the Supabase Auth account in ONE transaction.
                const { data, error } = await supabase.rpc('admin_delete_user', {
                    p_target_user_id: userId
                });

                if (error) throw error;

                // 3. Only a server-verified deletion counts as success.
                if (!data || data.success !== true || data.deleted_user_id !== userId || (data.auth_user_deleted !== undefined && data.auth_user_deleted !== true)) {
                    throw new Error('The server did not confirm the deletion of the authentication account.');
                }

                closeModal();

                // Reload overview counts and the user list from the database, then re-check.
                await loadAdminData();
                const stillListed = (state.adminUsers || []).some(u => u.id === userId);
                if (stillListed) {
                    notify('The server reported the deletion, but the account is still listed. Please refresh and verify before retrying.', 'error');
                } else {
                    notify(`User "${displayName}" was permanently deleted.`, 'success');
                }
            } catch (err) {
                // 4. On failure nothing was removed: keep the row, restore the controls, explain why.
                submitBtn.disabled = confirmInput.value.trim() !== 'DELETE';
                submitBtn.textContent = 'Permanently Delete User';
                if (cancelBtn) cancelBtn.disabled = false;
                confirmInput.disabled = false;

                const msg = friendlyAdminError(err, 'The account could not be deleted. No changes were made.');
                if (errBox) {
                    errBox.textContent = `Deletion failed: ${msg}`;
                    errBox.style.display = 'block';
                }
                notify(msg, 'error');
            }
        };
    }

    async function openAssignRoleModal(userId, currentRole) {
        if (state.currentRole !== 'owner') {
            notify('Only the Platform Owner can assign administrator roles and staff permissions.', 'error');
            return;
        }

        const user = state.adminUsers.find(u => u.id === userId);
        if (!user) return;

        let hasBulkUpload = false;
        try {
            const { data } = await supabase
                .from('staff_permissions')
                .select('permission')
                .eq('user_id', userId)
                .eq('permission', 'bulk_product_upload')
                .maybeSingle();
            if (data) hasBulkUpload = true;
        } catch {}

        $('modal').innerHTML = `
            <div class="modalbg" id="modal-bg">
                <form class="modal" id="form-role" style="max-width:480px">
                    <h2>Assign Administrative Role & Permissions</h2>
                    <p>Appoint administrator permissions for <b>${esc(user.full_name)}</b> (${esc(user.email)})</p>
                    <div class="fg full" style="margin-bottom:14px">
                        <label>Platform Role *</label>
                        <select class="field" id="select-new-role">
                            <option value="none" ${!currentRole || currentRole === 'member' ? 'selected' : ''}>Standard Member (No administrative access)</option>
                            <option value="moderator" ${currentRole === 'moderator' ? 'selected' : ''}>Moderator (Limited operational view)</option>
                            <option value="admin" ${currentRole === 'admin' ? 'selected' : ''}>Administrator (Full platform administration)</option>
                        </select>
                    </div>

                    <div class="fg full" style="margin-bottom:16px;padding:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:8px" id="fg-perm-box">
                        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
                            <input type="checkbox" id="check-perm-bulk" ${hasBulkUpload ? 'checked' : ''} style="width:18px;height:18px;margin-top:2px">
                            <div>
                                <b style="color:#fff">Bulk Product Upload Access (<code>bulk_product_upload</code>)</b>
                                <div class="muted" style="font-size:12px;margin-top:2px">Authorizes staff member to upload product catalogues into customer accounts via CSV. Available only to Moderator or Admin staff.</div>
                            </div>
                        </label>
                    </div>

                    <div class="auth-notice info">
                        <b>Privilege Note:</b> Platform Administrators can view registered user counts, manage suspensions, and review audit logs. Only the Owner can modify administrator roles and permissions.
                    </div>
                    <div class="actions">
                        <button type="button" class="btn secondary" id="modal-cancel">Cancel</button>
                        <button class="btn primary" id="modal-submit">Update Role & Permissions</button>
                    </div>
                </form>
            </div>
        `;

        $('modal-cancel').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };

        const roleSelect = $('select-new-role');
        const permBox = $('fg-perm-box');
        const permCheck = $('check-perm-bulk');
        const updatePermState = () => {
            if (roleSelect.value === 'none') {
                permBox.style.opacity = '0.4';
                permCheck.disabled = true;
                permCheck.checked = false;
            } else {
                permBox.style.opacity = '1';
                permCheck.disabled = false;
            }
        };
        roleSelect.onchange = updatePermState;
        updatePermState();

        $('form-role').onsubmit = async e => {
            e.preventDefault();
            const newRole = $('select-new-role').value;
            const wantBulkUpload = $('check-perm-bulk').checked;
            const btn = $('modal-submit');
            btn.disabled = true;
            btn.textContent = 'Updating...';

            try {
                // 1. Assign Role
                const { error: roleErr } = await supabase.rpc('admin_assign_role', {
                    p_target_user_id: userId,
                    p_role: newRole
                });
                if (roleErr) throw roleErr;

                // 2. Assign/Revoke Permission if staff
                if (newRole !== 'none') {
                    const { error: permErr } = await supabase.rpc('admin_set_staff_permission', {
                        p_target_user_id: userId,
                        p_permission: 'bulk_product_upload',
                        p_granted: wantBulkUpload
                    });
                    if (permErr) console.warn('Permission update warning:', permErr.message);
                }

                closeModal();
                notify('Role and staff permissions updated successfully.', 'success');
                await loadAdminUsers();
            } catch (err) {
                btn.disabled = false;
                btn.textContent = 'Update Role & Permissions';
                notify(err.message || 'Role assignment failed.', 'error');
            }
        };
    }

    async function loadPlatformSettings() {
        try {
            const { data } = await supabase
                .from('platform_settings')
                .select('*')
                .eq('key', 'system_settings')
                .maybeSingle();

            if (data && data.value) {
                state.platformSettings = { ...state.platformSettings, ...data.value };
                if ($('setting-platform-name')) $('setting-platform-name').value = state.platformSettings.platform_name || 'StockSense';
                if ($('setting-currency-symbol')) $('setting-currency-symbol').value = state.platformSettings.currency_symbol || '₦';
                if ($('setting-low-stock')) $('setting-low-stock').value = state.platformSettings.low_stock_default || 5;
                if ($('setting-whatsapp')) $('setting-whatsapp').value = state.platformSettings.support_whatsapp || '';
            }
        } catch (err) {
            console.warn('Could not load platform settings table:', err);
        }
    }

    async function bootstrapOwner() {
        const confirmed = window.confirm("Designate your current account as Platform Owner?\n\nThis one-time setup action is only permissible when no Owner exists yet.");
        if (!confirmed) return;

        try {
            const { data, error } = await supabase.rpc('bootstrap_initial_owner');
            if (error) {
                throw error;
            }

            state.currentRole = 'owner';
            updateUserSidebarInfo(state.currentUser, state.currentProfile, 'owner');
            notify('Successfully bootstrapped as Platform Owner!', 'success');
            await loadAdminData();
        } catch (err) {
            console.error(err);
            notify('Bootstrap failed: ' + (err.message || 'Database rejected bootstrap request.'), 'error');
        }
    }

    // -------------------------------------------------------------------------
    // Navigation, Dynamic Greeting & Page Switching
    // -------------------------------------------------------------------------
    function getGreeting(firstName, date = new Date()) {
        const hour = date.getHours();
        let timeOfDay = 'Good evening';
        if (hour >= 5 && hour < 12) {
            timeOfDay = 'Good morning';
        } else if (hour >= 12 && hour < 17) {
            timeOfDay = 'Good afternoon';
        }
        const cleanName = (firstName || '').trim();
        const displayName = cleanName || 'there';
        return `${timeOfDay}, ${displayName} 👋`;
    }

    function getUserFirstName() {
        const rawName = state.currentProfile?.full_name || 
                        state.currentUser?.user_metadata?.full_name || 
                        state.currentUser?.user_metadata?.name || '';
        const trimmed = rawName.trim();
        if (!trimmed) return '';
        const firstWord = trimmed.split(/\s+/)[0];
        return firstWord || '';
    }

    function updateDashboardGreeting() {
        if (state.currentView === 'dashboard') {
            const firstName = getUserFirstName();
            const greeting = getGreeting(firstName);
            if ($('title')) $('title').textContent = greeting;
            if ($('subtitle')) $('subtitle').textContent = "Here's your business at a glance.";
        }
    }

    // Pages that already render their own main heading inside the page content.
    // The shared top bar must not repeat that heading (or its primary action).
    const OWN_HEADING_PAGES = new Set(['inventory', 'movements']);

    const pageHeaders = {
        dashboard: ['', "Here's your business at a glance."],
        inventory: ['', ''],
        movements: ['', ''],
        advisor: ['StockSense Adviser', 'Get practical guidance for managing your stock.'],
        reports: ['Reports', 'Understand your inventory performance.'],
        admin: ['Platform Administration', 'Platform overview, user accounts, security roles and audit logs.'],
        assistance: ['How Can We Help You?', 'Choose the kind of assistance you need. Our team will guide you through the next steps.']
    };

    function go(pageId) {
        if (pageId === 'admin') {
            if (!state.currentUser) {
                showAuthScreen('signin');
                return;
            }
            if (!isAdminOrOwner() && !canBulkUpload()) {
                window.location.hash = '';
                notify('Access denied. Administrator privileges required.', 'error');
                go('dashboard');
                return;
            }
            window.location.hash = '#admin';
            loadAdminData();

            // If user is a staff member with bulk upload permission but not full admin/owner
            if (state.currentRole === 'moderator' && canBulkUpload()) {
                switchAdminTab('bulk-upload');
                document.querySelectorAll('.admin-nav-tab').forEach(t => {
                    t.style.display = (t.dataset.adminTab === 'bulk-upload') ? '' : 'none';
                });
            } else {
                document.querySelectorAll('.admin-nav-tab').forEach(t => {
                    t.style.display = '';
                });
            }
        } else {
            if (window.location.hash === '#admin') {
                window.location.hash = '';
            }
        }

        state.currentView = pageId;

        document.querySelectorAll('.page').forEach(el => {
            el.classList.toggle('active', el.id === `page-${pageId}`);
        });

        document.querySelectorAll('[data-page]').forEach(el => {
            el.classList.toggle('active', el.dataset.page === pageId);
        });

        if (pageId === 'dashboard') {
            updateDashboardGreeting();
        } else if (pageHeaders[pageId]) {
            if ($('title')) $('title').textContent = pageHeaders[pageId][0];
            if ($('subtitle')) $('subtitle').textContent = pageHeaders[pageId][1];
        }

        // Pages with their own in-page heading: render no second heading in the shared top bar.
        const ownsHeading = OWN_HEADING_PAGES.has(pageId);
        const topBar = $('page-top');
        const topHeading = $('top-heading-text');
        if (topBar) topBar.classList.toggle('top-compact', ownsHeading);
        if (topHeading) topHeading.hidden = ownsHeading;

        if (pageId === 'assistance') {
            const hasWhatsapp = !!(state.platformSettings.support_whatsapp || window.STOCKSENSE_WHATSAPP);
            const noWaEl = $('assistance-no-whatsapp');
            if (noWaEl) noWaEl.style.display = hasWhatsapp ? 'none' : 'block';
            const detailPanel = $('assistance-detail-panel');
            if (detailPanel) detailPanel.style.display = 'none';
        }

        $('sidebar')?.classList.remove('open');
        $('sidebar-overlay')?.classList.remove('active');

        if (pageId === 'advisor') recommend();
        if (pageId === 'reports') reports();
        if (pageId === 'inventory') renderProducts();
        if (pageId === 'movements') renderMoves();
    }

    // -------------------------------------------------------------------------
    // Customer Feedback System
    // -------------------------------------------------------------------------
    function openFeedbackModal() {
        const userEmail = state.currentUser ? (state.currentUser.email || '') : '';

        $('modal').innerHTML = `
            <div class="modalbg" id="modal-bg">
                <form class="modal" id="form-feedback" style="max-width:480px">
                    <h2>Share Feedback</h2>
                    <p style="margin-bottom:16px">Help us shape StockSense. Tell us about your experience, report an issue, or suggest a new feature.</p>
                    
                    <div class="fg full" style="margin-bottom:14px">
                        <label for="fb-type">Feedback Category *</label>
                        <select class="field" id="fb-type" required>
                            <option value="Suggestion">💡 Feature Suggestion</option>
                            <option value="Bug Report">🐛 Issue / Bug Report</option>
                            <option value="General Feedback" selected>💬 General Feedback</option>
                        </select>
                    </div>

                    <div class="fg full" style="margin-bottom:14px">
                        <label for="fb-message">Your Feedback *</label>
                        <textarea class="field" id="fb-message" rows="4" placeholder="Tell us what you like, what is confusing, or what you would like improved..." required style="resize:vertical;min-height:90px"></textarea>
                        <div style="display:flex;justify-content:space-between;margin-top:4px">
                            <small class="muted">Minimum 5 characters</small>
                            <small class="muted" id="fb-char-count">0 / 2000</small>
                        </div>
                    </div>

                    <div class="fg full" style="margin-bottom:18px">
                        <label for="fb-email">Contact Email (Optional)</label>
                        <input class="field" type="email" id="fb-email" value="${esc(userEmail)}" placeholder="you@company.com">
                        <small class="muted">Only used if we need to follow up regarding your report.</small>
                    </div>

                    <div class="actions">
                        <button type="button" class="btn secondary" id="modal-cancel">Cancel</button>
                        <button type="submit" class="btn primary" id="btn-submit-feedback">Submit Feedback</button>
                    </div>
                </form>
            </div>
        `;

        $('modal-cancel').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };

        const msgInput = $('fb-message');
        const charCount = $('fb-char-count');
        if (msgInput && charCount) {
            msgInput.oninput = () => {
                charCount.textContent = `${msgInput.value.length} / 2000`;
            };
        }

        $('form-feedback').onsubmit = async e => {
            e.preventDefault();
            const type = $('fb-type').value;
            const message = msgInput.value.trim();
            const email = $('fb-email').value.trim();
            const btn = $('btn-submit-feedback');

            if (message.length < 5) {
                notify('Please provide a message with at least 5 characters.', 'error');
                return;
            }
            if (message.length > 2000) {
                notify('Message exceeds maximum limit of 2000 characters.', 'error');
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Submitting...';

            try {
                const { error } = await supabase.from('feedback').insert({
                    user_id: state.currentUser ? state.currentUser.id : null,
                    feedback_type: type,
                    message: message,
                    contact_email: email || (state.currentUser ? state.currentUser.email : null)
                });

                if (error) {
                    throw error;
                }

                closeModal();
                notify('Thank you for helping us improve StockSense!', 'success');
            } catch (err) {
                btn.disabled = false;
                btn.textContent = 'Submit Feedback';
                notify('Failed to save feedback: ' + (err.message || 'Please check your connection and try again.'), 'error');
            }
        };
    }

    async function loadAdminFeedback() {
        const statusFilter = $('admin-fb-filter-status')?.value || 'all';
        const tbody = $('admin-feedback-table');
        if (!tbody) return;

        try {
            let query = supabase
                .from('feedback')
                .select('*')
                .order('created_at', { ascending: false });

            if (statusFilter !== 'all') {
                query = query.eq('status', statusFilter);
            }

            const { data, error } = await query;

            if (error) {
                tbody.innerHTML = `<tr><td colspan="6" class="empty">Could not load feedback: ${esc(error.message)}</td></tr>`;
                return;
            }

            if (!data || !data.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty">No feedback entries recorded.</td></tr>';
                return;
            }

            tbody.innerHTML = data.map(fb => {
                const statusCls = fb.status === 'Resolved' ? 'badge-active' : (fb.status === 'Reviewed' ? 'role-badge moderator' : 'badge-suspended');
                return `
                    <tr>
                        <td>${datefmt(fb.created_at)}</td>
                        <td><b>${esc(fb.feedback_type)}</b></td>
                        <td>${esc(fb.contact_email || 'Anonymous')}</td>
                        <td style="max-width:320px;white-space:normal;line-height:1.4">${esc(fb.message)}</td>
                        <td><span class="badge ${statusCls}">${esc(fb.status)}</span></td>
                        <td>
                            <select class="field" data-admin-act="fb-status" data-fbid="${fb.id}" style="padding:4px 8px;font-size:11px;width:auto">
                                <option value="New" ${fb.status === 'New' ? 'selected' : ''}>New</option>
                                <option value="Reviewed" ${fb.status === 'Reviewed' ? 'selected' : ''}>Reviewed</option>
                                <option value="Resolved" ${fb.status === 'Resolved' ? 'selected' : ''}>Resolved</option>
                            </select>
                        </td>
                    </tr>
                `;
            }).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty">Error: ${esc(err.message)}</td></tr>`;
        }
    }

    async function updateFeedbackStatus(id, newStatus) {
        try {
            const { error } = await supabase
                .from('feedback')
                .update({ status: newStatus })
                .eq('id', id);

            if (error) throw error;
            notify('Feedback status updated to ' + newStatus, 'success');
            loadAdminFeedback();
        } catch (err) {
            notify('Failed to update status: ' + err.message, 'error');
        }
    }

    // -------------------------------------------------------------------------
    // -------------------------------------------------------------------------
    // Progressive Web App (PWA) Install Prompt & 5-Minute Reminder
    //
    // Rules:
    //  - The prompt is eligible ONLY while a real authenticated session is active
    //    (never on login, signup, check-email, verification, password reset or loading screens).
    //  - It is shown at most once per eligibility window; route changes never re-trigger it.
    //  - If the user dismisses/cancels it, it is offered again after 5 minutes until installed.
    //  - Exactly ONE reminder timer exists at any time (every scheduler clears the previous one),
    //    and nothing is shown while the tab is in the background.
    //  - "Installed" is only recorded from the browser's `appinstalled` event or detected live from
    //    standalone display mode; accepting the native dialog alone is not treated as installed.
    // -------------------------------------------------------------------------
    const PWA_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const PWA_FIRST_PROMPT_DELAY_MS = 2500;
    const PWA_BUSY_RETRY_MS = 25000;
    let deferredPwaPrompt = null;      // native `beforeinstallprompt` event (Chromium-based browsers)
    let pwaReminderTimer = null;       // the single reminder timer
    let pwaPromptEligible = false;     // true only after successful authentication
    let pwaVisibilityBound = false;

    function readPwaStorage(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function writePwaStorage(key, value) {
        try {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch {}
    }

    function isRunningStandalone() {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.navigator && window.navigator.standalone === true) return true;
        if (document.referrer && document.referrer.startsWith('android-app://')) return true;
        return false;
    }

    function isAppInstalled() {
        if (isRunningStandalone()) return true;
        return readPwaStorage('stocksense_pwa_installed') === 'true';
    }

    function isIosDevice() {
        const ua = navigator.userAgent || '';
        const classicIos = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
        const modernIpad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1; // iPadOS 13+
        return classicIos || modernIpad;
    }

    /** True when the browser can actually install the app: native prompt captured, or iOS manual flow. */
    function isPwaInstallPossible() {
        return !!deferredPwaPrompt || isIosDevice();
    }

    function canOfferPwaPrompt() {
        if (!pwaPromptEligible) return false;                 // not authenticated (or signing out)
        if (!state.currentUser) return false;                 // auth unresolved / signed out
        if (isSigningOutDueToTimeout) return false;
        const appRoot = $('app-root');
        if (!appRoot || appRoot.style.display === 'none') return false;
        if (isAppInstalled()) return false;
        return isPwaInstallPossible();
    }

    function clearPwaTimer() {
        if (pwaReminderTimer) {
            clearTimeout(pwaReminderTimer);
            pwaReminderTimer = null;
        }
    }

    function isPwaBannerVisible() {
        const banner = $('pwa-install-banner');
        return !!banner && banner.style.display !== 'none';
    }

    function hidePwaUi() {
        const banner = $('pwa-install-banner');
        if (banner) banner.style.display = 'none';
        const iosModal = $('modal-pwa-instructions');
        if (iosModal) iosModal.style.display = 'none';
    }

    function pwaReminderDelay() {
        const dismissedAt = Number(readPwaStorage('stocksense_pwa_dismissed_at') || 0);
        if (!dismissedAt) return PWA_FIRST_PROMPT_DELAY_MS;
        return Math.max(0, PWA_INTERVAL_MS - (Date.now() - dismissedAt));
    }

    function shouldShowPwaPrompt() {
        if (!canOfferPwaPrompt()) return false;
        const dismissedAt = Number(readPwaStorage('stocksense_pwa_dismissed_at') || 0);
        if (!dismissedAt) return true;
        return (Date.now() - dismissedAt) >= PWA_INTERVAL_MS;
    }

    /** (Re)schedules the one and only reminder timer. Safe to call repeatedly. */
    function scheduleNextPwaPrompt() {
        clearPwaTimer();
        if (!canOfferPwaPrompt()) return;
        if (isPwaBannerVisible()) return; // already on screen; the next reminder starts at dismissal
        pwaReminderTimer = setTimeout(() => {
            pwaReminderTimer = null;
            showPwaPromptIfEligible();
        }, pwaReminderDelay());
    }

    function showPwaPromptIfEligible() {
        if (!canOfferPwaPrompt()) {
            clearPwaTimer();
            hidePwaUi();
            return;
        }
        if (!shouldShowPwaPrompt()) {
            scheduleNextPwaPrompt();
            return;
        }
        // Never show while the tab is in the background; the visibilitychange handler re-evaluates.
        if (document.visibilityState !== 'visible') return;
        if (isPwaBannerVisible()) return;

        // Defer while another dialog is open
        const modalEl = $('modal');
        if (modalEl && modalEl.children.length > 0) {
            clearPwaTimer();
            pwaReminderTimer = setTimeout(() => {
                pwaReminderTimer = null;
                showPwaPromptIfEligible();
            }, PWA_BUSY_RETRY_MS);
            return;
        }

        const banner = $('pwa-install-banner');
        if (banner) banner.style.display = 'flex';
    }

    /** Called once a real session is fully established (app shell visible). */
    function activatePwaPromptForSession() {
        pwaPromptEligible = true;
        if (!pwaVisibilityBound) {
            pwaVisibilityBound = true;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && canOfferPwaPrompt() && !isPwaBannerVisible() && !pwaReminderTimer) {
                    scheduleNextPwaPrompt();
                }
            });
        }
        // Idempotent: do not restart a pending timer or hide a banner that is already showing.
        if (pwaReminderTimer || isPwaBannerVisible()) return;
        scheduleNextPwaPrompt();
    }

    /** Called whenever an unauthenticated/transitional screen is displayed, and on sign-out. */
    function deactivatePwaPromptForSession() {
        pwaPromptEligible = false;
        clearPwaTimer();
        hidePwaUi();
    }

    function dismissPwaPrompt() {
        writePwaStorage('stocksense_pwa_dismissed_at', Date.now().toString());
        hidePwaUi();
        scheduleNextPwaPrompt();
    }

    function markPwaInstalled() {
        writePwaStorage('stocksense_pwa_installed', 'true');
        deferredPwaPrompt = null;
        clearPwaTimer();
        hidePwaUi();
    }

    async function handlePwaInstallClick() {
        if (deferredPwaPrompt) {
            const nativePrompt = deferredPwaPrompt;
            deferredPwaPrompt = null; // a captured prompt can only be used once
            const banner = $('pwa-install-banner');
            if (banner) banner.style.display = 'none';
            try {
                nativePrompt.prompt();
                const { outcome } = await nativePrompt.userChoice;
                if (outcome === 'accepted') {
                    // Wait for the browser's `appinstalled` event before recording anything as installed.
                    clearPwaTimer();
                } else {
                    dismissPwaPrompt();
                }
            } catch (err) {
                console.warn('[PWA] Install prompt failed:', err);
                dismissPwaPrompt();
            }
        } else if (isIosDevice()) {
            const banner = $('pwa-install-banner');
            if (banner) banner.style.display = 'none';
            $('modal-pwa-instructions').style.display = 'flex';
        } else {
            notify('To install StockSense, click the install icon in your browser address bar or choose "Install" from the menu (⋮).', 'info');
            dismissPwaPrompt();
        }
    }

    function initPwa() {
        // Register Service Worker for offline resilience
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(err => {
                console.warn('[PWA] Service worker registration error:', err);
            });
        }

        // Capture the native prompt as early as possible (it may fire before sign-in), but only
        // surface it to the user once authentication has succeeded.
        window.addEventListener('beforeinstallprompt', e => {
            e.preventDefault();
            deferredPwaPrompt = e;
            // The browser only fires this when the app is NOT installed, so clear any stale flag
            // left behind by a previous installation that has since been removed.
            writePwaStorage('stocksense_pwa_installed', null);
            if (pwaPromptEligible) scheduleNextPwaPrompt();
        });

        window.addEventListener('appinstalled', () => {
            markPwaInstalled();
        });

        // Leaving/entering standalone mode (e.g. after installing) updates the UI live.
        if (window.matchMedia) {
            const standaloneQuery = window.matchMedia('(display-mode: standalone)');
            const onDisplayModeChange = () => {
                if (standaloneQuery.matches) {
                    clearPwaTimer();
                    hidePwaUi();
                }
            };
            if (standaloneQuery.addEventListener) standaloneQuery.addEventListener('change', onDisplayModeChange);
        }

        if (isRunningStandalone()) {
            hidePwaUi();
        }
        // No prompt is evaluated here: eligibility starts only after authentication succeeds.
    }
    // -------------------------------------------------------------------------
    // Customer-Facing Inventory Setup Assistance
    // -------------------------------------------------------------------------
    function openAssistanceUpload() {
        state.activeAssistanceOption = 'upload';
        const detailPanel = $('assistance-detail-panel');
        if (!detailPanel) return;

        $('assistance-detail-title').innerHTML = '📦 Option A: Help Upload My Products';
        $('assistance-detail-content').innerHTML = `
            <p style="margin-bottom:16px;color:var(--text);font-size:14px;line-height:1.6">
                Have a long list of products or need help setting up your inventory? Our team can assist you with preparing and uploading your product catalogue to your StockSense account.
            </p>
            <div class="assistance-steps-list">
                <div class="assistance-step-item">
                    <span class="step-num">1</span>
                    <div>
                        <b>Product Catalogue Review</b>
                        <p>The StockSense team will discuss the product list and information required (product names, prices, categories, and initial quantities).</p>
                    </div>
                </div>
                <div class="assistance-step-item">
                    <span class="step-num">2</span>
                    <div>
                        <b>Spreadsheet Formatting & Guidance</b>
                        <p>You may be asked to provide a properly formatted spreadsheet or other agreed product details using our standard template.</p>
                    </div>
                </div>
                <div class="assistance-step-item">
                    <span class="step-num">3</span>
                    <div>
                        <b>Service Confirmation via WhatsApp</b>
                        <p>The team will confirm the service arrangements, pricing, and next steps through WhatsApp before any upload takes place.</p>
                    </div>
                </div>
                <div class="assistance-step-item">
                    <span class="step-num">4</span>
                    <div>
                        <b>Secure Staff Upload Workflow</b>
                        <p>Product uploads will be carried out by authorized team members using our verified staff workflow. Products and stock movements appear in your account automatically.</p>
                    </div>
                </div>
                <div class="assistance-step-item" style="border-color:rgba(239,68,68,0.3);background:rgba(239,68,68,0.04)">
                    <span class="step-num" style="background:#ef4444;color:#fff">🔒</span>
                    <div>
                        <b style="color:#ef4444">Strict Password Security Rule</b>
                        <p><strong style="color:#fff">Never share your StockSense password.</strong> Our team will never ask for your password or direct login access. Authorized staff import products securely from the backend without access to your credentials.</p>
                    </div>
                </div>
            </div>
        `;
        detailPanel.style.display = 'block';
        detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function openAssistanceTraining() {
        state.activeAssistanceOption = 'training';
        const detailPanel = $('assistance-detail-panel');
        if (!detailPanel) return;

        $('assistance-detail-title').innerHTML = '🎓 Option B: Train Me or My Staff';
        $('assistance-detail-content').innerHTML = `
            <p style="margin-bottom:16px;color:var(--text);font-size:14px;line-height:1.6">
                Would you like to learn how to add products, record sales and restocking, monitor stock levels, and use StockSense confidently? Request training for yourself or your staff.
            </p>
            <div class="assistance-steps-list">
                <div class="assistance-step-item">
                    <span class="step-num">1</span>
                    <div>
                        <b>Practical Inventory Skills</b>
                        <p>Learn end-to-end workflows: cataloguing products, setting low-stock reorder thresholds, recording sales, restocking incoming orders, and managing inventory adjustments.</p>
                    </div>
                </div>
                <div class="assistance-step-item">
                    <span class="step-num">2</span>
                    <div>
                        <b>Flexible Format & Schedule</b>
                        <p>Discuss your team's specific training needs, preferred delivery format (remote video walk-through or on-site where available), schedule, and participant count.</p>
                    </div>
                </div>
                <div class="assistance-step-item">
                    <span class="step-num">3</span>
                    <div>
                        <b>Direct WhatsApp Consultation</b>
                        <p>Confirm the available training options, arrangements, pricing, and next steps directly with the StockSense team. No automated commitments or hidden fees.</p>
                    </div>
                </div>
            </div>
        `;
        detailPanel.style.display = 'block';
        detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function closeAssistanceDetail() {
        const detailPanel = $('assistance-detail-panel');
        if (detailPanel) detailPanel.style.display = 'none';
        state.activeAssistanceOption = null;
    }

    function handleContinueToWhatsApp() {
        const configuredNumber = (state.platformSettings.support_whatsapp || window.STOCKSENSE_WHATSAPP || '').trim();
        const digitsOnly = configuredNumber.replace(/[^0-9]/g, '');

        if (!digitsOnly) {
            notify('StockSense support WhatsApp number is not configured yet. Please configure it in Platform Settings or contact your administrator.', 'warning');
            return;
        }

        let prefilledMessage = '';
        if (state.activeAssistanceOption === 'upload') {
            prefilledMessage = 'Hello StockSense team, I need assistance uploading the products in my shop to StockSense. Please explain the process, requirements, pricing, and next steps.';
        } else if (state.activeAssistanceOption === 'training') {
            prefilledMessage = 'Hello StockSense team, I would like assistance learning how to use StockSense. I need training for myself or my staff. Please explain the available options, pricing, and next steps.';
        } else {
            prefilledMessage = 'Hello StockSense team, I need assistance with setting up my inventory.';
        }

        const waUrl = `https://wa.me/${digitsOnly}?text=${encodeURIComponent(prefilledMessage)}`;
        window.open(waUrl, '_blank', 'noopener,noreferrer');
    }

    // -------------------------------------------------------------------------
    // Staff Bulk Product Upload Workflow
    // -------------------------------------------------------------------------
    function downloadCsvTemplate() {
        const headers = ['name', 'sku', 'category', 'unit_cost', 'selling_price', 'quantity', 'minimum_stock', 'supplier', 'emoji'];
        const sampleRows = [
            ['Wireless Optical Mouse', 'MOU-001', 'Electronics', '4500', '7500', '25', '5', 'TechSupplies Ltd', '🖱️'],
            ['USB-C Fast Charging Cable 2m', 'CAB-002', 'Accessories', '1500', '3000', '50', '10', 'CableWorld', '🔌'],
            ['Cotton Casual T-Shirt', 'TSH-003', 'Apparel', '2800', '5000', '15', '3', 'Apex Textiles', '👕']
        ];

        const csvContent = '\uFEFF' + [
            headers.join(','),
            ...sampleRows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))
        ].join('\r\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'stocksense_product_import_template.csv');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    function parseCsvText(text) {
        if (!text) return [];
        if (text.charCodeAt(0) === 0xFEFF) {
            text = text.slice(1);
        }

        const lines = [];
        let row = [];
        let col = '';
        let insideQuote = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const nextChar = text[i + 1];

            if (char === '"') {
                if (insideQuote && nextChar === '"') {
                    col += '"';
                    i++;
                } else {
                    insideQuote = !insideQuote;
                }
            } else if (char === ',' && !insideQuote) {
                row.push(col);
                col = '';
            } else if ((char === '\r' || char === '\n') && !insideQuote) {
                if (char === '\r' && nextChar === '\n') {
                    i++;
                }
                row.push(col);
                if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) {
                    lines.push(row);
                }
                row = [];
                col = '';
            } else {
                col += char;
            }
        }
        if (col.length > 0 || row.length > 0) {
            row.push(col);
            if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) {
                lines.push(row);
            }
        }

        if (lines.length < 2) return [];

        const headers = lines[0].map(h => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
        const objects = [];

        for (let r = 1; r < lines.length; r++) {
            const rowValues = lines[r];
            const obj = { _line: r + 1 };
            headers.forEach((h, colIdx) => {
                obj[h] = rowValues[colIdx] !== undefined ? rowValues[colIdx].trim() : '';
            });
            objects.push(obj);
        }

        return objects;
    }

    function validateCsvRows(rawRows, existingUserSkus = new Set()) {
        const validRows = [];
        const invalidRows = [];
        const errors = [];
        const seenSkusInFile = new Set();

        rawRows.forEach((row, idx) => {
            const lineNum = row._line || (idx + 2);
            const rowErrors = [];

            // Product name (required)
            const name = (row.name || row['product name'] || '').trim();
            if (!name) {
                rowErrors.push('Product name is required');
            }

            // SKU (optional, but must be unique)
            let sku = (row.sku || '').trim();
            if (sku) {
                const lowerSku = sku.toLowerCase();
                if (seenSkusInFile.has(lowerSku)) {
                    rowErrors.push(`Duplicate SKU "${sku}" within CSV file`);
                } else {
                    seenSkusInFile.add(lowerSku);
                }
                if (existingUserSkus && existingUserSkus.has(lowerSku)) {
                    rowErrors.push(`SKU "${sku}" already exists in customer catalog`);
                }
            }

            // Category (defaults to General / Other)
            const category = (row.category || 'General').trim() || 'General';

            // Selling price (required, non-negative)
            const sellingRaw = row.selling_price || row['selling price'] || row.price;
            const sellingPrice = sellingRaw !== undefined && sellingRaw !== '' ? Number(sellingRaw) : NaN;
            if (isNaN(sellingPrice) || sellingPrice < 0) {
                rowErrors.push('Selling price must be a valid non-negative number');
            }

            // Unit cost / Cost price (optional, non-negative)
            const costRaw = row.unit_cost || row['cost price'] || row.cost || '0';
            const unitCost = costRaw !== '' ? Number(costRaw) : 0;
            if (isNaN(unitCost) || unitCost < 0) {
                rowErrors.push('Cost price must be a non-negative number');
            }

            // Quantity (optional integer >= 0)
            const qtyRaw = row.quantity || row['initial quantity'] || row.qty || '0';
            const quantity = qtyRaw !== '' ? parseInt(qtyRaw, 10) : 0;
            if (isNaN(quantity) || quantity < 0) {
                rowErrors.push('Quantity must be a non-negative whole number');
            }

            // Minimum stock (optional integer >= 0)
            const minRaw = row.minimum_stock || row['min stock'] || row['minimum stock level'] || '5';
            const minimumStock = minRaw !== '' ? parseInt(minRaw, 10) : 5;
            if (isNaN(minimumStock) || minimumStock < 0) {
                rowErrors.push('Minimum stock must be a non-negative whole number');
            }

            // Supplier & emoji
            const supplier = (row.supplier || '').trim();
            const emoji = (row.emoji || '📦').trim() || '📦';

            if (rowErrors.length > 0) {
                invalidRows.push({ ...row, errors: rowErrors });
                errors.push(`Row ${lineNum} (${name || 'Unnamed'}): ${rowErrors.join(', ')}`);
            } else {
                validRows.push({
                    name,
                    sku: sku || null,
                    category,
                    unit_cost: unitCost,
                    selling_price: sellingPrice,
                    quantity,
                    minimum_stock: minimumStock,
                    supplier: supplier || null,
                    emoji
                });
            }
        });

        return {
            validRows,
            invalidRows,
            errors,
            totalRows: rawRows.length
        };
    }

    function initAdminBulkUploadView() {
        const stepFile = $('bulk-step-file');
        if (stepFile) stepFile.classList.add('disabled');
        const selectedBanner = $('bulk-selected-customer-card');
        if (selectedBanner) selectedBanner.style.display = 'none';
        const resultsEl = $('bulk-customer-results');
        if (resultsEl) resultsEl.style.display = 'none';
        const previewArea = $('bulk-csv-preview-area');
        if (previewArea) previewArea.style.display = 'none';
        const resultNotice = $('bulk-import-result');
        if (resultNotice) resultNotice.style.display = 'none';

        state.bulkUploadState = {
            targetCustomer: null,
            existingSkus: new Set(),
            parsedProducts: [],
            validProducts: [],
            invalidRows: []
        };
    }

    async function searchBulkCustomer() {
        const searchInput = $('bulk-customer-search');
        const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
        const resultsEl = $('bulk-customer-results');
        if (!resultsEl) return;

        resultsEl.innerHTML = '<div class="muted" style="padding:10px">Searching customers...</div>';
        resultsEl.style.display = 'flex';

        try {
            let matches = [];
            if (state.adminUsers && state.adminUsers.length > 0) {
                matches = state.adminUsers.filter(u => {
                    if (u.is_suspended) return false;
                    const name = (u.full_name || '').toLowerCase();
                    const email = (u.email || '').toLowerCase();
                    const id = (u.id || '').toLowerCase();
                    return !query || name.includes(query) || email.includes(query) || id.includes(query);
                });
            } else {
                const { data, error } = await supabase
                    .from('profiles')
                    .select('id, full_name, is_suspended, created_at')
                    .eq('is_suspended', false)
                    .limit(20);

                if (error) throw error;
                matches = data || [];
                if (query) {
                    matches = matches.filter(u => (u.full_name || '').toLowerCase().includes(query) || (u.id || '').toLowerCase().includes(query));
                }
            }

            if (!matches.length) {
                resultsEl.innerHTML = '<div class="muted" style="padding:10px">No matching active customers found.</div>';
                return;
            }

            resultsEl.innerHTML = matches.map(u => {
                const initial = (u.full_name || u.email || 'C')[0].toUpperCase();
                return `
                    <div class="bulk-customer-card">
                        <div style="display:flex;align-items:center;gap:12px">
                            <div style="width:34px;height:34px;border-radius:50%;background:rgba(168,85,247,0.2);color:#c084fc;display:flex;align-items:center;justify-content:center;font-weight:700">
                                ${initial}
                            </div>
                            <div>
                                <b style="color:#fff;font-size:14px">${esc(u.full_name || 'Customer Account')}</b>
                                <div style="font-size:12px;color:var(--lav)">${esc(u.email || 'Email Protected')} · <span style="font-family:monospace">${esc(u.id.substring(0, 8))}…</span></div>
                            </div>
                        </div>
                        <button class="btn primary btn-sm" type="button" data-select-cust-id="${esc(u.id)}">
                            Select Customer
                        </button>
                    </div>
                `;
            }).join('');
        } catch (err) {
            resultsEl.innerHTML = `<div class="auth-notice error" style="padding:8px">Search failed: ${esc(err.message)}</div>`;
        }
    }

    async function selectBulkCustomer(customerId) {
        let user = (state.adminUsers || []).find(u => u.id === customerId);
        if (!user) {
            user = { id: customerId, full_name: 'Customer Account', email: 'customer@stocksense.io' };
        }

        state.bulkUploadState.targetCustomer = user;
        state.bulkUploadState.existingSkus = new Set();

        const initial = (user.full_name || user.email || 'C')[0].toUpperCase();
        if ($('bulk-selected-avatar')) $('bulk-selected-avatar').textContent = initial;
        if ($('bulk-selected-name')) $('bulk-selected-name').textContent = user.full_name || 'Customer Account';
        if ($('bulk-selected-email')) $('bulk-selected-email').textContent = user.email || 'Customer Account';
        if ($('bulk-selected-id')) $('bulk-selected-id').textContent = `ID: ${user.id}`;

        if ($('bulk-selected-customer-card')) $('bulk-selected-customer-card').style.display = 'flex';
        if ($('bulk-customer-results')) $('bulk-customer-results').style.display = 'none';

        const stepFile = $('bulk-step-file');
        if (stepFile) stepFile.classList.remove('disabled');

        try {
            const { data } = await supabase
                .from('products')
                .select('sku')
                .eq('user_id', user.id);
            if (data && Array.isArray(data)) {
                data.forEach(p => {
                    if (p.sku) state.bulkUploadState.existingSkus.add(p.sku.toLowerCase().trim());
                });
            }
        } catch (err) {
            console.warn('Could not load existing customer SKUs:', err);
        }

        notify(`Target customer selected: ${user.full_name || user.email}`, 'info');
    }

    function changeBulkCustomer() {
        state.bulkUploadState.targetCustomer = null;
        state.bulkUploadState.existingSkus = new Set();
        if ($('bulk-selected-customer-card')) $('bulk-selected-customer-card').style.display = 'none';
        if ($('bulk-step-file')) $('bulk-step-file').classList.add('disabled');
        clearBulkCsvFile();
    }

    function clearBulkCsvFile() {
        const input = $('bulk-csv-input');
        if (input) input.value = '';
        state.bulkUploadState.parsedProducts = [];
        state.bulkUploadState.validProducts = [];
        state.bulkUploadState.invalidRows = [];
        const previewArea = $('bulk-csv-preview-area');
        if (previewArea) previewArea.style.display = 'none';
        const resultNotice = $('bulk-import-result');
        if (resultNotice) resultNotice.style.display = 'none';
    }

    function handleBulkCsvFileSelect(file) {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
            notify('Please select a valid CSV file (.csv).', 'error');
            return;
        }

        const reader = new FileReader();
        reader.onload = e => {
            try {
                const text = e.target.result;
                const rawRows = parseCsvText(text);

                if (rawRows.length === 0) {
                    notify('The selected CSV file appears to be empty or contains only headers.', 'warning');
                    return;
                }

                const { validRows, invalidRows, errors, totalRows } = validateCsvRows(
                    rawRows,
                    state.bulkUploadState.existingSkus
                );

                state.bulkUploadState.parsedProducts = rawRows;
                state.bulkUploadState.validProducts = validRows;
                state.bulkUploadState.invalidRows = invalidRows;

                if ($('bulk-valid-count')) $('bulk-valid-count').textContent = `${validRows.length} Valid Rows`;
                if ($('bulk-invalid-count')) {
                    if (invalidRows.length > 0) {
                        $('bulk-invalid-count').textContent = `${invalidRows.length} Invalid Rows`;
                        $('bulk-invalid-count').style.display = 'inline-block';
                    } else {
                        $('bulk-invalid-count').style.display = 'none';
                    }
                }
                if ($('bulk-total-count')) $('bulk-total-count').textContent = `${totalRows} Total Rows in File`;

                const errorsBox = $('bulk-csv-errors');
                const errorsList = $('bulk-errors-list');
                if (errorsBox && errorsList) {
                    if (errors.length > 0) {
                        errorsList.innerHTML = errors.slice(0, 10).map(err => `<li>${esc(err)}</li>`).join('');
                        if (errors.length > 10) {
                            errorsList.innerHTML += `<li style="color:var(--muted)">…and ${errors.length - 10} more row issues.</li>`;
                        }
                        errorsBox.style.display = 'block';
                    } else {
                        errorsBox.style.display = 'none';
                    }
                }

                const tbody = $('bulk-preview-tbody');
                if (tbody) {
                    const previewRows = rawRows.slice(0, 25);
                    tbody.innerHTML = previewRows.map((r, i) => {
                        const isInvalid = invalidRows.some(inv => inv._line === r._line);
                        const statusBadge = isInvalid
                            ? `<span class="badge badge-suspended">Rejected</span>`
                            : `<span class="badge badge-active">Ready</span>`;
                        return `
                            <tr style="${isInvalid ? 'opacity:0.6;background:rgba(239,68,68,0.06)' : ''}">
                                <td>${i + 1}</td>
                                <td><b>${esc(r.name || r['product name'] || '—')}</b></td>
                                <td><code>${esc(r.sku || '—')}</code></td>
                                <td>${esc(r.category || 'General')}</td>
                                <td>${cash(r.selling_price || 0)}</td>
                                <td>${cash(r.unit_cost || 0)}</td>
                                <td>${fmt(r.quantity || 0)}</td>
                                <td>${fmt(r.minimum_stock || 5)}</td>
                                <td>${statusBadge}</td>
                            </tr>
                        `;
                    }).join('');
                }

                const confirmBtn = $('btn-confirm-bulk-import');
                if (confirmBtn) {
                    confirmBtn.disabled = validRows.length === 0;
                    confirmBtn.textContent = `Confirm & Import ${validRows.length} Products →`;
                }

                if ($('bulk-csv-preview-area')) $('bulk-csv-preview-area').style.display = 'block';
                if ($('bulk-import-result')) $('bulk-import-result').style.display = 'none';

            } catch (err) {
                notify('Failed to parse CSV file: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    }

    async function executeBulkProductImport() {
        if (!canBulkUpload()) {
            notify('Access denied: Staff bulk upload permission required.', 'error');
            return;
        }

        const target = state.bulkUploadState.targetCustomer;
        if (!target) {
            notify('Please select a target customer account first.', 'error');
            return;
        }

        const validProducts = state.bulkUploadState.validProducts;
        if (!validProducts || validProducts.length === 0) {
            notify('No valid products to import.', 'warning');
            return;
        }

        const confirmed = window.confirm(
            `Import ${validProducts.length} verified products into account for "${target.full_name || target.email}"?\n\nThis will add the products to their catalog and record initial inventory movements.`
        );
        if (!confirmed) return;

        const btn = $('btn-confirm-bulk-import');
        btn.disabled = true;
        btn.textContent = 'Importing Products…';

        try {
            const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            const urlParams = new URLSearchParams(window.location.search);
            const isPreview = isLocalhost && urlParams.get('preview');

            let result;
            if (isPreview) {
                const totalSubmitted = validProducts.length + state.bulkUploadState.invalidRows.length;
                result = {
                    success: true,
                    total_submitted: totalSubmitted,
                    imported_count: validProducts.length,
                    failed_count: state.bulkUploadState.invalidRows.length,
                    failed_rows: []
                };

                state.adminAuditLogs.unshift({
                    id: 'mock-audit-' + Date.now(),
                    actor_email: state.currentUser ? state.currentUser.email : 'staff@stocksense.io',
                    action: 'BULK_PRODUCT_IMPORT',
                    target_type: 'user',
                    target_id: target.id,
                    details: {
                        imported_count: validProducts.length,
                        customer: target.full_name || target.email
                    },
                    created_at: new Date().toISOString()
                });
            } else {
                const { data, error } = await supabase.rpc('staff_bulk_import_products', {
                    p_target_user_id: target.id,
                    p_products: validProducts
                });

                if (error) throw error;
                result = data;
            }

            const resultNotice = $('bulk-import-result');
            if (resultNotice) {
                resultNotice.className = 'auth-notice ' + (result.imported_count > 0 ? 'info' : 'error');
                resultNotice.innerHTML = `
                    <b>Import Operation Completed:</b>
                    <ul style="margin:6px 0 0 16px;padding:0">
                        <li><b>Target Customer:</b> ${esc(target.full_name || target.email)}</li>
                        <li><b>Successfully Imported:</b> ${result.imported_count} products</li>
                        <li><b>Rejected / Skipped:</b> ${result.failed_count || state.bulkUploadState.invalidRows.length} rows</li>
                    </ul>
                    <div style="margin-top:8px;font-size:12px;color:var(--lav)">
                        An official audit record has been logged for this staff onboarding operation.
                    </div>
                `;
                resultNotice.style.display = 'block';
                resultNotice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }

            notify(`Import complete: ${result.imported_count} products added to ${target.full_name || target.email}`, 'success');

            $('bulk-csv-input').value = '';
            $('bulk-csv-preview-area').style.display = 'none';
            state.bulkUploadState.validProducts = [];
            state.bulkUploadState.parsedProducts = [];

        } catch (err) {
            btn.disabled = false;
            btn.textContent = `Confirm & Import ${validProducts.length} Products →`;
            notify('Import failed: ' + (err.message || 'Server error'), 'error');
        }
    }

    function switchAdminTab(tabId) {
        state.adminTab = tabId;
        document.querySelectorAll('.admin-nav-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.adminTab === tabId);
        });
        document.querySelectorAll('.admin-section').forEach(s => {
            s.classList.toggle('active', s.id === `admin-sec-${tabId}`);
        });

        if (tabId === 'users') loadAdminUsers();
        if (tabId === 'settings') loadPlatformSettings();
        if (tabId === 'feedback') loadAdminFeedback();
        if (tabId === 'bulk-upload') initAdminBulkUploadView();
    }

    // -------------------------------------------------------------------------
    // Event Listeners & Initialization
    // -------------------------------------------------------------------------
    document.addEventListener('click', e => {
        // Navigation links
        const navBtn = e.target.closest('[data-page]');
        if (navBtn) {
            go(navBtn.dataset.page);
            return;
        }

        const goBtn = e.target.closest('[data-go]');
        if (goBtn) {
            go(goBtn.dataset.go);
            return;
        }

        // Feedback triggers
        const fbBtn = e.target.closest('#btn-open-feedback');
        if (fbBtn) {
            openFeedbackModal();
            return;
        }

        const refreshFbBtn = e.target.closest('#btn-refresh-feedback');
        if (refreshFbBtn) {
            loadAdminFeedback();
            return;
        }

        // PWA banner actions
        const pwaInstallBtn = e.target.closest('#btn-pwa-install');
        if (pwaInstallBtn) {
            handlePwaInstallClick();
            return;
        }

        const pwaDismissBtn = e.target.closest('#btn-pwa-dismiss');
        if (pwaDismissBtn) {
            dismissPwaPrompt();
            return;
        }

        const pwaIosCloseBtn = e.target.closest('#btn-pwa-instructions-close');
        if (pwaIosCloseBtn) {
            $('modal-pwa-instructions').style.display = 'none';
            dismissPwaPrompt();
            return;
        }

        // Product actions
        const actBtn = e.target.closest('[data-act]');
        if (actBtn) {
            const act = actBtn.dataset.act;
            const id = actBtn.dataset.id;
            if (act === 'edit') {
                const p = state.products.find(x => x.id === id);
                if (p) openProductModal(p);
            } else if (act === 'sale') {
                openMovementModal(id, 'Sale');
            } else if (act === 'restock') {
                openMovementModal(id, 'Restock');
            } else if (act === 'adjust') {
                openAdjustmentModal(id);
            } else if (act === 'delete') {
                deleteProduct(id);
            }
            return;
        }

        // Setup assistance triggers
        if (e.target.closest('#btn-assistance-upload')) {
            openAssistanceUpload();
            return;
        }
        if (e.target.closest('#btn-assistance-training')) {
            openAssistanceTraining();
            return;
        }
        if (e.target.closest('#btn-close-assistance-detail') || e.target.closest('#btn-cancel-assistance')) {
            closeAssistanceDetail();
            return;
        }
        if (e.target.closest('#btn-continue-whatsapp')) {
            handleContinueToWhatsApp();
            return;
        }

        // Staff Bulk Upload triggers
        if (e.target.closest('#btn-download-csv-template')) {
            downloadCsvTemplate();
            return;
        }
        if (e.target.closest('#btn-search-customer')) {
            searchBulkCustomer();
            return;
        }
        const selectCustBtn = e.target.closest('[data-select-cust-id]');
        if (selectCustBtn) {
            selectBulkCustomer(selectCustBtn.dataset.selectCustId);
            return;
        }
        if (e.target.closest('#btn-change-target-customer')) {
            changeBulkCustomer();
            return;
        }
        if (e.target.closest('#dropzone-clickable-area')) {
            $('bulk-csv-input')?.click();
            return;
        }
        if (e.target.closest('#btn-cancel-bulk-import')) {
            clearBulkCsvFile();
            return;
        }
        if (e.target.closest('#btn-confirm-bulk-import')) {
            executeBulkProductImport();
            return;
        }

        // Admin actions
        const adminTabBtn = e.target.closest('[data-admin-tab]');
        if (adminTabBtn) {
            switchAdminTab(adminTabBtn.dataset.adminTab);
            return;
        }

        const adminActBtn = e.target.closest('[data-admin-act]');
        if (adminActBtn) {
            const act = adminActBtn.dataset.adminAct;
            const uid = adminActBtn.dataset.uid;
            if (act === 'details') openUserDetailsModal(uid);
            if (act === 'toggle-suspend') openSuspendModal(uid, adminActBtn.dataset.suspended === 'true');
            if (act === 'assign-role') openAssignRoleModal(uid, adminActBtn.dataset.role);
            if (act === 'delete-user') openDeleteUserModal(uid);
            return;
        }

        const adminPageBtn = e.target.closest('[data-admin-page]');
        if (adminPageBtn && !adminPageBtn.disabled) {
            const dir = adminPageBtn.dataset.adminPage;
            const step = state.adminUserLimit;
            state.adminUserOffset = dir === 'next' ? state.adminUserOffset + step : Math.max(0, state.adminUserOffset - step);
            loadAdminUsers();
            return;
        }
    });

    // File input and drag & drop for bulk upload
    $('bulk-csv-input')?.addEventListener('change', e => {
        if (e.target.files && e.target.files[0]) {
            handleBulkCsvFileSelect(e.target.files[0]);
        }
    });

    const bulkDropzone = $('bulk-file-dropzone');
    if (bulkDropzone) {
        bulkDropzone.addEventListener('dragover', e => {
            e.preventDefault();
            bulkDropzone.style.borderColor = 'var(--green)';
        });
        bulkDropzone.addEventListener('dragleave', e => {
            e.preventDefault();
            bulkDropzone.style.borderColor = 'rgba(168, 85, 247, 0.4)';
        });
        bulkDropzone.addEventListener('drop', e => {
            e.preventDefault();
            bulkDropzone.style.borderColor = 'rgba(168, 85, 247, 0.4)';
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleBulkCsvFileSelect(e.dataTransfer.files[0]);
            }
        });
    }

    $('bulk-customer-search')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchBulkCustomer();
        }
    });

    // Feedback status select change delegation
    document.addEventListener('change', e => {
        const sel = e.target.closest('[data-admin-act="fb-status"]');
        if (sel) {
            updateFeedbackStatus(sel.dataset.fbid, sel.value);
        }
    });
    $('admin-fb-filter-status')?.addEventListener('change', () => {
        loadAdminFeedback();
    });

    // Top action buttons
    $('add2').onclick = () => openProductModal();
    $('export').onclick = exportMovementsCSV;
    $('exportInventory').onclick = exportInventoryCSV;

    // Mobile drawer controls
    $('menu').onclick = () => {
        $('sidebar').classList.add('open');
        $('sidebar-overlay').classList.add('active');
    };
    $('sidebar-overlay').onclick = () => {
        $('sidebar').classList.remove('open');
        $('sidebar-overlay').classList.remove('active');
    };
    const sideCloseBtn = $('sidebar-close');
    if (sideCloseBtn) {
        sideCloseBtn.onclick = () => {
            $('sidebar').classList.remove('open');
            $('sidebar-overlay').classList.remove('active');
        };
    }

    // Close mobile drawer and modals with Escape key
    window.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            $('sidebar')?.classList.remove('open');
            $('sidebar-overlay')?.classList.remove('active');
            closeModal();
        }
    });

    // Live search & filters
    $('search').oninput = renderProducts;
    $('filter').onchange = renderProducts;
    $('catFilter').onchange = renderProducts;
    $('moveSearch').oninput = renderMoves;
    $('moveFilter').onchange = renderMoves;

    // Adviser budget trigger
    $('run').onclick = recommend;
    $('budget').onkeydown = e => { if (e.key === 'Enter') recommend(); };

    // Sign out button
    $('btn-signout').onclick = async () => {
        const confirmed = window.confirm("Are you sure you want to sign out of StockSense?");
        if (!confirmed) return;
        try { localStorage.removeItem(INACTIVITY_STORAGE_KEY); } catch {}
        await supabase.auth.signOut();
        state.currentUser = null;
        state.currentProfile = null;
        state.currentRole = null;
        state.products = [];
        state.moves = [];
        showAuthScreen('signin', 'You have been signed out safely.', 'info');
    };

    // User interaction listeners for 30-minute inactivity timeout
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt => {
        window.addEventListener(evt, onUserInteraction, { passive: true });
    });

    // Check inactivity every 15 seconds
    setInterval(checkInactivityTimeout, 15000);

    // Check inactivity on visibility change (switching tabs) and window focus
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            checkInactivityTimeout();
        }
    });
    window.addEventListener('focus', checkInactivityTimeout);

    // Admin controls
    $('admin-user-search').oninput = () => {
        state.adminUserOffset = 0;
        loadAdminUsers();
    };
    $('admin-user-role-filter').onchange = () => {
        state.adminUserOffset = 0;
        loadAdminUsers();
    };
    $('admin-user-status-filter').onchange = () => {
        state.adminUserOffset = 0;
        loadAdminUsers();
    };
    $('admin-btn-bootstrap-owner').onclick = bootstrapOwner;

    // Settings save
    $('form-admin-settings').onsubmit = async e => {
        e.preventDefault();
        const btn = $('btn-save-settings');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        const updatedSettings = {
            platform_name: $('setting-platform-name').value.trim() || 'StockSense',
            currency_symbol: $('setting-currency-symbol').value.trim() || '₦',
            low_stock_default: Number($('setting-low-stock').value) || 5,
            support_whatsapp: $('setting-whatsapp')?.value.trim() || '',
            maintenance_mode: false
        };

        try {
            await supabase.from('platform_settings').upsert({
                key: 'system_settings',
                value: updatedSettings,
                updated_at: new Date().toISOString(),
                updated_by: state.currentUser.id
            });
            state.platformSettings = updatedSettings;
            notify('Platform settings saved successfully.', 'success');
            render();
        } catch (err) {
            notify('Error saving settings: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Platform Settings';
        }
    };

    // Auth state changes
    supabase.auth.onAuthStateChange((event, session) => {
        if (isSigningOutDueToTimeout) return;
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        if (isLocalhost && new URLSearchParams(window.location.search).get('preview')) return;
        if (event === 'SIGNED_OUT' || !session) {
            state.currentUser = null;
            state.currentProfile = null;
            state.currentRole = null;
            state.products = [];
            state.moves = [];
            showAuthScreen('signin');
        } else if (event === 'SIGNED_IN' && session.user && !state.currentUser) {
            recordUserActivity();
            handleAuthenticatedSession(session.user);
        }
    });

    // Format current date in header
    $('date').textContent = new Date().toLocaleDateString('en-NG', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });

    // Dynamic greeting refresh when window/tab regains focus or becomes visible
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.currentView === 'dashboard') {
            updateDashboardGreeting();
        }
    });

    window.addEventListener('focus', () => {
        if (state.currentView === 'dashboard') {
            updateDashboardGreeting();
        }
    });

    // Secure browser URL hash changes for #admin navigation
    window.addEventListener('hashchange', async () => {
        if (window.location.hash === '#admin') {
            if (!state.currentUser) {
                showAuthScreen('signin');
                return;
            }
            const verifiedRole = await fetchUserRole(state.currentUser.id);
            state.currentRole = verifiedRole;
            updateUserSidebarInfo(state.currentUser, state.currentProfile, state.currentRole);
            if (verifiedRole === 'owner' || verifiedRole === 'admin') {
                go('admin');
            } else {
                window.location.hash = '';
                go('dashboard');
                notify('Access denied. Administrator privileges required.', 'error');
            }
        } else if (state.currentView === 'admin' && window.location.hash !== '#admin') {
            go('dashboard');
        }
    });

    // Expose helpers for tests and runtime inspection
    if (typeof window !== 'undefined') {
        window.StockSense = {
            state,
            getGreeting,
            getUserFirstName,
            updateDashboardGreeting,
            isAdminOrOwner,
            canBulkUpload,
            pageHeaders,
            go,
            isAppInstalled,
            shouldShowPwaPrompt,
            PWA_INTERVAL_MS,
            scheduleNextPwaPrompt,
            showPwaPromptIfEligible,
            dismissPwaPrompt,
            markPwaInstalled,
            openFeedbackModal,
            loadAdminFeedback,
            openAssistanceUpload,
            openAssistanceTraining,
            closeAssistanceDetail,
            handleContinueToWhatsApp,
            downloadCsvTemplate,
            parseCsvText,
            validateCsvRows,
            searchBulkCustomer,
            selectBulkCustomer,
            executeBulkProductImport,
            getAuthRedirectUrl,
            showAuthScreen,
            openDeleteUserModal
        };
    }

    // Initialize Progressive Web App reminders and service worker
    initPwa();

    // Start application session restoration
    initSession();

})();
