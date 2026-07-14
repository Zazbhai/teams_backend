const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

const adminRoutes = require('./routes/adminRoutes');
const SubscriptionPlan = require('./models/SubscriptionPlan');
const User = require('./models/User');

async function run() {
    const mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const app = express();
    app.use(express.json());
    
    const mockAuth = (req, res, next) => next();
    app.use(adminRoutes(mockAuth, {}));

    // 1. Create a plan
    const postRes = await request(app)
        .post('/api/subscriptions')
        .send({
            name: 'Test Plan',
            price: '₹29/mo',
            description: 'Test Desc',
            duration_days: 30
        });
    console.log('POST /api/subscriptions:', postRes.body);

    // 2. Fetch plans
    const getRes = await request(app).get('/api/subscriptions');
    console.log('GET /api/subscriptions:', JSON.stringify(getRes.body, null, 2));

    await mongoose.disconnect();
    await mongoServer.stop();
}

run().catch(console.error);
