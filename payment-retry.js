'use strict';

/**
 * Payment Retry with Card Rotation Module
 *
 * 支付逻辑：
 * 1. 获取当前地区和账单配置
 * 2. 选取免税地址
 * 3. 从卡池预留卡片，拒付时自动换卡（最多 PAYMENT_MAX_CARD_ATTEMPTS 次）
 * 4. 成功 → 绑定地址/姓名到卡片、标记地址已绑定
 */

const store = require('./mysql-store');
const { completeStripeCardPayment, readCheckoutDueAmount, estimateTaxFreeAmount } = require('./stripe-payment');
const { pickBillingAddressForCheckout } = require('./tax-free-address');
const { getRegionConfig } = require('./region-config');
const { getHardeningService } = require('./hardening/factory');
const crypto = require('node:crypto');

const MAX_CARD_ATTEMPTS = Number(process.env.PAYMENT_MAX_CARD_ATTEMPTS) || 3;
const MAX_AUTOMATION_ATTEMPTS = MAX_CARD_ATTEMPTS;

function isPaymentDeclined(errorMsg) {
    if (!errorMsg) return false;
    const declinedKeywords = [
        'declined', 'card_declined', 'insufficient_funds',
        'expired_card', 'incorrect_cvc', 'processing_error',
        'lost_card', 'stolen_card', 'do_not_honor',
        '拒绝', '被拒', 'your card was declined',
        'payment was not successful', 'payment was not approved',
        'not approved'
    ];
    const lower = errorMsg.toLowerCase();
    return declinedKeywords.some((kw) => lower.includes(kw));
}

/**
 * 解析应写入账单的实际扣款金额（优先免税后应付）
 */
async function resolveBilledAmountForRecord(page, paymentResult, preTaxAmount, currency) {
    if (paymentResult?.dueAmount > 0) {
        return {
            amount: paymentResult.dueAmount,
            currency: paymentResult.dueCurrency || currency,
        };
    }
    try {
        const due = await readCheckoutDueAmount(page);
        if (due?.amount > 0) {
            return { amount: due.amount, currency: due.currency || currency };
        }
    } catch (_) { /* ignore */ }
    if (preTaxAmount > 0) {
        const estimated = estimateTaxFreeAmount(preTaxAmount);
        if (estimated && estimated < preTaxAmount * 0.98) {
            return { amount: estimated, currency };
        }
    }
    return { amount: preTaxAmount, currency };
}

/**
 * 执行支付；拒付时在同一会话内换卡重试
 * @param {import('playwright').Page} page - Playwright Page 实例
 * @param {object} options - 支付选项
 * @returns {Promise<{ success: boolean, error?: string, cardLast4?: string, manualIntervention?: boolean, screenshots?: string[] }>}
 */
async function executePaymentWithRetry(page, options) {
    const { planType, cdkCode, email, onProgress, stripeSessionId } = options || {};
    const safety = getHardeningService();
    const jobKey = process.env.JOB_KEY || stripeSessionId ||
        (cdkCode ? `payment-${crypto.createHash('sha256').update(cdkCode).digest('hex').slice(0, 48)}` : crypto.randomUUID());
    const existingPayment = await safety.getPayment(jobKey);
    if (existingPayment) {
        console.log('PAYMENT_SUCCESS');
        return { success: true, paymentConfirmed: true, cardLast4: existingPayment.cardLast4, screenshots: [] };
    }

    const progress = (msg) => {
        console.log(`[PaymentRetry] ${msg}`);
        if (typeof onProgress === 'function') {
            try { onProgress(msg); } catch (_) { /* ignore callback errors */ }
        }
    };

    const regionOverride = String(process.env.PAYMENT_REGION_OVERRIDE || '').trim().toUpperCase();
    const region = regionOverride || await store.getPaymentRegion();
    const regionConfig = getRegionConfig(region);
    if (!regionConfig) {
        return { success: false, error: '不支持的支付地区配置' };
    }
    const { currency } = regionConfig;
    progress(`支付地区: ${region}, 币种: ${currency}`);

    const lastUsedIdRaw = await store.getAppConfigValue('last_used_address_id', null);
    const lastUsedId = lastUsedIdRaw ? Number(lastUsedIdRaw) : null;

    const address = await pickBillingAddressForCheckout(lastUsedId);
    const addressSource = address.generated ? '随机生成' : `地址池 #${address.id}`;
    progress(`已选取美国免税账单地址 (${addressSource}): ${address.line1}, ${address.city}, ${address.state}`);

    const ownerKey = process.env.JOB_KEY ? `payment_${process.env.JOB_KEY}` : cdkCode
        ? `payment_${cdkCode}_${Date.now()}`
        : `payment_debug_${Date.now()}`;

    const screenshots = [];
    const declinedLast4s = [];
    let lastError = '';
    let lastCardLast4 = '';
    let billingHolderName = '';

    let billedAmount = 0;
    let billedCurrency = currency;
    try {
        const due = await readCheckoutDueAmount(page);
        if (due?.amount) {
            billedAmount = due.amount;
            if (due.currency) billedCurrency = due.currency;
            progress(`Checkout 应付金额: ${billedCurrency} ${billedAmount}`);
        }
    } catch (_) { /* ignore */ }

    progress(`开始支付（最多尝试 ${MAX_CARD_ATTEMPTS} 张卡）...`);

    for (let cardAttempt = 1; cardAttempt <= MAX_CARD_ATTEMPTS; cardAttempt += 1) {
        const card = await store.reserveCard(ownerKey);
        if (!card) {
            progress(cardAttempt === 1 ? '卡池无可用卡，终止支付' : `卡池已无更多可用卡（已拒 ${declinedLast4s.length} 张）`);
            if (cardAttempt === 1) {
                await store.createBillingRecord({
                    card_last4: '----',
                    amount: billedAmount,
                    currency: billedCurrency,
                    plan_type: planType || 'plus',
                    cdk_code: cdkCode,
                    email,
                    stripe_session_id: stripeSessionId || null,
                    status: 'failed',
                    error_code: 'card_pool_exhausted',
                    error_message: '卡池资产枯竭'
                });
                return { success: false, error: '卡池资产枯竭' };
            }
            break;
        }

        const cardInfo = {
            number: card.card_number,
            expiry: card.card_expiry,
            cvc: card.card_cvc,
            holder: card.card_holder
        };
        const cardLast4 = String(card.card_number || '').slice(-4);
        lastCardLast4 = cardLast4;
        progress(`已预留卡片 #${cardAttempt}: ...${cardLast4}`);

        let cardHandled = false;

        try {
            const paymentResult = await completeStripeCardPayment(page, cardInfo, address, {
                cardAttempt,
                holderName: billingHolderName
            });

            if (paymentResult.holderName) {
                billingHolderName = paymentResult.holderName;
            }

            if (paymentResult.success) {
                // 支付事实必须先通知父进程。之后任何本地写库/截图异常，都不能被解释为未扣款。
                cardHandled = true;
                try {
                    if (typeof process.send === 'function') process.send({ type: 'payment-confirmed', jobKey }, () => {});
                } catch (_) { /* 父进程断开时仍保留成功结果，并通过本地 outbox 记账。 */ }
                console.log('PAYMENT_SUCCESS');
                let bookkeepingPending = false;
                const holderName = paymentResult.holderName || card.card_holder || billingHolderName || '';
                try {
                    // 页面可能已跳转或关闭；金额补读失败不能阻止保存已有的支付事实。
                    try {
                        const resolved = await resolveBilledAmountForRecord(
                            page,
                            paymentResult,
                            billedAmount,
                            billedCurrency
                        );
                        billedAmount = resolved.amount;
                        billedCurrency = resolved.currency;
                    } catch (_) {
                        progress('扣款金额补读失败，先保存已确认的支付结果供后台核实');
                    }
                    progress(`实际扣款金额（免税后）: ${billedCurrency} ${billedAmount}`);

                    const record = await safety.recordPayment({
                        jobKey, cardId: card.id, cardLast4, holderName, address, ownerKey,
                        paidAt: new Date().toISOString(),
                        amount: billedAmount,
                        currency: billedCurrency,
                        planType: planType || 'plus',
                        cdk: cdkCode,
                        email,
                        stripeSessionId: stripeSessionId || null
                    });
                    bookkeepingPending = !record.recorded;
                } catch (_) {
                    bookkeepingPending = true;
                    progress('支付已确认，记账暂未完成，请管理员核实；禁止重新支付');
                }
                progress(`支付成功！卡片: ...${cardLast4}，姓名: ${holderName}，地址: ${address.line1}, ${address.city}`);
                if (paymentResult.screenshot) {
                    screenshots.push(paymentResult.screenshot);
                    progress(`SUCCESS_SCREENSHOT: ${paymentResult.screenshot}`);
                }
                return { success: true, paymentConfirmed: true, bookkeepingPending, cardLast4, holderName, screenshots };
            }

            lastError = paymentResult.error || '支付失败';
            if (paymentResult.screenshot) {
                screenshots.push(paymentResult.screenshot);
                progress(`FAILURE_SCREENSHOT: ${paymentResult.screenshot}`);
            }

            const declined = paymentResult.declined || isPaymentDeclined(lastError);
            if (declined) {
                await store.createBillingRecord({
                    card_number: card.card_number,
                    card_last4: cardLast4,
                    amount: billedAmount,
                    currency: billedCurrency,
                    plan_type: planType || 'plus',
                    cdk_code: cdkCode,
                    email,
                    stripe_session_id: stripeSessionId || null,
                    status: 'failed',
                    error_code: 'card_declined',
                    error_message: lastError
                });
                progress(`Stripe 拒绝支付，标记卡片已报废 (ID: ${card.id}, ...${cardLast4})`);
                await store.markCardExhausted(card.id);
                cardHandled = true;
                declinedLast4s.push(cardLast4);

                if (cardAttempt < MAX_CARD_ATTEMPTS && paymentResult.canRetryCard !== false) {
                    progress(`卡 ...${cardLast4} 被拒，换上下一张卡 (${cardAttempt}/${MAX_CARD_ATTEMPTS})`);
                    continue;
                }

                const summary = declinedLast4s.length > 1
                    ? `${declinedLast4s.length} 张卡均被拒 (...${declinedLast4s.join(', ...')})`
                    : `银行卡被拒绝: ${lastError}`;
                return {
                    success: false,
                    error: summary,
                    cardLast4: lastCardLast4,
                    manualIntervention: true,
                    screenshots,
                    cardsDeclined: declinedLast4s.length
                };
            }

            if (paymentResult.captchaRequired) {
                progress('检测到 Cloudflare/hCaptcha 人机验证，自动化无法可靠通过');
            }

            await store.createBillingRecord({
                card_number: card.card_number,
                card_last4: cardLast4,
                amount: billedAmount,
                currency: billedCurrency,
                plan_type: planType || 'plus',
                cdk_code: cdkCode,
                email,
                stripe_session_id: stripeSessionId || null,
                status: 'failed',
                error_code: 'form_validation_failed',
                error_message: lastError
            });

            progress('支付自动化失败，需人工操作');
            return {
                success: false,
                error: `需要人工操作：${lastError}`,
                cardLast4,
                manualIntervention: true,
                screenshots
            };
        } finally {
            if (card?.id && !cardHandled) {
                await store.releaseCard(card.id, ownerKey).catch(() => { });
            }
        }
    }

    const summary = declinedLast4s.length
        ? `${declinedLast4s.length} 张卡均被拒 (...${declinedLast4s.join(', ...')})`
        : (lastError || '支付失败');
    return {
        success: false,
        error: summary,
        cardLast4: lastCardLast4,
        manualIntervention: true,
        screenshots,
        cardsDeclined: declinedLast4s.length
    };
}

module.exports = {
    executePaymentWithRetry,
    isPaymentDeclined,
    MAX_AUTOMATION_ATTEMPTS,
    MAX_CARD_ATTEMPTS
};
