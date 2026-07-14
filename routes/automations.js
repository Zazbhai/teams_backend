// This file is intentionally minimal.
// All automation routes are handled in adminRoutes.js to share activeProcesses state.
const express = require('express');
const router = express.Router();

module.exports = function(authenticateToken, io) {
    // All /automations/* routes live in adminRoutes.js
    return router;
};
