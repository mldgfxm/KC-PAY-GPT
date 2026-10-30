'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function createTaskAccess({ secret } = {}) {
    let signingKey = secret;
    function key() {
        if (!signingKey) {
            const file = path.join(__dirname, '..', 'data', 'task-access.secret');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
            signingKey = fs.readFileSync(file);
            if (signingKey.length !== 32) throw new Error('任务授权密钥尚未就绪');
        }
        return signingKey;
    }
    function sign(body) { return crypto.createHmac('sha256', key()).update(body).digest('base64url'); }
    return {
        issue(jobKey) {
            const body = Buffer.from(JSON.stringify({ jobKey, exp: Date.now() + 24 * 3600 * 1000 })).toString('base64url');
            return `${body}.${sign(body)}`;
        },
        verify(token, jobKey) {
            try {
                const parts = String(token || '').split('.');
                if (parts.length !== 2) return false;
                const actual = Buffer.from(parts[1]);
                const expected = Buffer.from(sign(parts[0]));
                if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
                const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
                return payload.jobKey === jobKey && Number(payload.exp) > Date.now();
            } catch (_) { return false; }
        }
    };
}

module.exports = { createTaskAccess };
