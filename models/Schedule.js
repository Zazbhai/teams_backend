const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  user_name: { type: String },
  team_name: { type: String, required: true },
  meeting_name: { type: String, required: true },
  url: { type: String },
  start_time: { type: String, required: true },
  end_time: { type: String, required: true },
  day: { type: String, required: true },
  is_active: { type: Number, default: 1 } // 1 for true, 0 for false
}, { timestamps: true });

module.exports = mongoose.model('Schedule', scheduleSchema);
