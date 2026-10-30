'use strict';

function createController(service) {
    return {
        async listRenewals(req, res) {
            try { res.json({ success: true, jobs: await service.listRenewals() }); }
            catch (_) { res.status(503).json({ success: false, message: '暂时无法读取续费补偿任务' }); }
        },
        async retryRenewal(req, res) {
            const jobKey = String(req.params.jobKey || '').trim();
            if (!jobKey || jobKey.length > 64) return res.status(400).json({ success: false, message: '任务号无效' });
            try {
                const sessionRaw = String(req.body?.session || '').trim();
                const result = await service.retryRenewal(jobKey, sessionRaw || undefined);
                res.status(result.success ? 200 : 409).json(result);
            }
            catch (_) { res.status(503).json({ success: false, message: '暂时无法保存续费补偿任务' }); }
        }
    };
}

module.exports = { createController };

module.exports.createActivationController = (service, getClientIp) => async (req, res) => {
    const result = await service.activate(req.body || {}, getClientIp(req));
    return res.status(result.statusCode).json(result.body);
};
