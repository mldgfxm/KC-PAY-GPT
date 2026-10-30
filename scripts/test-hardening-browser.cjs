'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { fork } = require('node:child_process');
const mysql = require('mysql2/promise');
const WebSocket = require('ws');
const { createTaskAccess } = require('../hardening/task-access');
const { chromium } = require('playwright');

(async () => {
    const database = `kc_hardening_test_${crypto.randomBytes(8).toString('hex')}`;
    assert(/^kc_hardening_test_[a-f0-9]{16}$/.test(database));
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD
    });
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const secret = crypto.randomBytes(32).toString('hex');
    const port = 3112;
    const base = `http://127.0.0.1:${port}`;
    const child = fork(path.join(__dirname, '../server.js'), [], {
        env: { ...process.env, DB_NAME: database, PORT: String(port), BROWSER_POOL: '0', COMPENSATION_ENABLED: '0',
            ADMIN_EMAIL: 'admin@example.invalid', ADMIN_PASSWORD: 'test-only-login',
            ADMIN_SECONDARY_PASSWORD: 'test-only-secondary', ADMIN_TOKEN_SECRET: secret, TASK_ACCESS_SECRET: secret },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    let logs = '';
    child.stdout.on('data', data => { logs += data.toString(); });
    child.stderr.on('data', data => { logs += data.toString(); });
    let browser;
    const cases = [];
    async function api(route, options = {}) {
        const response = await fetch(base + route, options);
        return { status: response.status, data: await response.json() };
    }
    async function subscribe(payload) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(base.replace('http:', 'ws:'));
            const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS response timeout')); }, 5000);
            ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', ...payload })));
            ws.on('message', raw => {
                clearTimeout(timer); const result = JSON.parse(raw); ws.close(); resolve(result);
            });
            ws.on('error', reject);
        });
    }
    try {
        let ready = false;
        for (let attempt = 0; attempt < 120; attempt += 1) {
            if (child.exitCode !== null) throw new Error(`Test server exited: ${logs.slice(-1200)}`);
            try { ready = (await api('/api/public/runtime')).data.success; } catch (_) { }
            if (ready) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert(ready, 'test server did not become ready');
        await connection.query(`USE \`${database}\``);
        await connection.query("INSERT INTO card_assets (card_number, card_expiry, card_cvc) VALUES ('4242424242424242', '12/30', '123')");
        await connection.query("INSERT INTO task_logs (job_key, token_preview, cdk_code, status, progress, display_time) VALUES ('ws-test-job', 'test@example.invalid', 'TEST-ONLY-CDK', 'success', 100, 'test')");
        await connection.query("INSERT INTO renewal_jobs (job_key, state, last_message) VALUES ('ws-test-job', 'manual', '测试补偿任务')");
        const login = await api('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'admin@example.invalid', password: 'test-only-login' })
        });
        assert(login.data.success);
        const headers = { Authorization: `Bearer ${login.data.token}` };
        assert.equal((await api('/api/admin/data')).status, 401);
        const overview = await api('/api/admin/data', { headers });
        assert.equal(overview.status, 200);
        assert.equal(overview.data.config.card_pool_count, 1);
        assert(!JSON.stringify(overview.data).includes('4242424242424242'));
        cases.push('anonymous admin denied; primary-only overview has no card credentials');
        for (const route of ['/api/admin/cards', '/api/admin/sessions', '/api/admin/cdks', '/api/admin/billing', '/api/admin/billing/export']) {
            const result = await api(route, { headers });
            assert.equal(result.status, 403);
            assert.equal(result.data.code, 'SECONDARY_REQUIRED');
        }
        cases.push('card, session, CDK and billing APIs require secondary authentication');
        const config = await api('/api/admin/config', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ card_pool: [] })
        });
        assert.equal(config.status, 403);
        assert.equal((await connection.query('SELECT COUNT(*) AS total FROM card_assets'))[0][0].total, 1);
        cases.push('legacy bulk-config endpoint cannot bypass secondary authentication');
        const secondary = await api('/api/admin/verify-secondary', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'test-only-secondary' })
        });
        assert(secondary.data.secondaryToken);
        const fullHeaders = { ...headers, 'x-admin-secondary-token': secondary.data.secondaryToken };
        assert.equal((await api('/api/admin/cards', { headers: fullHeaders })).status, 200);
        cases.push('valid secondary token restores authorized card access');
        assert.equal((await subscribe({ jobKey: 'ws-test-job' })).code, 'TASK_UNAUTHORIZED');
        const access = createTaskAccess({ secret });
        assert.equal((await subscribe({ jobKey: 'ws-test-job', taskToken: access.issue('other-job') })).code, 'TASK_UNAUTHORIZED');
        assert.equal((await subscribe({ jobKey: 'ws-test-job', taskToken: access.issue('ws-test-job') })).type, 'snapshot');
        assert.equal((await subscribe({ jobKey: 'ws-test-job', adminToken: login.data.token })).type, 'snapshot');
        cases.push('WebSocket rejects missing/cross-task authorization and accepts owner/admin');
        const retryDenied = await api('/api/admin/renewal-jobs/ws-test-job/retry', {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}'
        });
        assert.equal(retryDenied.status, 403);
        cases.push('manual renewal compensation is secondary-protected');

        browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await context.addInitScript(() => { window.lucide = { createIcons() {} }; });
        await context.route('**/*', route => {
            if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort();
            return route.continue();
        });
        await page.goto(base + '/admin-login');
        await page.locator('#email').fill('admin@example.invalid');
        await page.locator('#password').fill('test-only-login');
        await page.locator('#loginBtn').click();
        await page.waitForURL('**/admin');
        await page.waitForFunction(() => typeof switchPage === 'function');
        assert.equal(await page.locator('dialog[open]').count(), 0);
        await page.evaluate(() => switchPage('cards', document.querySelector('[data-page="cards"]')));
        await page.locator('dialog[open] input[type="password"]').fill('test-only-secondary');
        await page.locator('dialog[open] button[value="verify"]').click();
        await page.waitForFunction(() => document.getElementById('card_pool_list_body').textContent.includes('4242424242424242'));
        cases.push('browser prompts for secondary password only when opening sensitive card view');
        await page.evaluate(() => switchPage('cancel_renewal', document.querySelector('[data-page="cancel_renewal"]')));
        await page.waitForFunction(() => document.getElementById('renewal_jobs').textContent.includes('需要人工处理'));
        await page.locator('[data-renewal-job="ws-test-job"]').click();
        await page.waitForFunction(() => document.getElementById('renewal_jobs').textContent.includes('等待处理'));
        cases.push('browser renewal status panel can requeue manual compensation');
        await page.screenshot({ path: path.join(__dirname, '../.local/hardening-renewal-browser.png'), fullPage: true });
        assert.deepEqual(errors, []);
        await context.close();
        await connection.query("UPDATE app_config SET config_value = '2' WHERE config_key = 'admin_secondary_password_version'");
        assert.equal((await api('/api/admin/cards', { headers: fullHeaders })).status, 403);
        assert.equal((await api('/api/admin/secondary/session', { headers: fullHeaders })).data.verified, false);
        cases.push('secondary password version change invalidates old tokens');
        console.log(JSON.stringify({ isolatedDatabase: true, passed: cases.length, cases }, null, 2));
    } finally {
        if (browser) await browser.close();
        child.kill('SIGTERM');
        await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
        await connection.query(`DROP DATABASE \`${database}\``);
        await connection.end();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
