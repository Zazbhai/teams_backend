const express = require('express');
const router = express.Router();
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const AutomationLog = require('../models/AutomationLog');
const { scheduleMeetingJob, activeCronJobs } = require('../services/cronScheduler');

module.exports = function(authenticateToken, io) {

    // Helper: get MongoDB user from Firebase token
    async function getUser(req) {
        return await User.findOne({ email: req.user.email });
    }

    // GET /schedules
    router.get('/schedules', authenticateToken, async (req, res) => {
        try {
            const user = await getUser(req);
            if (!user) return res.status(404).json({ detail: "User not found" });
            const schedules = await Schedule.find({ user_id: user._id }).lean();
            res.json(schedules.map(s => ({ ...s, id: s._id })));
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // GET /schedules/all (admin only)
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
            const u = await getUser(req);
            if (!u) return res.status(404).json({ detail: "User not found" });

            if (u.has_subscription !== 1) {
                return res.status(403).json({ detail: "Subscription required", expired: true });
            }
            if (u.subscription_end_date && new Date(u.subscription_end_date) < new Date()) {
                return res.status(403).json({ detail: "Plan expired. Please renew.", expired: true });
            }

            const { team_name, meeting_name, url, start_time, end_time, day } = req.body;

            const schedule = await Schedule.create({
                team_name, meeting_name, url: url || '', start_time, end_time, day,
                user_id: u._id, user_name: u.name || req.user.name || ''
            });

            // Register cron job
            scheduleMeetingJob(schedule._id, start_time, end_time, day, url || '', team_name, meeting_name, u._id);

            res.json({ ...schedule.toObject(), id: schedule._id, message: "Scheduled successfully" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // POST /schedules/bulk
    router.post('/schedules/bulk', authenticateToken, async (req, res) => {
        try {
            const { schedules } = req.body;
            const u = await getUser(req);
            if (!u) return res.status(404).json({ detail: "User not found" });

            for (const s of schedules) {
                // Delete existing for same meeting/day combo
                await Schedule.deleteMany({ user_id: u._id, meeting_name: s.meeting_name, day: s.day });
                const created = await Schedule.create({
                    team_name: s.team_name, meeting_name: s.meeting_name, url: s.url || '',
                    start_time: s.start_time, end_time: s.end_time, day: s.day,
                    user_id: u._id, user_name: u.name || req.user.name || ''
                });
                scheduleMeetingJob(created._id, s.start_time, s.end_time, s.day, s.url || '', s.team_name, s.meeting_name, u._id);
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

            // Re-register cron
            const u = await getUser(req);
            if (activeCronJobs[req.params.id]) {
                activeCronJobs[req.params.id].stop();
                delete activeCronJobs[req.params.id];
            }
            scheduleMeetingJob(req.params.id, start_time, end_time, day, url, team_name, meeting_name, u?._id);

            res.json({ message: "Schedule updated successfully" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // DELETE /schedules/:id
    router.delete('/schedules/:id', authenticateToken, async (req, res) => {
        try {
            await Schedule.findByIdAndDelete(req.params.id);
            // Stop cron job
            if (activeCronJobs[req.params.id]) {
                activeCronJobs[req.params.id].stop();
                delete activeCronJobs[req.params.id];
            }
            res.json({ message: "Schedule deleted successfully" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // GET /automation-logs (admin)
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

    // DELETE /automation-logs (clear all - admin)
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
