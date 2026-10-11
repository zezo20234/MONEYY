// api/log-sms.js
// Your iPhone Shortcut sends each UrPay text here. This saves it as a "pending" purchase in your
// database; the app then shows a pop-up where you pick Hangout / Savings / PlayStation, or Decline.
// (Optional) it also pings your Discord webhook so you know to open the app.
//
// Only ONE environment variable is needed: SMS_SECRET.
// URL (POST, SMS text as the body):  https://moneyy-sdwg.vercel.app/api/log-sms?user=Zezo&key=YOUR_SMS_SECRET
// The card digits in the SMS are never saved — only the amount and the store name.

import { createHash } from 'node:crypto';

const DB = (process.env.FIREBASE_DATABASE_URL || 'https://money-e560a-default-rtdb.firebaseio.com').replace(/\/$/, '');
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function readBody(req) {
    const b = req.body;
    if (!b) return '';
    if (typeof b === 'string') return b;
    if (Buffer.isBuffer(b)) return b.toString('utf8');
    return String(b.text || b.message || b.body || b.sms || '');
}

// "amount:13:13.49" -> 13.49
function parseAmount(text) {
    const m = text.match(/amount\s*[:：]?\s*([^\n\r]*)/i);
    if (!m) return null;
    const nums = m[1].replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    const v = Number(nums[nums.length - 1]);
    return v > 0 && v < 1e6 ? r2(v) : null;
}
function parseStore(text) {
    const m = text.match(/^\s*at\s*[:：]\s*(.+)$/im);
    return ((m && m[1].trim()) || 'UrPay purchase').slice(0, 80);
}

export default async function handler(req, res) {
    try {
        if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'use POST' });
        const secret = process.env.SMS_SECRET;
        const given = (req.query && req.query.key) || req.headers['x-key'];
        if (!secret || given !== secret) return res.status(401).json({ error: 'wrong or missing key' });

        const user = String((req.query && req.query.user) || '').trim();
        if (!user || /[.#$\[\]\/|]/.test(user)) return res.status(400).json({ error: 'missing or invalid ?user=' });

        const text = readBody(req) || String((req.query && req.query.text) || '');
        if (!text.trim()) return res.status(400).json({ error: 'empty message' });

        if (/\botp\b|one.?time|verification|code\s*[:：]/i.test(text)) return res.status(200).json({ ignored: 'looks like a code message' });
        if (/refund|reversal|return|credit/i.test(text)) return res.status(200).json({ ignored: 'refund/credit not handled yet' });
        if (!/purchase|\bpos\b|mada|apple\s*pay|online|payment/i.test(text)) return res.status(200).json({ ignored: 'not a purchase message' });
        const amount = parseAmount(text);
        if (!amount) return res.status(200).json({ ignored: 'no amount found' });
        const store = parseStore(text);

        const u = encodeURIComponent(user);
        const id = createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 20);

        // The same SMS twice (phone retry) must only count once.
        const seen = await (await fetch(`${DB}/users/${u}/smsSeen/${id}.json`)).json();
        if (seen) return res.status(200).json({ ignored: 'already received' });
        await fetch(`${DB}/users/${u}/smsSeen/${id}.json`, { method: 'PUT', body: JSON.stringify(Date.now()) });
        await fetch(`${DB}/users/${u}/pendingSms/${id}.json`, { method: 'PUT', body: JSON.stringify({ amount, store, createdAt: Date.now() }) });

        // Optional heads-up on Discord (never fails the request).
        try {
            const webhook = await (await fetch(`${DB}/users/${u}/discordWebhook.json`)).json();
            if (webhook) {
                await fetch(webhook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: 'Money', content: `💳 UrPay purchase: ${amount} ⃁ at ${store}. Open the app to choose where it comes from.`, allowed_mentions: { parse: [] } }),
                });
            }
        } catch { /* ignore */ }

        return res.status(200).json({ pending: true, amount, store });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
