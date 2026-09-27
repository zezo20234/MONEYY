// api/check-inactivity.js
//
// Free serverless endpoint (deploy on Vercel — NOT Firebase Cloud Functions,
// so no Blaze plan and no card needed anywhere). Triggered by a fetch from
// index.html every time someone opens the app — there's no schedule/cron.
//
// For every user in the database:
//   - if they haven't logged a purchase (lastPurchaseAt) in 3+ days, AND
//   - they haven't already been reminded (lastNotifiedAt) in the last 3 days, AND
//   - it's currently between 1pm-8pm Riyadh time (UTC+3, fixed — no DST)
// ...it sends them a push notification via Firebase Cloud Messaging.
//
// The Firebase service account credential lives only in Vercel's server-side
// environment variables (set in the Vercel dashboard), never in this repo
// and never in the HTML that ships to phones.

import admin from 'firebase-admin';

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const RIYADH_UTC_OFFSET_HOURS = 3; // Saudi Arabia doesn't observe DST

function isWithinSendWindow() {
    const now = new Date();
    const riyadhHour = (now.getUTCHours() + RIYADH_UTC_OFFSET_HOURS) % 24;
    return riyadhHour >= 13 && riyadhHour < 20; // 1pm (13:00) to 8pm (20:00)
}

function getApp() {
    if (admin.apps.length) return admin.app();
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    return admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
}

export default async function handler(req, res) {
    try {
        // Zezo's "Send Test Notification to Everyone" button hits this with
        // ?test=1 — it ignores the time window and the 3-day inactivity check
        // and just messages every registered device, so you can confirm the
        // whole pipeline works without waiting 3 days or for 1pm.
        const isTest = req.query && req.query.test === '1';

        if (!isTest && !isWithinSendWindow()) {
            return res.status(200).json({ sent: 0, reason: 'outside 1pm-8pm Riyadh window' });
        }

        const app = getApp();
        const db = app.database();
        const usersSnap = await db.ref('users').get();
        if (!usersSnap.exists()) {
            return res.status(200).json({ sent: 0, reason: 'no users found' });
        }

        const users = usersSnap.val();
        const now = Date.now();
        const messaging = app.messaging();
        const results = [];

        for (const [username, data] of Object.entries(users)) {
            const lastPurchaseAt = data.lastPurchaseAt || 0;
            const lastNotifiedAt = data.lastNotifiedAt || 0;
            const token = data.fcmToken;

            if (!token) continue; // this device never registered for push

            if (!isTest) {
                if (now - lastPurchaseAt < THREE_DAYS_MS) continue; // logged recently
                if (now - lastNotifiedAt < THREE_DAYS_MS) continue; // already reminded recently
            }

            try {
                await messaging.send({
                    token,
                    notification: isTest
                        ? { title: 'Money Manager', body: 'This is a test notification from Zezo.' }
                        : { title: 'Money Manager', body: "Don't forget to log your spending!" },
                });
                if (!isTest) {
                    await db.ref(`users/${username}/lastNotifiedAt`).set(now);
                }
                results.push({ username, sent: true });
            } catch (err) {
                // Common cause: token is stale (app uninstalled, etc.) — not fatal,
                // just means this one user doesn't get a push this time.
                results.push({ username, sent: false, error: err.message });
            }
        }

        return res.status(200).json({ sent: results.filter(r => r.sent).length, results });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
