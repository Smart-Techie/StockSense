import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9222;
const HTTP_PORT = 3000;

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

function createStaticServer(port = HTTP_PORT) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const urlPath = req.url.split('?')[0];
            const clean = urlPath.replace(/^[\\\/]+/, '');
            let targetFile = (!clean || clean === 'index.html') ? 'index.html' : clean;
            let filePath = path.join(rootDir, targetFile);

            fs.stat(filePath, (err, stats) => {
                if (err || !stats.isFile()) {
                    console.warn(`[StaticServer 404] ${urlPath} -> ${filePath}`);
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('404 Not Found');
                    return;
                }
                const ext = path.extname(filePath).toLowerCase();
                const contentType = mimeTypes[ext] || 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': contentType });
                fs.createReadStream(filePath).pipe(res);
            });
        });

        server.on('error', err => {
            if (err.code === 'EADDRINUSE') {
                console.log(`Port ${port} already active; reusing existing server.`);
                resolve(null);
            } else {
                reject(err);
            }
        });

        server.listen(port, () => {
            console.log(`Test static server running at http://localhost:${port}/`);
            resolve(server);
        });
    });
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runBrowserTests() {
    console.log('=================================================');
    console.log('Running StockSense End-to-End Headless Browser Tests');
    console.log('=================================================');

    // 0. Ensure static server is active
    const staticServer = await createStaticServer(HTTP_PORT);

    // 1. Launch Edge with remote debugging
    const edgeProc = spawn(EDGE_PATH, [
        `--remote-debugging-port=${CDP_PORT}`,
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
    ], { stdio: 'ignore' });

    let ws = null;
    try {
        // Wait for CDP endpoint to become ready
        let targetWsUrl = null;
        for (let i = 0; i < 20; i++) {
            await sleep(500);
            try {
                const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
                if (res.ok) {
                    const data = await res.json();
                    targetWsUrl = data.webSocketDebuggerUrl;
                    if (targetWsUrl) break;
                }
            } catch (err) {}
        }

        if (!targetWsUrl) {
            throw new Error('Failed to connect to browser CDP endpoint');
        }

        // Create a new target/page
        const newPageRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://localhost:${HTTP_PORT}/?preview=user`, { method: 'PUT' });
        const newPageData = await newPageRes.json();
        const pageWsUrl = newPageData.webSocketDebuggerUrl;

        ws = new WebSocket(pageWsUrl);
        let idCounter = 1;
        const pending = new Map();

        ws.onmessage = evt => {
            const msg = JSON.parse(evt.data);
            if (msg.id && pending.has(msg.id)) {
                const { resolve, reject } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            }
        };

        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        function send(method, params = {}) {
            return new Promise((resolve, reject) => {
                const id = idCounter++;
                pending.set(id, { resolve, reject });
                ws.send(JSON.stringify({ id, method, params }));
            });
        }

        async function evaluate(expression) {
            const res = await send('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise: true
            });
            if (res.exceptionDetails) {
                throw new Error(res.exceptionDetails.text || 'Evaluation failed');
            }
            return res.result?.value;
        }

        await send('Network.enable');
        await send('Network.setCacheDisabled', { cacheDisabled: true });
        try { await send('Network.setBypassServiceWorker', { bypass: true }); } catch {}
        try { await send('Storage.clearDataForOrigin', { origin: `http://localhost:${HTTP_PORT}`, storageTypes: 'cache_storage,service_workers' }); } catch {}
        await send('Page.enable');
        await send('DOM.enable');

        await send('Page.navigate', { url: `http://localhost:${HTTP_PORT}/?preview=user` });

        // Wait for page load
        await sleep(3000);
        const pageState = await evaluate(`({
            url: window.location.href,
            readyState: document.readyState,
            bodyLength: document.body ? document.body.innerHTML.length : 0,
            title: document.title,
            authDisplay: document.getElementById('auth-screen')?.style.display,
            appRootDisplay: document.getElementById('app-root')?.style.display
        })`);
        console.log('Page state after load:', pageState);

        let passCount = 0;
        let failCount = 0;

        function assert(cond, name) {
            if (cond) {
                console.log(`✓ PASS: ${name}`);
                passCount++;
            } else {
                console.error(`✗ FAIL: ${name}`);
                failCount++;
            }
        }

        // Test 1: Personalized Greeting & Subtitle
        const greetingData = await evaluate(`(() => {
            const h = document.getElementById('title')?.textContent.trim();
            const s = document.getElementById('subtitle')?.textContent.trim();
            return { h, s };
        })()`);
        assert(greetingData.h && greetingData.h.includes('Sarah') && greetingData.h.includes('👋'), `Greeting includes user first name and emoji: "${greetingData.h}"`);
        assert(greetingData.s === "Here's your business at a glance.", `Subtitle matches required text: "${greetingData.s}"`);

        // Test 2: Compact Welcome Card
        const welcomeData = await evaluate(`(() => {
            const card = document.querySelector('.welcome');
            const eyebrow = card?.querySelector('.eyebrow')?.textContent.trim();
            const h2 = card?.querySelector('h2')?.textContent.trim();
            return { exists: !!card, eyebrow, h2 };
        })()`);
        assert(welcomeData.exists && welcomeData.eyebrow === 'Welcome to StockSense', `Welcome card eyebrow is "Welcome to StockSense"`);
        assert(welcomeData.h2 === "Let's make every product count.", `Welcome card tagline is "Let's make every product count."`);

        // Test 3: Exactly Four Key Statistic Cards with Real Data
        const metricsData = await evaluate(`(() => {
            const cards = Array.from(document.querySelectorAll('#metrics .metric'));
            const items = cards.map(c => ({
                label: c.querySelector('.metric-head')?.innerText || c.querySelector('.metric-head')?.textContent || '',
                value: c.querySelector('.value')?.textContent.trim()
            }));
            return items;
        })()`);
        assert(metricsData.length === 4, `Dashboard has exactly 4 key statistic cards (found ${metricsData.length})`);
        assert(metricsData[0]?.label.includes('Total Products') && metricsData[0]?.value === '5', `Metric 1: Total Products = 5`);
        assert(metricsData[1]?.label.includes('Units in Stock') && metricsData[1]?.value === '37', `Metric 2: Units in Stock = 37`);
        assert(metricsData[2]?.label.includes('Low-Stock Items') && metricsData[2]?.value === '2', `Metric 3: Low-Stock Items = 2`);
        assert(metricsData[3]?.label.includes('Inventory Value') && metricsData[3]?.value.includes('102,100'), `Metric 4: Inventory Value = ₦102,100`);

        // Test 4: Green StockSense Adviser Card
        const adviserCard = await evaluate(`(() => {
            const card = document.querySelector('.advisor-banner-card');
            const h = card?.querySelector('h3')?.textContent.trim();
            const desc = card?.querySelector('p')?.textContent.trim();
            const btn = card?.querySelector('button')?.textContent.trim();
            return { exists: !!card, h, desc, btn };
        })()`);
        assert(adviserCard.exists && adviserCard.h === 'StockSense Adviser', `StockSense Adviser card is present with heading`);
        assert(adviserCard.desc.includes('Your inventory assistant helps you identify shortages'), `Adviser description matches requirement`);
        assert(adviserCard.btn.includes('Review Stock Recommendations'), `Adviser CTA button exists`);

        // Test 5: Compact Stock-Alert Summary
        const alertSummary = await evaluate(`(() => {
            const summary = document.getElementById('stock-alert-summary');
            return summary?.textContent.trim();
        })()`);
        assert(alertSummary && alertSummary.includes('low on stock') && alertSummary.includes('out of stock'), `Stock-alert summary accurately reports: "${alertSummary}"`);

        // ---------------------------------------------------------------------
        // PART 1 E2E TESTS: Customer-Facing Inventory Setup Assistance
        // ---------------------------------------------------------------------

        // Test 6: Homepage Section "Need Help Setting Up Your Inventory?"
        const assistanceHomeSection = await evaluate(`(() => {
            const sec = document.getElementById('sec-setup-assistance');
            const h = sec?.querySelector('h3')?.textContent.trim();
            const desc = sec?.querySelector('p')?.textContent.trim();
            const btn = document.getElementById('btn-homepage-assistance');
            const btnText = btn?.textContent.trim();
            return { exists: !!sec, h, desc, btnExists: !!btn, btnText };
        })()`);
        assert(assistanceHomeSection.exists, `Homepage assistance section exists`);
        assert(assistanceHomeSection.h === 'Need Help Setting Up Your Inventory?', `Assistance section heading matches: "Need Help Setting Up Your Inventory?"`);
        assert(assistanceHomeSection.desc.includes('Getting started or managing a large product catalogue? Our team can help you upload your products'), `Assistance section supporting text matches specification`);
        assert(assistanceHomeSection.btnText === 'Get Setup Assistance', `Assistance button text is "Get Setup Assistance"`);

        // Test 7: Navigation from Homepage to Dedicated Assistance Page
        const navAssistanceCheck = await evaluate(`(async () => {
            document.getElementById('btn-homepage-assistance')?.click();
            await new Promise(r => setTimeout(r, 150));
            const isAssistanceActive = document.getElementById('page-assistance')?.classList.contains('active');
            const pageTitle = document.getElementById('title')?.textContent.trim();
            const pageSub = document.getElementById('subtitle')?.textContent.trim();
            return { isAssistanceActive, pageTitle, pageSub };
        })()`);
        assert(navAssistanceCheck.isAssistanceActive, `Clicking 'Get Setup Assistance' navigates to #page-assistance`);
        assert(navAssistanceCheck.pageTitle === 'How Can We Help You?', `Assistance page title is "How Can We Help You?"`);
        assert(navAssistanceCheck.pageSub.includes('Choose the kind of assistance you need'), `Assistance page subtitle matches`);

        // Test 8: Assistance Option Cards & Dynamic Step Confirmation
        const assistanceOptionsCheck = await evaluate(`(async () => {
            const cardUpload = document.getElementById('btn-assistance-upload');
            const cardTraining = document.getElementById('btn-assistance-training');

            // Click Option A: Help Upload My Products
            cardUpload?.click();
            await new Promise(r => setTimeout(r, 100));
            const detailPanel = document.getElementById('assistance-detail-panel');
            const detailTitleA = document.getElementById('assistance-detail-title')?.textContent.trim();
            const contentA = document.getElementById('assistance-detail-content')?.textContent.trim();
            const hasPasswordWarning = contentA.includes('Never share your StockSense password');
            const hasStaffWorkflowNotice = contentA.includes('authorized team members') || contentA.includes('staff workflow');

            // Click Option B: Train Me or My Staff
            cardTraining?.click();
            await new Promise(r => setTimeout(r, 100));
            const detailTitleB = document.getElementById('assistance-detail-title')?.textContent.trim();
            const contentB = document.getElementById('assistance-detail-content')?.textContent.trim();

            return {
                cardUploadExists: !!cardUpload,
                cardTrainingExists: !!cardTraining,
                panelVisible: detailPanel?.style.display !== 'none',
                detailTitleA,
                hasPasswordWarning,
                hasStaffWorkflowNotice,
                detailTitleB,
                contentBHasTopics: contentB.includes('practical') || contentB.includes('workflows')
            };
        })()`);
        assert(assistanceOptionsCheck.cardUploadExists && assistanceOptionsCheck.cardTrainingExists, `Both Option cards (Upload and Training) exist`);
        assert(assistanceOptionsCheck.detailTitleA.includes('Option A: Help Upload My Products'), `Option A detail title renders correctly`);
        assert(assistanceOptionsCheck.hasPasswordWarning, `Option A explanation emphasizes: "Never share your StockSense password"`);
        assert(assistanceOptionsCheck.hasStaffWorkflowNotice, `Option A mentions authorized team members using secure staff workflow`);
        assert(assistanceOptionsCheck.detailTitleB.includes('Option B: Train Me or My Staff'), `Option B detail title renders correctly`);

        // Test 9: WhatsApp Integration & Message Prefills
        const waIntegrationCheck = await evaluate(`(() => {
            // Unconfigured number check
            window.StockSense.state.platformSettings.support_whatsapp = '';
            delete window.STOCKSENSE_WHATSAPP;
            
            // Check notice banner visibility
            window.StockSense.go('assistance');
            const noWaBannerVisible = document.getElementById('assistance-no-whatsapp')?.style.display !== 'none';

            // Test prefilled WhatsApp links with configured test number
            const testPhone = '2348012345678';
            window.StockSense.state.platformSettings.support_whatsapp = testPhone;

            window.StockSense.openAssistanceUpload();
            const uploadOpt = window.StockSense.state.activeAssistanceOption;
            
            window.StockSense.openAssistanceTraining();
            const trainingOpt = window.StockSense.state.activeAssistanceOption;

            return {
                noWaBannerVisible,
                uploadOpt,
                trainingOpt
            };
        })()`);
        assert(waIntegrationCheck.noWaBannerVisible, `Unconfigured WhatsApp number displays setup notification banner`);
        assert(waIntegrationCheck.uploadOpt === 'upload' && waIntegrationCheck.trainingOpt === 'training', `Assistance option states switch accurately`);

        // ---------------------------------------------------------------------
        // PART 2 E2E TESTS: Admin-Controlled Bulk Product Upload Access
        // ---------------------------------------------------------------------

        // Test 10: Role and Permission Access Control (Moderator with/without permission)
        const accessControlCheck = await evaluate(`(async () => {
            // 1. Ordinary User -> Cannot bulk upload
            window.StockSense.state.currentRole = null;
            window.StockSense.state.staffPermissions = [];
            const userCanUpload = window.StockSense.canBulkUpload();

            // 2. Moderator without permission -> Denied
            window.StockSense.state.currentRole = 'moderator';
            window.StockSense.state.staffPermissions = [];
            const modWithoutPermCanUpload = window.StockSense.canBulkUpload();

            // 3. Moderator with bulk_product_upload -> Permitted
            window.StockSense.state.staffPermissions = ['bulk_product_upload'];
            const modWithPermCanUpload = window.StockSense.canBulkUpload();

            // 4. Admin/Owner -> Always permitted
            window.StockSense.state.currentRole = 'owner';
            const ownerCanUpload = window.StockSense.canBulkUpload();

            return {
                userCanUpload,
                modWithoutPermCanUpload,
                modWithPermCanUpload,
                ownerCanUpload
            };
        })()`);
        assert(!accessControlCheck.userCanUpload, `Standard user cannot perform bulk product upload`);
        assert(!accessControlCheck.modWithoutPermCanUpload, `Moderator without bulk_product_upload permission is DENIED`);
        assert(accessControlCheck.modWithPermCanUpload, `Moderator with bulk_product_upload permission is PERMITTED`);
        assert(accessControlCheck.ownerCanUpload, `Platform Owner is authorized to perform bulk upload`);

        // Test 11: Admin Bulk Upload Tab & Customer Selection Workflow
        const bulkWorkflowCheck = await evaluate(`(async () => {
            window.StockSense.state.currentRole = 'owner';
            window.StockSense.state.staffPermissions = ['bulk_product_upload'];
            window.StockSense.go('admin');
            await new Promise(r => setTimeout(r, 150));

            // Switch to Bulk Upload tab
            const bulkTabBtn = document.querySelector('[data-admin-tab="bulk-upload"]');
            bulkTabBtn?.click();
            await new Promise(r => setTimeout(r, 150));

            const secActive = document.getElementById('admin-sec-bulk-upload')?.classList.contains('active');

            // Search for customer
            const searchInput = document.getElementById('bulk-customer-search');
            searchInput.value = 'Sarah';
            document.getElementById('btn-search-customer')?.click();
            await new Promise(r => setTimeout(r, 150));

            const hasResults = document.querySelectorAll('#bulk-customer-results .bulk-customer-card').length > 0;

            // Select customer
            const selectBtn = document.querySelector('[data-select-cust-id]');
            const selectedUserId = selectBtn?.dataset.selectCustId;
            selectBtn?.click();
            await new Promise(r => setTimeout(r, 150));

            const bannerVisible = document.getElementById('bulk-selected-customer-card')?.style.display !== 'none';
            const customerNameText = document.getElementById('bulk-selected-name')?.textContent.trim();
            const stepFileUnlocked = !document.getElementById('bulk-step-file')?.classList.contains('disabled');

            return {
                secActive,
                hasResults,
                bannerVisible,
                customerNameText,
                stepFileUnlocked
            };
        })()`);
        assert(bulkWorkflowCheck.secActive, `Bulk Product Upload tab is visible and active in Admin portal`);
        assert(bulkWorkflowCheck.hasResults, `Customer search yields matching customer accounts`);
        assert(bulkWorkflowCheck.bannerVisible && bulkWorkflowCheck.customerNameText.includes('Sarah'), `Customer account selection reveals target customer banner ("${bulkWorkflowCheck.customerNameText}")`);
        assert(bulkWorkflowCheck.stepFileUnlocked, `Selecting customer unlocks Step 2 (CSV Upload)`);

        // Test 12: CSV Validation, Preview Table & Duplicate SKU Handling
        const csvValidationCheck = await evaluate(`(async () => {
            const rawTestCsv = [
                { _line: 2, name: 'Premium Wireless Headphones', sku: 'AUD-991', category: 'Audio', unit_cost: '12000', selling_price: '22000', quantity: '15', minimum_stock: '4', supplier: 'AudioTech', emoji: '🎧' },
                { _line: 3, name: 'Compact USB-C Adapter', sku: 'ADP-992', category: 'Accessories', unit_cost: '2000', selling_price: '4500', quantity: '30', minimum_stock: '5', supplier: 'CableHub', emoji: '🔌' },
                { _line: 4, name: '', sku: 'ERR-01', selling_price: '5000' }, // Missing name
                { _line: 5, name: 'Negative Price Item', sku: 'ERR-02', selling_price: '-1000' }, // Negative price
                { _line: 6, name: 'Duplicate Item', sku: 'AUD-991', selling_price: '18000' } // Duplicate SKU within file
            ];

            const existingSkus = new Set(['existing-sku-1']);
            const result = window.StockSense.validateCsvRows(rawTestCsv, existingSkus);

            return {
                validCount: result.validRows.length,
                invalidCount: result.invalidRows.length,
                errorCount: result.errors.length,
                errors: result.errors
            };
        })()`);
        assert(csvValidationCheck.validCount === 2, `CSV Validation accurately accepts exactly 2 valid products (got ${csvValidationCheck.validCount})`);
        assert(csvValidationCheck.invalidCount === 3, `CSV Validation rejects exactly 3 invalid rows (got ${csvValidationCheck.invalidCount})`);
        assert(csvValidationCheck.errors.some(e => e.includes('Product name is required')), `Missing name error detected`);
        assert(csvValidationCheck.errors.some(e => e.includes('Selling price must be a valid non-negative number')), `Negative price error detected`);
        assert(csvValidationCheck.errors.some(e => e.includes('Duplicate SKU "AUD-991" within CSV file')), `Duplicate SKU error detected`);

        // Test 13: Bulk Product Import Execution in Preview Mode
        const importExecutionCheck = await evaluate(`(async () => {
            // Pre-load valid products into state
            window.StockSense.state.bulkUploadState.validProducts = [
                { name: 'Imported Bluetooth Speaker', sku: 'SPK-771', category: 'Audio', unit_cost: 8000, selling_price: 15000, quantity: 20, minimum_stock: 5, supplier: 'SoundCorp', emoji: '🔊' },
                { name: 'Braided Lightning Cable', sku: 'CAB-772', category: 'Cables', unit_cost: 1200, selling_price: 3000, quantity: 50, minimum_stock: 10, supplier: 'CableHub', emoji: '⚡' }
            ];

            // Override window.confirm to return true for headless testing
            const origConfirm = window.confirm;
            window.confirm = () => true;

            await window.StockSense.executeBulkProductImport();
            window.confirm = origConfirm;

            const resultNotice = document.getElementById('bulk-import-result');
            const noticeText = resultNotice?.textContent.trim() || '';
            const auditLogged = window.StockSense.state.adminAuditLogs.some(l => l.action === 'BULK_PRODUCT_IMPORT');

            return {
                noticeVisible: resultNotice?.style.display !== 'none',
                noticeText,
                auditLogged
            };
        })()`);
        assert(importExecutionCheck.noticeVisible && importExecutionCheck.noticeText.includes('Successfully Imported: 2 products'), `Import executes cleanly and displays summary: "${importExecutionCheck.noticeText.replace(/\s+/g, ' ')}"`);
        assert(importExecutionCheck.auditLogged, `Official BULK_PRODUCT_IMPORT audit record created in admin log`);

        // ---------------------------------------------------------------------
        // PART 3: Responsive Viewport Checks across Pages
        // ---------------------------------------------------------------------

        // Test 14: Mobile & Desktop Viewports Check on Assistance Page (No horizontal overflow)
        await evaluate(`window.StockSense.go('assistance')`);
        const viewports = [320, 360, 375, 390, 430, 768, 1024, 1440];
        for (const w of viewports) {
            await send('Emulation.setDeviceMetricsOverride', {
                width: w,
                height: 800,
                deviceScaleFactor: 1,
                mobile: w < 768
            });
            await sleep(150);
            const overflow = await evaluate(`(() => {
                const docEl = document.documentElement;
                return {
                    scrollWidth: docEl.scrollWidth,
                    clientWidth: docEl.clientWidth,
                    hasOverflow: docEl.scrollWidth > window.innerWidth
                };
            })()`);
            assert(!overflow.hasOverflow, `Viewport ${w}px on #page-assistance has NO horizontal overflow (scrollWidth=${overflow.scrollWidth}, innerWidth=${w})`);
        }

        // Return to Dashboard and check viewports
        await evaluate(`window.StockSense.go('dashboard')`);
        for (const w of viewports) {
            await send('Emulation.setDeviceMetricsOverride', {
                width: w,
                height: 800,
                deviceScaleFactor: 1,
                mobile: w < 768
            });
            await sleep(150);
            const overflow = await evaluate(`(() => {
                const docEl = document.documentElement;
                return {
                    scrollWidth: docEl.scrollWidth,
                    clientWidth: docEl.clientWidth,
                    hasOverflow: docEl.scrollWidth > window.innerWidth
                };
            })()`);
            assert(!overflow.hasOverflow, `Viewport ${w}px on #page-dashboard has NO horizontal overflow (scrollWidth=${overflow.scrollWidth}, innerWidth=${w})`);
        }

        console.log('\n=================================================');
        console.log(`End-to-End Test Results: ${passCount} Passed, ${failCount} Failed`);
        console.log('=================================================');

        if (failCount > 0) {
            process.exit(1);
        }

    } finally {
        if (ws) ws.close();
        edgeProc.kill();
        if (staticServer) staticServer.close();
    }
}

runBrowserTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
