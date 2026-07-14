const mongoose = require('mongoose');

const subscriptionPlanSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: String, required: true },
  description: { type: String },
  duration_days: { type: Number, required: true }
});

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
