'use strict';

const { validateCard } = require('../card-validator');

function createCardImportService(manager) {
    return {
        async importCards(cards) {
            if (!Array.isArray(cards) || cards.length > 500) throw new Error('单次导入上限 500 条');
            const failures = [];
            const unique = new Map();
            for (const [index, card] of cards.entries()) {
                const validation = validateCard(card);
                if (!validation.valid || String(card.card_holder || '').length > 128) {
                    failures.push({ index, errors: validation.valid ? ['持卡人姓名过长'] : validation.errors });
                    continue;
                }
                const normalized = {
                    card_number: String(card.card_number).replace(/\s|-/g, ''),
                    card_expiry: String(card.card_expiry).trim(), card_cvc: String(card.card_cvc).trim(),
                    card_holder: String(card.card_holder || '').trim()
                };
                if (!unique.has(normalized.card_number)) unique.set(normalized.card_number, normalized);
            }
            const imported = await manager.insert([...unique.values()]);
            return { imported, skipped: cards.length - failures.length - imported, failed: failures.length, failures };
        }
    };
}

module.exports = { createCardImportService };
