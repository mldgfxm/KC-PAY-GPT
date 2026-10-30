'use strict';

// 仅创建和删除随机命名的隔离测试库，不在应用业务库内执行测试写入。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
    const database = `kc_hardening_test_${crypto.randomBytes(8).toString('hex')}`;
    assert(/^kc_hardening_test_[a-f0-9]{16}$/.test(database));
    const admin = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '', port: Number(process.env.DB_PORT || 3306)
    });
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    process.env.DB_NAME = database;
    const { getPool } = require('../database/pool');
    const pool = getPool();
    const store = require('../mysql-store');
    const { createMapper } = require('../hardening/mapper');
    const { createManager } = require('../hardening/manager');
    const { createService } = require('../hardening/service');
    const { createTaskAccess } = require('../hardening/task-access');
    const { createCardImportService } = require('../hardening/card-import-service');
    const { createCardImportManager } = require('../hardening/card-import-manager');
    const { createCardImportMapper } = require('../hardening/card-import-mapper');
    const mapper = createMapper(pool);
    const manager = createManager({ pool, mapper });
    const cases = [];
    const query = async (sql, args = []) => (await pool.query(sql, args))[0];
    try {
        await store.ensureReady();
        cases.push('fresh schema and backwards-compatible migration');
        const { DEFAULT_REGION } = require('../region-config');
        assert.equal(await store.getPaymentRegion(), DEFAULT_REGION);
        await store.setPaymentRegion('US');
        assert.equal(await store.getPaymentRegion(), 'US');
        cases.push('payment region access remains available after moving card import');
        await query("UPDATE app_config SET config_value = '1' WHERE config_key = 'max_concurrent_activations'");
        await query("INSERT INTO cdk_codes (cdk_code) VALUES ('A'), ('B'), ('C'), ('D'), ('E')");
        const claim = (accountKey, cdk, jobKey = crypto.randomUUID()) => manager.claimActivation({
            accountKey: accountKey.repeat(64), cdk, jobKey, email: 'test@example.invalid',
            sessionRaw: JSON.stringify({ accessToken: accountKey }), displayTime: 'test'
        });
        const first = await Promise.all([claim('a', 'A'), claim('b', 'B')]);
        assert.equal(first.filter(row => row.jobKey).length, 1);
        assert.equal(first.filter(row => row.statusCode === 429).length, 1);
        cases.push('concurrent admissions respect a global limit of one');
        const paidJob = first.find(row => row.jobKey).jobKey;
        await query('DELETE FROM activation_claims');
        await query('UPDATE cdk_codes SET used_at = NULL');
        await query("UPDATE app_config SET config_value = '3' WHERE config_key = 'max_concurrent_activations'");
        const accounts = await Promise.all([claim('c', 'C'), claim('c', 'D')]);
        assert.equal(accounts.filter(row => row.jobKey).length, 1);
        assert.equal(accounts.filter(row => row.statusCode === 409).length, 1);
        cases.push('same account cannot start two CDKs simultaneously');
        const claimedCdk = (await query('SELECT cdk_code FROM activation_claims'))[0].cdk_code;
        assert.equal((await claim('d', claimedCdk)).statusCode, 409);
        cases.push('same CDK cannot be claimed by another account');
        const broken = createManager({ pool, mapper: { ...mapper, createTask: async () => { throw new Error('injected insert failure'); } } });
        await assert.rejects(() => broken.claimActivation({ accountKey: 'e'.repeat(64), cdk: 'E', jobKey: crypto.randomUUID() }));
        assert.equal((await query("SELECT used_at FROM cdk_codes WHERE cdk_code = 'E'"))[0].used_at, null);
        cases.push('task creation failure rolls back CDK atomically');

        await store.updateTaskLog(paidJob, { status: 'success', message: 'paid', progress: 100 });
        await store.updateTaskLog(paidJob, { status: 'running', message: 'late', progress: 10 });
        assert.deepEqual((await query('SELECT status, message, progress FROM task_logs WHERE job_key = ?', [paidJob]))[0],
            { status: 'success', message: 'paid', progress: 100 });
        cases.push('late progress cannot regress terminal state');

        const importer = createCardImportService(createCardImportManager(pool, createCardImportMapper()));
        const card = { card_number: '4242424242424242', card_expiry: '12/30', card_cvc: '123', card_holder: 'Test' };
        const imports = await Promise.all([importer.importCards([card, card]), importer.importCards([card])]);
        assert.equal(imports.reduce((total, row) => total + row.imported, 0), 1);
        assert.equal(imports.reduce((total, row) => total + row.skipped, 0), 2);
        assert.equal((await query('SELECT COUNT(*) AS total FROM card_assets'))[0].total, 1);
        cases.push('database unique key deduplicates concurrent card imports');
        const emails = Array.from({ length: 205 }, (_, i) => `mail${i}@example.invalid password`).join('\n');
        const mail = await store.bulkImportPoolEmails(emails);
        assert.equal(mail.applied, 205);
        assert.equal((await query('SELECT COUNT(*) AS total FROM pool_emails'))[0].total, 205);
        cases.push('mail import works across three database batches');
        await store.saveConfig({ card_pool: [{ number: card.card_number, expiry: '01/31', cvc: '456' }] });
        assert.equal((await query('SELECT card_cvc FROM card_assets'))[0].card_cvc, '456');
        cases.push('bulk configuration upserts existing cards');

        const cardId = (await query('SELECT id FROM card_assets'))[0].id;
        const receipt = {
            jobKey: paidJob, paidAt: new Date().toISOString(), cardId, cardLast4: '4242',
            amount: 20, currency: 'PHP', cdk: 'A', email: 'test@example.invalid', address: {}, ownerKey: 'original'
        };
        await Promise.all([manager.recordPayment(receipt), manager.recordPayment(receipt)]);
        assert.equal((await query('SELECT usage_count FROM card_assets'))[0].usage_count, 1);
        assert.equal((await query('SELECT COUNT(*) AS total FROM billing_records'))[0].total, 1);
        assert.equal((await query('SELECT COUNT(*) AS total FROM renewal_jobs'))[0].total, 1);
        cases.push('payment replay is idempotent for usage, billing and renewal enqueue');
        await query("UPDATE task_logs SET status = 'running', progress = 99 WHERE job_key = ?", [paidJob]);
        await query(
            `INSERT INTO activation_claims (job_key, account_key, cdk_code, lease_until)
             VALUES (?, ?, 'RECOVERY-TEST', DATE_ADD(NOW(), INTERVAL 120 SECOND))`,
            [paidJob, 'r'.repeat(64)]
        );
        await manager.recoverPaidTasks();
        assert.equal((await query('SELECT status FROM task_logs WHERE job_key = ?', [paidJob]))[0].status, 'running');
        await query('UPDATE activation_claims SET lease_until = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE job_key = ?', [paidJob]);
        await manager.recoverPaidTasks();
        assert.equal((await query('SELECT status FROM task_logs WHERE job_key = ?', [paidJob]))[0].status, 'success');
        assert.equal((await query('SELECT usage_count FROM card_assets'))[0].usage_count, 1);
        cases.push('paid facts restore terminal status after the original worker disappears');
        await query("UPDATE card_assets SET in_use = 1, locked_by = 'new-owner', locked_at = NOW()");
        await manager.recordPayment({ ...receipt, jobKey: 'another-paid-job' });
        assert.equal((await query('SELECT locked_by FROM card_assets'))[0].locked_by, 'new-owner');
        cases.push('old payment compensation cannot release another task card lock');
        await query("INSERT INTO activation_claims (job_key, account_key, cdk_code, lease_until) VALUES ('lock-guard-job', ?, 'LOCK-TEST', DATE_ADD(NOW(), INTERVAL 120 SECOND))", ['z'.repeat(64)]);
        await query("UPDATE card_assets SET in_use = 1, locked_by = 'payment_lock-guard-job', locked_at = DATE_SUB(NOW(), INTERVAL 30 MINUTE)");
        await store.releaseStaleAssetLocks();
        assert.equal((await query('SELECT in_use FROM card_assets'))[0].in_use, 1);
        await query("UPDATE activation_claims SET lease_until = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE job_key = 'lock-guard-job'");
        await store.releaseStaleAssetLocks();
        assert.equal((await query('SELECT in_use FROM card_assets'))[0].in_use, 0);
        cases.push('stale asset cleanup respects another live worker lease');
        const leases = await Promise.all([manager.claimRenewal(paidJob), manager.claimRenewal(paidJob)]);
        assert.equal(leases.filter(Boolean).length, 1);
        const lease = leases.find(Boolean);
        await manager.finishRenewal(paidJob, 'wrong-owner', { state: 'confirmed', message: 'invalid' });
        assert.equal((await query('SELECT state FROM renewal_jobs WHERE job_key = ?', [paidJob]))[0].state, 'running');
        cases.push('renewal lease excludes concurrent workers and late wrong-owner writes');
        await manager.finishRenewal(paidJob, lease.owner, { state: 'retry', message: 'retry after restart', delay: 0 });
        const service = createService({
            manager, access: createTaskAccess({ secret: 'test' }),
            extractToken: raw => JSON.parse(raw).accessToken,
            extractProfile: token => ({ accountId: token }),
            closeRenewal: async () => ({ confirmed: true, message: 'confirmed' }),
            dataDir: path.join(__dirname, '../.local/test-artifacts/db-service')
        });
        await service.tick();
        assert.equal((await query('SELECT state FROM renewal_jobs WHERE job_key = ?', [paidJob]))[0].state, 'confirmed');
        cases.push('fresh service instance recovers persisted renewal work');
        await query("UPDATE renewal_jobs SET state = 'manual', lease_until = NULL WHERE job_key = ?", [paidJob]);
        const wrong = await service.retryRenewal(paidJob, JSON.stringify({ accessToken: 'different-account' }));
        assert.equal(wrong.success, false);
        const original = JSON.parse((await query('SELECT session_payload FROM task_logs WHERE job_key = ?', [paidJob]))[0].session_payload);
        assert.equal((await service.retryRenewal(paidJob, JSON.stringify(original))).success, true);
        cases.push('manual retry can refresh only the original account session');

        await query('ALTER TABLE card_assets DROP INDEX uniq_card_assets_number');
        await query('INSERT INTO card_assets (card_number, card_expiry, card_cvc) VALUES (?, ?, ?)', [card.card_number, '01/31', '456']);
        await assert.rejects(() => store.ensureReady(), /重复卡号/);
        assert.equal((await query('SELECT COUNT(*) AS total FROM card_assets'))[0].total, 2);
        cases.push('legacy duplicate migration fails safely without deleting data');
        const report = { isolatedDatabase: true, passed: cases.length, cases };
        fs.mkdirSync(path.join(__dirname, '../.local'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, '../.local/hardening-db-report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await pool.end();
        await admin.query(`DROP DATABASE \`${database}\``);
        await admin.end();
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
