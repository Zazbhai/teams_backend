const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const User = require('../models/User');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const AutomationLog = require('../models/AutomationLog');
const Schedule = require('../models/Schedule');
const { activeProcesses, runAutomation, checkDailyQuota, cancelAutomation, takeScreenshot } = require('../services/automation');

module.exports = function(authenticateToken, io) {

    // ---- STATS ----
    router.get('/stats', async (req, res) => {
        try {
            const total_users = await User.countDocuments();
            const pro_users = await User.countDocuments({ has_subscription: 1 });
            const total_schedules = await Schedule.countDocuments();
            const mrr = pro_users * 29;
            res.json({
                total_users, pro_users, total_schedules, mrr,
                success_rate: 100.0,
                trends: { users: "+2.4%", mrr: "+0.0%", schedules: "+1.1%" }
            });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.get('/users/recent', async (req, res) => {
        try {
            const users = await User.find().sort({ _id: -1 }).limit(5)
                .select('name email has_subscription subscription_end_date role can_edit_template daily_meeting_limit').lean();
            res.json(users.map(u => ({ ...u, id: u._id })));
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    // ---- SUBSCRIPTION PLANS ----
    router.get('/api/subscriptions', async (req, res) => {
        try {
            const plans = await SubscriptionPlan.find().lean();
            for (let p of plans) {
                const now = new Date().toISOString();
                p.active_users = await User.countDocuments({
                    plan_id: p._id.toString(),
                    has_subscription: 1,
                    $or: [{ subscription_end_date: null }, { subscription_end_date: { $gt: now } }]
                });
                p.id = p._id;
            }
            res.json({ plans });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.post('/api/subscriptions', async (req, res) => {
        try {
            const { name, price, description, duration_days } = req.body;
            const duration = duration_days ? parseInt(duration_days) : 30;
            const plan = await SubscriptionPlan.create({ name, price: price || '₹0/mo', description, duration_days: duration });
            res.json({ status: "success", id: plan._id });
        } catch (e) {
            console.error('[Add Subscription Error]', e);
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/api/subscriptions/:id', async (req, res) => {
        try {
            const { name, price, description, duration_days } = req.body;
            const duration = duration_days ? parseInt(duration_days) : 30;
            await SubscriptionPlan.findByIdAndUpdate(req.params.id, { name, price, description, duration_days: duration });
            res.json({ status: "success" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.delete('/api/subscriptions/:id', async (req, res) => {
        try {
            await SubscriptionPlan.findByIdAndDelete(req.params.id);
            res.json({ status: "success" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    // ---- USER MANAGEMENT ----
    router.put('/users/:id/subscription', authenticateToken, async (req, res) => {
        try {
            const active = req.query?.active === 'true' || req.body?.active === true;
            const planId = req.body?.plan_id || null;
            let endDate = null;
            let actualPlanId = planId;

            if (active) {
                let duration = 30;
                if (planId) {
                    const plan = await SubscriptionPlan.findById(planId);
                    if (plan && plan.duration_days) duration = plan.duration_days;
                }
                const date = new Date();
                date.setDate(date.getDate() + duration);
                endDate = date.toISOString();
            } else {
                actualPlanId = null;
            }

            await User.findByIdAndUpdate(req.params.id, {
                has_subscription: active ? 1 : 0,
                subscription_end_date: endDate,
                plan_id: actualPlanId
            });
            res.json({ message: "Subscription updated", subscription_end_date: endDate, plan_id: actualPlanId });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.delete('/users/:id', authenticateToken, async (req, res) => {
        try {
            await User.findByIdAndDelete(req.params.id);
            await Schedule.deleteMany({ user_id: req.params.id });
            await AutomationLog.deleteMany({ user_id: req.params.id });
            res.json({ message: "Deleted" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.put('/users/:id/role', authenticateToken, async (req, res) => {
        try {
            const role = req.query?.role || req.body?.role;
            const u = await User.findById(req.params.id);
            if (!u) return res.status(404).json({ detail: "Not found" });
            u.role = role;
            u.is_admin = role === 'admin' ? 1 : 0;
            await u.save();
            res.json({ message: "Role updated" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.put('/users/:id/template_permission', authenticateToken, async (req, res) => {
        try {
            const can_edit = req.body.can_edit ? 1 : 0;
            await User.findByIdAndUpdate(req.params.id, { can_edit_template: can_edit });
            res.json({ message: "Template permission updated" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.put('/users/:id/details', authenticateToken, async (req, res) => {
        try {
            const { name, email, password } = req.body;
            await User.findByIdAndUpdate(req.params.id, { name, email, ...(password ? { password } : {}) });
            res.json({ message: "User details updated" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.put('/users/:id/daily_limit', authenticateToken, async (req, res) => {
        try {
            const limit = parseInt(req.body.daily_limit);
            if (isNaN(limit) || limit < 0) return res.status(400).json({ detail: "daily_limit must be a non-negative integer" });
            await User.findByIdAndUpdate(req.params.id, { daily_meeting_limit: limit });
            res.json({ message: "Daily limit updated", daily_meeting_limit: limit });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.post('/users/me/subscribe', authenticateToken, async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
            await User.findOneAndUpdate({ email: req.user.email }, { has_subscription: 1 });
            res.json({ message: "Subscription successful" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.post('/users/:id/subscribe', async (req, res) => {
        try {
            await User.findByIdAndUpdate(req.params.id, { has_subscription: 1 });
            res.json({ message: "Subscription successful" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    // ---- QUOTAS ----
    router.get('/users/me/quota', authenticateToken, async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
            const user = await User.findOne({ email: req.user.email });
            if (!user) return res.status(404).json({ detail: "User not found" });
            const quota = await checkDailyQuota(user._id);
            res.json(quota);
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    // ---- START AUTOMATION IMMEDIATELY ----
    router.post('/automations/start', authenticateToken, async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
            const user = await User.findOne({ email: req.user.email });
            if (!user) return res.status(404).json({ detail: "User not found" });

            if (user.has_subscription !== 1) {
                return res.status(403).json({ detail: "Subscription required", expired: true });
            }
            if (user.subscription_end_date && new Date(user.subscription_end_date) < new Date()) {
                return res.status(403).json({ detail: "Plan expired. Please renew.", expired: true });
            }

            const { team_name, meeting_name, url, duration } = req.body;
            if (!url) return res.status(400).json({ detail: "URL is required" });

            const quota = await checkDailyQuota(user._id);
            if (!quota.allowed) {
                return res.status(429).json({
                    detail: `Daily meeting limit reached (${quota.joins_today} joined + ${quota.active_count} active = ${quota.limit} limit). Try again tomorrow.`,
                    quota_exceeded: true, quota
                });
            }

            const userName = user.name || 'AutoPilot User';
            const mins = parseInt(duration) || 60;
            const tempId = `manual_${Date.now()}_${user._id}`;

            await runAutomation(tempId, url, mins, team_name || userName, meeting_name || 'Ad-Hoc Meeting', user._id);
            res.json({ message: "Started immediately" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.post('/automations/run-now', async (req, res) => {
        try {
            const { url, name, duration } = req.body;
            if (!url) return res.status(400).json({ error: 'url is required' });
            const displayName = name || 'Test User';
            const mins = parseInt(duration) || 5;
            const tempId = `test_${Date.now()}`;
            await runAutomation(tempId, url, mins, displayName, 'Manual Test', null);
            res.json({ message: "Started test automation" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    // ---- SCHEDULES RUN NOW ----
    router.post('/schedules/:id/run-now', async (req, res) => {
        try {
            const schedule = await Schedule.findById(req.params.id).lean();
            if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

            const [startH, startM] = schedule.start_time.split(':').map(Number);
            const [endH, endM] = schedule.end_time.split(':').map(Number);
            let duration = (endH * 60 + endM) - (startH * 60 + startM);
            if (duration <= 0) duration = 60;

            await runAutomation(schedule._id, schedule.url, duration, schedule.team_name, schedule.meeting_name, schedule.user_id);
            res.json({ message: `Started automation for "${schedule.meeting_name}" immediately` });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    // ---- AUTOMATION LOGS ----
    router.get('/automations/logs', authenticateToken, async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 50;
            const screenshotsDir = path.join(__dirname, '..', 'screenshots');
            let allScreenshots = [];
            try {
                if (fs.existsSync(screenshotsDir)) allScreenshots = fs.readdirSync(screenshotsDir);
            } catch (e) {}

            const logs = await AutomationLog.find().sort({ started_at: -1 }).limit(limit).lean();
            res.json(logs.map(l => {
                const pidStr = `_${l.pid}_`;
                const screenshots = allScreenshots.filter(f => f.includes(pidStr)).map(f => `/screenshots/${f}`);
                return { ...l, id: l._id, screenshots };
            }));
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.get('/automations/logs/my', authenticateToken, async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
            const user = await User.findOne({ email: req.user.email });
            if (!user) return res.status(404).json({ detail: "User not found" });

            const screenshotsDir = path.join(__dirname, '..', 'screenshots');
            let allScreenshots = [];
            try {
                if (fs.existsSync(screenshotsDir)) allScreenshots = fs.readdirSync(screenshotsDir);
            } catch (e) {}

            const logs = await AutomationLog.find({ user_id: user._id, status: { $ne: 'cancelled' } }).sort({ started_at: -1 }).limit(50).lean();
            res.json(logs.map(l => {
                const pidStr = `_${l.pid}_`;
                const screenshots = allScreenshots.filter(f => f.includes(pidStr)).map(f => `/screenshots/${f}`);
                return { ...l, id: l._id, screenshots };
            }));
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    // ---- ACTIVE AUTOMATIONS ----
    router.get('/automations/active', authenticateToken, async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
            const user = await User.findOne({ email: req.user.email });
            if (!user) return res.status(404).json({ detail: "User not found" });

            const result = [];
            for (const [logId, p] of Object.entries(activeProcesses)) {
                if (String(p.userId) === String(user._id)) {
                    result.push({
                        schedule_id: logId,
                        pid: p.process?.pid,
                        user_name: p.meetingName,
                        meeting_name: p.meetingName,
                        url: p.url,
                        started_at: p.startedAt,
                        current_step: p.currentStep ?? 0
                    });
                }
            }
            res.json({ count: result.length, instances: result });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.post('/automations/active/:id/leave', authenticateToken, async (req, res) => {
        const id = req.params.id;
        // Try both string key (for manual_... IDs) and any other formats
        const processInfo = activeProcesses[id];
        if (!processInfo) {
            return res.status(404).json({ error: "Process not found", active_ids: Object.keys(activeProcesses) });
        }
        
        try {
            await cancelAutomation(id);
            res.json({ message: "Leave command sent successfully" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/automations/active/:id/screenshot', authenticateToken, async (req, res) => {
        const id = req.params.id;
        const processInfo = activeProcesses[id];
        if (!processInfo) {
            return res.status(404).json({ error: "Process not found" });
        }
        
        const screenshotsDir = path.join(__dirname, '..', 'screenshots');

        try {
            const result = await takeScreenshot(id, screenshotsDir);
            if (!result) return res.status(404).json({ error: "Process not found" });

            const { filename, filepath } = result;

            // Wait up to 15 seconds for the screenshot file to be written by Python
            let attempts = 0;
            let responded = false;
            const checkInterval = setInterval(() => {
                if (responded) return;
                if (fs.existsSync(filepath)) {
                    responded = true;
                    clearInterval(checkInterval);
                    res.json({ url: `/screenshots/${filename}` });
                } else if (attempts >= 30) {
                    responded = true;
                    clearInterval(checkInterval);
                    res.status(504).json({ error: "Screenshot timeout — Selenium may be busy or not in meeting" });
                }
                attempts++;
            }, 500);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ---- SETTINGS/TEMPLATE ----
    router.get('/settings/template', async (req, res) => {
        try {
            const Setting = require('../models/Setting');
            const rows = await Setting.find({ key: { $in: ['template_url', 'template_start_day', 'template_end_day', 'template_start_time', 'template_end_time', 'whatsapp_start_time', 'whatsapp_end_time'] } });
            const settings = {
                template_url: '',
                template_start_day: 'Monday',
                template_end_day: 'Friday',
                template_start_time: '09:30',
                template_end_time: '12:40',
                whatsapp_start_time: '09:00',
                whatsapp_end_time: '18:00'
            };
            rows.forEach(r => settings[r.key] = r.value);
            res.json(settings);
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    router.post('/settings/template', authenticateToken, async (req, res) => {
        try {
            if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
            const user = await User.findOne({ email: req.user.email });
            if (!user) return res.status(404).json({ detail: "User not found" });
            if (user.can_edit_template !== 1 && user.role !== 'admin') {
                return res.status(403).json({ detail: "Forbidden" });
            }

            const Setting = require('../models/Setting');
            const { url, start_day, end_day, start_time, end_time, whatsapp_start_time, whatsapp_end_time } = req.body;

            const upsert = async (key, val) => {
                if (val !== undefined) await Setting.findOneAndUpdate({ key }, { value: val }, { upsert: true, new: true });
            };

            await upsert('template_url', url);
            await upsert('template_start_day', start_day);
            await upsert('template_end_day', end_day);
            await upsert('template_start_time', start_time);
            await upsert('template_end_time', end_time);
            await upsert('whatsapp_start_time', whatsapp_start_time);
            await upsert('whatsapp_end_time', whatsapp_end_time);

            // Apply template changes
            if (url !== undefined || start_time !== undefined || end_time !== undefined || start_day !== undefined || end_day !== undefined) {
                const { applyTemplateForAllDays } = require('../services/templateService');
                await applyTemplateForAllDays();
            }

            res.json({ message: "Template settings updated successfully" });
        } catch (e) { res.status(500).json({ detail: e.message }); }
    });

    return router;
};
