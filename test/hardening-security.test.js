'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const auth = require('../admin-auth');
const { createTaskAccess } = require('../hardening/task-access');

function response() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
}

describe('secondary authentication boundary', () => {
    afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

    it.each(['missing', 'invalid', 'old-version', 'expired'])('rejects %s authorization', async mode => {
        vi.stubEnv('ADMIN_TOKEN_SECRET', 'test-only-secret');
        const token = auth.issueSecondaryToken(mode === 'old-version' ? 1 : 2).token;
        if (mode === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000);
        const config = { getAdminAuthConfig: async () => ({ secondaryPasswordVersion: 2 }) };
        const middleware = auth.createRequireSecondaryAuth(config, async () => {});
        const res = response();
        const next = vi.fn();
        const actual = mode === 'missing' ? '' : mode === 'invalid' ? 'bad' : token;
        await middleware({ headers: { 'x-admin-secondary-token': actual } }, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it('accepts a current secondary token and fails closed on database errors', async () => {
        const token = auth.issueSecondaryToken(2).token;
        const store = { getAdminAuthConfig: vi.fn().mockResolvedValue({ secondaryPasswordVersion: 2 }) };
        const middleware = auth.createRequireSecondaryAuth(store, async () => {});
        const next = vi.fn();
        await middleware({ headers: { 'x-admin-secondary-token': token } }, response(), next);
        expect(next).toHaveBeenCalledOnce();
        store.getAdminAuthConfig.mockRejectedValueOnce(new Error('database unavailable'));
        const res = response();
        await middleware({ headers: { 'x-admin-secondary-token': token } }, res, vi.fn());
        expect(res.status).toHaveBeenCalledWith(503);
    });

    it('does not expose card credentials in the overview response', async () => {
        const source = fs.readFileSync(path.join(__dirname, '../mysql-store.js'), 'utf8');
        const start = source.indexOf('async function getAdminData()');
        const end = source.indexOf('async function saveConfig(', start);
        const ctx = {
            runQuery: async sql => sql.includes('FROM card_assets') ? [{ total: 1 }] : [],
            listAdminTaskLogs: async () => [], getBillingOverviewStats: async () => [],
            getTelegramConfig: async () => ({}), getHcaptchaConfig: async () => ({}), publicHcaptchaConfig: x => x
        };
        vm.runInNewContext(source.slice(start, end) + '\nglobalThis.run = getAdminData;', ctx);
        const payload = await ctx.run();
        expect(JSON.stringify(payload)).not.toContain('4242424242424242');
        expect(JSON.stringify(payload)).not.toContain('card_cvc');
        expect(payload.config.card_pool_count).toBe(1);
    });
});

describe('task access capabilities', () => {
    it('binds a signed, expiring token to exactly one task', () => {
        const access = createTaskAccess({ secret: 'synthetic-key' });
        const token = access.issue('job-a');
        expect(access.verify(token, 'job-a')).toBe(true);
        expect(access.verify(token, 'job-b')).toBe(false);
        expect(access.verify(`${token}x`, 'job-a')).toBe(false);
        expect(access.verify('', 'job-a')).toBe(false);
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 3600 * 1000);
        expect(access.verify(token, 'job-a')).toBe(false);
        vi.restoreAllMocks();
    });
});
