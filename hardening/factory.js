'use strict';

const path = require('node:path');
const { getPool } = require('../database/pool');
const { createMapper } = require('./mapper');
const { createManager } = require('./manager');
const { createService } = require('./service');
const { createTaskAccess } = require('./task-access');
const { closeAutoRenewAfterRecharge } = require('../activation-renewal-service');
const { extractAccessTokenFromRaw, extractProfileFromToken } = require('../session-auth');

let instance;
function getHardeningService() {
    if (!instance) {
        const pool = getPool();
        instance = createService({
            manager: createManager({ pool, mapper: createMapper(pool) }),
            access: createTaskAccess({ secret: process.env.TASK_ACCESS_SECRET }), closeRenewal: closeAutoRenewAfterRecharge,
            extractToken: extractAccessTokenFromRaw, extractProfile: extractProfileFromToken,
            dataDir: path.join(__dirname, '..', 'data')
        });
    }
    return instance;
}

module.exports = { getHardeningService };
