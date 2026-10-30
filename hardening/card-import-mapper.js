'use strict';

function createCardImportMapper() {
    return {
        async insertBatch(connection, cards) {
            const [result] = await connection.query(
                `INSERT IGNORE INTO card_assets (card_number, card_expiry, card_cvc, card_holder, sort_order, is_active, status)
                 VALUES ?`, [cards.map(card => [card.card_number, card.card_expiry, card.card_cvc, card.card_holder, 0, 1, '正常'])]
            );
            const [warnings] = await connection.query('SHOW WARNINGS');
            // IGNORE 只用于并发重复键；字段截断等错误必须回滚，不能被当成成功导入。
            if (warnings.some(warning => Number(warning.Code) !== 1062)) throw new Error('银行卡字段不符合数据库限制');
            return Number(result.affectedRows);
        }
    };
}

module.exports = { createCardImportMapper };
