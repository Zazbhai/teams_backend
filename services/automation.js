const { spawn } = require('child_process');
const path = require('path');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const AutomationLog = require('../models/AutomationLog');

const activeProcesses = {}; // { logId: { process: child_process, userId, scheduleId } }

// Helper: get today in IST
function getTodayIST() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffset);
    return istDate.toISOString().slice(0, 10);
}

// Checks if a user is within their daily quota
async function checkDailyQuota(userId) {
    const user = await User.findById(userId).lean();
    const limit = (user && user.daily_meeting_limit) ? user.daily_meeting_limit : 0;

    if (limit === 0) {
        return { allowed: true, limit: 0, active_count: 0, joins_today: 0, scheduled_count: 0, remaining: -1 };
    }

    const activeCount = Object.values(activeProcesses).filter(p => String(p.userId) === String(userId)).length;
    
    const todayIST = getTodayIST();
    const joinsToday = await AutomationLog.countDocuments({ user_id: userId, joined_date: todayIST, status: 'completed' });
    
    const schedulesCount = await Schedule.countDocuments({ user_id: userId });
    
    const totalToday = activeCount + joinsToday;
    const allowed = totalToday < limit;
    
    return {
        allowed,
        limit,
        active_count: activeCount,
        joins_today: joinsToday,
        scheduled_count: schedulesCount,
        remaining: limit - totalToday
    };
}

async function runAutomation(scheduleId, url, duration, teamName, meetingName, userId) {
    const displayName = teamName || 'AutoPilot Team';
    console.log(`[Automation] Starting: "${meetingName}" for ${displayName} (${duration} mins) => ${url}`);
    
    const autojoinPath = path.join(__dirname, '..', 'autojoin.py');
    const startedAt = new Date().toISOString();

    const log = await AutomationLog.create({
        schedule_id: scheduleId, user_id: userId || null, user_name: displayName,
        meeting_name: meetingName || '', url, status: 'running', started_at: startedAt
    });
    const logId = log._id;

    const pythonExecutable = process.env.PYTHON_PATH || 'python3';
    const pythonProcess = spawn(pythonExecutable, [
        autojoinPath,
        '--url', url,
        '--name', displayName,
        '--duration', duration.toString(),
        '--headless'
    ]);

    activeProcesses[logId] = { process: pythonProcess, userId, scheduleId, meetingName, url, startedAt };

    await AutomationLog.findByIdAndUpdate(logId, { pid: pythonProcess.pid });

    pythonProcess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        console.log(`[Python ${logId}]: ${msg}`);
        // Here we could emit to socket if we pass io down
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[Python Error ${logId}]: ${data}`);
    });

    pythonProcess.on('close', async (code) => {
        const endTime = new Date().toISOString();
        const joinedDate = getTodayIST();
        console.log(`[Automation ${logId}] process exited with code ${code}`);
        const status = (code === 0) ? 'completed' : 'failed';
        await AutomationLog.findByIdAndUpdate(logId, { status, ended_at: endTime, joined_date: joinedDate });
        delete activeProcesses[logId];
    });
}

// Function to handle cancelling
async function cancelAutomation(logId) {
    if (activeProcesses[logId]) {
        activeProcesses[logId].process.kill('SIGINT');
        delete activeProcesses[logId];
        await AutomationLog.findByIdAndUpdate(logId, { status: 'cancelled', ended_at: new Date().toISOString() });
        return true;
    }
    return false;
}

// Main checkSchedules logic
async function checkSchedules() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(now.getTime() + istOffset);
    
    const currentHour = istDate.getUTCHours().toString().padStart(2, '0');
    const currentMinute = istDate.getUTCMinutes().toString().padStart(2, '0');
    const currentTime = `${currentHour}:${currentMinute}`;
    
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = days[istDate.getUTCDay()];

    console.log(`[Scheduler] Checking for schedules at ${currentTime} on ${currentDay} (IST)`);

    try {
        const schedules = await Schedule.find({ day: currentDay, start_time: currentTime, is_active: 1 }).lean();
        
        for (const schedule of schedules) {
            const userId = schedule.user_id;
            
            if (userId) {
                const user = await User.findById(userId).lean();
                if (user && user.has_subscription === 0) {
                    const quota = await checkDailyQuota(userId);
                    if (!quota.allowed) {
                        console.log(`[Scheduler] Skipped schedule ${schedule._id} for user ${userId} - Daily limit reached`);
                        continue;
                    }
                }
            }

            const [startH, startM] = schedule.start_time.split(':').map(Number);
            const [endH, endM] = schedule.end_time.split(':').map(Number);
            
            let duration = (endH * 60 + endM) - (startH * 60 + startM);
            if (duration <= 0) duration = 60; 

            runAutomation(schedule._id, schedule.url, duration, schedule.team_name, schedule.meeting_name, schedule.user_id);
        }
    } catch (e) {
        console.error('[Scheduler] Error:', e.message);
    }
}

module.exports = {
    checkSchedules,
    cancelAutomation,
    activeProcesses,
    runAutomation,
    checkDailyQuota
};
