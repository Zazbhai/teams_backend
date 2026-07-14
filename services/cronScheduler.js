const cron = require('node-cron');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const AutomationLog = require('../models/AutomationLog');
const Setting = require('../models/Setting');
const { runAutomation, activeProcesses, getTodayIST } = require('./automation');

const activeCronJobs = {};

function calculateDuration(start, end) {
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    let duration = (endH * 60 + endM) - (startH * 60 + startM);
    return duration > 0 ? duration : 60;
}

function scheduleMeetingJob(scheduleId, startTime, endTime, day, url, teamName, meetingName, userId) {
    const dayMap = { 'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 'Friday': 5, 'Saturday': 6 };
    const cronDay = dayMap[day] !== undefined ? dayMap[day] : 1;
    
    const [hour, minute] = startTime.split(':');
    const duration = calculateDuration(startTime, endTime);
    const cronExpression = `${minute} ${hour} * * ${cronDay}`;
    
    if (activeCronJobs[scheduleId]) activeCronJobs[scheduleId].stop();
    
    const task = cron.schedule(cronExpression, async () => {
        let finalUrl = url;
        if (!finalUrl || finalUrl.trim() === '') {
            const setting = await Setting.findOne({ key: 'template_url' });
            if (setting && setting.value) {
                const todayIST = getTodayIST();
                const updatedAt = new Date(setting.updatedAt);
                const updatedIST = new Date(updatedAt.getTime() + (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 10);
                if (updatedIST === todayIST) {
                    finalUrl = setting.value;
                } else {
                    console.log(`[Scheduler] Existing template_url is from a previous day. Waiting for today's link...`);
                }
            }
        }

        let maxWaitMins = 30;
        const waitSetting = await Setting.findOne({ key: 'whatsapp_link_wait_mins' });
        if (waitSetting && waitSetting.value) {
            maxWaitMins = parseInt(waitSetting.value, 10) || 30;
        }

        // Wait up to maxWaitMins for WhatsApp bot if meeting is 'Premade Template' or URL is empty
        let waitedMinutes = 0;
        while ((!finalUrl || finalUrl.trim() === '') && waitedMinutes < maxWaitMins) {
            console.log(`[Scheduler] No link found for ${meetingName}. Waiting ${waitedMinutes + 1}/${maxWaitMins} minutes...`);
            await new Promise(resolve => setTimeout(resolve, 60 * 1000));
            waitedMinutes++;
            
            const setting = await Setting.findOne({ key: 'template_url' });
            if (setting && setting.value) {
                // Verify the link was updated today
                const todayIST = getTodayIST();
                const updatedAt = new Date(setting.updatedAt);
                const updatedIST = new Date(updatedAt.getTime() + (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 10);
                if (updatedIST === todayIST) {
                    finalUrl = setting.value;
                    break;
                }
            }
        }

        if (!finalUrl || finalUrl.trim() === '') {
            const now = new Date().toISOString();
            await AutomationLog.create({
                schedule_id: scheduleId, user_id: userId || null, user_name: teamName || 'AutoPilot Team',
                meeting_name: meetingName || '', url: '', status: `skipped (no link after ${maxWaitMins} mins)`, started_at: now, ended_at: now
            });
            return;
        }

        if (userId) {
            const user = await User.findById(userId);
            const limit = (user && user.daily_meeting_limit) ? user.daily_meeting_limit : 0;
            if (limit > 0) {
                const activeCount = Object.values(activeProcesses).filter(p => String(p.userId) === String(userId)).length;
                const todayIST = getTodayIST();
                const joinsToday = await AutomationLog.countDocuments({ user_id: userId, joined_date: todayIST, status: 'completed' });
                
                if (joinsToday + activeCount >= limit) {
                    const now = new Date().toISOString();
                    await AutomationLog.create({
                        schedule_id: scheduleId, user_id: userId, user_name: teamName || 'AutoPilot Team',
                        meeting_name: meetingName || '', url: '', status: 'skipped (quota reached)', started_at: now, ended_at: now
                    });
                    return;
                }
            }
        }

        runAutomation(scheduleId, finalUrl, duration, teamName, meetingName, userId);
    }, { timezone: 'Asia/Kolkata' });
    
    activeCronJobs[scheduleId] = task;
    console.log(`[Scheduler] Job registered: id=${scheduleId} | cron: ${cronExpression}`);
}

async function loadJobsFromDb() {
    const schedules = await Schedule.find({ is_active: 1 }).lean();
    for (const row of schedules) {
        scheduleMeetingJob(row._id, row.start_time, row.end_time, row.day, row.url, row.team_name, row.meeting_name, row.user_id);
    }
    console.log(`[Scheduler] Loaded ${schedules.length} jobs from database.`);
}

module.exports = { scheduleMeetingJob, loadJobsFromDb, activeCronJobs };
