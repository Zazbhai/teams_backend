const express = require('express');
const router = express.Router();
const User = require('../models/User');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const AutomationLog = require('../models/AutomationLog');
const Schedule = require('../models/Schedule');

module.exports = function(authenticateToken, io) {
    function getTodayIST() {
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(now.getTime() + istOffset);
        return istDate.toISOString().slice(0, 10);
    }

    // Admin Routes
    router.get('/stats', authenticateToken, async (req, res) => {
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
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.get('/users/recent', authenticateToken, async (req, res) => {
        try {
            const users = await User.find().sort({ _id: -1 }).limit(5).select('name email has_subscription subscription_end_date role can_edit_template daily_meeting_limit');
            res.json(users);
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.get('/users', authenticateToken, async (req, res) => {
        try {
            const users = await User.find().select('name email has_subscription subscription_end_date role can_edit_template daily_meeting_limit');
            res.json(users);
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.get('/users/stats', authenticateToken, async (req, res) => {
        try {
            const todayIST = getTodayIST();
            const users = await User.find().sort({ _id: -1 }).lean();
            const result = [];
            for (const u of users) {
                const total = await AutomationLog.countDocuments({ user_id: u._id });
                const success = await AutomationLog.countDocuments({ user_id: u._id, status: 'completed' });
                const failed = await AutomationLog.countDocuments({ user_id: u._id, status: 'failed' });
                const today = await AutomationLog.countDocuments({ user_id: u._id, joined_date: todayIST });
                
                result.push({
                    id: u._id, name: u.name, email: u.email, has_subscription: u.has_subscription,
                    subscription_end_date: u.subscription_end_date, role: u.role, can_edit_template: u.can_edit_template,
                    daily_meeting_limit: u.daily_meeting_limit,
                    total_meetings: total, successful_meetings: success, failed_meetings: failed, today_meetings: today
                });
            }
            res.json(result);
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/users/:id/role', authenticateToken, async (req, res) => {
        try {
            const user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ detail: "Not found" });
            user.role = req.body.role;
            user.is_admin = req.body.role === 'admin' ? 1 : 0;
            await user.save();
            res.json({ message: "Role updated" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/users/:id/subscription', authenticateToken, async (req, res) => {
        try {
            const user = await User.findById(req.params.id);
            if (!user) return res.status(404).json({ detail: "Not found" });
            user.has_subscription = req.body.has_subscription ? 1 : 0;
            if (req.body.has_subscription) {
                const endDate = new Date();
                endDate.setDate(endDate.getDate() + 30);
                user.subscription_end_date = endDate.toISOString();
            } else {
                user.subscription_end_date = null;
            }
            await user.save();
            res.json({ message: "Subscription updated" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.delete('/users/:id', authenticateToken, async (req, res) => {
        try {
            await User.findByIdAndDelete(req.params.id);
            await Schedule.deleteMany({ user_id: req.params.id });
            await AutomationLog.deleteMany({ user_id: req.params.id });
            res.json({ message: "Deleted" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.get('/api/subscriptions', async (req, res) => {
        try {
            const plans = await SubscriptionPlan.find().lean();
            for (let p of plans) {
                const now = new Date().toISOString();
                p.active_users = await User.countDocuments({ 
                    plan_id: p._id.toString(), 
                    has_subscription: 1,
                    $or: [
                        { subscription_end_date: null },
                        { subscription_end_date: { $gt: now } }
                    ]
                });
                p.id = p._id;
            }
            res.json({ plans });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.post('/api/subscriptions', async (req, res) => {
        try {
            const { name, price, description, duration_days } = req.body;
            const duration = duration_days ? parseInt(duration_days) : 30;
            const plan = await SubscriptionPlan.create({ name, price, description, duration_days: duration });
            res.json({ status: "success", id: plan._id });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/api/subscriptions/:id', async (req, res) => {
        try {
            const { name, price, description, duration_days } = req.body;
            const duration = duration_days ? parseInt(duration_days) : 30;
            await SubscriptionPlan.findByIdAndUpdate(req.params.id, { name, price, description, duration_days: duration });
            res.json({ status: "success" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.delete('/api/subscriptions/:id', async (req, res) => {
        try {
            await SubscriptionPlan.findByIdAndDelete(req.params.id);
            res.json({ status: "success" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    return router;
};
