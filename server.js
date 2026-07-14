require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const { setupWhatsAppBot, stopWhatsAppBot } = require('./whatsappListener');
const { loadJobsFromDb } = require('./services/cronScheduler');
const { applyTemplateForAllDays } = require('./services/templateService');

if (getApps().length === 0) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 8000;

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/teams_automation')
    .then(async () => {
        console.log('Connected to MongoDB');
        await loadJobsFromDb();
        await applyTemplateForAllDays();
        console.log('[Server] Scheduler and template sync complete');
    })
    .catch(err => console.error('MongoDB connection error:', err));

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

// ---- Firebase Auth Middleware (strict — requires valid token) ----
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ detail: "No token provided" });
    
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

// ---- Firebase Middleware (loose — attaches user if token present, continues regardless) ----
const firebaseMiddleware = async (req, res, next) => {
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        const token = req.headers.authorization.split('Bearer ')[1];
        try {
            const decodedToken = await getAuth().verifyIdToken(token);
            req.auth = { userId: decodedToken.uid };
            req.user = decodedToken; // also set req.user for routes that use firebaseMiddleware only
        } catch (e) { /* ignore */ }
    }
    next();
};
app.use(firebaseMiddleware);

// ---- Mount Routes ----
app.use(require('./routes/users')(authenticateToken, io));
app.use(require('./routes/settings')(authenticateToken, io));
app.use(require('./routes/schedules')(authenticateToken, io));
app.use(require('./routes/automations')(authenticateToken, io));
app.use(require('./routes/adminRoutes')(authenticateToken, io));

// ---- Legacy compat endpoints ----
app.post('/signup', async (req, res) => {
    try {
        const User = require('./models/User');
        const { name, email, password } = req.body;
        const user = await User.create({ name, email, password: password || '', role: 'user', has_subscription: 0 });
        res.json({ message: "User created", id: user._id, name: user.name });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

app.post('/login', async (req, res) => {
    try {
        const User = require('./models/User');
        const { email, password } = req.body;
        const user = await User.findOne({ email, password });
        if (!user) return res.status(401).json({ detail: "Invalid credentials" });
        res.json({ token: `mock_token_${user._id}`, user_id: user._id, name: user.name, has_subscription: user.has_subscription === 1 });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// ---- WhatsApp bot sleep/wake scheduling (every minute) ----
cron.schedule('* * * * *', async () => {
    try {
        const Setting = require('./models/Setting');
        const rows = await Setting.find({ key: { $in: ['whatsapp_start_time', 'whatsapp_end_time'] } });
        let startT = '09:00';
        let endT = '18:00';
        rows.forEach(r => {
            if (r.key === 'whatsapp_start_time') startT = r.value;
            if (r.key === 'whatsapp_end_time') endT = r.value;
        });

        const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
        const currTotal = nowIST.getHours() * 60 + nowIST.getMinutes();
        const [sh, sm] = startT.split(':').map(Number);
        const [eh, em] = endT.split(':').map(Number);
        const startTotal = sh * 60 + sm;
        const endTotal = eh * 60 + em;

        let isWithin = false;
        if (startTotal <= endTotal) {
            isWithin = (currTotal >= startTotal && currTotal < endTotal);
        } else {
            isWithin = (currTotal >= startTotal || currTotal < endTotal);
        }

        if (isWithin) {
            setupWhatsAppBot(applyTemplateForAllDays);
        } else {
            stopWhatsAppBot();
        }
    } catch (e) {
        console.error("Error managing WhatsApp bot schedule:", e);
    }
}, { timezone: 'Asia/Kolkata' });

// ---- Daily template re-apply at midnight ----
cron.schedule('1 0 * * *', async () => {
    try {
        await applyTemplateForAllDays();
        console.log('[Cron] Daily template applied at midnight');
    } catch (e) {
        console.error('[Cron] Failed to apply daily template:', e.message);
    }
}, { timezone: 'Asia/Kolkata' });

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Teams AutoPilot backend listening on port ${PORT}`);
});
