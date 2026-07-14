const User = require('../models/User');
const Schedule = require('../models/Schedule');
const Setting = require('../models/Setting');
const { scheduleMeetingJob } = require('./cronScheduler');

async function applyTemplateForAllDays(targetUserId = null) {
    const settingsList = await Setting.find({ key: { $in: ['template_url', 'template_start_day', 'template_end_day', 'template_start_time', 'template_end_time'] } });
    const settings = { template_url: '', template_start_day: 'Monday', template_end_day: 'Friday', template_start_time: '09:30', template_end_time: '12:40' };
    settingsList.forEach(r => settings[r.key] = r.value);
    
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const startIdx = days.indexOf(settings.template_start_day);
    const endIdx = days.indexOf(settings.template_end_day);
    
    let activeDays = [];
    if (startIdx !== -1 && endIdx !== -1) {
        if (startIdx <= endIdx) {
            for (let i = startIdx; i <= endIdx; i++) activeDays.push(days[i]);
        } else {
            for (let i = startIdx; i <= 6; i++) activeDays.push(days[i]);
            for (let i = 0; i <= endIdx; i++) activeDays.push(days[i]);
        }
    }
    
    const query = targetUserId ? { _id: targetUserId, auto_template_enabled: 1 } : { auto_template_enabled: 1 };
    const users = await User.find(query).lean();
    
    for (const u of users) {
        const teamName = u.template_team_name || 'Template';
        const meetingName = u.template_meeting_name || 'Premade Template';
        
        for (const dayName of activeDays) {
            const existing = await Schedule.findOne({ user_id: u._id, day: dayName, meeting_name: meetingName });
            if (existing) {
                await Schedule.findByIdAndUpdate(existing._id, {
                    url: settings.template_url, start_time: settings.template_start_time, end_time: settings.template_end_time, team_name: teamName
                });
                scheduleMeetingJob(existing._id, settings.template_start_time, settings.template_end_time, dayName, settings.template_url, teamName, meetingName, u._id);
            } else {
                const s = await Schedule.create({
                    team_name: teamName, meeting_name: meetingName, url: settings.template_url,
                    start_time: settings.template_start_time, end_time: settings.template_end_time,
                    day: dayName, user_id: u._id, user_name: u.name
                });
                scheduleMeetingJob(s._id, settings.template_start_time, settings.template_end_time, dayName, settings.template_url, teamName, meetingName, u._id);
            }
        }
        
        // Remove templates for inactive days
        const inactiveDays = days.filter(d => !activeDays.includes(d));
        if (inactiveDays.length > 0) {
            await Schedule.deleteMany({ user_id: u._id, meeting_name: meetingName, day: { $in: inactiveDays } });
        }
    }
}

module.exports = { applyTemplateForAllDays };
