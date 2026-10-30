'use strict';

function createCardImportManager(pool, mapper) {
    return {
        async insert(cards) {
            let imported = 0;
            // 按批次提交短事务；唯一索引裁决并发去重，不依赖“先查询再插入”的时间窗口。
            for (let offset = 0; offset < cards.length; offset += 100) {
                const connection = await pool.getConnection();
                try {
                    await connection.beginTransaction();
                    imported += await mapper.insertBatch(connection, cards.slice(offset, offset + 100));
                    await connection.commit();
                } catch (error) {
                    await connection.rollback();
                    throw error;
                } finally { connection.release(); }
            }
            return imported;
        }
    };
}

module.exports = { createCardImportManager };
