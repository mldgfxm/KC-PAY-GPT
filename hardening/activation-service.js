'use strict';

function createActivationService({ manager, safety, sessions, runtime, notify }) {
    function reject(statusCode, message) { return { statusCode, body: { success: false, message } }; }

    return {
        async activate(input, clientIp) {
            const raw = String(input.session || input.token || '').trim();
            const token = sessions.extractAccessTokenFromRaw(raw);
            const cdk = String(input.cdk || '').trim();
            if (!token || !cdk) return reject(400, '缺少 Session 或 CDK');
            const valid = sessions.validateAccessToken(token);
            if (!valid.valid) return reject(400, valid.message);
            let ownedJob = null;
            let workerStarted = false;
            try {
                const maintenance = await manager.getMaintenanceModeState();
                if (maintenance.enabled) return reject(503, '系统维护中，请稍后再试');
                const ipLimit = clientIp ? await manager.getActivationAttemptLimit('ip', clientIp) : null;
                if (ipLimit?.cooldown_until && new Date(ipLimit.cooldown_until) > new Date()) {
                    return reject(403, '当前 IP 处于冷却中，请稍后再试');
                }
                const details = await manager.verifyCdkDetails(cdk);
                const running = details ? await manager.getRunningTaskByCdk(cdk) : null;
                if (running) return {
                    statusCode: 200,
                    body: { success: true, jobKey: running.job_key, taskToken: safety.access.issue(running.job_key),
                        message: '该 CDK 已有运行任务，正在恢复进度' }
                };
                if (!details || details.used_at || details.type !== '自助') return reject(403, 'CDK 无效或已使用');
                const cfg = await manager.getGptApiConfig();
                const thirdParty = cfg.enabled && Boolean(cfg.api_key);
                if (!thirdParty && !await manager.hasAvailableCard()) {
                    notify('card_pool_empty', { cdk, message: '银行卡池暂无可用卡片，任务未启动' });
                    return reject(503, '银行卡池暂无可用卡片');
                }
                const json = sessions.parseSessionJson(raw);
                const sessionRaw = json ? JSON.stringify(json) : JSON.stringify({ accessToken: token });
                const claim = await safety.claimActivation({ token, cdk, sessionRaw });
                if (claim.error) return reject(claim.statusCode, claim.error);
                if (!claim.resumed) ownedJob = claim.jobKey;
                const taskToken = safety.access.issue(claim.jobKey);
                if (claim.resumed) return {
                    statusCode: 200, body: { success: true, jobKey: claim.jobKey, taskToken, message: '正在恢复任务进度' }
                };
                const task = { jobKey: claim.jobKey, tokenPreview: sessions.extractEmailFromSession(sessionRaw) };
                runtime.reserve(task.jobKey);
                const args = { task, token, cdk, planType: claim.planType || 'plus' };
                if (thirdParty) runtime.launchThirdParty({ ...args, session: JSON.parse(sessionRaw) });
                else runtime.launchLocal({ ...args, sessionRaw, cdkDetails: details, clientIp });
                workerStarted = true;
                return { statusCode: 200, body: { success: true, jobKey: task.jobKey, taskToken, message: '任务已启动' } };
            } catch (_) {
                // 只能回滚本次事务创建、且尚未交给执行器的任务，不能解锁其他请求的 CDK。
                if (ownedJob && !workerStarted) {
                    await safety.abortUnstarted(ownedJob, cdk).catch(() => {});
                    await runtime.release(ownedJob);
                }
                return reject(503, '暂时无法启动任务，请稍后重试');
            }
        }
    };
}

module.exports = { createActivationService };
