const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let client = null;

/**
 * @param {Function} applyTemplateForTodayCallback - called after URL is saved
 */
function setupWhatsAppBot(applyTemplateForTodayCallback) {
    if (client) {
        return;
    }
    console.log('[WhatsApp] Initializing WhatsApp bot...');
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('\n======================================================')
        console.log('   Scan this QR code with WhatsApp to enable link fetcher  ');
        console.log('======================================================\n');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('[WhatsApp] Client is ready and listening for meeting links!');
    });

    client.on('message_create', async (message) => {
        try {
            if (message.isStatus || message.from === 'status@broadcast') return;

            console.log(`[WhatsApp Debug] New raw message from ${message.from}: ${message.body}`);

            let chat;
            try {
                chat = await message.getChat();
            } catch (err) {
                console.log(`[WhatsApp Debug] getChat() failed for message from ${message.from}. Error: ${err.message}`);
                // Ignore random puppeteer evaluate errors (like 'r: r') for system messages
                return;
            }
            
            console.log(`[WhatsApp Debug] Received message in "${chat.name}" (isGroup: ${chat.isGroup}): ${message.body}`);

            if (chat.isGroup) {
                // Read target group from SQLite settings first, then fall back to env
                let targetGroupName = process.env.WHATSAPP_GROUP_NAME || '';
                try {
                    const Setting = require('./models/Setting');
                    const groupNameRow = await Setting.findOne({ key: 'whatsapp_group_name' });
                    if (groupNameRow && groupNameRow.value) {
                        targetGroupName = groupNameRow.value;
                    }
                } catch (e) {
                    console.error('[WhatsApp] Error reading target group name from DB', e);
                }
                
                // Normalize whitespaces (like newlines) to a single space before comparing
                const normalize = (str) => str.replace(/\s+/g, ' ').trim().toLowerCase();

                // If a target group is set, ignore messages from other groups (case-insensitive & ignoring newlines).
                if (targetGroupName && targetGroupName.trim() !== '') {
                    if (normalize(chat.name) !== normalize(targetGroupName)) {
                        console.log(`[WhatsApp Debug] Ignoring message because group "${chat.name}" doesn't match target "${targetGroupName}"`);
                        return; // Not the target group
                    }
                }

                console.log(`[WhatsApp Debug] Message is in the correct group! Checking for links...`);

                // Check if message contains a meeting link (made https optional)
                // Added support for teams.microsoft.com/meet/ format
                const linkRegex = /((?:https?:\/\/)?(?:teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/|meet\.google\.com\/|zoom\.us\/j\/)[^\s]+)/gi;
                const match = message.body.match(linkRegex);

                if (match && match.length > 0) {
                    let meetingUrl = match[0];
                    if (!meetingUrl.startsWith('http')) {
                        meetingUrl = 'https://' + meetingUrl;
                    }
                    console.log(`[WhatsApp] Found meeting link in group "${chat.name}": ${meetingUrl}`);
                    
                    // Save to MongoDB database
                    try {
                        const Setting = require('./models/Setting');
                        await Setting.findOneAndUpdate({ key: 'template_url' }, { value: meetingUrl }, { upsert: true });
                        console.log(`[WhatsApp] Saved template_url to DB: ${meetingUrl}`);
                    } catch (e) {
                        console.error('[WhatsApp] Error saving template URL to DB', e);
                    }
                    
                    // Trigger template application for today
                    if (applyTemplateForTodayCallback) {
                        applyTemplateForTodayCallback();
                        console.log(`[WhatsApp] Successfully updated Premade Template with new URL.`);
                    }
                    
                    // Send confirmation message
                    const confirmNumber = process.env.WHATSAPP_CONFIRM_NUMBER || '919262231588';
                    try {
                        await client.sendMessage(`${confirmNumber}@c.us`, `today teams meeting link set to ${meetingUrl}`);
                        console.log(`[WhatsApp] Sent confirmation to +${confirmNumber}`);
                    } catch (err) {
                        console.error(`[WhatsApp] Failed to send confirmation to +${confirmNumber}`, err);
                    }
                }
            }
        } catch (e) {
            console.error('[WhatsApp] Error handling message:', e);
        }
    });

    client.initialize();
}

function stopWhatsAppBot() {
    if (client) {
        console.log('[WhatsApp] Stopping WhatsApp bot...');
        client.destroy();
        client = null;
    }
}

module.exports = { setupWhatsAppBot, stopWhatsAppBot };
