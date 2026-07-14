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

            // Only log if it contains something that looks like a link to reduce log spam
            if (message.body && message.body.includes('http')) {
                console.log(`[WhatsApp Debug] New raw message from ${message.from}: ${message.body}`);
            }

            // Check if message contains a meeting link
            const linkRegex = /((?:https?:\/\/)?(?:teams\.microsoft\.com\/(?:l\/meetup-join|meet)\/|meet\.google\.com\/|zoom\.us\/j\/)[^\s]+)/gi;
            const match = message.body ? message.body.match(linkRegex) : null;

            if (!match || match.length === 0) {
                return; // Ignore messages without meeting links
            }

            const isGroup = message.from.endsWith('@g.us');
            if (!isGroup) {
                console.log(`[WhatsApp Debug] Ignoring link from non-group chat: ${message.from}`);
                return;
            }

            let chatName = "Unknown Group";
            try {
                const chat = await message.getChat();
                chatName = chat.name;
                console.log(`[WhatsApp Debug] Message is from group: "${chatName}"`);
            } catch (err) {
                console.log(`[WhatsApp Debug] getChat() failed for ${message.from}. Error: ${err.message}. Proceeding with 'Unknown Group'.`);
            }

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
            
            const normalize = (str) => str.replace(/\s+/g, ' ').trim().toLowerCase();

            if (chatName !== "Unknown Group" && targetGroupName && targetGroupName.trim() !== '') {
                if (normalize(chatName) !== normalize(targetGroupName)) {
                    console.log(`[WhatsApp Debug] Ignoring message because group "${chatName}" doesn't match target "${targetGroupName}"`);
                    return;
                }
            } else if (chatName === "Unknown Group" && targetGroupName && targetGroupName.trim() !== '') {
                console.log(`[WhatsApp Debug] WARNING: Could not verify group name for "${message.from}" due to WhatsApp Web issue, but accepting link anyway to prevent failures.`);
            }

            let meetingUrl = match[0];
            if (!meetingUrl.startsWith('http')) {
                meetingUrl = 'https://' + meetingUrl;
            }
            console.log(`[WhatsApp] Found meeting link from ${message.from}: ${meetingUrl}`);
            
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
