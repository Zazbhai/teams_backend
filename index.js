require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

if (getApps().length === 0) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}
const Database = require('better-sqlite3');
const fs = require('fs');
const cron = require('node-cron');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

// Setup CORS
app.use(cors({
    origin: '*',
    credentials: true
}));

// Firebase Auth Middleware
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        console.log('[Auth] No token provided in request');
        return res.status(401).json({ detail: "No token provided" });
    }
    
    try {
        console.log('[Auth] Verifying token...');
        const decodedToken = await getAuth().verifyIdToken(token);
        req.user = decodedToken;
        console.log('[Auth] Token verified for email:', decodedToken.email);
        next();
    } catch (e) {
        console.error('[Auth] Token verification failed:', e.message);
        res.status(403).json({ detail: "Invalid token", error: e.message });
    }
};

app.get('/api/users/me', authenticateToken, (req, res) => {
    try {
        const email = req.user.email;
        console.log('[Users/Me] Fetching profile for email:', email);
        if (!email) return res.status(400).json({ detail: "No email in token" });
        
        let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
        console.log('[Users/Me] DB result:', user ? `found (has_subscription=${user.has_subscription})` : 'NOT FOUND');
        
        // If user doesn't exist in SQLite yet, create them with has_subscription = 0
        if (!user) {
            const name = req.user.name || "User";
            const info = db.prepare("INSERT INTO users (name, email, password, has_subscription, role) VALUES (?, ?, ?, 0, 'user')").run(name, email, 'oauth');
            user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
            console.log('[Users/Me] Created new user with id:', user.id);
        }
        
        // Auto-expire subscription if end date has passed
        if (user.has_subscription === 1 && user.subscription_end_date) {
            const endDate = new Date(user.subscription_end_date);
            if (endDate < new Date()) {
                console.log(`[Users/Me] Subscription expired for user ${user.id} on ${endDate.toISOString()}`);
                db.prepare("UPDATE users SET has_subscription = 0 WHERE id = ?").run(user.id);
                user.has_subscription = 0; // Update local object
            }
        }
        
        // Fetch plan name if user has a plan
        let planName = null;
        if (user.plan_id) {
            const plan = db.prepare("SELECT name FROM subscription_plans WHERE id = ?").get(user.plan_id);
            if (plan) planName = plan.name;
        }
        
        const response = {
            id: user.id,
            email: user.email,
            name: user.name,
            has_subscription: user.has_subscription === 1,
            subscription_end_date: user.subscription_end_date || null,
            plan_name: planName,
            role: user.role,
            can_edit_template: user.can_edit_template === 1
        };
        console.log('[Users/Me] Returning:', response);
        res.json(response);
    } catch (e) {
        console.error("Error fetching user profile:", e);
        res.status(500).json({ detail: "Internal Server Error" });
    }
});

app.use(express.json());
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

// Initialize Database
const dbPath = path.join(__dirname, '..', 'scheduler.db');
const db = new Database(dbPath);

// Supercharge SQLite speed
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

function initDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_name TEXT NOT NULL,
            meeting_name TEXT NOT NULL,
            url TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            day TEXT NOT NULL
        )
    `);
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            firebase_uid TEXT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT,
            has_subscription BOOLEAN DEFAULT 0,
            subscription_end_date TEXT,
            role TEXT DEFAULT 'user'
        )
    `);

    try {
        db.exec("ALTER TABLE users ADD COLUMN firebase_uid TEXT");
    } catch (e) {
        // column might already exist
    }
    
    try {
        db.exec("ALTER TABLE users ADD COLUMN plan_id INTEGER REFERENCES subscription_plans(id)");
    } catch (e) {
        // column might already exist
    }
    
    try {
        db.exec("ALTER TABLE users ADD COLUMN subscription_end_date TEXT");
    } catch (e) {
        // column might already exist
    }

    try {
        db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
    } catch (e) {
        // column might already exist
    }

    try {
        db.exec("ALTER TABLE users ADD COLUMN can_edit_template BOOLEAN DEFAULT 0");
    } catch (e) {
        // column might already exist
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS subscription_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price TEXT NOT NULL,
            description TEXT NOT NULL,
            duration_days INTEGER DEFAULT 30
        )
    `);
    
    try {
        db.exec("ALTER TABLE subscription_plans ADD COLUMN duration_days INTEGER DEFAULT 30");
    } catch (e) {
        // column might already exist
    }

    try {
        db.exec("ALTER TABLE schedules ADD COLUMN user_id INTEGER");
    } catch (e) { /* already exists */ }

    try {
        db.exec("ALTER TABLE schedules ADD COLUMN user_name TEXT");
    } catch (e) { /* already exists */ }

    db.exec(`
        CREATE TABLE IF NOT EXISTS automation_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            schedule_id INTEGER,
            user_id INTEGER,
            user_name TEXT,
            meeting_name TEXT,
            url TEXT,
            status TEXT DEFAULT 'running',
            started_at TEXT,
            ended_at TEXT,
            pid INTEGER
        )
    `);

    // Add indexes for much faster fetching
    db.exec("CREATE INDEX IF NOT EXISTS idx_logs_user ON automation_logs(user_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_users_firebase ON users(firebase_uid);");

    const countPlans = db.prepare("SELECT COUNT(*) as count FROM subscription_plans").get();
    if (countPlans.count === 0) {
        const insertPlan = db.prepare("INSERT INTO subscription_plans (name, price, description, duration_days) VALUES (?, ?, ?, ?)");
        insertPlan.run("Free Tier", "\u20b90/mo", "Basic automation", 0);
        insertPlan.run("Pro Tier", "\u20b929/mo", "Unlimited automation", 30);
    }
}

initDb();

// Apply Firebase Middleware
const firebaseMiddleware = async (req, res, next) => {
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        const token = req.headers.authorization.split('Bearer ')[1];
        try {
            const decodedToken = await getAuth().verifyIdToken(token);
            req.auth = { userId: decodedToken.uid };
            
            // Sync user to local database
            let localUser = db.prepare("SELECT * FROM users WHERE firebase_uid = ?").get(decodedToken.uid);
            
            // If not found by firebase_uid, try finding by email and link them
            if (!localUser && decodedToken.email) {
                localUser = db.prepare("SELECT * FROM users WHERE email = ?").get(decodedToken.email);
                if (localUser) {
                    db.prepare("UPDATE users SET firebase_uid = ? WHERE id = ?").run(decodedToken.uid, localUser.id);
                }
            }
            
            // If still no user, create a new one
            if (!localUser) {
                const email = decodedToken.email || `${decodedToken.uid}@firebase.user`;
                const name = decodedToken.name || 'Firebase User';
                const stmt = db.prepare("INSERT INTO users (firebase_uid, name, email, password, has_subscription, role) VALUES (?, ?, ?, ?, ?, ?)");
                try {
                    stmt.run(decodedToken.uid, name, email, 'firebase_auth', 0, 'user');
                    localUser = db.prepare("SELECT * FROM users WHERE firebase_uid = ?").get(decodedToken.uid);
                } catch (e) {
                    console.error('Failed to sync user to local DB:', e.message);
                }
            }
            
            req.user = localUser;
            req.auth = decodedToken;
            return next();
        } catch (err) {
            console.error('Firebase validation error:', err.message);
        }
    }
    req.auth = null;
    next();
};
app.use(firebaseMiddleware);
// Background Scheduling Logic
const activeCronJobs = {};

function calculateDuration(startTime, endTime) {
    try {
        const [sHour, sMinute] = startTime.split(':').map(Number);
        const [eHour, eMinute] = endTime.split(':').map(Number);
        
        let startMinutes = sHour * 60 + sMinute;
        let endMinutes = eHour * 60 + eMinute;
        
        let duration = endMinutes - startMinutes;
        if (duration <= 0) {
            duration += 24 * 60; // wrap around midnight
        }
        return duration;
    } catch (e) {
        return 60; // Default
    }
}

// Track active automation processes: scheduleId -> { process, logId }
const activeProcesses = {};

function runAutomation(scheduleId, url, duration, teamName, meetingName, userId) {
    const displayName = teamName || 'AutoPilot Team';
    console.log(`[Automation] Starting: "${meetingName}" for ${displayName} (${duration} mins) => ${url}`);
    
    const autojoinPath = path.join(__dirname, '..', 'autojoin.py');
    const startedAt = new Date().toISOString();

    // Insert log entry
    const logStmt = db.prepare(`
        INSERT INTO automation_logs (schedule_id, user_id, user_name, meeting_name, url, status, started_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?)
    `);
    const logInfo = logStmt.run(scheduleId, userId || null, displayName, meetingName || '', url, startedAt);
    const logId = logInfo.lastInsertRowid;

    const pythonProcess = spawn('python3', [
        autojoinPath,
        '--url', url,
        '--name', displayName,
        '--duration', duration.toString(),
        '--headless'
    ]);

    activeProcesses[scheduleId] = { pid: pythonProcess.pid, logId, userName: displayName, meetingName, url, startedAt, userId };

    // Update log with PID
    db.prepare("UPDATE automation_logs SET pid = ? WHERE id = ?").run(pythonProcess.pid, logId);

    // Auto remove from upcoming schedules if it's a saved schedule (numeric ID)
    if (typeof scheduleId === 'number' || !String(scheduleId).startsWith('test_')) {
        try {
            db.prepare("DELETE FROM schedules WHERE id = ?").run(scheduleId);
            if (activeCronJobs[scheduleId]) {
                activeCronJobs[scheduleId].stop();
                delete activeCronJobs[scheduleId];
            }
            console.log(`[Scheduler] Auto-removed schedule id=${scheduleId} as it has started running`);
        } catch (e) {
            console.error(`[Scheduler] Failed to auto-remove schedule id=${scheduleId}:`, e.message);
        }
    }

    pythonProcess.stdout.on('data', (data) => {
        console.log(`[${displayName}/${meetingName}]: ${data.toString().trim()}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        console.error(`[ERROR ${displayName}/${meetingName}]: ${data.toString().trim()}`);
    });

    pythonProcess.on('close', (code) => {
        const endedAt = new Date().toISOString();
        const status = code === 0 ? 'completed' : 'failed';
        db.prepare("UPDATE automation_logs SET status = ?, ended_at = ? WHERE id = ?").run(status, endedAt, logId);
        delete activeProcesses[scheduleId];
        console.log(`[Automation] ${displayName}/${meetingName} ended with code ${code} (${status})`);
    });
}

function scheduleMeetingJob(scheduleId, startTime, endTime, day, url, teamName, meetingName, userId) {
    const dayMap = {
        'Sunday': 0, 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3,
        'Thursday': 4, 'Friday': 5, 'Saturday': 6
    };
    const cronDay = dayMap[day] !== undefined ? dayMap[day] : 1;
    
    const [hour, minute] = startTime.split(':');
    const duration = calculateDuration(startTime, endTime);
    
    const cronExpression = `${minute} ${hour} * * ${cronDay}`;
    
    if (activeCronJobs[scheduleId]) {
        activeCronJobs[scheduleId].stop();
    }
    
    const task = cron.schedule(cronExpression, () => {
        let finalUrl = url;
        if (!finalUrl || finalUrl.trim() === '') {
            const row = db.prepare("SELECT value FROM settings WHERE key = 'template_url'").get();
            if (row && row.value) {
                finalUrl = row.value;
            }
        }

        if (!finalUrl || finalUrl.trim() === '') {
            console.log(`[Scheduler] Skipping meeting ${meetingName} because URL is empty. Rescheduling for next time.`);
            const logStmt = db.prepare(`
                INSERT INTO automation_logs (schedule_id, user_id, user_name, meeting_name, url, status, started_at, ended_at)
                VALUES (?, ?, ?, ?, ?, 'skipped', ?, ?)
            `);
            const now = new Date().toISOString();
            logStmt.run(scheduleId, userId || null, teamName || 'AutoPilot Team', meetingName || '', '', now, now);
            return;
        }

        runAutomation(scheduleId, finalUrl, duration, teamName, meetingName, userId);
    }, { timezone: 'Asia/Kolkata' });
    
    activeCronJobs[scheduleId] = task;
    console.log(`[Scheduler] Job registered: id=${scheduleId} | ${teamName || 'N/A'} | ${meetingName || url} | ${day} ${startTime} IST (cron: ${cronExpression})`);
}

function loadJobsFromDb() {
    const rows = db.prepare(`
        SELECT s.id, s.start_time, s.end_time, s.day, s.url, s.meeting_name, s.team_name,
               s.user_id, s.user_name, u.name as db_user_name
        FROM schedules s
        LEFT JOIN users u ON s.user_id = u.id
    `).all();
    rows.forEach(row => {
        const teamName = row.team_name || 'AutoPilot Team';
        scheduleMeetingJob(row.id, row.start_time, row.end_time, row.day, row.url, teamName, row.meeting_name, row.user_id);
    });
    console.log(`[Scheduler] Loaded ${rows.length} jobs from database.`);
}

loadJobsFromDb();

// Routes

app.get('/users/me', (req, res) => {
    if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
    res.json(req.user);
});

app.get('/automations/logs/my', (req, res) => {
    if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
    const rows = db.prepare(`
        SELECT id, meeting_name, url, status, started_at, ended_at, user_name as team_name
        FROM automation_logs 
        WHERE user_id = ? 
        ORDER BY started_at DESC
    `).all(req.user.id);
    res.json(rows);
});

app.get('/schedules', (req, res) => {
    if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
    const rows = db.prepare("SELECT * FROM schedules WHERE user_id = ?").all(req.user.id);
    res.json(rows);
});

// POST /schedules/:id/run-now — trigger a scheduled job immediately (for testing)
app.post('/schedules/:id/run-now', (req, res) => {
    const id = req.params.id;
    const row = db.prepare(`
        SELECT s.*, u.name as db_user_name
        FROM schedules s LEFT JOIN users u ON s.user_id = u.id
        WHERE s.id = ?
    `).get(id);

    if (!row) return res.status(404).json({ error: 'Schedule not found' });

    const duration = calculateDuration(row.start_time, row.end_time);
    const teamName = row.team_name || 'AutoPilot Team';
    runAutomation(row.id, row.url, duration, teamName, row.meeting_name, row.user_id);

    res.json({ message: `Started automation for "${row.meeting_name}" immediately`, pid: activeProcesses[row.id]?.pid });
});

// POST /automations/run-now — run an arbitrary URL immediately (quick test)
app.post('/automations/run-now', (req, res) => {
    const { url, name, duration } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const displayName = name || 'Test User';
    const mins = parseInt(duration) || 5;
    const tempId = `test_${Date.now()}`;
    runAutomation(tempId, url, mins, displayName, 'Manual Test', null);
    res.json({ message: `Started test automation`, pid: activeProcesses[tempId]?.pid });
});

// POST /automations/start — securely start an automation immediately for a user
app.post('/automations/start', (req, res) => {
    if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
    if (req.user.has_subscription !== 1) {
        return res.status(403).json({ detail: "Subscription required", expired: true });
    }
    if (req.user.subscription_end_date && new Date(req.user.subscription_end_date) < new Date()) {
        return res.status(403).json({ detail: "Plan expired. Please renew.", expired: true });
    }

    const { team_name, meeting_name, url, duration } = req.body;
    if (!url) return res.status(400).json({ detail: "URL is required" });

    const userId = req.user.id;
    const userName = req.user.name || 'AutoPilot User';
    const mins = parseInt(duration) || 60; // Default to 60 minutes
    const tempId = `manual_${Date.now()}_${userId}`;

    runAutomation(tempId, url, mins, team_name || userName, meeting_name || 'Ad-Hoc Meeting', userId);
    res.json({ message: "Started immediately", pid: activeProcesses[tempId]?.pid });
});

app.post('/schedules', (req, res) => {
    if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
    if (req.user.has_subscription !== 1) {
        return res.status(403).json({ detail: "Subscription required", expired: true });
    }
    if (req.user.subscription_end_date && new Date(req.user.subscription_end_date) < new Date()) {
        return res.status(403).json({ detail: "Plan expired. Please renew.", expired: true });
    }

    const { team_name, meeting_name, url, start_time, end_time, day } = req.body;
    const userId = req.user.id;
    const userName = req.user.name || 'AutoPilot User';

    const stmt = db.prepare(
        "INSERT INTO schedules (team_name, meeting_name, url, start_time, end_time, day, user_id, user_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const info = stmt.run(team_name, meeting_name, url, start_time, end_time, day, userId, userName);
    
    scheduleMeetingJob(info.lastInsertRowid, start_time, end_time, day, url, team_name, meeting_name, userId);
    
    res.json({ id: info.lastInsertRowid, message: "Scheduled successfully" });
});

app.delete('/schedules/:id', (req, res) => {
    const id = req.params.id;
    db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    
    if (activeCronJobs[id]) {
        activeCronJobs[id].stop();
        delete activeCronJobs[id];
    }

    // Kill any running automation process for this schedule
    if (activeProcesses[id]) {
        try {
            process.kill(activeProcesses[id].pid, 'SIGTERM');
            db.prepare("UPDATE automation_logs SET status = 'cancelled', ended_at = ? WHERE id = ?")
              .run(new Date().toISOString(), activeProcesses[id].logId);
        } catch (e) { /* already dead */ }
        delete activeProcesses[id];
    }
    
    res.json({ message: "Deleted successfully" });
});

// GET /automations/active — currently running Selenium instances
app.get('/automations/active', (req, res) => {
    const active = Object.entries(activeProcesses)
        .filter(([_, info]) => info.userId === req.user?.id)
        .map(([scheduleId, info]) => ({
            schedule_id: isNaN(parseInt(scheduleId)) ? scheduleId : parseInt(scheduleId),
            pid: info.pid,
            user_name: info.userName,
            meeting_name: info.meetingName,
            url: info.url,
            started_at: info.startedAt,
        }));
    res.json({ count: active.length, instances: active });
});

// POST /automations/active/:id/leave — send LEAVE command
app.post('/automations/active/:id/leave', (req, res) => {
    const id = req.params.id;
    const processInfo = activeProcesses[id];
    if (!processInfo) {
        return res.status(404).json({ error: "Process not found" });
    }
    
    const cmdFile = path.join(__dirname, '..', `cmd_${processInfo.pid}.txt`);
    try {
        fs.writeFileSync(cmdFile, "LEAVE");
        res.json({ message: "Leave command sent successfully" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /automations/active/:id/screenshot — send SCREENSHOT command and wait for result
app.post('/automations/active/:id/screenshot', async (req, res) => {
    const id = req.params.id;
    const processInfo = activeProcesses[id];
    if (!processInfo) {
        return res.status(404).json({ error: "Process not found" });
    }
    
    const timestamp = Date.now();
    const filename = `screenshot_${processInfo.pid}_${timestamp}.png`;
    const filepath = path.join(__dirname, 'screenshots', filename);
    const cmdFile = path.join(__dirname, '..', `cmd_${processInfo.pid}.txt`);
    
    try {
        fs.writeFileSync(cmdFile, `SCREENSHOT ${filepath}`);
        
        // Wait up to 10 seconds for the file to be created
        let attempts = 0;
        const checkInterval = setInterval(() => {
            if (fs.existsSync(filepath)) {
                clearInterval(checkInterval);
                res.json({ url: `/screenshots/${filename}` });
            } else if (attempts >= 20) { // 20 * 500ms = 10s
                clearInterval(checkInterval);
                res.status(504).json({ error: "Screenshot timeout" });
            }
            attempts++;
        }, 500);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /automations/logs — history of all automation runs
app.get('/automations/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const rows = db.prepare(`
        SELECT * FROM automation_logs
        ORDER BY started_at DESC
        LIMIT ?
    `).all(limit);
    res.json(rows);
});

app.get('/stats', (req, res) => {
    const total_users = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
    const pro_users = db.prepare("SELECT COUNT(*) as count FROM users WHERE has_subscription = 1").get().count;
    const total_schedules = db.prepare("SELECT COUNT(*) as count FROM schedules").get().count;
    
    const mrr = pro_users * 29;
    
    res.json({
        total_users,
        pro_users,
        total_schedules,
        mrr,
        success_rate: 100.0,
        trends: {
            users: "+2.4%",
            mrr: "+0.0%",
            schedules: "+1.1%"
        }
    });
});

app.get('/users/recent', (req, res) => {
    const rows = db.prepare("SELECT id, name, email, has_subscription, subscription_end_date, role, can_edit_template FROM users ORDER BY id DESC LIMIT 5").all();
    res.json(rows);
});

app.get('/users', (req, res) => {
    const rows = db.prepare("SELECT id, name, email, has_subscription, subscription_end_date, role, can_edit_template FROM users").all();
    res.json(rows);
});

app.post('/users', (req, res) => {
    const { name, email, password, role } = req.body;
    try {
        const stmt = db.prepare("INSERT INTO users (name, email, password, has_subscription, role) VALUES (?, ?, ?, 0, ?)");
        const info = stmt.run(name, email, password || '', role || 'user');
        res.json({ message: "User created", id: info.lastInsertRowid });
    } catch (e) {
        res.status(400).json({ detail: "Email already registered" });
    }
});

app.put('/users/:id/role', (req, res) => {
    const id = req.params.id;
    const role = req.query?.role || req.body?.role;
    const info = db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
    if (info.changes === 0) return res.status(404).json({ detail: "User not found" });
    res.json({ message: "Role updated" });
});

app.put('/users/:id/subscription', (req, res) => {
    const id = req.params.id;
    const active = req.query?.active === 'true' || req.body?.active === true;
    const planId = req.body?.plan_id || null;
    
    let endDate = null;
    let actualPlanId = planId;
    if (active) {
        let duration = 30;
        if (planId) {
            const plan = db.prepare("SELECT duration_days FROM subscription_plans WHERE id = ?").get(planId);
            if (plan && plan.duration_days) {
                duration = plan.duration_days;
            }
        }
        const date = new Date();
        date.setDate(date.getDate() + duration);
        endDate = date.toISOString();
    } else {
        actualPlanId = null;
    }
    
    const info = db.prepare("UPDATE users SET has_subscription = ?, subscription_end_date = ?, plan_id = ? WHERE id = ?").run(active ? 1 : 0, endDate, actualPlanId, id);
    if (info.changes === 0) return res.status(404).json({ detail: "User not found" });
    res.json({ message: "Subscription updated", subscription_end_date: endDate, plan_id: actualPlanId });
});


// Mock signup/login kept for backward compatibility if flutter isn't updated immediately
app.post('/signup', (req, res) => {
    const { name, email, password } = req.body;
    try {
        const stmt = db.prepare("INSERT INTO users (name, email, password, has_subscription) VALUES (?, ?, ?, 0)");
        const info = stmt.run(name, email, password);
        res.json({ token: `mock_token_${info.lastInsertRowid}`, user_id: info.lastInsertRowid, name: name, has_subscription: false });
    } catch (e) {
        res.status(400).json({ detail: "Email already registered" });
    }
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const row = db.prepare("SELECT * FROM users WHERE email = ? AND password = ?").get(email, password);
    if (row) {
        res.json({ token: `mock_token_${row.id}`, user_id: row.id, name: row.name, has_subscription: Boolean(row.has_subscription) });
    } else {
        res.status(401).json({ detail: "Invalid email or password" });
    }
});

app.delete('/users/:id', (req, res) => {
    const id = req.params.id;
    const info = db.prepare("DELETE FROM users WHERE id = ?").run(id);
    if (info.changes === 0) return res.status(404).json({ detail: "User not found" });
    res.json({ message: "User deleted" });
});

app.get('/settings/template', (req, res) => {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('template_url', 'template_start_day', 'template_end_day', 'template_start_time', 'template_end_time')").all();
    const settings = { template_url: '', template_start_day: 'Monday', template_end_day: 'Friday', template_start_time: '09:30', template_end_time: '12:40' };
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
});

app.post('/settings/template', (req, res) => {
    if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
    if (req.user.can_edit_template !== 1 && req.user.role !== 'admin') {
        return res.status(403).json({ detail: "Forbidden" });
    }
    const { url, start_day, end_day, start_time, end_time } = req.body;
    const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?");
    if (url !== undefined) stmt.run('template_url', url, url);
    if (start_day !== undefined) stmt.run('template_start_day', start_day, start_day);
    if (end_day !== undefined) stmt.run('template_end_day', end_day, end_day);
    if (start_time !== undefined) stmt.run('template_start_time', start_time, start_time);
    if (end_time !== undefined) stmt.run('template_end_time', end_time, end_time);
    res.json({ message: "Template settings updated successfully" });
});

app.put('/users/:id/template_permission', (req, res) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ detail: "Forbidden" });
    const can_edit = req.body.can_edit ? 1 : 0;
    db.prepare("UPDATE users SET can_edit_template = ? WHERE id = ?").run(can_edit, req.params.id);
    res.json({ message: "Template permission updated" });
});

app.put('/users/:id/details', (req, res) => {
    const id = req.params.id;
    const { name, email, password } = req.body;
    try {
        const info = db.prepare("UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?").run(name, email, password, id);
        if (info.changes === 0) return res.status(404).json({ detail: "User not found" });
        res.json({ message: "User details updated successfully" });
    } catch (e) {
        res.status(400).json({ detail: "Failed to update user details, email might already exist" });
    }
});

app.post('/users/me/subscribe', (req, res) => {
    if (!req.user) return res.status(401).json({ detail: "Unauthorized" });
    const info = db.prepare("UPDATE users SET has_subscription = 1 WHERE id = ?").run(req.user.id);
    if (info.changes === 0) return res.status(404).json({ detail: "User not found" });
    res.json({ message: "Subscription successful" });
});

app.post('/users/:id/subscribe', (req, res) => {
    const id = req.params.id;
    const info = db.prepare("UPDATE users SET has_subscription = 1 WHERE id = ?").run(id);
    if (info.changes === 0) return res.status(404).json({ detail: "User not found" });
    res.json({ message: "Subscription successful" });
});

app.get('/api/subscriptions', (req, res) => {
    const rows = db.prepare(`
        SELECT sp.*, 
               (SELECT COUNT(*) FROM users u WHERE u.plan_id = sp.id AND u.has_subscription = 1 AND (u.subscription_end_date IS NULL OR u.subscription_end_date > datetime('now'))) as active_users
        FROM subscription_plans sp
    `).all();
    res.json({ plans: rows });
});

app.post('/api/subscriptions', (req, res) => {
    const { name, price, description, duration_days } = req.body;
    const duration = duration_days ? parseInt(duration_days) : 30;
    const info = db.prepare("INSERT INTO subscription_plans (name, price, description, duration_days) VALUES (?, ?, ?, ?)").run(name, price, description, duration);
    res.json({ status: "success", id: info.lastInsertRowid });
});

app.put('/api/subscriptions/:id', (req, res) => {
    const id = req.params.id;
    const { name, price, description, duration_days } = req.body;
    const duration = duration_days ? parseInt(duration_days) : 30;
    db.prepare("UPDATE subscription_plans SET name=?, price=?, description=?, duration_days=? WHERE id=?").run(name, price, description, duration, id);
    res.json({ status: "success" });
});

app.delete('/api/subscriptions/:id', (req, res) => {
    const id = req.params.id;
    db.prepare("DELETE FROM subscription_plans WHERE id=?").run(id);
    res.json({ status: "success" });
});


app.listen(PORT, () => {
    console.log(`Teams AutoPilot backend listening at http://localhost:${PORT}`);
});
