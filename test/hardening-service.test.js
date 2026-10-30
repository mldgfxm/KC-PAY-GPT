'use strict';

const path = require('node:path');
const { createService } = require('../hardening/service');
const { createActivationService } = require('../hardening/activation-service');

function renewalHarness(overrides = {}) {
    const manager = {
        enqueueRenewal: vi.fn().mockResolvedValue(undefined),
        claimRenewal: vi.fn().mockResolvedValue({ job_key: 'job', owner: 'lease', attempts: 1, session_payload: 'token' }),
        finishRenewal: vi.fn().mockResolvedValue(undefined), ...overrides
    };
    const closeRenewal = vi.fn().mockResolvedValue({ confirmed: false, reason: 'retryable', message: 'retry' });
    const service = createService({
        manager, access: {}, closeRenewal, extractToken: x => x, extractProfile: x => ({ accountId: x }),
        dataDir: path.resolve(__dirname, '../.local/test-artifacts/renewal-empty')
    });
    return { service, manager, closeRenewal };
}

describe('durable renewal processing', () => {
    it.each([
        [true, undefined, 1, 'confirmed'],
        [false, 'retryable', 1, 'retry'],
        [false, 'session_invalid', 1, 'manual'],
        [false, 'unsupported_channel', 1, 'manual'],
        [false, 'retryable', 8, 'manual']
    ])('persists confirmed=%s reason=%s attempts=%s as %s', async (confirmed, reason, attempts, state) => {
        const h = renewalHarness();
        h.manager.claimRenewal.mockResolvedValue({ job_key: 'job', owner: 'lease', attempts });
        h.closeRenewal.mockResolvedValue({ confirmed, reason, message: 'result' });
        const result = await h.service.closeAfterRecharge({ jobKey: 'job', accessToken: 'synthetic' });
        expect(result.confirmed).toBe(confirmed);
        expect(h.manager.enqueueRenewal).toHaveBeenCalledWith('job');
        expect(h.manager.finishRenewal).toHaveBeenCalledWith('job', 'lease', expect.objectContaining({ state }));
    });

    it('does not call the cancellation service while another worker owns the lease', async () => {
        const h = renewalHarness({ claimRenewal: vi.fn().mockResolvedValue(null), listRenewals: async () => [] });
        const result = await h.service.closeAfterRecharge({ jobKey: 'job', accessToken: 'synthetic' });
        expect(h.closeRenewal).not.toHaveBeenCalled();
        expect(result.message).toContain('后台处理中');
    });

    it('preserves recharge success when the queue database is unavailable', async () => {
        const h = renewalHarness({ enqueueRenewal: vi.fn().mockRejectedValue(new Error('db down')) });
        const result = await h.service.closeAfterRecharge({ jobKey: 'job', accessToken: 'synthetic' });
        expect(result.confirmed).toBe(false);
        expect(result.message).toContain('充值成功');
        expect(result.message).toContain('后台补偿');
    });
});

describe('activation service request ownership', () => {
    function harness() {
        const manager = {
            getMaintenanceModeState: async () => ({ enabled: false }), getActivationAttemptLimit: async () => null,
            verifyCdkDetails: async () => ({ type: '自助' }), getRunningTaskByCdk: async () => null,
            getGptApiConfig: async () => ({ enabled: false }), hasAvailableCard: async () => true
        };
        const safety = {
            claimActivation: vi.fn().mockResolvedValue({ jobKey: 'new-job' }),
            abortUnstarted: vi.fn().mockResolvedValue(undefined), access: { issue: () => 'task-token' }
        };
        const runtime = { reserve: vi.fn(), release: vi.fn(), launchLocal: vi.fn(), launchThirdParty: vi.fn() };
        const service = createActivationService({
            manager, safety, runtime, notify: vi.fn(),
            sessions: {
                extractAccessTokenFromRaw: () => 'test-token', validateAccessToken: () => ({ valid: true }),
                parseSessionJson: () => ({}), extractEmailFromSession: () => 'test@example.invalid'
            }
        });
        return { service, manager, safety, runtime };
    }

    it('returns a task-bound capability with the admitted job', async () => {
        const h = harness();
        const result = await h.service.activate({ session: '{}', cdk: 'TEST' }, '127.0.0.1');
        expect(result.body).toMatchObject({ success: true, jobKey: 'new-job', taskToken: 'task-token' });
        expect(h.runtime.launchLocal).toHaveBeenCalledOnce();
    });

    it('never rolls back a CDK when the request did not acquire its claim', async () => {
        const h = harness();
        h.safety.claimActivation.mockRejectedValue(new Error('db error before claim'));
        expect((await h.service.activate({ session: '{}', cdk: 'TEST' }, '')).statusCode).toBe(503);
        expect(h.safety.abortUnstarted).not.toHaveBeenCalled();
    });

    it('rolls back only its own unstarted task if launching fails', async () => {
        const h = harness();
        h.runtime.launchLocal.mockImplementation(() => { throw new Error('launch error'); });
        await h.service.activate({ session: '{}', cdk: 'TEST' }, '');
        expect(h.safety.abortUnstarted).toHaveBeenCalledWith('new-job', 'TEST');
        expect(h.runtime.release).toHaveBeenCalledWith('new-job');
    });

    it('cleans up its own admission if task-token signing fails before launching', async () => {
        const h = harness();
        h.safety.access.issue = () => { throw new Error('key storage unavailable'); };
        await h.service.activate({ session: '{}', cdk: 'TEST' }, '');
        expect(h.safety.abortUnstarted).toHaveBeenCalledWith('new-job', 'TEST');
        expect(h.runtime.launchLocal).not.toHaveBeenCalled();
    });
});
