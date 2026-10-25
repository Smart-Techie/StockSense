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

console.log(`\n=================================================`);
console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
console.log(`=================================================`);

if (failed > 0) process.exit(1);
