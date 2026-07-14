require('dotenv').config();
const Database = require('better-sqlite3');
const mongoose = require('mongoose');
const User = require('./models/User');
const Schedule = require('./models/Schedule');
const AutomationLog = require('./models/AutomationLog');
const Setting = require('./models/Setting');
const SubscriptionPlan = require('./models/SubscriptionPlan');
const path = require('path');

async function migrate() {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/teams_automation');
    console.log('Connected to MongoDB.');

    const dbPath = path.join(__dirname, '..', 'scheduler.db');
    const db = new Database(dbPath, { readonly: true });
    
    console.log('Starting Migration...');

    // Migrate Users
    console.log('Migrating Users...');
    const users = db.prepare("SELECT * FROM users").all();
    const userMap = {}; // old_id -> new_id
    for (const u of users) {
        const newUser = await User.create({
            name: u.name,
            email: u.email,
            password: u.password,
            has_subscription: u.has_subscription,
            role: u.role,
            can_edit_template: u.can_edit_template,
            daily_meeting_limit: u.daily_meeting_limit,
            firebase_uid: u.firebase_uid,
            template_team_name: u.template_team_name,
            template_meeting_name: u.template_meeting_name,
            auto_template_enabled: u.auto_template_enabled,
            subscription_start_date: u.subscription_start_date,
            subscription_end_date: u.subscription_end_date,
            whatsapp_number: u.whatsapp_number,
            push_token: u.push_token,
            is_admin: u.is_admin
        });
        userMap[u.id] = newUser._id;
    }
    console.log(`Migrated ${users.length} users.`);

    // Migrate Settings
    console.log('Migrating Settings...');
    const settings = db.prepare("SELECT * FROM settings").all();
    for (const s of settings) {
        await Setting.create({ key: s.key, value: s.value });
    }
    console.log(`Migrated ${settings.length} settings.`);

    // Migrate Plans
    console.log('Migrating Subscription Plans...');
    const plans = db.prepare("SELECT * FROM subscription_plans").all();
    for (const p of plans) {
        await SubscriptionPlan.create({
            name: p.name, price: p.price, description: p.description, duration_days: p.duration_days
        });
    }
    console.log(`Migrated ${plans.length} plans.`);

    // Migrate Schedules
    console.log('Migrating Schedules...');
    const schedules = db.prepare("SELECT * FROM schedules").all();
    const scheduleMap = {};
    for (const s of schedules) {
        const newSchedule = await Schedule.create({
            user_id: userMap[s.user_id] || null,
            user_name: s.user_name,
            team_name: s.team_name,
            meeting_name: s.meeting_name,
            url: s.url,
            start_time: s.start_time,
            end_time: s.end_time,
            day: s.day,
            is_active: s.is_active
        });
        scheduleMap[s.id] = newSchedule._id;
    }
    console.log(`Migrated ${schedules.length} schedules.`);

    // Migrate Logs
    console.log('Migrating Automation Logs...');
    const logs = db.prepare("SELECT * FROM automation_logs").all();
    for (const l of logs) {
        await AutomationLog.create({
            schedule_id: scheduleMap[l.schedule_id] || null,
            user_id: userMap[l.user_id] || null,
            user_name: l.user_name,
            meeting_name: l.meeting_name,
            url: l.url,
            status: l.status,
            started_at: l.started_at,
            ended_at: l.ended_at,
            pid: l.pid,
            joined_date: l.joined_date
        });
    }
    console.log(`Migrated ${logs.length} logs.`);

    console.log('Migration Complete!');
    process.exit(0);
}

migrate().catch(console.error);
