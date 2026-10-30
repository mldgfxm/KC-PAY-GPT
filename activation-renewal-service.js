'use strict';

const subscription = require('./subscription-check');

const SYNC_DELAYS_MS = [2000, 5000];

function renewalResult(successMessage, confirmed, detail) {
    const message = `${successMessage}；${detail}`;
    return { confirmed, message, logMessage: `[自动续费] ${message}` };
}

function manualActionResult(successMessage, result) {
    let detail = '自动关闭续费失败，请在续费管理中手动处理';
    if (result?.statusCode === 401) {
        detail = 'Session 已失效，自动续费未确认关闭，请更新 Session 后在续费管理中处理';
    } else if (result?.code === 'unsupported_subscription_channel') {
        detail = '请在 App Store / Google Play 中关闭自动续费';
    } else if (result?.code === 'subscription_not_active') {
        detail = '订阅状态尚未同步，自动续费未确认关闭，请稍后在续费管理中处理';
    }
    const reason = result?.statusCode === 401 ? 'session_invalid'
        : result?.code === 'unsupported_subscription_channel' ? 'unsupported_channel' : 'retryable';
    return { ...renewalResult(successMessage, false, detail), reason };
}

function pendingResult(successMessage) {
    return renewalResult(
        successMessage,
        false,
        '已提交关闭自动续费请求，尚未确认，请稍后在续费管理中核实'
    );
}

/**
 * 充值成功后的独立收尾步骤，不负责支付、数据库写入或任务状态变更。
 * 新订阅只做有限的同步等待；取消失败不能让调用方重新充值或回滚已使用的 CDK。
 */
async function closeAutoRenewAfterRecharge(
    { accessToken, email, successMessage = '充值成功' },
    {
        cancelRenewal = subscription.cancelAutoRenew,
        querySubscription = subscription.querySubscriptionBySession,
        wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    } = {}
) {
    const token = String(accessToken || '').trim();
    if (!token) {
        return manualActionResult(successMessage, { statusCode: 401 });
    }

    let cancellationSubmitted = false;
    try {
        let result;
        for (let attempt = 0; attempt <= SYNC_DELAYS_MS.length; attempt += 1) {
            result = await cancelRenewal(token, { email });
            if (result?.ok || result?.code !== 'subscription_not_active') {
                break;
            }
            // 刚完成扣款时订阅查询可能暂时仍为 Free；仅在尚未发出取消请求时重试。
            if (attempt < SYNC_DELAYS_MS.length) {
                await wait(SYNC_DELAYS_MS[attempt]);
            }
        }

        if (!result?.ok) {
            return manualActionResult(successMessage, result);
        }
        if (result.data?.autoRenewRaw === false) {
            return renewalResult(successMessage, true, '自动续费已关闭');
        }

        // 取消接口接受请求不等于已关闭。后续只复查状态，避免重复提交取消请求。
        if (result.data?.cancelled) {
            cancellationSubmitted = true;
            for (const delayMs of SYNC_DELAYS_MS) {
                await wait(delayMs);
                const verification = await querySubscription(token, { email });
                if (verification?.ok && verification.data?.autoRenewRaw === false) {
                    return renewalResult(successMessage, true, '自动续费已关闭');
                }
                if (verification?.statusCode === 401 || verification?.statusCode === 403) {
                    break;
                }
            }
            return pendingResult(successMessage);
        }
        return manualActionResult(successMessage);
    } catch (_) {
        // 不向任务日志透传网络异常，防止错误对象携带 Token、请求头或代理凭据。
        return cancellationSubmitted ? pendingResult(successMessage) : manualActionResult(successMessage);
    }
}

module.exports = { closeAutoRenewAfterRecharge };
