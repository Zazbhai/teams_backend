const Database = require('better-sqlite3');
const db = new Database('../scheduler.db');

try {
    db.exec('ALTER TABLE users ADD COLUMN auto_template_enabled BOOLEAN DEFAULT 1');
    console.log("Successfully added auto_template_enabled column to users table.");
} catch(e) {
    console.log("Column may already exist or error:", e.message);
}
