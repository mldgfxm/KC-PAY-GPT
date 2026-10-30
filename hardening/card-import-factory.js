'use strict';
const { getPool } = require('../database/pool');
const { createCardImportMapper } = require('./card-import-mapper');
const { createCardImportManager } = require('./card-import-manager');
const { createCardImportService } = require('./card-import-service');
module.exports = createCardImportService(createCardImportManager(getPool(), createCardImportMapper()));
