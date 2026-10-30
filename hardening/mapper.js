'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createMapper(pool) {
    async function query(sql, params = [], connection = pool) {
        const [rows] = await connection.query(sql, params);
        return rows;
    }
    return {
        query,
        initialize: () => query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')),
        lockAdmission: connection => query(
            "SELECT config_value FROM app_config WHERE config_key = 'max_concurrent_activations' FOR UPDATE", [], connection
        ),
        cleanupSuccessfulClaims: connection => query(
            "DELETE a FROM activation_claims a JOIN task_logs t ON t.job_key = a.job_key WHERE t.status = 'success'", [], connection
        ),
        findClaim: (account, cdk, connection) => query(
            'SELECT * FROM activation_claims WHERE account_key = ? OR cdk_code = ? FOR UPDATE',
            [account, cdk], connection
        ),
        countClaims: connection => query(
            'SELECT COUNT(*) AS total FROM activation_claims WHERE lease_until > NOW()', [], connection
        ),
        lockCdk: (cdk, connection) => query('SELECT * FROM cdk_codes WHERE cdk_code = ? FOR UPDATE', [cdk], connection),
        createClaim: (data, connection) => query(
            'INSERT INTO activation_claims (job_key, account_key, cdk_code, lease_until) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 120 SECOND))',
            [data.jobKey, data.accountKey, data.cdk], connection
        ),
        createTask: (data, connection) => query(
            `INSERT INTO task_logs (job_key, token_preview, session_payload, cdk_code, status, progress, message, display_time)
             VALUES (?, ?, ?, ?, 'running', 3, '正在开通中', ?)`,
            [data.jobKey, data.email, data.sessionRaw, data.cdk, data.displayTime], connection
        ),
        useCdk: (cdk, connection) => query(
            'UPDATE cdk_codes SET used_at = CURRENT_TIMESTAMP WHERE cdk_code = ? AND used_at IS NULL AND is_active = 1',
            [cdk], connection
        ),
        heartbeat: keys => keys.length ? query(
            'UPDATE activation_claims SET lease_until = DATE_ADD(NOW(), INTERVAL 120 SECOND) WHERE job_key IN (?)', [keys]
        ) : undefined,
        release: jobKey => query('DELETE FROM activation_claims WHERE job_key = ?', [jobKey]),
        abortUnstarted: (jobKey, cdk, connection) => query(
            `UPDATE cdk_codes c JOIN activation_claims a ON a.cdk_code = c.cdk_code
             SET c.used_at = NULL WHERE a.job_key = ? AND c.cdk_code = ?`, [jobKey, cdk], connection
        ),
        failUnstarted: (jobKey, connection) => query(
            "UPDATE task_logs SET status = 'failed', message = '任务未能启动' WHERE job_key = ? AND status = 'running'",
            [jobKey], connection
        ),
        deleteClaim: (jobKey, connection) => query('DELETE FROM activation_claims WHERE job_key = ?', [jobKey], connection),
        getReceipt: (jobKey, connection, lock = false) => query(
            `SELECT * FROM payment_receipts WHERE job_key = ?${lock ? ' FOR UPDATE' : ''}`, [jobKey], connection
        ),
        insertReceipt: (data, connection) => query(
            'INSERT IGNORE INTO payment_receipts (job_key, payload, paid_at) VALUES (?, ?, ?)',
            [data.jobKey, JSON.stringify(data), new Date(data.paidAt)], connection
        ),
        finishReceipt: (jobKey, connection) => query(
            'UPDATE payment_receipts SET recorded_at = NOW() WHERE job_key = ?', [jobKey], connection
        ),
        // 父进程退出或终态写库失败后，支付凭证仍是事实依据；批量恢复而不再调用支付。
        recoverPaidTasks: () => query(
            `UPDATE task_logs t JOIN payment_receipts p ON p.job_key = t.job_key
             LEFT JOIN activation_claims a ON a.job_key = t.job_key
             LEFT JOIN renewal_jobs r ON r.job_key = t.job_key
             SET t.status = 'success', t.progress = 100,
                 t.message = IF(r.state = 'confirmed', '充值成功；自动续费已关闭', '充值成功；自动续费待后台处理')
             WHERE p.recorded_at IS NOT NULL AND t.status <> 'success'
               AND (a.job_key IS NULL OR a.lease_until < NOW())`
        ),
        saveCardPayment: (data, connection) => {
            if (data.source === 'third-party') {
                return query(
                    `UPDATE card_assets SET usage_count = usage_count + 1, last_used_at = NOW(),
                     daily_usage_count = IF(daily_usage_reset_at IS NULL OR daily_usage_reset_at < DATE_SUB(NOW(), INTERVAL 24 HOUR), 1, daily_usage_count + 1),
                     daily_usage_reset_at = IF(daily_usage_reset_at IS NULL OR daily_usage_reset_at < DATE_SUB(NOW(), INTERVAL 24 HOUR), NOW(), daily_usage_reset_at),
                     cooldown_until = IF(daily_usage_count >= 3, DATE_ADD(NOW(), INTERVAL 24 HOUR), cooldown_until),
                     in_use = IF(locked_by = ?, 0, in_use), locked_at = IF(locked_by = ?, NULL, locked_at),
                     locked_by = IF(locked_by = ?, NULL, locked_by) WHERE id = ?`,
                    [data.ownerKey, data.ownerKey, data.ownerKey, data.cardId], connection
                );
            }
            const address = data.address || {};
            return query(
                `UPDATE card_assets SET payment_holder_name = ?, payment_address_line1 = ?,
                 payment_address_city = ?, payment_address_state = ?, payment_address_postal = ?, payment_address_id = ?,
                 usage_count = usage_count + 1, last_used_at = NOW(),
                 daily_usage_count = IF(daily_usage_reset_at IS NULL OR daily_usage_reset_at < DATE_SUB(NOW(), INTERVAL 24 HOUR), 1, daily_usage_count + 1),
                 daily_usage_reset_at = IF(daily_usage_reset_at IS NULL OR daily_usage_reset_at < DATE_SUB(NOW(), INTERVAL 24 HOUR), NOW(), daily_usage_reset_at),
                 cooldown_until = IF(daily_usage_count >= 3, DATE_ADD(NOW(), INTERVAL 24 HOUR), cooldown_until),
                 in_use = IF(locked_by = ? OR locked_by IS NULL, 0, in_use),
                 locked_at = IF(locked_by = ? OR locked_by IS NULL, NULL, locked_at),
                 locked_by = IF(locked_by = ? OR locked_by IS NULL, NULL, locked_by) WHERE id = ?`,
                [data.holderName || '', address.line1 || '', address.city || '', address.state || '',
                    address.postal_code || '', address.id || null,
                    data.ownerKey || '', data.ownerKey || '', data.ownerKey || '', data.cardId], connection
            );
        },
        bindAddress: (data, connection) => data.source !== 'third-party' && data.address?.id ? query(
            'UPDATE tax_free_addresses SET is_bound = 1, bound_card_id = ?, bound_at = NOW() WHERE id = ?',
            [data.cardId, data.address.id], connection
        ) : undefined,
        // 上游代充未返回可核实的扣款金额，不能伪造一笔 0 元 Stripe 账单。
        insertBilling: (data, connection) => data.source === 'third-party' ? undefined : query(
            `INSERT INTO billing_records (payment_time, card_last4, amount, currency, plan_type, stripe_session_id, cdk_code, email, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success')`,
            [new Date(data.paidAt), data.cardLast4, data.amount || 0, data.currency || 'USD', data.planType || 'plus',
                data.stripeSessionId || null, data.cdk || null, data.email || null], connection
        ),
        enqueueRenewal: (jobKey, connection) => query(
            'INSERT IGNORE INTO renewal_jobs (job_key) VALUES (?)', [jobKey], connection
        ),
        dueRenewal: (connection, jobKey) => query(
            `SELECT r.*, t.session_payload, t.token_preview FROM renewal_jobs r JOIN task_logs t ON t.job_key = r.job_key
             WHERE r.state IN ('pending', 'retry', 'running') AND r.next_attempt_at <= NOW()
             AND (r.lease_until IS NULL OR r.lease_until < NOW()) ${jobKey ? 'AND r.job_key = ?' : ''}
             ORDER BY r.next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
            jobKey ? [jobKey] : [], connection
        ),
        claimRenewal: (jobKey, owner, connection) => query(
            `UPDATE renewal_jobs SET state = 'running', attempts = attempts + 1, lease_owner = ?,
             lease_until = DATE_ADD(NOW(), INTERVAL 10 MINUTE) WHERE job_key = ?`, [owner, jobKey], connection
        ),
        finishRenewal: (jobKey, owner, result, connection) => query(
            `UPDATE renewal_jobs SET state = ?, last_message = ?, lease_owner = NULL, lease_until = NULL,
             confirmed_at = IF(? = 'confirmed', NOW(), confirmed_at), next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
             WHERE job_key = ? AND lease_owner = ?`,
            [result.state, result.message, result.state, result.delay ?? 300, jobKey, owner], connection
        ),
        publishRenewalConfirmation: (jobKey, connection) => query(
            `UPDATE task_logs SET message = CONCAT(SUBSTRING_INDEX(COALESCE(message, '充值成功'), '；', 1), '；自动续费已关闭')
             WHERE job_key = ? AND status = 'success'`, [jobKey], connection
        ),
        listRenewals: () => query(
            'SELECT job_key, state, attempts, last_message, next_attempt_at, confirmed_at FROM renewal_jobs ORDER BY updated_at DESC LIMIT 100'
        ),
        renewalSession: jobKey => query(
            'SELECT t.session_payload FROM renewal_jobs r JOIN task_logs t ON t.job_key = r.job_key WHERE r.job_key = ?',
            [jobKey]
        ),
        replaceSession: (jobKey, sessionRaw, connection) => query(
            'UPDATE task_logs SET session_payload = ? WHERE job_key = ?', [sessionRaw, jobKey], connection
        ),
        retryRenewal: (jobKey, connection) => query(
            `UPDATE renewal_jobs SET state = 'pending', attempts = 0, next_attempt_at = NOW()
             WHERE job_key = ? AND state IN ('manual', 'retry') AND (lease_until IS NULL OR lease_until < NOW())`,
            [jobKey], connection
        )
    };
}

module.exports = { createMapper };
