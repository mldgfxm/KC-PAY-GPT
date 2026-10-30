'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const serverPath = path.resolve(__dirname, '..', 'server.js');
const task = { jobKey: 'renewal-test-job', tokenPreview: 'user@example.test' };
const accessToken = 'test-access-token';

function loadWorker(functionName, nextDeclaration, dependencies) {
    const source = fs.readFileSync(serverPath, 'utf8');
    const declaration = functionName === 'runGptApiWorker'
        ? `async function ${functionName}(`
        : `function ${functionName}(`;
    const start = source.indexOf(declaration);
    const end = source.indexOf(`\n${nextDeclaration}`, start);
    if (start < 0 || end < 0) {
        throw new Error(`Cannot isolate ${functionName} from server.js`);
    }

    // 仅执行真实 worker 的函数体：不启动 HTTP 服务，也不加载真实数据库和上游客户端。
    const context = {
        ...dependencies,
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        process: { env: { GPT_API_MAX_POLLS: '1', GPT_API_POLL_INTERVAL_MS: '1' } },
        path,
        __dirname: path.dirname(serverPath)
    };
    vm.runInNewContext(
        `${source.slice(start, end)}\nglobalThis.worker = ${functionName};`,
        context,
        { filename: serverPath }
    );
    return context.worker;
}

function createHarness({ paid, renewalConfirmed, shouldRetry = false, maxProcessAttempts = 1 }) {
    let finishWorker;
    const completed = new Promise(resolve => { finishWorker = resolve; });
    const store = {
        updateTaskLog: vi.fn().mockResolvedValue(undefined),
        getGptApiConfig: vi.fn().mockResolvedValue({ enabled: true, api_key: 'test-key' }),
        getActiveProxy: vi.fn().mockResolvedValue(''),
        getHcaptchaConfig: vi.fn().mockResolvedValue({}),
        reserveCard: vi.fn().mockResolvedValue({
            id: 1,
            card_number: '4242424242424242',
            card_expiry: '12/30',
            card_cvc: '123',
            card_holder: 'Test User'
        }),
        resetCdkFailure: vi.fn().mockResolvedValue(undefined),
        resetActivationAttemptFailure: vi.fn().mockResolvedValue(undefined),
        recordCardUsage: vi.fn().mockResolvedValue(undefined),
        releaseCard: vi.fn().mockResolvedValue(undefined),
        markCdkUnused: vi.fn().mockResolvedValue(undefined),
        recordCdkFailure: vi.fn().mockResolvedValue(false),
        recordActivationAttemptFailure: vi.fn().mockResolvedValue(false),
        getMaintenanceModeState: vi.fn().mockResolvedValue({ enabled: false, drain: false }),
        setMaintenanceModeState: vi.fn().mockResolvedValue(undefined)
    };
    const renewalText = renewalConfirmed ? '自动续费已关闭' : '自动关闭续费未确认，请手动处理';
    const closeAutoRenewAfterRecharge = vi.fn(async ({ successMessage }) => ({
        confirmed: renewalConfirmed,
        message: `${successMessage}；${renewalText}`,
        logMessage: renewalText
    }));
    const broadcastToTask = vi.fn();
    const notifyTaskOutcome = vi.fn();
    const dependencies = {
        hardening: { recordPayment: vi.fn().mockResolvedValue({ recorded: true }) },
        store,
        closeAutoRenewAfterRecharge,
        broadcastToTask,
        notifyTaskOutcome,
        logTask: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        releaseForegroundSlot: vi.fn(() => finishWorker()),
        // 保留一个无关任务，令 finally 的收尾同步结束，便于等待无返回值的后台 worker。
        getTotalActiveJobs: vi.fn(() => 1),
        mapGptApiPlanKey: vi.fn(() => 'plus'),
        parseCardExpiry: vi.fn(() => ({ month: 12, year: 2030 })),
        maskProxyForLog: vi.fn(() => '(proxy)'),
        isTerminalGptApiStatus: vi.fn(() => true),
        isSuccessGptApiStatus: vi.fn(() => paid),
        gptApi: {
            inspectPay: vi.fn().mockResolvedValue({ success: true }),
            submitPay: vi.fn().mockResolvedValue({ success: true, orderId: 'order-test', data: {} }),
            queryOrder: vi.fn().mockResolvedValue({
                success: true,
                rawStatus: paid ? 'success' : 'failed',
                data: { result: { ok: paid, error: paid ? undefined : 'payment_declined' } }
            }),
            extractTopupCode: vi.fn(() => '')
        },
        MAX_PROCESS_ATTEMPTS: maxProcessAttempts,
        extractEmailFromSession: vi.fn(() => 'user@example.test'),
        buildHcaptchaEnvFromConfig: vi.fn(() => ({ env: {} })),
        spawnWorkerWithBrowser: vi.fn(({ runtimeEnv, runScript }) => runScript(runtimeEnv)),
        runCheckoutScript: vi.fn().mockResolvedValue({
            output: paid ? 'PAYMENT_SUCCESS' : 'payment declined',
            analysis: { status: paid ? 'success' : 'failed', shouldRetry, message: paid ? '激活成功' : '支付失败' }
        }),
        extractCardLast4FromOutput: vi.fn(() => '4242'),
        normalizeTaskProgress: vi.fn(value => value),
        getCheckoutProgress: vi.fn(() => paid ? 100 : 40),
        extractTaskMediaFromOutput: vi.fn(() => ({ screenshots: [], videos: [] })),
        isCardPoolExhaustedIssue: vi.fn(() => false),
        isNoActivationEligibilityMessage: vi.fn(() => false)
    };
    return {
        store,
        dependencies,
        closeAutoRenewAfterRecharge,
        broadcastToTask,
        notifyTaskOutcome,
        completed,
        renewalText
    };
}

async function runRechargeWorker(kind, harness) {
    const common = { task, token: accessToken, cdk: 'test-cdk', planType: 'plus' };
    if (kind === 'third-party') {
        const worker = loadWorker('runGptApiWorker', 'function maskProxyForLog(', harness.dependencies);
        await worker({ ...common, session: { accessToken } });
    } else {
        const worker = loadWorker('spawnActivationWorker', 'async function handleActivationRequest(', harness.dependencies);
        worker({ ...common, sessionRaw: '{}', cdkDetails: { plan_type: 'plus' }, clientIp: '127.0.0.1' });
        await harness.completed;
    }
}

describe.each(['local', 'third-party'])('%s recharge renewal integration', kind => {
    it.each([true, false])(
        'keeps paid status and reports the renewal result (confirmed=%s)',
        async renewalConfirmed => {
            const harness = createHarness({ paid: true, renewalConfirmed });
            await runRechargeWorker(kind, harness);

            expect(harness.closeAutoRenewAfterRecharge).toHaveBeenCalledTimes(1);
            expect(harness.closeAutoRenewAfterRecharge).toHaveBeenCalledWith(expect.objectContaining({
                accessToken,
                email: 'user@example.test',
                successMessage: expect.any(String)
            }));
            expect(harness.store.markCdkUnused).not.toHaveBeenCalled();
            const finalTask = harness.store.updateTaskLog.mock.calls.at(-1);
            expect(finalTask[0]).toBe(task.jobKey);
            expect(finalTask[1]).toMatchObject({ status: 'success', progress: 100 });
            expect(finalTask[1].message).toContain(harness.renewalText);
            const finalBroadcast = harness.broadcastToTask.mock.calls.at(-1)[1];
            expect(finalBroadcast).toMatchObject({ status: 'success', progress: 100 });
            expect(finalBroadcast.message).toContain(harness.renewalText);
            // 前端会在收到任意 success 时结束等待，不能在续费收尾之前提前发送成功终态。
            const successBroadcasts = harness.broadcastToTask.mock.calls
                .map(([, payload]) => payload)
                .filter(payload => payload.status === 'success');
            expect(successBroadcasts).toHaveLength(1);
            for (const payload of successBroadcasts) {
                expect(payload.message).toContain(harness.renewalText);
            }
            const successWrites = harness.store.updateTaskLog.mock.calls
                .map(([, payload]) => payload)
                .filter(payload => payload.status === 'success');
            for (const payload of successWrites) {
                expect(payload.message).toContain(harness.renewalText);
            }
            expect(harness.notifyTaskOutcome).toHaveBeenLastCalledWith(expect.objectContaining({
                event: 'success', message: expect.stringContaining(harness.renewalText)
            }));
        }
    );

    it('does not cancel renewal when recharge fails', async () => {
        const harness = createHarness({ paid: false, renewalConfirmed: false });
        await runRechargeWorker(kind, harness);

        expect(harness.closeAutoRenewAfterRecharge).not.toHaveBeenCalled();
        expect(harness.store.markCdkUnused).toHaveBeenCalledWith('test-cdk');
        expect(harness.store.updateTaskLog.mock.calls.at(-1)[1].status).toBe('failed');
        expect(harness.notifyTaskOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'failure' }));
    });
});

it('does not recharge again when a successful local analysis also requests retry', async () => {
    const harness = createHarness({
        paid: true,
        renewalConfirmed: true,
        shouldRetry: true,
        maxProcessAttempts: 3
    });
    await runRechargeWorker('local', harness);

    // 充值成功优先于重试标记，防止仅因后置任务失败而再次扣款。
    expect(harness.dependencies.runCheckoutScript).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.spawnWorkerWithBrowser).toHaveBeenCalledTimes(1);
    expect(harness.closeAutoRenewAfterRecharge).toHaveBeenCalledTimes(1);
    expect(harness.store.markCdkUnused).not.toHaveBeenCalled();
    expect(harness.store.updateTaskLog.mock.calls.at(-1)[1]).toMatchObject({
        status: 'success',
        message: expect.stringContaining(harness.renewalText)
    });
});

it.each([
    ['local', 'updateTaskLog'],
    ['third-party', 'paymentReceipt'],
    ['local', 'resetCdkFailure']
])('preserves a paid %s recharge when post-payment %s fails once', async (kind, operation) => {
    const harness = createHarness({ paid: true, renewalConfirmed: true });
    if (operation === 'paymentReceipt') {
        harness.dependencies.hardening.recordPayment.mockRejectedValueOnce(new Error('temporary outbox write failure'));
    } else {
        harness.store[operation].mockRejectedValueOnce(new Error('transient post-payment persistence failure'));
    }

    await runRechargeWorker(kind, harness);

    // 支付结果已经明确，资产统计和状态写入异常只能触发收尾恢复，不能回滚或再次充值。
    expect(harness.closeAutoRenewAfterRecharge).toHaveBeenCalledTimes(1);
    expect(harness.closeAutoRenewAfterRecharge).toHaveBeenCalledWith(expect.objectContaining({ accessToken }));
    expect(harness.store.markCdkUnused).not.toHaveBeenCalled();
    expect(harness.store.updateTaskLog.mock.calls.at(-1)[1]).toMatchObject({
        status: 'success',
        progress: 100,
        message: expect.stringContaining(harness.renewalText)
    });
    expect(harness.broadcastToTask.mock.calls.at(-1)[1]).toMatchObject({
        status: 'success',
        progress: 100,
        message: expect.stringContaining(harness.renewalText)
    });
    expect(harness.notifyTaskOutcome).toHaveBeenLastCalledWith(expect.objectContaining({
        event: 'success',
        message: expect.stringContaining(harness.renewalText)
    }));
    const failedWrites = harness.store.updateTaskLog.mock.calls
        .map(([, payload]) => payload)
        .filter(payload => payload.status === 'failed');
    expect(failedWrites).toHaveLength(0);
    if (kind === 'local') {
        expect(harness.dependencies.runCheckoutScript).toHaveBeenCalledTimes(1);
    } else {
        expect(harness.dependencies.gptApi.submitPay).toHaveBeenCalledTimes(1);
    }
});
