const express = require('express');
const router = express.Router();
const User = require('../models/User');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const AutomationLog = require('../models/AutomationLog');
const { getAuth } = require('firebase-admin/auth');

// Middleware for token auth is assumed to be passed or attached in index.js
// but we'll export a function that takes `authenticateToken`

module.exports = function(authenticateToken, io) {

    // Helper: get today in IST
    function getTodayIST() {
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(now.getTime() + istOffset);
        return istDate.toISOString().slice(0, 10);
    }

    // ----------------------------------------------------
    // API Routes (Require Auth)
    // ----------------------------------------------------
    router.get('/api/users/me', authenticateToken, async (req, res) => {
        try {
            const email = req.user.email;
            if (!email) return res.status(400).json({ detail: "No email in token" });
            
            let user = await User.findOne({ email });
            
            if (!user) {
                const name = req.user.name || "User";
                user = await User.create({ name, email, password: 'oauth', has_subscription: 0, role: 'user', firebase_uid: req.user.uid });
            }
            
            // Auto-expire subscription
            if (user.has_subscription === 1 && user.subscription_end_date) {
                const endDate = new Date(user.subscription_end_date);
                if (endDate < new Date()) {
                    user.has_subscription = 0;
                    await user.save();
                }
            }
            
            let planName = null;
            if (user.plan_id) {
                const plan = await SubscriptionPlan.findById(user.plan_id);
                if (plan) planName = plan.name;
            }
            
            res.json({
                id: user._id,
                email: user.email,
                name: user.name,
                has_subscription: user.has_subscription === 1,
                subscription_end_date: user.subscription_end_date || null,
                plan_name: planName,
                role: user.role,
                is_admin: user.is_admin,
                can_edit_template: user.can_edit_template === 1,
                auto_template_enabled: user.auto_template_enabled === 1,
                template_team_name: user.template_team_name || 'Template',
                template_meeting_name: user.template_meeting_name || 'Premade Template'
            });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.get('/users/me', authenticateToken, async (req, res) => {
        try {
            const email = req.user.email;
            if (!email) return res.status(400).json({ detail: "No email in token" });
            const user = await User.findOne({ email });
            if (!user) return res.status(404).json({ detail: "User not found" });
            res.json(user);
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/api/users/me/auto_template', authenticateToken, async (req, res) => {
        try {
            const email = req.user.email;
            if (!email) return res.status(400).json({ detail: "No email in token" });
            
            const user = await User.findOne({ email });
            if (!user) return res.status(404).json({ detail: "User not found" });
            
            user.auto_template_enabled = req.body.enabled !== undefined ? (req.body.enabled === true ? 1 : 0) : user.auto_template_enabled;
            if (req.body.template_team_name !== undefined) user.template_team_name = req.body.template_team_name;
            if (req.body.template_meeting_name !== undefined) user.template_meeting_name = req.body.template_meeting_name;
            
            await user.save();
            
            // Note: trigger_now logic (applyTemplateForAllDays) is moved to schedules controller
            // We'll return status for now
            res.json({ status: "success", enabled: user.auto_template_enabled, template_team_name: user.template_team_name, template_meeting_name: user.template_meeting_name });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // ----------------------------------------------------
    // Admin / Management Routes
    // ----------------------------------------------------
    router.get('/users', async (req, res) => {
        try {
            const users = await User.find().select('_id name email has_subscription subscription_end_date role can_edit_template daily_meeting_limit').sort({ _id: -1 }).lean();
            // Map _id to id for frontend compatibility
            res.json(users.map(u => ({ ...u, id: u._id })));
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.get('/users/stats', async (req, res) => {
        try {
            const todayIST = getTodayIST();
            
            const stats = await User.aggregate([
                {
                    $lookup: {
                        from: 'automationlogs',
                        localField: '_id',
                        foreignField: 'user_id',
                        as: 'logs'
                    }
                },
                {
                    $project: {
                        id: '$_id', name: 1, email: 1, has_subscription: 1, subscription_end_date: 1,
                        role: 1, can_edit_template: 1, daily_meeting_limit: 1,
                        total_meetings: { $size: '$logs' },
                        successful_meetings: {
                            $size: { $filter: { input: '$logs', as: 'log', cond: { $eq: ['$$log.status', 'completed'] } } }
                        },
                        failed_meetings: {
                            $size: { $filter: { input: '$logs', as: 'log', cond: { $eq: ['$$log.status', 'failed'] } } }
                        },
                        today_meetings: {
                            $size: { $filter: { input: '$logs', as: 'log', cond: { $eq: ['$$log.joined_date', todayIST] } } }
                        }
                    }
                },
                { $sort: { id: -1 } }
            ]);
            
            res.json(stats);
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/users/:id/daily_limit', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Admin access required" });
            const limit = parseInt(req.body.limit);
            if (isNaN(limit) || limit < 0) return res.status(400).json({ detail: "Invalid limit" });
            
            await User.findByIdAndUpdate(req.params.id, { daily_meeting_limit: limit });
            res.json({ message: "Limit updated" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.post('/users', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            const { name, email, password, role } = req.body;
            
            const user = await User.create({ name, email, password: password || '', has_subscription: 0, role: role || 'user' });
            res.json(user);
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/users/:id/role', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            const role = req.query?.role || req.body?.role;
            await User.findByIdAndUpdate(req.params.id, { role });
            res.json({ message: "Role updated" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/users/:id/template_edit', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            const can_edit = req.body.can_edit === true ? 1 : 0;
            await User.findByIdAndUpdate(req.params.id, { can_edit_template: can_edit });
            res.json({ message: "Template edit permission updated" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    return router;
};
