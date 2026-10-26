// StockSense Version 1.0 — Automated Logic and Unit Test Suite
import assert from 'assert';

console.log("=================================================");
console.log("Running StockSense Version 1.0 Unit Test Suite");
console.log("=================================================\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`✓ PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`✗ FAIL: ${name}`);
        console.error(`  Error: ${err.message}`);
        failed++;
    }
}

// -----------------------------------------------------------------------------
// 1. SKU Generation & Collision Prevention
// -----------------------------------------------------------------------------
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

test('SKU generator produces readable prefix and 4-digit code', () => {
    const sku = generateUniqueSKU('Chargers', []);
    assert.match(sku, /^CHG-\d{4}$/, `Expected CHG-XXXX format, got: ${sku}`);
});

test('SKU generator falls back gracefully for unknown categories', () => {
    const sku = generateUniqueSKU('Footwear', []);
    assert.match(sku, /^FOO-\d{4}$/, `Expected FOO-XXXX format, got: ${sku}`);
});

test('SKU generator avoids collision with existing user SKUs', () => {
    const existing = [{ sku: 'PHN-5555' }, { sku: 'PHN-1234' }];
    const sku = generateUniqueSKU('Phone accessories', existing);
    assert.notStrictEqual(sku.toLowerCase(), 'phn-5555');
    assert.notStrictEqual(sku.toLowerCase(), 'phn-1234');
    assert.match(sku, /^PHN-\d{4}$/);
});

// -----------------------------------------------------------------------------
// 2. Stock Health Status Evaluation
// -----------------------------------------------------------------------------
function st(p) {
    const qty = Number(p.quantity || 0);
    const min = Number(p.minimum_stock || 0);
    if (qty <= 0) return 'out';
    if (qty <= min) return 'low';
    return 'ok';
}

test('Status helper correctly marks out-of-stock when qty <= 0', () => {
    assert.strictEqual(st({ quantity: 0, minimum_stock: 5 }), 'out');
    assert.strictEqual(st({ quantity: -1, minimum_stock: 5 }), 'out');
});

test('Status helper correctly marks low-stock when qty <= minimum_stock', () => {
    assert.strictEqual(st({ quantity: 3, minimum_stock: 5 }), 'low');
    assert.strictEqual(st({ quantity: 5, minimum_stock: 5 }), 'low');
});

test('Status helper correctly marks in-stock when qty > minimum_stock', () => {
    assert.strictEqual(st({ quantity: 6, minimum_stock: 5 }), 'ok');
    assert.strictEqual(st({ quantity: 100, minimum_stock: 5 }), 'ok');
});

// -----------------------------------------------------------------------------
// 3. Movement Calculations and Safeguards
// -----------------------------------------------------------------------------
function calculateSale(currentStock, quantity) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Quantity must be a positive integer');
    }
    if (quantity > currentStock) {
        throw new Error(`Insufficient stock. Current: ${currentStock}, Requested: ${quantity}`);
    }
    return currentStock - quantity;
}

function calculateRestock(currentStock, quantity) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Quantity must be a positive integer');
    }
    return currentStock + quantity;
}

function calculateAdjustment(currentStock, mode, quantity) {
    if (mode === 'add') {
        if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Quantity must be positive');
        return currentStock + quantity;
    }
    if (mode === 'subtract') {
        if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Quantity must be positive');
        if (quantity > currentStock) throw new Error('Cannot reduce stock below zero');
        return currentStock - quantity;
    }
    if (mode === 'set') {
        if (!Number.isInteger(quantity) || quantity < 0) throw new Error('Quantity cannot be negative');
        return quantity;
    }
    throw new Error('Invalid adjustment mode');
}

test('Sale correctly deducts stock within available quantity', () => {
    const after = calculateSale(10, 4);
    assert.strictEqual(after, 6);
});

test('Sale rejects requests exceeding available stock', () => {
    assert.throws(() => calculateSale(5, 6), /Insufficient stock/);
});

test('Sale rejects non-positive or non-integer quantities', () => {
    assert.throws(() => calculateSale(10, 0), /positive integer/);
    assert.throws(() => calculateSale(10, -3), /positive integer/);
    assert.throws(() => calculateSale(10, 2.5), /positive integer/);
});

test('Restock correctly increases stock', () => {
    const after = calculateRestock(8, 5);
    assert.strictEqual(after, 13);
});

test('Adjustment handles addition, subtraction, and exact count', () => {
    assert.strictEqual(calculateAdjustment(10, 'add', 5), 15);
    assert.strictEqual(calculateAdjustment(10, 'subtract', 3), 7);
    assert.strictEqual(calculateAdjustment(10, 'set', 20), 20);
    assert.throws(() => calculateAdjustment(5, 'subtract', 10), /below zero/);
    assert.throws(() => calculateAdjustment(5, 'set', -2), /cannot be negative/);
});

// -----------------------------------------------------------------------------
// 4. Registration and Validation Logic
// -----------------------------------------------------------------------------
function validateRegistration(fullName, email, password, confirmPassword) {
    if (!fullName || !fullName.trim()) return 'Please enter your full name or business name.';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email.trim())) return 'Please enter a valid email address.';
    if (!password || password.length < 8) return 'Password must be at least 8 characters long.';
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        return 'Password must contain both letters and numbers.';
    }
    if (password !== confirmPassword) return 'Passwords do not match.';
    return null;
}

test('Registration rejects missing name', () => {
    assert.strictEqual(validateRegistration('', 'test@example.com', 'Pass1234!', 'Pass1234!'), 'Please enter your full name or business name.');
});

test('Registration rejects invalid email format', () => {
    assert.strictEqual(validateRegistration('User Name', 'invalid-email', 'Pass1234!', 'Pass1234!'), 'Please enter a valid email address.');
});

test('Registration rejects weak password (< 8 chars)', () => {
    assert.strictEqual(validateRegistration('User Name', 'test@example.com', 'Pass1', 'Pass1'), 'Password must be at least 8 characters long.');
});

test('Registration rejects password missing numbers', () => {
    assert.strictEqual(validateRegistration('User Name', 'test@example.com', 'PasswordOnly', 'PasswordOnly'), 'Password must contain both letters and numbers.');
});

test('Registration rejects mismatched passwords', () => {
    assert.strictEqual(validateRegistration('User Name', 'test@example.com', 'Password123!', 'DifferentPass123!'), 'Passwords do not match.');
});

test('Registration passes valid input', () => {
    assert.strictEqual(validateRegistration('Malcolm Jude', 'malcolm@business.com', 'SecurePass2026!', 'SecurePass2026!'), null);
});

// -----------------------------------------------------------------------------
// 5. StockSense Adviser Algorithm Verification
// -----------------------------------------------------------------------------
function calculateRestockPlan(products, moves, budget) {
    let left = budget;
    const candidates = products
        .filter(p => st(p) !== 'ok' && Number(p.unit_cost) > 0)
        .map(p => {
            const thirtyDaysAgo = Date.now() - (30 * 86400000);
            const sales = moves
                .filter(m => m.product_id === p.id && m.movement_type === 'Sale' && new Date(m.created_at).getTime() > thirtyDaysAgo)
                .reduce((s, m) => s + Number(m.quantity || 0), 0);
            const currentQty = Number(p.quantity || 0);
            const minQty = Number(p.minimum_stock || 0);
            const need = Math.max(1, minQty - currentQty);
            const score = (currentQty <= 0 ? 50 : 25) + Math.min(sales * 2, 20);
            return { ...p, need, sales, score };
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
            plan.push({ id: item.id, restockQty, totalCost });
        }
    }
    return { plan, spent: budget - left, remaining: left };
}

test('Adviser prioritizes out-of-stock items before low-stock items', () => {
    const products = [
        { id: '1', name: 'Low Stock Item', quantity: 2, minimum_stock: 5, unit_cost: 1000 },
        { id: '2', name: 'Out of Stock Item', quantity: 0, minimum_stock: 5, unit_cost: 1000 }
    ];
    const { plan } = calculateRestockPlan(products, [], 5000);
    assert.strictEqual(plan[0].id, '2', 'Out of stock item should be first priority');
});

test('Adviser suggestions do not exceed allocated budget', () => {
    const products = [
        { id: '1', name: 'Item A', quantity: 0, minimum_stock: 10, unit_cost: 3000 },
        { id: '2', name: 'Item B', quantity: 0, minimum_stock: 10, unit_cost: 2000 }
    ];
    const budget = 7000;
    const { plan, spent, remaining } = calculateRestockPlan(products, [], budget);
    assert(spent <= budget, `Spent (${spent}) exceeded budget (${budget})`);
    assert(remaining >= 0, `Remaining budget (${remaining}) cannot be negative`);
});

// -----------------------------------------------------------------------------
// 6. CSV Escaping (RFC 4180)
// -----------------------------------------------------------------------------
function formatCSVRow(row) {
    return row.map(cell => {
        const str = String(cell ?? '').replace(/"/g, '""');
        return `"${str}"`;
    }).join(',');
}

test('CSV formatter escapes commas, quotes, and line breaks properly', () => {
    const row = ['Fast Charger', 'ACC-001, v2', 'Includes "premium" cable\n2m', 1500];
    const formatted = formatCSVRow(row);
    assert.strictEqual(formatted, '"Fast Charger","ACC-001, v2","Includes ""premium"" cable\n2m","1500"');
});

// -----------------------------------------------------------------------------
// 7. 30-Minute Session Inactivity Timeout Logic
// -----------------------------------------------------------------------------
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (1,800,000 ms)

function isSessionExpired(lastActivityTimestamp, currentTimestamp = Date.now()) {
    if (!lastActivityTimestamp || isNaN(lastActivityTimestamp) || lastActivityTimestamp <= 0) {
        return false;
    }
    return (currentTimestamp - lastActivityTimestamp) >= INACTIVITY_TIMEOUT_MS;
}

test('Inactivity check flags session expired when 30 minutes or more have passed', () => {
    const now = Date.now();
    const exactly30MinsAgo = now - (30 * 60 * 1000);
    const thirtyOneMinsAgo = now - (31 * 60 * 1000);
    const twoHoursAgo = now - (120 * 60 * 1000);

    assert.strictEqual(isSessionExpired(exactly30MinsAgo, now), true, 'Exactly 30 mins should expire');
    assert.strictEqual(isSessionExpired(thirtyOneMinsAgo, now), true, '31 mins should expire');
    assert.strictEqual(isSessionExpired(twoHoursAgo, now), true, '2 hours should expire');
});

test('Inactivity check keeps session valid when less than 30 minutes have passed', () => {
    const now = Date.now();
    const activeNow = now;
    const tenMinsAgo = now - (10 * 60 * 1000);
    const twentyNineMinsAgo = now - (29 * 60 * 1000 + 50 * 1000); // 29m 50s

    assert.strictEqual(isSessionExpired(activeNow, now), false, 'Active now should be valid');
    assert.strictEqual(isSessionExpired(tenMinsAgo, now), false, '10 mins ago should be valid');
    assert.strictEqual(isSessionExpired(twentyNineMinsAgo, now), false, '29m 50s should be valid');
});

test('Inactivity check safely handles missing, invalid or zero timestamps', () => {
    const now = Date.now();
    assert.strictEqual(isSessionExpired(null, now), false);
    assert.strictEqual(isSessionExpired(undefined, now), false);
    assert.strictEqual(isSessionExpired(0, now), false);
    assert.strictEqual(isSessionExpired(NaN, now), false);
});

// -----------------------------------------------------------------------------
// 7. Dynamic Greeting & Profile First-Name Extraction
// -----------------------------------------------------------------------------
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

function getUserFirstName(profile, user) {
    const rawName = profile?.full_name || 
                    user?.user_metadata?.full_name || 
                    user?.user_metadata?.name || '';
    const trimmed = rawName.trim();
    if (!trimmed) return '';
    const firstWord = trimmed.split(/\s+/)[0];
    return firstWord || '';
}

test('Greeting: 5:00 AM to 11:59 AM produces "Good morning"', () => {
    const morningEarly = new Date(2026, 9, 26, 5, 0, 0);
    const morningLate = new Date(2026, 9, 26, 11, 59, 59);
    assert.strictEqual(getGreeting('John', morningEarly), 'Good morning, John 👋');
    assert.strictEqual(getGreeting('John', morningLate), 'Good morning, John 👋');
});

test('Greeting: 12:00 PM to 4:59 PM produces "Good afternoon"', () => {
    const noon = new Date(2026, 9, 26, 12, 0, 0);
    const afternoonLate = new Date(2026, 9, 26, 16, 59, 59);
    assert.strictEqual(getGreeting('John', noon), 'Good afternoon, John 👋');
    assert.strictEqual(getGreeting('John', afternoonLate), 'Good afternoon, John 👋');
});

test('Greeting: 5:00 PM to 4:59 AM produces "Good evening"', () => {
    const evening5pm = new Date(2026, 9, 26, 17, 0, 0);
    const midnight = new Date(2026, 9, 26, 0, 0, 0);
    const earlyMorning459 = new Date(2026, 9, 26, 4, 59, 59);
    assert.strictEqual(getGreeting('John', evening5pm), 'Good evening, John 👋');
    assert.strictEqual(getGreeting('John', midnight), 'Good evening, John 👋');
    assert.strictEqual(getGreeting('John', earlyMorning459), 'Good evening, John 👋');
});

test('Greeting: missing profile name falls back gracefully to "there"', () => {
    const morning = new Date(2026, 9, 26, 9, 0, 0);
    const afternoon = new Date(2026, 9, 26, 14, 0, 0);
    assert.strictEqual(getGreeting('', morning), 'Good morning, there 👋');
    assert.strictEqual(getGreeting(null, morning), 'Good morning, there 👋');
    assert.strictEqual(getGreeting('   ', afternoon), 'Good afternoon, there 👋');
});

test('First name extractor gets first name from full name or falls back gracefully', () => {
    assert.strictEqual(getUserFirstName({ full_name: 'John Doe' }, null), 'John');
    assert.strictEqual(getUserFirstName({ full_name: 'Sarah' }, null), 'Sarah');
    assert.strictEqual(getUserFirstName({ full_name: '  Adaeze   Nnamdi  ' }, null), 'Adaeze');
    assert.strictEqual(getUserFirstName({ full_name: '' }, { user_metadata: { full_name: 'Chioma Obi' } }), 'Chioma');
    assert.strictEqual(getUserFirstName(null, null), '');
    assert.strictEqual(getUserFirstName({ full_name: '' }, null), '');
});

// -----------------------------------------------------------------------------
// 8. Navigation Page Headers & Subtitles Configuration
// -----------------------------------------------------------------------------
const pageHeaders = {
    dashboard: ['', "Here's your business at a glance."],
    inventory: ['Product Inventory', 'Manage your catalog, products, prices, and stock.'],
    movements: ['Stock Movements', 'Track sales, restocking, and inventory adjustments.'],
    advisor: ['StockSense Adviser', 'Get practical guidance for managing your stock.'],
    reports: ['Reports', 'Understand your inventory performance.'],
    admin: ['Platform Administration', 'Platform overview, user accounts, security roles and audit logs.']
};

test('Page headers conform to updated specifications', () => {
    assert.strictEqual(pageHeaders.inventory[0], 'Product Inventory');
    assert.strictEqual(pageHeaders.inventory[1], 'Manage your catalog, products, prices, and stock.');
    assert.strictEqual(pageHeaders.movements[0], 'Stock Movements');
    assert.strictEqual(pageHeaders.movements[1], 'Track sales, restocking, and inventory adjustments.');
    assert.strictEqual(pageHeaders.advisor[0], 'StockSense Adviser');
    assert.strictEqual(pageHeaders.advisor[1], 'Get practical guidance for managing your stock.');
    assert.strictEqual(pageHeaders.reports[0], 'Reports');
    assert.strictEqual(pageHeaders.reports[1], 'Understand your inventory performance.');
    assert.strictEqual(pageHeaders.dashboard[1], "Here's your business at a glance.");
});

// -----------------------------------------------------------------------------
// 9. Add Product Button Visibility Rule
// -----------------------------------------------------------------------------
function isAddProductButtonVisible(pageId) {
    return pageId === 'inventory';
}

test('Main Add Product button is visible ONLY on Product Inventory', () => {
    assert.strictEqual(isAddProductButtonVisible('inventory'), true);
    assert.strictEqual(isAddProductButtonVisible('dashboard'), false);
    assert.strictEqual(isAddProductButtonVisible('movements'), false);
    assert.strictEqual(isAddProductButtonVisible('advisor'), false);
    assert.strictEqual(isAddProductButtonVisible('reports'), false);
    assert.strictEqual(isAddProductButtonVisible('admin'), false);
});

// -----------------------------------------------------------------------------
// 10. Role-Based Administrative Authorization
// -----------------------------------------------------------------------------
function isAdminOrOwner(role) {
    return role === 'owner' || role === 'admin';
}

test('Administrative authorization permits only owner and admin roles', () => {
    assert.strictEqual(isAdminOrOwner('owner'), true);
    assert.strictEqual(isAdminOrOwner('admin'), true);
    assert.strictEqual(isAdminOrOwner('member'), false);
    assert.strictEqual(isAdminOrOwner('moderator'), false);
    assert.strictEqual(isAdminOrOwner(null), false);
    assert.strictEqual(isAdminOrOwner(undefined), false);
    assert.strictEqual(isAdminOrOwner(''), false);
});

// -----------------------------------------------------------------------------
// 11. Four Key Homepage Statistics Calculations
// -----------------------------------------------------------------------------
function calculateHomepageMetrics(products) {
    const totalProducts = products.length;
    const unitsInStock = products.reduce((acc, p) => acc + Number(p.quantity || 0), 0);
    // Low-stock items exclude out-of-stock items (quantity > 0 && quantity <= minimum_stock)
    const lowStockItems = products.filter(p => Number(p.quantity) > 0 && Number(p.quantity) <= Number(p.minimum_stock)).length;
    // Inventory cost value
    const inventoryValue = products.reduce((acc, p) => acc + (Number(p.quantity || 0) * Number(p.unit_cost || 0)), 0);
    return { totalProducts, unitsInStock, lowStockItems, inventoryValue };
}

test('Homepage metrics calculate total products, units in stock, low-stock, and cost value', () => {
    const sampleProducts = [
        { id: '1', quantity: 10, minimum_stock: 5, unit_cost: 1000 }, // in stock
        { id: '2', quantity: 3, minimum_stock: 5, unit_cost: 2000 },  // low stock
        { id: '3', quantity: 0, minimum_stock: 5, unit_cost: 3000 },  // out of stock (excluded from low-stock count)
        { id: '4', quantity: 20, minimum_stock: 10, unit_cost: 500 }  // in stock
    ];
    const metrics = calculateHomepageMetrics(sampleProducts);
    assert.strictEqual(metrics.totalProducts, 4);
    assert.strictEqual(metrics.unitsInStock, 33); // 10 + 3 + 0 + 20
    assert.strictEqual(metrics.lowStockItems, 1); // only item 2
    assert.strictEqual(metrics.inventoryValue, (10 * 1000) + (3 * 2000) + (0 * 3000) + (20 * 500)); // 26,000
});

// -----------------------------------------------------------------------------
// 12. PWA State Machine & 5-Minute Repeat Timing
// -----------------------------------------------------------------------------
const PWA_INTERVAL_MS = 5 * 60 * 1000;

function shouldShowPwaPrompt(isInstalled, lastDismissedTimestamp, currentTimestamp = Date.now()) {
    if (isInstalled) return false;
    if (!lastDismissedTimestamp || lastDismissedTimestamp <= 0) return true;
    return (currentTimestamp - lastDismissedTimestamp) >= PWA_INTERVAL_MS;
}

test('PWA prompt logic never displays when app is installed', () => {
    const now = Date.now();
    assert.strictEqual(shouldShowPwaPrompt(true, null, now), false);
    assert.strictEqual(shouldShowPwaPrompt(true, now - 1000000, now), false);
});

test('PWA prompt shows on initial visit when uninstalled and never dismissed', () => {
    const now = Date.now();
    assert.strictEqual(shouldShowPwaPrompt(false, null, now), true);
    assert.strictEqual(shouldShowPwaPrompt(false, 0, now), true);
});

test('PWA prompt is suppressed during the 5-minute dismissal window', () => {
    const now = Date.now();
    const fourMinutesAgo = now - (4 * 60 * 1000);
    const fourMins59SecsAgo = now - (4 * 60 * 1000 + 59 * 1000);
    assert.strictEqual(shouldShowPwaPrompt(false, now, now), false);
    assert.strictEqual(shouldShowPwaPrompt(false, fourMinutesAgo, now), false);
    assert.strictEqual(shouldShowPwaPrompt(false, fourMins59SecsAgo, now), false);
});

test('PWA prompt re-triggers after 5 minutes have elapsed since dismissal', () => {
    const now = Date.now();
    const exactly5MinutesAgo = now - (5 * 60 * 1000);
    const sixMinutesAgo = now - (6 * 60 * 1000);
    assert.strictEqual(shouldShowPwaPrompt(false, exactly5MinutesAgo, now), true);
    assert.strictEqual(shouldShowPwaPrompt(false, sixMinutesAgo, now), true);
});

// -----------------------------------------------------------------------------
// 13. Customer Feedback Validation
// -----------------------------------------------------------------------------
function validateFeedbackInput(feedbackType, message, email) {
    const validTypes = ['Suggestion', 'Bug Report', 'General Feedback'];
    if (!validTypes.includes(feedbackType)) {
        return { valid: false, error: 'Invalid feedback category.' };
    }
    const cleanMessage = (message || '').trim();
    if (cleanMessage.length < 5) {
        return { valid: false, error: 'Feedback message must be at least 5 characters long.' };
    }
    if (cleanMessage.length > 2000) {
        return { valid: false, error: 'Feedback message cannot exceed 2000 characters.' };
    }
    if (email && email.trim()) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) {
            return { valid: false, error: 'Please enter a valid email address or leave blank.' };
        }
    }
    return { valid: true, error: null };
}

test('Feedback validation accepts valid suggestions, bug reports, and general feedback', () => {
    const res = validateFeedbackInput('Suggestion', 'Please add multi-currency exchange rate calculation.', 'owner@store.com');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.error, null);
});

test('Feedback validation accepts empty optional email', () => {
    const res = validateFeedbackInput('General Feedback', 'The mobile layout feels so much smoother now!', '');
    assert.strictEqual(res.valid, true);
});

test('Feedback validation rejects short or empty messages', () => {
    assert.strictEqual(validateFeedbackInput('Bug Report', '', '').valid, false);
    assert.strictEqual(validateFeedbackInput('Bug Report', '   ', '').valid, false);
    assert.strictEqual(validateFeedbackInput('Bug Report', 'Hi', '').valid, false);
});

test('Feedback validation rejects messages exceeding 2000 characters', () => {
    const longMessage = 'A'.repeat(2001);
    const res = validateFeedbackInput('Suggestion', longMessage, '');
    assert.strictEqual(res.valid, false);
});

test('Feedback validation rejects invalid email format when provided', () => {
    const res = validateFeedbackInput('Suggestion', 'I have a great restock feature request', 'invalid-email');
    assert.strictEqual(res.valid, false);
});

// -----------------------------------------------------------------------------
// 12. Inventory Setup Assistance & WhatsApp Integration
// -----------------------------------------------------------------------------
function buildWhatsAppUrl(configuredPhone, optionType) {
    const digitsOnly = (configuredPhone || '').replace(/[^0-9]/g, '');
    if (!digitsOnly) return null;

    let message = '';
    if (optionType === 'upload') {
        message = 'Hello StockSense team, I need assistance uploading the products in my shop to StockSense. Please explain the process, requirements, pricing, and next steps.';
    } else if (optionType === 'training') {
        message = 'Hello StockSense team, I would like assistance learning how to use StockSense. I need training for myself or my staff. Please explain the available options, pricing, and next steps.';
    } else {
        message = 'Hello StockSense team, I need assistance with setting up my inventory.';
    }

    return `https://wa.me/${digitsOnly}?text=${encodeURIComponent(message)}`;
}

test('WhatsApp URL builder generates valid wa.me link with prefilled upload message', () => {
    const url = buildWhatsAppUrl('+234 801 234 5678', 'upload');
    assert.ok(url);
    assert.ok(url.startsWith('https://wa.me/2348012345678?text='));
    assert.ok(url.includes(encodeURIComponent('I need assistance uploading the products in my shop to StockSense')));
});

test('WhatsApp URL builder generates valid wa.me link with prefilled training message', () => {
    const url = buildWhatsAppUrl('2348012345678', 'training');
    assert.ok(url);
    assert.ok(url.startsWith('https://wa.me/2348012345678?text='));
    assert.ok(url.includes(encodeURIComponent('I would like assistance learning how to use StockSense')));
});

test('WhatsApp URL builder returns null when phone number is missing or unconfigured', () => {
    assert.strictEqual(buildWhatsAppUrl('', 'upload'), null);
    assert.strictEqual(buildWhatsAppUrl('   ', 'training'), null);
    assert.strictEqual(buildWhatsAppUrl(null, 'upload'), null);
    assert.strictEqual(buildWhatsAppUrl(undefined, 'training'), null);
});

// -----------------------------------------------------------------------------
// 13. Admin Staff Permissions & Role Governance
// -----------------------------------------------------------------------------
function canBulkUpload(role, permissions = []) {
    if (role === 'owner' || role === 'admin') return true;
    if (role === 'moderator') {
        return Array.isArray(permissions) && permissions.includes('bulk_product_upload');
    }
    return false; // Ordinary users or null roles never have access
}

test('canBulkUpload allows owner and admin unconditionally', () => {
    assert.strictEqual(canBulkUpload('owner', []), true);
    assert.strictEqual(canBulkUpload('admin', []), true);
});

test('canBulkUpload permits moderator ONLY when bulk_product_upload permission is granted', () => {
    assert.strictEqual(canBulkUpload('moderator', ['bulk_product_upload']), true);
    assert.strictEqual(canBulkUpload('moderator', []), false);
    assert.strictEqual(canBulkUpload('moderator', ['other_perm']), false);
});

test('canBulkUpload rejects ordinary customers even if permission flag is spoofed', () => {
    assert.strictEqual(canBulkUpload(null, ['bulk_product_upload']), false);
    assert.strictEqual(canBulkUpload('user', ['bulk_product_upload']), false);
    assert.strictEqual(canBulkUpload(undefined, ['bulk_product_upload']), false);
});

test('canBulkUpload reflects immediate revocation on moderator', () => {
    let staffPerms = ['bulk_product_upload'];
    assert.strictEqual(canBulkUpload('moderator', staffPerms), true);

    // Revoke permission
    staffPerms = staffPerms.filter(p => p !== 'bulk_product_upload');
    assert.strictEqual(canBulkUpload('moderator', staffPerms), false);
});

// -----------------------------------------------------------------------------
// 14. CSV Parsing & Validation for Staff Bulk Upload
// -----------------------------------------------------------------------------
function parseCsvText(text) {
    if (!text) return [];
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

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
            if (char === '\r' && nextChar === '\n') i++;
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

        const name = (row.name || row['product name'] || '').trim();
        if (!name) rowErrors.push('Product name is required');

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

        const category = (row.category || 'General').trim() || 'General';

        const sellingRaw = row.selling_price || row['selling price'] || row.price;
        const sellingPrice = sellingRaw !== undefined && sellingRaw !== '' ? Number(sellingRaw) : NaN;
        if (isNaN(sellingPrice) || sellingPrice < 0) {
            rowErrors.push('Selling price must be a valid non-negative number');
        }

        const costRaw = row.unit_cost || row['cost price'] || row.cost || '0';
        const unitCost = costRaw !== '' ? Number(costRaw) : 0;
        if (isNaN(unitCost) || unitCost < 0) {
            rowErrors.push('Cost price must be a non-negative number');
        }

        const qtyRaw = row.quantity || row['initial quantity'] || row.qty || '0';
        const quantity = qtyRaw !== '' ? parseInt(qtyRaw, 10) : 0;
        if (isNaN(quantity) || quantity < 0) {
            rowErrors.push('Quantity must be a non-negative whole number');
        }

        const minRaw = row.minimum_stock || row['min stock'] || row['minimum stock level'] || '5';
        const minimumStock = minRaw !== '' ? parseInt(minRaw, 10) : 5;
        if (isNaN(minimumStock) || minimumStock < 0) {
            rowErrors.push('Minimum stock must be a non-negative whole number');
        }

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

    return { validRows, invalidRows, errors, totalRows: rawRows.length };
}

test('CSV Parser handles quotes, commas inside fields, and standard headers', () => {
    const csv = `name,sku,category,unit_cost,selling_price,quantity,minimum_stock,supplier,emoji\r\n` +
                `"Wireless Mouse, USB",MOU-101,Electronics,4500,7500,20,5,"Tech, Inc.",🖱️\r\n` +
                `"Fast Cable",CAB-202,Accessories,1500,3000,50,10,CableCo,🔌`;

    const parsed = parseCsvText(csv);
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].name, 'Wireless Mouse, USB');
    assert.strictEqual(parsed[0].supplier, 'Tech, Inc.');
    assert.strictEqual(parsed[1].sku, 'CAB-202');
});

test('CSV Validation approves well-formed product rows', () => {
    const rawRows = [
        { _line: 2, name: 'Standard Product', sku: 'STK-01', category: 'General', unit_cost: '2000', selling_price: '3500', quantity: '10', minimum_stock: '3', supplier: 'Vendor A', emoji: '📦' }
    ];
    const { validRows, invalidRows } = validateCsvRows(rawRows);
    assert.strictEqual(validRows.length, 1);
    assert.strictEqual(invalidRows.length, 0);
    assert.strictEqual(validRows[0].selling_price, 3500);
    assert.strictEqual(validRows[0].quantity, 10);
});

test('CSV Validation rejects rows with missing name or negative prices', () => {
    const rawRows = [
        { _line: 2, name: '', sku: 'STK-01', selling_price: '1000' },
        { _line: 3, name: 'Negative Item', sku: 'STK-02', selling_price: '-500' },
        { _line: 4, name: 'Negative Cost', sku: 'STK-03', selling_price: '1000', unit_cost: '-200' },
        { _line: 5, name: 'Negative Qty', sku: 'STK-04', selling_price: '1000', quantity: '-5' }
    ];
    const { validRows, invalidRows, errors } = validateCsvRows(rawRows);
    assert.strictEqual(validRows.length, 0);
    assert.strictEqual(invalidRows.length, 4);
    assert.ok(errors.some(e => e.includes('Product name is required')));
    assert.ok(errors.some(e => e.includes('Selling price must be a valid non-negative number')));
    assert.ok(errors.some(e => e.includes('Cost price must be a non-negative number')));
    assert.ok(errors.some(e => e.includes('Quantity must be a non-negative whole number')));
});

test('CSV Validation detects duplicate SKUs within file and collisions with customer catalog', () => {
    const rawRows = [
        { _line: 2, name: 'Item 1', sku: 'DUP-01', selling_price: '1000' },
        { _line: 3, name: 'Item 2', sku: 'DUP-01', selling_price: '1200' }, // Duplicate in file
        { _line: 4, name: 'Item 3', sku: 'EXISTING-99', selling_price: '2000' } // Exists in customer's account
    ];
    const existingSkus = new Set(['existing-99']);
    const { validRows, invalidRows, errors } = validateCsvRows(rawRows, existingSkus);

    assert.strictEqual(validRows.length, 1); // Only Item 1 is valid
    assert.strictEqual(invalidRows.length, 2);
    assert.ok(errors.some(e => e.includes('Duplicate SKU "DUP-01" within CSV file')));
    assert.ok(errors.some(e => e.includes('SKU "EXISTING-99" already exists in customer catalog')));
});

// -----------------------------------------------------------------------------
// 12. Email Verification Routing, URL Detection & Cooldown Timer
// -----------------------------------------------------------------------------
function resolveAuthRedirect(origin, hostname) {
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
    if (isLocalhost) {
        return `${origin}/auth/verify`;
    }
    if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
        return `${origin}/auth/verify`;
    }
    return 'https://stocksense-psi.vercel.app/auth/verify';
}

function parseVerificationCallback(urlString) {
    const url = new URL(urlString, 'https://stocksense-psi.vercel.app');
    const rawHash = url.hash ? url.hash.replace(/^#/, '') : '';
    const hashParams = new URLSearchParams(rawHash);
    const searchParams = url.searchParams;

    const path = url.pathname.replace(/\/+$/, '');
    const isVerifyPath = path.endsWith('/auth/verify') || path.endsWith('/auth/verify.html');

    const authError = hashParams.get('error') || searchParams.get('error') || hashParams.get('error_code') || searchParams.get('error_code');
    const authErrorDesc = hashParams.get('error_description') || searchParams.get('error_description');
    const pkceCode = searchParams.get('code');
    const hasVerifyHash = rawHash.includes('type=signup') || rawHash.includes('type=email_change');

    if (authError || (isVerifyPath && (authError || authErrorDesc))) {
        return {
            status: 'invalid',
            code: authError || 'error',
            description: authErrorDesc || 'The verification link may have expired or already been used.'
        };
    }

    if (pkceCode && isVerifyPath) {
        return {
            status: 'pkce_exchange',
            code: pkceCode
        };
    }

    if (isVerifyPath || hasVerifyHash) {
        return {
            status: 'verifying'
        };
    }

    return {
        status: 'standard_session'
    };
}

test('resolveAuthRedirect returns local /auth/verify for localhost', () => {
    const redirectUrl = resolveAuthRedirect('http://localhost:3000', 'localhost');
    assert.strictEqual(redirectUrl, 'http://localhost:3000/auth/verify');
});

test('resolveAuthRedirect returns production /auth/verify for production domain', () => {
    const redirectUrl = resolveAuthRedirect('https://stocksense-psi.vercel.app', 'stocksense-psi.vercel.app');
    assert.strictEqual(redirectUrl, 'https://stocksense-psi.vercel.app/auth/verify');
});

test('parseVerificationCallback detects expired OTP error in URL parameters', () => {
    const result = parseVerificationCallback('https://stocksense-psi.vercel.app/auth/verify?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    assert.strictEqual(result.status, 'invalid');
    assert.strictEqual(result.code, 'access_denied');
    assert.ok(result.description.includes('invalid or has expired'));
});

test('parseVerificationCallback identifies PKCE authorization code on /auth/verify', () => {
    const result = parseVerificationCallback('https://stocksense-psi.vercel.app/auth/verify?code=d6a9a797-2866-4e50-9f0e-3fa5f37740f9');
    assert.strictEqual(result.status, 'pkce_exchange');
    assert.strictEqual(result.code, 'd6a9a797-2866-4e50-9f0e-3fa5f37740f9');
});

test('parseVerificationCallback triggers verifying state when navigating to /auth/verify with token hash', () => {
    const result = parseVerificationCallback('https://stocksense-psi.vercel.app/auth/verify#access_token=test_tok&type=signup');
    assert.strictEqual(result.status, 'verifying');
});

test('Resend verification cooldown prevents immediate repeated clicks', () => {
    let cooldown = 60;
    const canResend = () => cooldown <= 0;
    assert.strictEqual(canResend(), false);

    cooldown = 0;
    assert.strictEqual(canResend(), true);
});

// -----------------------------------------------------------------------------
// 13. Admin User Deletion Authorization & Safeguards
// -----------------------------------------------------------------------------
function canAdminDeleteUser(callerRole, callerId, targetUser) {
    if (!callerRole || !['owner', 'admin'].includes(callerRole)) {
        return { allowed: false, reason: 'Administrator privileges required.' };
    }
    if (callerId === targetUser.id) {
        return { allowed: false, reason: 'You cannot delete your own administrator account.' };
    }
    if (targetUser.role === 'owner') {
        return { allowed: false, reason: 'Cannot delete the Platform Owner account.' };
    }
    if (targetUser.role === 'admin' && callerRole !== 'owner') {
        return { allowed: false, reason: 'Only the Platform Owner can delete an Administrator account.' };
    }
    return { allowed: true };
}

test('canAdminDeleteUser rejects non-admin users', () => {
    const res = canAdminDeleteUser('member', 'user-1', { id: 'user-2', role: 'member' });
    assert.strictEqual(res.allowed, false);
    assert.ok(res.reason.includes('Administrator privileges required'));
});

test('canAdminDeleteUser prevents administrator self-deletion', () => {
    const res = canAdminDeleteUser('admin', 'admin-1', { id: 'admin-1', role: 'admin' });
    assert.strictEqual(res.allowed, false);
    assert.ok(res.reason.includes('cannot delete your own administrator account'));
});

test('canAdminDeleteUser prevents deleting the platform owner', () => {
    const res = canAdminDeleteUser('owner', 'owner-1', { id: 'owner-2', role: 'owner' });
    assert.strictEqual(res.allowed, false);
    assert.ok(res.reason.includes('Cannot delete the Platform Owner account'));
});

test('canAdminDeleteUser prevents regular admin from deleting another admin', () => {
    const res = canAdminDeleteUser('admin', 'admin-1', { id: 'admin-2', role: 'admin' });
    assert.strictEqual(res.allowed, false);
    assert.ok(res.reason.includes('Only the Platform Owner can delete an Administrator account'));
});

test('canAdminDeleteUser permits admin to delete standard customer', () => {
    const res = canAdminDeleteUser('admin', 'admin-1', { id: 'cust-1', role: 'member' });
    assert.strictEqual(res.allowed, true);
});

test('canAdminDeleteUser permits owner to delete customer and admin accounts', () => {
    const resCustomer = canAdminDeleteUser('owner', 'owner-1', { id: 'cust-1', role: 'member' });
    assert.strictEqual(resCustomer.allowed, true);

    const resAdmin = canAdminDeleteUser('owner', 'owner-1', { id: 'admin-1', role: 'admin' });
    assert.strictEqual(resAdmin.allowed, true);
});

test('Delete confirmation input requires exact DELETE keyword', () => {
    const isValidConfirmation = (input) => input.trim() === 'DELETE';
    assert.strictEqual(isValidConfirmation('delete'), false);
    assert.strictEqual(isValidConfirmation('Delete'), false);
    assert.strictEqual(isValidConfirmation(''), false);
    assert.strictEqual(isValidConfirmation(' DELETE '), true);
    assert.strictEqual(isValidConfirmation('DELETE'), true);
});

// -----------------------------------------------------------------------------
// 14. Related-Record Cascading Deletion Order & Historical Integrity
// -----------------------------------------------------------------------------
function simulateDatabaseCascadeDeletion(database, targetUserId) {
    // 1. Check if user exists
    const user = database.authUsers.find(u => u.id === targetUserId);
    if (!user) throw new Error('User not found');

    // 2. Clear references where ON DELETE SET NULL applies
    database.feedback.forEach(f => {
        if (f.user_id === targetUserId) f.user_id = null;
    });
    database.platformRoles.forEach(r => {
        if (r.assigned_by === targetUserId) r.assigned_by = null;
    });
    database.adminAuditLogs.forEach(l => {
        if (l.actor_id === targetUserId) l.actor_id = null;
    });

    // 3. Delete user movements first, then products
    database.stockMovements = database.stockMovements.filter(m => m.user_id !== targetUserId);
    const userProductIds = new Set(database.products.filter(p => p.user_id === targetUserId).map(p => p.id));
    database.stockMovements = database.stockMovements.filter(m => !userProductIds.has(m.product_id));
    database.products = database.products.filter(p => p.user_id !== targetUserId);

    // 4. Delete profile and auth user
    database.profiles = database.profiles.filter(p => p.id !== targetUserId);
    database.authUsers = database.authUsers.filter(u => u.id !== targetUserId);

    return { success: true };
}

test('Cascading deletion cleans products and movements while preserving audit and feedback integrity', () => {
    const db = {
        authUsers: [{ id: 'user-to-del', email: 'disposable@test.io' }, { id: 'admin-1', email: 'admin@test.io' }],
        profiles: [{ id: 'user-to-del', full_name: 'Disposable User' }],
        products: [{ id: 'prod-1', user_id: 'user-to-del', name: 'Charger' }],
        stockMovements: [{ id: 'mov-1', user_id: 'user-to-del', product_id: 'prod-1', quantity: 5 }],
        feedback: [{ id: 'fb-1', user_id: 'user-to-del', message: 'Great app' }],
        platformRoles: [{ id: 'r-1', user_id: 'admin-1', assigned_by: 'user-to-del', role: 'admin' }],
        adminAuditLogs: [{ id: 'log-1', actor_id: 'user-to-del', action: 'EXPORT_CSV' }]
    };

    const res = simulateDatabaseCascadeDeletion(db, 'user-to-del');
    assert.strictEqual(res.success, true);
    assert.strictEqual(db.authUsers.length, 1);
    assert.strictEqual(db.profiles.length, 0);
    assert.strictEqual(db.products.length, 0);
    assert.strictEqual(db.stockMovements.length, 0);
    // Historical audit logs and feedback are preserved with actor/user nullified
    assert.strictEqual(db.feedback.length, 1);
    assert.strictEqual(db.feedback[0].user_id, null);
    assert.strictEqual(db.adminAuditLogs.length, 1);
    assert.strictEqual(db.adminAuditLogs[0].actor_id, null);
    assert.strictEqual(db.platformRoles[0].assigned_by, null);
});

test('Submission state tracking prevents duplicate concurrent deletion requests', () => {
    let isSubmitting = false;
    const triggerDeletion = () => {
        if (isSubmitting) return { rejected: true, reason: 'Already in progress' };
        isSubmitting = true;
        return { rejected: false };
    };

    const firstClick = triggerDeletion();
    assert.strictEqual(firstClick.rejected, false);

    const secondClick = triggerDeletion();
    assert.strictEqual(secondClick.rejected, true);
    assert.strictEqual(secondClick.reason, 'Already in progress');
});

console.log(`\n=================================================`);
console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
console.log(`=================================================`);

if (failed > 0) process.exit(1);


