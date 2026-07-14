const express = require('express');
const router = express.Router();
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const AutomationLog = require('../models/AutomationLog');

module.exports = function(authenticateToken, io) {

    // Helper: applyTemplateForAllDays logic can be added here if needed

    // GET /schedules
    router.get('/schedules', authenticateToken, async (req, res) => {
        try {
            const schedules = await Schedule.find({ user_id: req.user.id }).lean();
            res.json(schedules.map(s => ({ ...s, id: s._id })));
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // GET /schedules/all
    router.get('/schedules/all', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            const schedules = await Schedule.find().lean();
            res.json(schedules.map(s => ({ ...s, id: s._id })));
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // POST /schedules
    router.post('/schedules', authenticateToken, async (req, res) => {
        try {
            const { team_name, meeting_name, url, start_time, end_time, day } = req.body;
            const u = await User.findById(req.user.id);
            if (!u) return res.status(404).json({ detail: "User not found" });

            if (u.has_subscription === 0) {
                const count = await Schedule.countDocuments({ user_id: u._id });
                if (count >= 5) return res.status(403).json({ detail: "Free users can only schedule up to 5 meetings." });
            }

            const schedule = await Schedule.create({
                team_name, meeting_name, url, start_time, end_time, day, user_id: u._id, user_name: u.name || req.user.name
            });
            res.json({ ...schedule.toObject(), id: schedule._id });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // POST /schedules/bulk
    router.post('/schedules/bulk', authenticateToken, async (req, res) => {
        try {
            const { schedules } = req.body;
            const u = await User.findById(req.user.id);
            if (!u) return res.status(404).json({ detail: "User not found" });

            if (u.has_subscription === 0) {
                const count = await Schedule.countDocuments({ user_id: u._id });
                if (count + schedules.length > 5) {
                    return res.status(403).json({ detail: "Free users can only schedule up to 5 meetings." });
                }
            }

            for (const s of schedules) {
                // Delete existing for same meeting/day
                await Schedule.deleteMany({ user_id: u._id, meeting_name: s.meeting_name, day: s.day });
                await Schedule.create({
                    team_name: s.team_name, meeting_name: s.meeting_name, url: s.url,
                    start_time: s.start_time, end_time: s.end_time, day: s.day,
                    user_id: u._id, user_name: u.name || req.user.name
                });
            }
            res.json({ message: "Schedules created successfully" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // PUT /schedules/:id
    router.put('/schedules/:id', authenticateToken, async (req, res) => {
        try {
            const { team_name, meeting_name, url, start_time, end_time, day } = req.body;
            await Schedule.findByIdAndUpdate(req.params.id, { team_name, meeting_name, url, start_time, end_time, day });
            res.json({ message: "Schedule updated successfully" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // DELETE /schedules/:id
    router.delete('/schedules/:id', authenticateToken, async (req, res) => {
        try {
            await Schedule.findByIdAndDelete(req.params.id);
            res.json({ message: "Schedule deleted successfully" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // GET /automation-logs
    router.get('/automation-logs', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            const logs = await AutomationLog.find().sort({ _id: -1 }).limit(100).lean();
            res.json(logs.map(l => ({ ...l, id: l._id })));
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // GET /automation-logs/:scheduleId
    router.get('/automation-logs/:scheduleId', authenticateToken, async (req, res) => {
        try {
            const logs = await AutomationLog.find({ schedule_id: req.params.scheduleId }).sort({ _id: -1 }).lean();
            res.json(logs.map(l => ({ ...l, id: l._id })));
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // GET /automation-logs/user/:userId
    router.get('/automation-logs/user/:userId', authenticateToken, async (req, res) => {
        try {
            const logs = await AutomationLog.find({ user_id: req.params.userId }).sort({ _id: -1 }).limit(50).lean();
            res.json(logs.map(l => ({ ...l, id: l._id })));
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // DELETE /automation-logs (Clear all)
    router.delete('/automation-logs', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            await AutomationLog.deleteMany({});
            res.json({ message: "All logs cleared" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    return router;
};
