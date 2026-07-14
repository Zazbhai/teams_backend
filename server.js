require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
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
    .then(() => {
        console.log('Connected to MongoDB');
        loadJobsFromDb();
        setupWhatsAppBot(applyTemplateForAllDays);
    })
    .catch(err => console.error('MongoDB connection error:', err));

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ detail: "No token provided" });
    
    try {
        const decodedToken = await getAuth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (e) {
        res.status(403).json({ detail: "Invalid token", error: e.message });
    }
};

const firebaseMiddleware = async (req, res, next) => {
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        const token = req.headers.authorization.split('Bearer ')[1];
        try {
            const decodedToken = await getAuth().verifyIdToken(token);
            req.auth = { userId: decodedToken.uid };
        } catch (e) { }
    }
    next();
};
app.use(firebaseMiddleware);

// Mount Routes
app.use(require('./routes/users')(authenticateToken, io));
app.use(require('./routes/settings')(authenticateToken, io));
app.use(require('./routes/schedules')(authenticateToken, io));
app.use(require('./routes/automations')(authenticateToken, io));
app.use(require('./routes/adminRoutes')(authenticateToken, io));

// Template trigger
app.post('/settings/template', authenticateToken, async (req, res) => {
    try {
        const { apply_now } = req.body;
        if (apply_now) await applyTemplateForAllDays();
        res.json({ message: "Template processed" });
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

// Auth endpoints for legacy compatibility
app.post('/signup', async (req, res) => {
    try {
        const User = require('./models/User');
        const { name, email, password } = req.body;
        const user = await User.create({ name, email, password, role: 'user', has_subscription: 0 });
        res.json(user);
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
        res.json(user);
    } catch (e) {
        res.status(500).json({ detail: e.message });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Listening on port ${PORT}`);
});
