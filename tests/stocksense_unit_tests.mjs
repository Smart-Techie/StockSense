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

console.log(`\n=================================================`);
console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
console.log(`=================================================`);

if (failed > 0) process.exit(1);

