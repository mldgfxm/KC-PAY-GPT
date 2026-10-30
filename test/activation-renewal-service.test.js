'use strict';

const { closeAutoRenewAfterRecharge } = require('../activation-renewal-service');

const input = {
    accessToken: 'test-token-never-log',
    email: 'user@example.test',
    successMessage: '激活成功'
};

function dependencies() {
    return {
        cancelRenewal: vi.fn(),
        querySubscription: vi.fn(),
        wait: vi.fn().mockResolvedValue(undefined)
    };
}

describe('post-recharge automatic renewal cancellation', () => {
    it.each([false, true])('confirms disabled renewal, including already cancelled (%s)', async alreadyCancelled => {
        const deps = dependencies();
        deps.cancelRenewal.mockResolvedValue({
            ok: true,
            data: { autoRenewRaw: false, alreadyCancelled }
        });
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result).toMatchObject({ confirmed: true, message: '激活成功；自动续费已关闭' });
        expect(deps.cancelRenewal).toHaveBeenCalledOnce();
        expect(deps.cancelRenewal).toHaveBeenCalledWith(input.accessToken, { email: input.email });
        expect(deps.querySubscription).not.toHaveBeenCalled();
        expect(deps.wait).not.toHaveBeenCalled();
    });

    it('waits for a newly paid subscription to become active before cancelling', async () => {
        const deps = dependencies();
        deps.cancelRenewal
            .mockResolvedValueOnce({ ok: false, code: 'subscription_not_active' })
            .mockResolvedValueOnce({ ok: false, code: 'subscription_not_active' })
            .mockResolvedValueOnce({ ok: true, data: { autoRenewRaw: false } });
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result.confirmed).toBe(true);
        expect(deps.cancelRenewal).toHaveBeenCalledTimes(3);
        expect(deps.wait.mock.calls).toEqual([[2000], [5000]]);
    });

    it('bounds subscription synchronization attempts and reports manual follow-up', async () => {
        const deps = dependencies();
        deps.cancelRenewal.mockResolvedValue({ ok: false, code: 'subscription_not_active' });
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result).toMatchObject({ confirmed: false });
        expect(result.message).toContain('订阅状态尚未同步');
        expect(deps.cancelRenewal).toHaveBeenCalledTimes(3);
        expect(deps.wait).toHaveBeenCalledTimes(2);
    });

    it('only queries after cancellation was accepted, without submitting it again', async () => {
        const deps = dependencies();
        deps.cancelRenewal.mockResolvedValue({ ok: true, data: { cancelled: true, autoRenewRaw: true } });
        deps.querySubscription
            .mockResolvedValueOnce({ ok: true, data: { autoRenewRaw: true } })
            .mockResolvedValueOnce({ ok: true, data: { autoRenewRaw: false } });
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result.confirmed).toBe(true);
        expect(deps.cancelRenewal).toHaveBeenCalledOnce();
        expect(deps.querySubscription).toHaveBeenCalledTimes(2);
    });

    it.each([undefined, true, null, 'false'])('does not claim disabled renewal from an uncertain value (%s)', async value => {
        const deps = dependencies();
        deps.cancelRenewal.mockResolvedValue({ ok: true, data: { cancelled: true, autoRenewRaw: value } });
        deps.querySubscription.mockResolvedValue({ ok: true, data: { autoRenewRaw: value } });
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result.confirmed).toBe(false);
        expect(result.message).toContain('尚未确认');
        expect(deps.cancelRenewal).toHaveBeenCalledOnce();
    });

    it.each([401, 403])('does not retry authentication failures (%s)', async statusCode => {
        const deps = dependencies();
        deps.cancelRenewal.mockResolvedValue({ ok: false, statusCode });
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result.confirmed).toBe(false);
        expect(result.message).toContain('续费管理');
        expect(deps.cancelRenewal).toHaveBeenCalledOnce();
        expect(deps.wait).not.toHaveBeenCalled();
    });

    it('stops verification when the session expires', async () => {
        const deps = dependencies();
        deps.cancelRenewal.mockResolvedValue({ ok: true, data: { cancelled: true } });
        deps.querySubscription.mockResolvedValue({ ok: false, statusCode: 401 });
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result.message).toContain('尚未确认');
        expect(deps.querySubscription).toHaveBeenCalledOnce();
    });

    it('directs mobile subscriptions to the owning store', async () => {
        const deps = dependencies();
        deps.cancelRenewal.mockResolvedValue({ ok: false, code: 'unsupported_subscription_channel' });
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result.confirmed).toBe(false);
        expect(result.message).toContain('App Store / Google Play');
        expect(deps.cancelRenewal).toHaveBeenCalledOnce();
    });

    it('does not send requests when the token is missing', async () => {
        const deps = dependencies();
        const result = await closeAutoRenewAfterRecharge({ ...input, accessToken: '' }, deps);
        expect(result.confirmed).toBe(false);
        expect(deps.cancelRenewal).not.toHaveBeenCalled();
    });

    it('isolates network errors and does not leak request credentials', async () => {
        const deps = dependencies();
        deps.cancelRenewal.mockRejectedValue(new Error(`Authorization: Bearer ${input.accessToken}`));
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result.confirmed).toBe(false);
        expect(result.message).toContain('激活成功');
        expect(JSON.stringify(result)).not.toContain(input.accessToken);
    });

    it('preserves accepted but unverified cancellation when the verification network fails', async () => {
        const deps = dependencies();
        deps.cancelRenewal.mockResolvedValue({ ok: true, data: { cancelled: true } });
        deps.querySubscription.mockRejectedValue(new Error('network timeout'));
        const result = await closeAutoRenewAfterRecharge(input, deps);
        expect(result.confirmed).toBe(false);
        expect(result.message).toContain('已提交关闭自动续费请求，尚未确认');
        expect(deps.cancelRenewal).toHaveBeenCalledOnce();
    });
});
