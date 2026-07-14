const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const SubscriptionPlan = require('./models/SubscriptionPlan');

async function run() {
    const mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    try {
        const plan = await SubscriptionPlan.create({
            name: "Pro",
            price: "₹29/mo",
            description: "Desc",
            duration_days: 30
        });
        console.log("Success:", plan);
    } catch(e) {
        console.error("Error:", e);
    }

    await mongoose.disconnect();
    await mongoServer.stop();
}

run();
