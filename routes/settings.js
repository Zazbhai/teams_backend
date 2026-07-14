const express = require('express');
const router = express.Router();
const Setting = require('../models/Setting');
const SubscriptionPlan = require('../models/SubscriptionPlan');

module.exports = function(authenticateToken) {

    // ----------------------------------------------------
    // Settings API
    // ----------------------------------------------------
    router.get('/settings', async (req, res) => {
        try {
            const settings = await Setting.find({ key: { $in: ['template_url', 'template_start_day', 'template_end_day', 'template_start_time', 'template_end_time'] } });
            const result = {};
            settings.forEach(s => result[s.key] = s.value);
            res.json(result);
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/settings', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            const { key, value } = req.body;
            await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
            res.json({ message: "Settings updated" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    // ----------------------------------------------------
    // Subscription Plans API
    // ----------------------------------------------------
    router.get('/plans', async (req, res) => {
        try {
            const plans = await SubscriptionPlan.find().lean();
            res.json(plans.map(p => ({ ...p, id: p._id })));
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.post('/plans', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            const { name, price, description, duration_days } = req.body;
            const plan = await SubscriptionPlan.create({ name, price, description, duration_days: parseInt(duration_days) || 30 });
            res.json(plan);
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.put('/plans/:id', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            const { name, price, description, duration_days } = req.body;
            await SubscriptionPlan.findByIdAndUpdate(req.params.id, { name, price, description, duration_days: parseInt(duration_days) || 30 });
            res.json({ message: "Plan updated" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    router.delete('/plans/:id', authenticateToken, async (req, res) => {
        try {
            if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
            await SubscriptionPlan.findByIdAndDelete(req.params.id);
            res.json({ message: "Plan deleted" });
        } catch (e) {
            res.status(500).json({ detail: e.message });
        }
    });

    return router;
};
