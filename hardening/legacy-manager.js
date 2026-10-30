'use strict';

// 旧存储模块仍承担数据访问；新业务通过此 manager 适配，不直接依赖旧 SQL 实现。
function createLegacyManager(store) {
    return {
        getMaintenanceModeState: (...args) => store.getMaintenanceModeState(...args),
        getActivationAttemptLimit: (...args) => store.getActivationAttemptLimit(...args),
        verifyCdkDetails: (...args) => store.verifyCdkDetails(...args),
        getRunningTaskByCdk: (...args) => store.getRunningTaskByCdk(...args),
        getGptApiConfig: (...args) => store.getGptApiConfig(...args),
        hasAvailableCard: (...args) => store.hasAvailableCard(...args)
    };
}

module.exports = { createLegacyManager };
