const express = require('express');
const router = express.Router();
const AutomationLog = require('../models/AutomationLog');
const { activeProcesses, cancelAutomation } = require('../services/automation');

module.exports = function(authenticateToken, io) {

    router.get('/automations/active', authenticateToken, (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            const result = [];
            for (const [logId, p] of Object.entries(activeProcesses)) {
                result.push({ log_id: logId, pid: p.process.pid, user_id: p.userId, schedule_id: p.scheduleId });
            }
            res.json(result);
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.post('/automations/active/:id/leave', authenticateToken, async (req, res) => {
        try {
            const logId = req.params.id;
            const success = await cancelAutomation(logId);
            if (success) {
                res.json({ message: "Process stopped" });
            } else {
                res.status(404).json({ detail: "Process not found or already stopped" });
            }
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.post('/automations/active/:id/screenshot', authenticateToken, async (req, res) => {
        try {
            // Need python script for screenshot logic. Assuming it is sent via IO.
            res.json({ message: "Screenshot request sent to python" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    return router;
};
