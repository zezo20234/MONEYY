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

// Accepts plain text, {"text": "..."} or anything else Shortcuts sends: it collects every piece of text it can find.
function collectText(v, out = []) {
    if (v == null) return out;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => collectText(x, out));
    else if (typeof v === 'object') Object.values(v).forEach((x) => collectText(x, out));
    return out;
}
function readBody(req) {
    let b = req.body;
    if (!b) return '';
    if (Buffer.isBuffer(b)) b = b.toString('utf8');
    if (typeof b === 'string') {
        try { const j = JSON.parse(b); if (j && typeof j === 'object') return collectText(j).join('\n'); } catch { /* plain text */ }
        return b;
    }
    return collectText(b).join('\n');
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
        const hash = createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

        // Only a REPEAT within 2 minutes (a phone retry) is ignored. Two real purchases with the same
        // price and store are both kept (the SMS also has the time, and each one gets its own id).
        const lastSeen = Number(await (await fetch(`${DB}/users/${u}/smsSeen/${hash}.json`)).json()) || 0;
        if (Date.now() - lastSeen < 2 * 60 * 1000) return res.status(200).json({ ignored: 'same message received a moment ago' });
        await fetch(`${DB}/users/${u}/smsSeen/${hash}.json`, { method: 'PUT', body: JSON.stringify(Date.now()) });
        const id = hash + Date.now().toString(36);
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
