const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Schedule = require('../models/Schedule');
const User = require('../models/User');
const AutomationLog = require('../models/AutomationLog');

const activeProcesses = {}; // { logId: { process, userId, scheduleId, meetingName, url, startedAt } }

// Export so cronScheduler can use it
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

    activeProcesses[logId] = { process: pythonProcess, userId, scheduleId, meetingName, url, startedAt, currentStep: 0, leaveRequested: false };

    await AutomationLog.findByIdAndUpdate(logId, { pid: pythonProcess.pid });

    pythonProcess.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
            console.log(`[Python ${logId}]: ${line}`);

            // Parse step for socket.io progress tracking
            let step = null;
            if (line.includes('Opening:')) step = 0;
            else if (line.includes('Turning off camera')) step = 1;
            else if (line.includes('Selecting no audio')) step = 2;
            else if (line.includes('Looking for name input') || line.includes('Entered name:')) step = 3;
            else if (line.includes('Clicking Join Now') || line.includes('lobby') || line.includes('Still in lobby')) step = 4;
            else if (line.includes('CONFIRMED:')) step = 5;

            if (step !== null && activeProcesses[logId]) {
                activeProcesses[logId].currentStep = step;
                // io emitting is handled at route level (io not available here without passing it in)
            }
        }
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[Python Error ${logId}]: ${data}`);
    });

    pythonProcess.on('close', async (code) => {
        const info = activeProcesses[logId] || {};
        const endTime = new Date().toISOString();
        
        let status = code === 0 ? 'completed' : 'failed';
        if (code === 2) status = 'cancelled';
        if (info.leaveRequested && (info.currentStep || 0) < 5) status = 'cancelled';

        const joinedDate = status === 'completed' ? getTodayIST() : null;

        console.log(`[Automation ${logId}] process exited with code ${code} (${status})`);
        await AutomationLog.findByIdAndUpdate(logId, { status, ended_at: endTime, joined_date: joinedDate });

        // Clean up cmd file
        if (info.process && info.process.pid) {
            const cmdFile = path.join(__dirname, '..', `cmd_${info.process.pid}.txt`);
            try { if (fs.existsSync(cmdFile)) fs.unlinkSync(cmdFile); } catch (e) {}
        }

        delete activeProcesses[logId];
    });
}

// Function to handle cancelling via LEAVE command file
async function cancelAutomation(logId) {
    const processInfo = activeProcesses[logId];
    if (!processInfo) return false;

    const cmdFile = path.join(__dirname, '..', `cmd_${processInfo.process?.pid}.txt`);
    processInfo.leaveRequested = true;
    try {
        fs.writeFileSync(cmdFile, 'LEAVE');
        console.log(`[Leave] Wrote LEAVE command to ${cmdFile}`);
    } catch (e) {
        // Fall back to killing the process
        processInfo.process.kill('SIGINT');
    }

    await AutomationLog.findByIdAndUpdate(logId, { status: 'cancelled', ended_at: new Date().toISOString() });
    return true;
}

// Function to handle extending time via ADDTIME command file
async function extendAutomation(logId, extraMins) {
    const processInfo = activeProcesses[logId];
    if (!processInfo) return false;

    const cmdFile = path.join(__dirname, '..', `cmd_${processInfo.process?.pid}.txt`);
    try {
        fs.writeFileSync(cmdFile, `ADDTIME ${extraMins}`);
        console.log(`[Extend] Wrote ADDTIME ${extraMins} to ${cmdFile}`);
        return true;
    } catch (e) {
        console.error(`[Extend] Failed to write ADDTIME to ${cmdFile}`, e);
        return false;
    }
}

// Take a screenshot
async function takeScreenshot(logId, screenshotsDir) {
    const processInfo = activeProcesses[logId];
    if (!processInfo) return null;

    const pid = processInfo.process?.pid;
    const timestamp = Date.now();
    const filename = `screenshot_${pid}_${timestamp}.png`;
    const filepath = path.join(screenshotsDir, filename);
    const cmdFile = path.join(__dirname, '..', `cmd_${pid}.txt`);

    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    fs.writeFileSync(cmdFile, `SCREENSHOT ${filepath}`);

    return { filename, filepath };
}

// Main checkSchedules logic (minute-by-minute polling, used as fallback)
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
        const schedules = await Schedule.find({ day: currentDay, start_time: currentTime }).lean();
        
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
    extendAutomation,
    takeScreenshot,
    activeProcesses,
    runAutomation,
    checkDailyQuota,
    getTodayIST
};
