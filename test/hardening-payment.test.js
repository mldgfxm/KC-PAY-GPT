'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createService } = require('../hardening/service');

describe('payment facts survive bookkeeping errors', () => {
    it.each([
        { persistenceThrows: false, amountFails: false },
        { persistenceThrows: true, amountFails: false },
        { persistenceThrows: false, amountFails: true }
    ])('preserves paid success under post-payment errors (%j)', async ({ persistenceThrows, amountFails }) => {
        const output = { exports: {} };
        const safety = {
            getPayment: vi.fn().mockResolvedValue(null),
            recordPayment: persistenceThrows
                ? vi.fn().mockRejectedValue(new Error('disk failure'))
                : vi.fn().mockResolvedValue({ recorded: false })
        };
        const store = {
            getPaymentRegion: async () => 'PH', getAppConfigValue: async () => null,
            reserveCard: vi.fn().mockResolvedValue({ id: 1, card_number: '4242424242424242' }), releaseCard: vi.fn()
        };
        const pay = vi.fn().mockResolvedValue({ success: true, dueAmount: amountFails ? null : 20 });
        const readAmount = vi.fn().mockResolvedValueOnce({ amount: 20 }).mockRejectedValue(new Error('page closed'));
        const dependencies = {
            './mysql-store': store,
            './stripe-payment': {
                completeStripeCardPayment: pay, readCheckoutDueAmount: readAmount,
                estimateTaxFreeAmount: () => { throw new Error('amount parsing failed'); }
            },
            './tax-free-address': { pickBillingAddressForCheckout: async () => ({ line1: 'Test' }) },
            './region-config': { getRegionConfig: () => ({ currency: 'PHP' }) },
            './hardening/factory': { getHardeningService: () => safety }, 'node:crypto': require('node:crypto')
        };
        const send = vi.fn();
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../payment-retry.js'), 'utf8'), {
            require: name => dependencies[name], module: output,
            console: { log() {} }, process: { env: { JOB_KEY: 'test-job' }, send }
        });
        const result = await output.exports.executePaymentWithRetry({}, {});
        expect(result).toMatchObject({ success: true, paymentConfirmed: true, bookkeepingPending: true });
        expect(pay).toHaveBeenCalledOnce();
        expect(safety.recordPayment).toHaveBeenCalledOnce();
        expect(store.releaseCard).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith({ type: 'payment-confirmed', jobKey: 'test-job' }, expect.any(Function));
        safety.getPayment.mockResolvedValue({ cardLast4: '4242' });
        await output.exports.executePaymentWithRetry({}, {});
        expect(pay).toHaveBeenCalledOnce();
    });

    it('replays a durable outbox after restart and only compensates bookkeeping', async () => {
        const root = path.resolve(__dirname, '../.local/test-artifacts');
        await fsp.mkdir(root, { recursive: true });
        const dataDir = await fsp.mkdtemp(path.join(root, 'payment-'));
        const manager = {
            recordPayment: vi.fn().mockRejectedValueOnce(new Error('mysql unavailable')).mockResolvedValue(undefined),
            recoverPaidTasks: vi.fn().mockResolvedValue(undefined),
            claimRenewal: vi.fn().mockResolvedValue(null)
        };
        const make = () => createService({ manager, access: {}, closeRenewal: vi.fn(), extractToken: x => x, dataDir });
        const receipt = { jobKey: 'job-paid', cardLast4: '4242' };
        expect(await make().recordPayment(receipt)).toEqual({ recorded: false });
        const restarted = make();
        expect(await restarted.getPayment(receipt.jobKey)).toEqual(receipt);
        await restarted.tick();
        expect(manager.recordPayment).toHaveBeenCalledTimes(2);
        expect(await fsp.readdir(path.join(dataDir, 'payment-outbox'))).toEqual([]);
    });

    it('falls back to the database when the journal is unwritable', async () => {
        const root = path.resolve(__dirname, '../.local/test-artifacts');
        await fsp.mkdir(root, { recursive: true });
        const dataDir = await fsp.mkdtemp(path.join(root, 'disk-failure-'));
        // 用普通文件占住目录路径，稳定模拟只读/不可写磁盘，不依赖操作系统权限。
        await fsp.writeFile(path.join(dataDir, 'payment-outbox'), 'blocked');
        const manager = { recordPayment: vi.fn().mockResolvedValue(undefined) };
        const service = createService({ manager, access: {}, dataDir });
        expect(await service.recordPayment({ jobKey: 'disk-paid' })).toEqual({ recorded: true });
        expect(manager.recordPayment).toHaveBeenCalledOnce();
        manager.recordPayment.mockRejectedValue(new Error('mysql also down'));
        await expect(service.recordPayment({ jobKey: 'disk-paid' })).rejects.toThrow('磁盘与数据库均无法保存');
    });
});

it('drains asynchronous progress before resolving the worker and publishing a terminal status', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const start = source.indexOf('function runCheckoutScript(');
    const end = source.indexOf("app.get('/admin'", start);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const ctx = {
        spawn: () => child, activeProcesses: new Set(), PROCESS_IDLE_TIMEOUT_MS: 3000,
        logTask() {}, logTaskChunk() {}, setTimeout, clearTimeout, getCheckoutProgress: () => 100,
        analyzeProcessOutput: () => ({ status: 'success' }), console: { error() {} }
    };
    vm.runInNewContext(source.slice(start, end) + '\nglobalThis.run = runCheckoutScript;', ctx);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const events = [];
    const pending = ctx.run('job', 'fake.js', {}, 1, async () => { await gate; events.push('progress'); })
        .then(() => events.push('terminal'));
    child.stdout.emit('data', Buffer.from('PAYMENT_SUCCESS'));
    child.emit('close', 0, null);
    await Promise.resolve();
    expect(events).toEqual([]);
    release();
    await pending;
    expect(events).toEqual(['progress', 'terminal']);
});
