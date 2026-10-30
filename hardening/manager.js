'use strict';

const crypto = require('node:crypto');

function createManager({ pool, mapper }) {
    async function transaction(action) {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const result = await action(connection);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    return {
        initialize: mapper.initialize,
        async claimActivation(data) {
            return transaction(async connection => {
                // 所有实例先锁同一条配置记录，限制检查、CDK 占用和任务创建在一个短事务内完成。
                const [limit] = await mapper.lockAdmission(connection);
                await mapper.cleanupSuccessfulClaims(connection);
                const claims = await mapper.findClaim(data.accountKey, data.cdk, connection);
                if (claims.length) {
                    const same = claims.find(row => row.account_key === data.accountKey && row.cdk_code === data.cdk);
                    if (same) return { jobKey: same.job_key, resumed: true };
                    return { error: '该账号或 CDK 已有未完成任务，请勿重复提交', statusCode: 409 };
                }
                const [count] = await mapper.countClaims(connection);
                if (Number(count.total) >= Math.max(1, Number(limit?.config_value || 1))) {
                    return { error: '当前任务过多，请稍后再试', statusCode: 429 };
                }
                const [cdk] = await mapper.lockCdk(data.cdk, connection);
                if (!cdk || !cdk.is_active || cdk.used_at || cdk.type !== '自助' ||
                    cdk.cooldown_until && new Date(cdk.cooldown_until) > new Date()) {
                    return { error: 'CDK 不可用、已使用或处于冷却中', statusCode: 403 };
                }
                await mapper.useCdk(data.cdk, connection);
                await mapper.createTask(data, connection);
                await mapper.createClaim(data, connection);
                return { jobKey: data.jobKey, displayTime: data.displayTime, planType: cdk.plan_type };
            });
        },
        heartbeat: mapper.heartbeat,
        release: mapper.release,
        abortUnstarted: (jobKey, cdk) => transaction(async connection => {
            await mapper.abortUnstarted(jobKey, cdk, connection);
            await mapper.failUnstarted(jobKey, connection);
            await mapper.deleteClaim(jobKey, connection);
        }),
        getReceipt: async jobKey => (await mapper.getReceipt(jobKey))[0] || null,
        recoverPaidTasks: mapper.recoverPaidTasks,
        async recordPayment(data) {
            return transaction(async connection => {
                await mapper.insertReceipt(data, connection);
                const [receipt] = await mapper.getReceipt(data.jobKey, connection, true);
                if (receipt.recorded_at) return;
                // 以首次确认支付的事实为准，重放时不能换卡、重复累计次数或重复插入账单。
                const payload = typeof receipt.payload === 'string' ? JSON.parse(receipt.payload) : receipt.payload;
                await mapper.saveCardPayment(payload, connection);
                await mapper.bindAddress(payload, connection);
                await mapper.insertBilling(payload, connection);
                await mapper.enqueueRenewal(data.jobKey, connection);
                await mapper.finishReceipt(data.jobKey, connection);
            });
        },
        enqueueRenewal: jobKey => mapper.enqueueRenewal(jobKey),
        async claimRenewal(jobKey) {
            return transaction(async connection => {
                const [job] = await mapper.dueRenewal(connection, jobKey);
                if (!job) return null;
                const owner = crypto.randomUUID();
                await mapper.claimRenewal(job.job_key, owner, connection);
                return { ...job, attempts: Number(job.attempts) + 1, owner };
            });
        },
        finishRenewal: (jobKey, owner, result) => transaction(async connection => {
            const updated = await mapper.finishRenewal(jobKey, owner, result, connection);
            if (updated.affectedRows && result.state === 'confirmed') {
                await mapper.publishRenewalConfirmation(jobKey, connection);
            }
            return updated;
        }),
        listRenewals: mapper.listRenewals,
        renewalSession: async jobKey => (await mapper.renewalSession(jobKey))[0],
        retryRenewal: (jobKey, sessionRaw) => transaction(async connection => {
            const result = await mapper.retryRenewal(jobKey, connection);
            if (result.affectedRows && sessionRaw) await mapper.replaceSession(jobKey, sessionRaw, connection);
            return result;
        })
    };
}

module.exports = { createManager };
