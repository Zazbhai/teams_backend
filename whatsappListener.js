const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

function setupWhatsAppBot(db, applyTemplateForTodayCallback) {
    console.log('[WhatsApp] Initializing WhatsApp bot...');
    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('\n======================================================');
        console.log('   Scan this QR code with WhatsApp to enable link fetcher  ');
        console.log('======================================================\n');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('[WhatsApp] Client is ready and listening for meeting links!');
    });

    client.on('message', async (message) => {
        try {
            const chat = await message.getChat();
            
            if (chat.isGroup) {
                // Fetch group name from settings. If empty, we can process all groups,
                // but usually users want a specific group.
                const groupNameRow = db.prepare("SELECT value FROM settings WHERE key = 'whatsapp_group_name'").get();
                let targetGroupName = groupNameRow ? groupNameRow.value : '';
                
                // If a target group is set, ignore messages from other groups.
                if (targetGroupName && targetGroupName.trim() !== '' && chat.name !== targetGroupName) {
                    return;
                }

                // Check if message contains a meeting link
                const linkRegex = /(https?:\/\/(?:teams\.microsoft\.com\/l\/meetup-join\/|meet\.google\.com\/|zoom\.us\/j\/)[^\s]+)/gi;
                const match = message.body.match(linkRegex);

                if (match && match.length > 0) {
                    const meetingUrl = match[0];
                    console.log(`[WhatsApp] Found meeting link in group "${chat.name}": ${meetingUrl}`);
                    
                    // Save to database
                    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
                      .run('template_url', meetingUrl, meetingUrl);
                    
                    // Trigger template application for today
                    if (applyTemplateForTodayCallback) {
                        applyTemplateForTodayCallback();
                        console.log(`[WhatsApp] Successfully updated Premade Template with new URL.`);
                        
                        // Send confirmation back to group
                        await message.reply(`✅ AutoPilot: Meeting link updated for today's template!`);
                    }
                }
            }
        } catch (e) {
            console.error('[WhatsApp] Error handling message:', e);
        }
    });

    client.initialize();
}

module.exports = { setupWhatsAppBot };
