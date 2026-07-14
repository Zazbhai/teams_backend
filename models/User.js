const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  firebase_uid: { type: String, unique: true, sparse: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String }, // might be 'oauth'
  has_subscription: { type: Number, default: 0 },
  role: { type: String, default: 'user' },
  can_edit_template: { type: Number, default: 1 },
  daily_meeting_limit: { type: Number, default: 0 },
  template_team_name: { type: String, default: 'Template' },
  template_meeting_name: { type: String, default: 'Premade Template' },
  auto_template_enabled: { type: Number, default: 0 },
  plan_id: { type: Number }, // We'll keep it simple for now, maybe map to string or Number
  subscription_start_date: { type: String },
  subscription_end_date: { type: String },
  whatsapp_number: { type: String },
  push_token: { type: String },
  is_admin: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
