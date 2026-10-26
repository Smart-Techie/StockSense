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
        platformSettings: {
            platform_name: "StockSense",
            currency_symbol: "₦",
            currency_code: "NGN",
            maintenance_mode: false,
            low_stock_default: 5
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
    async function initSession() {
        showAuthScreen('loading');

        // Check for dev preview parameter on localhost / 127.0.0.1
        const urlParams = new URLSearchParams(window.location.search);
        const previewRole = urlParams.get('preview');
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

        if (isLocalhost && previewRole) {
            recordUserActivity();
            const isOwner = previewRole === 'owner';
            const mockUser = {
                id: '00000000-0000-0000-0000-000000000001',
                email: isOwner ? 'owner@stocksense.io' : 'store@stocksense.io',
                user_metadata: { full_name: isOwner ? 'Malcolm Jude (Owner)' : 'Sarah Business Store' }
            };
            state.currentUser = mockUser;
            state.currentProfile = {
                id: mockUser.id,
                full_name: mockUser.user_metadata.full_name,
                is_suspended: false
            };
            state.currentRole = isOwner ? 'owner' : (previewRole === 'admin' ? 'admin' : null);

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
                if (isAdminOrOwner()) {
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
            return;
        }

        // Check for password recovery hash in URL
        const hash = window.location.hash;
        if (hash && hash.includes('type=recovery')) {
            showAuthScreen('recovery');
            return;
        }

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

        // Fetch administrative role
        state.currentRole = await fetchUserRole(user.id);

        // Update UI
        updateUserSidebarInfo(user, profile, state.currentRole);

        // Load inventory data
        await loadInventoryData(user.id);

        // Transition from auth to application
        $('auth-screen').style.display = 'none';
        $('app-root').style.display = '';

        // Check if navigated directly to #admin
        if (window.location.hash === '#admin') {
            if (isAdminOrOwner()) {
                go('admin');
            } else {
                go('dashboard');
                notify('Administrator privileges required to access Admin Dashboard.', 'error');
            }
        } else {
            go('dashboard');
        }
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

    function isAdminOrOwner() {
        return state.currentRole === 'owner' || state.currentRole === 'admin';
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
            if (role === 'owner' || role === 'admin') {
                adminBtn.classList.remove('hide');
                adminBtn.querySelector('.nav-badge').textContent = role.toUpperCase();
            } else {
                adminBtn.classList.add('hide');
            }
        }
    }

    // -------------------------------------------------------------------------
    // Auth UI View Rendering
    // -------------------------------------------------------------------------
    function showAuthScreen(view, message = '', messageType = 'error') {
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
                        data: { full_name: fullName }
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
            const email = message || 'your email address';
            container.innerHTML = `
                <div style="text-align:center;padding:20px 0">
                    <div style="font-size:48px;margin-bottom:12px">✉️</div>
                    <h3 style="margin:0 0 8px;font-size:20px">Check your email</h3>
                    <p style="color:#c4b8d3;font-size:13px;line-height:1.5;margin-bottom:20px">
                        We have sent an activation link to <b style="color:#fff">${esc(email)}</b>. 
                        Please click the link in your email to confirm your account and access your inventory.
                    </p>
                    <div class="auth-notice info" style="text-align:left">
                        <b>Next step:</b> Check your inbox (and spam/promotions folder). Once confirmed, sign in below.
                    </div>
                    <button class="btn primary" id="btn-back-to-signin" style="width:100%;margin-top:10px">Proceed to Sign In →</button>
                </div>
            `;
            $('btn-back-to-signin').onclick = () => showAuthScreen('signin');
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
                    redirectTo: window.location.origin + window.location.pathname
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
                    email
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
        const outCount = p.filter(x => st(x) === 'out').length;
        const totalVal = p.reduce((s, x) => s + (Number(x.quantity || 0) * Number(x.unit_cost || 0)), 0);

        const html = card('Total products', fmt(p.length), '▦', '', 'Unique listed products') +
            card('Units in stock', fmt(totalUnits), '▤', 'g', 'Across catalogue') +
            card('Low-stock items', fmt(lowCount), '!', 'o', lowCount === 1 ? '1 needs attention' : `${lowCount} need attention`) +
            card('Inventory value', cash(totalVal), '₦', 'p', 'At recorded purchase cost') +
            (containerId === 'metrics' ? card('Out of stock', fmt(outCount), '×', 'r', `${outCount} currently unavailable`) : '');

        $(containerId).innerHTML = html;
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
        renderChart();
        renderAlerts();
        renderRecent();
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

    async function loadAdminUsers() {
        const search = ($('admin-user-search')?.value || '').trim();
        const role = $('admin-user-role-filter')?.value || 'all';
        const status = $('admin-user-status-filter')?.value || 'all';

        try {
            // Try calling admin_get_users RPC
            const { data, error } = await supabase.rpc('admin_get_users', {
                p_search: search,
                p_role: role,
                p_status: status,
                p_limit: state.adminUserLimit,
                p_offset: state.adminUserOffset
            });

            if (!error && data) {
                state.adminUsers = data.users || [];
                state.adminTotalUsers = data.total || 0;
                renderAdminUsersTable();
                return;
            }
        } catch (rpcErr) {
            console.warn('admin_get_users RPC failed, falling back to profiles table:', rpcErr);
        }

        // Fallback: query profiles directly
        let query = supabase.from('profiles').select('*, platform_roles(role)');
        if (status === 'active') query = query.eq('is_suspended', false);
        if (status === 'suspended') query = query.eq('is_suspended', true);

        const { data: profiles, error } = await query;
        if (!error && profiles) {
            state.adminUsers = profiles.map(p => ({
                id: p.id,
                email: p.id === state.currentUser.id ? state.currentUser.email : `user_${p.id.substring(0, 6)}@client`,
                full_name: p.full_name,
                is_suspended: p.is_suspended,
                suspension_reason: p.suspension_reason,
                role: p.platform_roles?.[0]?.role || null,
                created_at: p.created_at,
                last_sign_in_at: p.updated_at
            }));
            state.adminTotalUsers = state.adminUsers.length;
            renderAdminUsersTable();
        }
    }

    function renderAdminUsersTable() {
        const tbody = $('admin-users-table');
        if (!tbody) return;

        if (!state.adminUsers.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty">No matching users found.</td></tr>';
            return;
        }

        tbody.innerHTML = state.adminUsers.map(u => {
            const isSuspended = u.is_suspended;
            const role = u.role || 'member';
            const isOwner = role === 'owner';
            const isSelf = u.id === state.currentUser.id;

            return `
                <tr>
                    <td>
                        <b>${esc(u.full_name || 'Unnamed User')}</b>
                        <div class="foot">${esc(u.id)}</div>
                    </td>
                    <td>${esc(u.email || '—')}</td>
                    <td><span class="role-badge ${role}">${role}</span></td>
                    <td><span class="status ${isSuspended ? 'out' : 'ok'}">${isSuspended ? 'Suspended' : 'Active'}</span></td>
                    <td>${datefmt(u.created_at)}</td>
                    <td>${datefmt(u.last_sign_in_at)}</td>
                    <td>
                        <button class="smallbtn" data-admin-act="details" data-uid="${u.id}">Details</button>
                        ${!isOwner && !isSelf ? `
                            <button class="smallbtn ${isSuspended ? '' : 'del'}" data-admin-act="toggle-suspend" data-uid="${u.id}" data-suspended="${isSuspended}">
                                ${isSuspended ? 'Reactivate' : 'Suspend'}
                            </button>
                        ` : ''}
                        ${state.currentRole === 'owner' && !isSelf ? `
                            <button class="smallbtn" data-admin-act="assign-role" data-uid="${u.id}" data-role="${role}">
                                Set Role
                            </button>
                        ` : ''}
                    </td>
                </tr>
            `;
        }).join('');

        // Update pagination text
        const pageSpan = $('admin-users-pagination-info');
        if (pageSpan) {
            const start = state.adminTotalUsers > 0 ? state.adminUserOffset + 1 : 0;
            const end = Math.min(state.adminUserOffset + state.adminUserLimit, state.adminTotalUsers);
            pageSpan.textContent = `Showing ${start}-${end} of ${state.adminTotalUsers} users`;
        }
    }

    function openUserDetailsModal(userId) {
        const user = state.adminUsers.find(u => u.id === userId);
        if (!user) return;

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
                    <div class="actions">
                        <button type="button" class="btn primary" id="modal-close-btn">Close</button>
                    </div>
                </div>
            </div>
        `;
        $('modal-close-btn').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };
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
                    ` : `
                        <p style="color:var(--green)">Reactivating this account will restore the user's access to their inventory.</p>
                    `}
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
            btn.disabled = true;
            btn.textContent = 'Processing...';

            try {
                // Enforce server-side authorization RPC
                const { error } = await supabase.rpc('admin_toggle_suspension', {
                    p_target_user_id: userId,
                    p_suspend: !isCurrentlySuspended,
                    p_reason: reason
                });

                if (error) {
                    throw error;
                }

                closeModal();
                notify(`User ${isCurrentlySuspended ? 'reactivated' : 'suspended'} successfully.`, 'success');
                await loadAdminUsers();
            } catch (err) {
                btn.disabled = false;
                btn.textContent = `${actionWord} Account`;
                notify(err.message || 'Operation failed.', 'error');
            }
        };
    }

    function openAssignRoleModal(userId, currentRole) {
        if (state.currentRole !== 'owner') {
            notify('Only the Platform Owner can assign administrator roles.', 'error');
            return;
        }

        const user = state.adminUsers.find(u => u.id === userId);
        if (!user) return;

        $('modal').innerHTML = `
            <div class="modalbg" id="modal-bg">
                <form class="modal" id="form-role">
                    <h2>Assign Administrative Role</h2>
                    <p>Appoint administrator permissions for <b>${esc(user.full_name)}</b> (${esc(user.email)})</p>
                    <div class="fg full" style="margin-bottom:16px">
                        <label>Platform Role *</label>
                        <select class="field" id="select-new-role">
                            <option value="none" ${!currentRole || currentRole === 'member' ? 'selected' : ''}>Standard Member (No administrative access)</option>
                            <option value="moderator" ${currentRole === 'moderator' ? 'selected' : ''}>Moderator (Limited operational view)</option>
                            <option value="admin" ${currentRole === 'admin' ? 'selected' : ''}>Administrator (Full platform administration)</option>
                        </select>
                    </div>
                    <div class="auth-notice info">
                        <b>Privilege Note:</b> Platform Administrators can view registered user counts, manage suspensions, and review audit logs. Only the Owner can modify administrator roles.
                    </div>
                    <div class="actions">
                        <button type="button" class="btn secondary" id="modal-cancel">Cancel</button>
                        <button class="btn primary" id="modal-submit">Update Role</button>
                    </div>
                </form>
            </div>
        `;

        $('modal-cancel').onclick = closeModal;
        $('modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };

        $('form-role').onsubmit = async e => {
            e.preventDefault();
            const newRole = $('select-new-role').value;
            const btn = $('modal-submit');
            btn.disabled = true;
            btn.textContent = 'Updating...';

            try {
                // Enforce server-side authorization RPC
                const { error } = await supabase.rpc('admin_assign_role', {
                    p_target_user_id: userId,
                    p_role: newRole
                });

                if (error) {
                    throw error;
                }

                closeModal();
                notify('Administrator role updated successfully.', 'success');
                await loadAdminUsers();
            } catch (err) {
                btn.disabled = false;
                btn.textContent = 'Update Role';
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
        return cleanName ? `${timeOfDay}, ${cleanName} 👋` : `${timeOfDay} 👋`;
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

    const pageHeaders = {
        dashboard: ['', "Here's your business at a glance."],
        inventory: ['Product Inventory', 'Manage your catalog, products, prices, and stock.'],
        movements: ['Stock Movements', 'Track sales, restocking, and inventory adjustments.'],
        advisor: ['StockSense Adviser', 'Get practical guidance for managing your stock.'],
        reports: ['Reports', 'Understand your inventory performance.'],
        admin: ['Platform Administration', 'Platform overview, user accounts, security roles and audit logs.']
    };

    function go(pageId) {
        if (pageId === 'admin') {
            if (!state.currentUser) {
                showAuthScreen('signin');
                return;
            }
            if (!isAdminOrOwner()) {
                window.location.hash = '';
                notify('Access denied. Administrator privileges required.', 'error');
                go('dashboard');
                return;
            }
            window.location.hash = '#admin';
            loadAdminData();
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

        // Add Product button belongs ONLY on Product Inventory
        const addBtn = $('add');
        if (addBtn) {
            addBtn.style.display = (pageId === 'inventory') ? '' : 'none';
        }

        $('sidebar')?.classList.remove('open');
        $('sidebar-overlay')?.classList.remove('active');

        if (pageId === 'advisor') recommend();
        if (pageId === 'reports') reports();
        if (pageId === 'inventory') renderProducts();
        if (pageId === 'movements') renderMoves();
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
            return;
        }
    });

    // Top action buttons
    $('add').onclick = $('add2').onclick = () => openProductModal();
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
            pageHeaders,
            go
        };
    }

    // Start application session restoration
    initSession();

})();
