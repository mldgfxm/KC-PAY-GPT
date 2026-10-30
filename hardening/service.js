'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function createService({ manager, access, closeRenewal, extractToken, extractProfile, dataDir }) {
    const outboxDir = path.join(dataDir, 'payment-outbox');
    let running = false;
    let timer;
    let replayCursor = 0;
    function receiptFile(jobKey) {
        return path.join(outboxDir, `${crypto.createHash('sha256').update(jobKey).digest('hex')}.json`);
    }

    async function recordPayment(receipt) {
        // 先落本机持久化目录，再记账；MySQL 暂停时仍保留已支付事实，后台只重放记账。
        const file = receiptFile(receipt.jobKey);
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        let journaled = false;
        try {
            await fs.mkdir(outboxDir, { recursive: true });
            const handle = await fs.open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify(receipt));
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fs.rename(temporary, file);
            journaled = true;
        } catch (_) {
            // 磁盘暂不可写仍尝试直接记账；只有磁盘和数据库均失败时才要求人工核实。
            await fs.unlink(temporary).catch(() => {});
        }
        try {
            await manager.recordPayment(receipt);
            if (journaled) await fs.unlink(file).catch(() => {});
            return { recorded: true };
        } catch (_) {
            if (!journaled) throw new Error('支付已确认，但磁盘与数据库均无法保存，请人工核实');
            return { recorded: false };
        }
    }

    async function processRenewal(job, input = {}) {
        const token = input.accessToken || extractToken(job.session_payload || '');
        const result = await closeRenewal({
            ...input, accessToken: token, email: input.email || job.token_preview, successMessage: input.successMessage || '充值成功'
        });
        const permanent = result.reason === 'session_invalid' || result.reason === 'unsupported_channel';
        await manager.finishRenewal(job.job_key, job.owner, {
            state: result.confirmed ? 'confirmed' : permanent || job.attempts >= 8 ? 'manual' : 'retry',
            message: result.message,
            delay: Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7))
        });
        return result;
    }

    async function tick() {
        if (running) return;
        running = true;
        try {
            const files = await fs.readdir(outboxDir).catch(() => []);
            // 每轮重放一笔独立事务，避免批量补偿挤占在线任务的数据库连接。
            const receipts = files.filter(name => name.endsWith('.json')).sort();
            // 单笔坏数据不能长期挡住其他已支付事件；失败文件保留并轮换重试。
            const file = receipts.length ? receipts[replayCursor++ % receipts.length] : null;
            if (file) {
                const fullPath = path.join(outboxDir, file);
                try {
                    const receipt = JSON.parse(await fs.readFile(fullPath, 'utf8'));
                    await manager.recordPayment(receipt);
                    await fs.unlink(fullPath);
                } catch (_) { /* 保留文件，下一轮重试；不输出包含业务凭据的错误对象。 */ }
            }
            await manager.recoverPaidTasks();
            const job = await manager.claimRenewal();
            if (!job) return;
            await processRenewal(job);
        } finally { running = false; }
    }

    return {
        initialize: manager.initialize,
        access,
        async claimActivation({ token, ...data }) {
            const profile = extractProfile(token);
            const identity = profile.accountId || String(profile.email || '').toLowerCase();
            if (!identity) return { error: 'Session 缺少账号标识，无法安全启动任务', statusCode: 400 };
            return manager.claimActivation({
                ...data, jobKey: crypto.randomUUID(), displayTime: new Date().toLocaleString('zh-CN'),
                email: profile.email || data.email || '',
                accountKey: crypto.createHash('sha256').update(identity).digest('hex')
            });
        },
        heartbeat: manager.heartbeat,
        release: manager.release,
        abortUnstarted: manager.abortUnstarted,
        getReceipt: manager.getReceipt,
        async getPayment(jobKey) {
            const pending = await fs.readFile(receiptFile(jobKey), 'utf8').catch(error => {
                if (error.code === 'ENOENT') return null;
                throw error;
            });
            if (pending) return JSON.parse(pending);
            const row = await manager.getReceipt(jobKey);
            return row ? (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) : null;
        },
        recordPayment,
        async closeAfterRecharge(input) {
            // 先保存待补偿任务；当前取消失败或进程退出后，仍可由后续后台轮次接手。
            try {
                if (!input.jobKey) return closeRenewal(input);
                await manager.enqueueRenewal(input.jobKey);
                const job = await manager.claimRenewal(input.jobKey);
                if (job) return await processRenewal(job, input);
                const jobs = await manager.listRenewals();
                const existing = jobs.find(row => row.job_key === input.jobKey);
                const confirmed = existing?.state === 'confirmed';
                const message = `${input.successMessage || '充值成功'}；${confirmed ? '自动续费已关闭' : '自动续费正在后台处理中'}`;
                return { confirmed, message, logMessage: `[自动续费] ${message}` };
            } catch (_) {
                const message = `${input.successMessage || '充值成功'}；续费处理已转入后台补偿，请在续费管理中核实`;
                return { confirmed: false, message, logMessage: `[自动续费] ${message}` };
            }
        },
        listRenewals: manager.listRenewals,
        async retryRenewal(jobKey, sessionRaw) {
            if (sessionRaw) {
                const previous = await manager.renewalSession(jobKey);
                if (!previous) return { success: false, message: '补偿任务不存在' };
                const oldProfile = extractProfile(extractToken(previous.session_payload || ''));
                const nextProfile = extractProfile(extractToken(sessionRaw));
                const identity = profile => profile.accountId || String(profile.email || '').toLowerCase();
                if (!identity(oldProfile) || identity(oldProfile) !== identity(nextProfile)) {
                    return { success: false, message: '新 Session 必须属于原充值账号' };
                }
            }
            const success = (await manager.retryRenewal(jobKey, sessionRaw)).affectedRows > 0;
            return { success, message: success ? '已加入后台补偿队列' : '任务正在处理或已确认关闭，不能重复排队' };
        },
        tick,
        start() {
            if (timer) return;
            timer = setInterval(() => tick().catch(() => console.warn('[补偿] 暂时无法完成，稍后重试')), 15000);
            timer.unref();
            tick().catch(() => {});
        },
        stop() { clearInterval(timer); timer = null; }
    };
}

module.exports = { createService };
