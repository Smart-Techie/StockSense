import { spawn } from 'child_process';

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9222;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runBrowserTests() {
    console.log('=================================================');
    console.log('Running StockSense End-to-End Headless Browser Tests');
    console.log('=================================================');

    // 1. Launch Edge with remote debugging
    const edgeProc = spawn(EDGE_PATH, [
        `--remote-debugging-port=${PORT}`,
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
                const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
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
        const newPageRes = await fetch(`http://127.0.0.1:${PORT}/json/new?http://localhost:3000/?preview=user`, { method: 'PUT' });
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
        await send('Page.enable');
        await send('DOM.enable');

        await send('Page.navigate', { url: 'http://localhost:3000/?preview=user' });

        // Allow page to load & initialize state
        await sleep(3000);

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

        // Test 6: Getting Started Guide (3 steps)
        const guideData = await evaluate(`(() => {
            const guide = document.querySelector('.getting-started-panel');
            const steps = Array.from(guide?.querySelectorAll('.getting-started-step') || []).map(s => s.querySelector('b')?.textContent.trim());
            return { exists: !!guide, steps };
        })()`);
        assert(guideData.steps.length === 3, `Getting Started contains exactly 3 steps`);
        assert(guideData.steps[0]?.includes('Add Your Products'), `Step 1 is "Add Your Products"`);
        assert(guideData.steps[1]?.includes('Record Stock Movements'), `Step 2 is "Record Stock Movements"`);
        assert(guideData.steps[2]?.includes('Understand Your Inventory'), `Step 3 is "Understand Your Inventory"`);

        // Test 7: The Future of StockSense (v2.0 preview)
        const v2Data = await evaluate(`(() => {
            const panel = document.querySelector('.v2-preview-panel');
            const cards = Array.from(panel?.querySelectorAll('.v2-feature-card') || []).map(c => ({
                title: c.querySelector('b')?.textContent.trim(),
                badge: c.querySelector('.tag-planned')?.textContent.trim()
            }));
            return cards;
        })()`);
        assert(v2Data.length === 4, `The Future of StockSense has 4 preview cards`);
        const allPlanned = v2Data.every(c => c.badge === 'Planned');
        assert(allPlanned, `All v2.0 cards are clearly marked with 'Planned' badges`);

        // Test 8: Floating PWA Install Banner & Dismissal
        const pwaBanner = await evaluate(`(() => {
            localStorage.removeItem('stocksense_pwa_installed');
            localStorage.removeItem('stocksense_pwa_dismissed_at');
            const installed = window.StockSense.isAppInstalled();
            const shouldShow = window.StockSense.shouldShowPwaPrompt();
            window.StockSense.showPwaPromptIfEligible();
            const b = document.getElementById('pwa-install-banner');
            const btn = document.getElementById('btn-pwa-install')?.textContent.trim();
            const isVisible = b && (b.style.display === 'flex' || b.style.display === '' || b.offsetParent !== null);
            return { exists: !!b, btn, isVisible, installed, shouldShow, styleDisplay: b?.style.display };
        })()`);
        console.log('PWA debug info:', pwaBanner);
        assert(pwaBanner.exists && pwaBanner.btn === 'Install StockSense', `Floating PWA banner has 'Install StockSense'`);

        // Test 9: Share Feedback Modal
        const feedbackModalCheck = await evaluate(`(async () => {
            // Click Share Feedback
            document.getElementById('btn-open-feedback')?.click();
            await new Promise(r => setTimeout(r, 100));
            const modalForm = document.getElementById('form-feedback');
            const isOpen = !!modalForm;
            const typeSelect = document.getElementById('fb-type');
            const messageArea = document.getElementById('fb-message');
            const emailInput = document.getElementById('fb-email');
            
            // Set short message (< 5 chars)
            messageArea.value = 'hi';

            // Dispatch submit event on the form
            modalForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await new Promise(r => setTimeout(r, 100));

            const toastMessage = document.getElementById('toast')?.textContent.trim() || '';

            // Close modal
            document.getElementById('modal-cancel')?.click();
            await new Promise(r => setTimeout(r, 100));

            return {
                isOpen,
                hasTypes: typeSelect?.options.length === 3,
                hasEmail: !!emailInput,
                toastMessage
            };
        })()`);
        assert(feedbackModalCheck.isOpen, `Feedback modal opens on 'Share Feedback' click`);
        assert(feedbackModalCheck.hasTypes, `Feedback modal has 3 feedback type options`);
        assert(feedbackModalCheck.toastMessage.includes('at least 5 characters'), `Short feedback is rejected with toast: "${feedbackModalCheck.toastMessage}"`);

        // Test 10: Responsive Viewports Check (No horizontal scroll)
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
            assert(!overflow.hasOverflow, `Viewport ${w}px has NO horizontal overflow (scrollWidth=${overflow.scrollWidth}, innerWidth=${w})`);
        }

        // Test 11: Adviser Page Navigation & Dedicated Movements Page
        const navCheck = await evaluate(`(async () => {
            // Click review stock recommendations
            document.getElementById('btn-dashboard-adviser')?.click();
            await new Promise(r => setTimeout(r, 150));
            const onAdvisor = document.getElementById('page-advisor')?.classList.contains('active');

            // Navigate to Stock Movements dedicated page
            window.StockSense.go('movements');
            await new Promise(r => setTimeout(r, 150));
            const onMoves = document.getElementById('page-movements')?.classList.contains('active');
            const movesTableRows = document.querySelectorAll('#moves tr').length;

            // Return to dashboard
            window.StockSense.go('dashboard');
            return { onAdvisor, onMoves, movesTableRows };
        })()`);
        assert(navCheck.onAdvisor, `Adviser CTA button navigates to Adviser page`);
        assert(navCheck.onMoves && navCheck.movesTableRows > 0, `Dedicated Stock Movements page remains fully functional with rows (${navCheck.movesTableRows})`);

        // Test 12: Admin Feedback Tab & Controls
        const adminCheck = await evaluate(`(async () => {
            window.StockSense.state.currentRole = 'owner';
            window.StockSense.go('admin');
            await new Promise(r => setTimeout(r, 150));
            
            // Switch to Feedback tab
            const fbTabBtn = document.querySelector('[data-admin-tab="feedback"]');
            fbTabBtn?.click();
            await new Promise(r => setTimeout(r, 150));

            const fbSecActive = document.getElementById('admin-sec-feedback')?.classList.contains('active');
            const filterExists = !!document.getElementById('admin-fb-filter-status');
            const tableExists = !!document.getElementById('admin-feedback-table');

            window.StockSense.go('dashboard');
            return { fbSecActive, filterExists, tableExists };
        })()`);
        assert(adminCheck.fbSecActive && adminCheck.filterExists && adminCheck.tableExists, `Admin portal contains Feedback tab, status filter, and feedback review table`);

        console.log('\n=================================================');
        console.log(`End-to-End Test Results: ${passCount} Passed, ${failCount} Failed`);
        console.log('=================================================');

        if (failCount > 0) {
            process.exit(1);
        }

    } finally {
        if (ws) ws.close();
        edgeProc.kill();
    }
}

runBrowserTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
});
