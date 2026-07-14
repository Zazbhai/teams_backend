const mongoose = require('mongoose');

const automationLogSchema = new mongoose.Schema({
  schedule_id: { type: mongoose.Schema.Types.Mixed }, // Can be ObjectId or string (for manual/test runs)
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  user_name: { type: String },
  meeting_name: { type: String },
  url: { type: String },
  status: { type: String, default: 'running' },
  started_at: { type: String },
  ended_at: { type: String },
  pid: { type: Number },
  joined_date: { type: String } // Stores YYYY-MM-DD
}, { timestamps: true });

// Add index on user_id for faster fetch
automationLogSchema.index({ user_id: 1 });

module.exports = mongoose.model('AutomationLog', automationLogSchema);
