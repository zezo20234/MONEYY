// api/log-sms.js
// Your iPhone Shortcut sends each UrPay text here. This saves it as a "pending" purchase in your
// database; the app then shows a pop-up where you pick Hangout / Savings / PlayStation, or Decline.
// (Optional) it also pings your Discord webhook so you know to open the app.
//
// Works for texts sent LATE (queued on the phone while offline and sent once you are on Wi-Fi): the purchase
// time is read from the SMS itself ("09-10-2026 12:29", Riyadh time), or from a "received: <ISO time>" line the
// Shortcut adds, or from ?time=. A queued text that is sent twice is only saved once.
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

// The real purchase time. The SMS ends with "09-10-2026 12:29" (DD-MM-YYYY HH:MM, Riyadh time, UTC+3),
// so a purchase made outside and sent later from home still gets the time it was really made.
const RIYADH_MS = 3 * 60 * 60 * 1000;
const sane = (ms) => Number.isFinite(ms) && ms < Date.now() + 36e5 && ms > Date.now() - 400 * 864e5;
function parseSmsTime(text) {
    const m = text.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})\s+(\d{1,2}):(\d{2})/);
    if (!m) return null;
    let [, a, b, y, hh, mm] = m.map(Number);
    let day = a, month = b;
    if (month > 12 && day <= 12) { day = b; month = a; } // tolerate MM-DD-YYYY
    const ms = Date.UTC(y, month - 1, day, hh, mm) - RIYADH_MS;
    return sane(ms) ? ms : null;
}
// Fallback: the Shortcut adds a line "received: 2026-10-09T12:29:41+03:00" (or ?time=) to every queued text.
function parseReceivedTime(text, queryTime) {
    const m = text.match(/^\s*received\s*[:：]\s*(\S+)/im);
    const raw = (m && m[1]) || queryTime;
    if (!raw) return null;
    const ms = /^\d{10,13}$/.test(String(raw)) ? (String(raw).length <= 10 ? Number(raw) * 1000 : Number(raw)) : Date.parse(raw);
    return sane(ms) ? ms : null;
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

        const smsTime = parseSmsTime(text);
        const givenTime = smsTime || parseReceivedTime(text, req.query && req.query.time);
        const purchasedAt = givenTime || Date.now();
        const hasRealTime = !!givenTime;

        const u = encodeURIComponent(user);
        // The "received:" line is not part of the SMS, so it is left out of the duplicate check.
        const hashText = text.replace(/^\s*received\s*[:：].*$/im, '').replace(/\s+/g, ' ').trim();
        const hash = createHash('sha1').update(hashText + (smsTime ? '' : '|' + purchasedAt)).digest('hex').slice(0, 12);

        // A text that carries its real purchase time can only be saved ONCE (so a queued text that was sent
        // twice, e.g. the phone lost Wi-Fi halfway, never makes a double purchase). A text with no time at all
        // is only treated as a repeat inside 2 minutes (a phone retry), as before.
        const lastSeen = Number(await (await fetch(`${DB}/users/${u}/smsSeen/${hash}.json`)).json()) || 0;
        const dupWindow = hasRealTime ? 7 * 24 * 60 * 60 * 1000 : 2 * 60 * 1000;
        if (Date.now() - lastSeen < dupWindow) return res.status(200).json({ ignored: 'same message already received' });
        await fetch(`${DB}/users/${u}/smsSeen/${hash}.json`, { method: 'PUT', body: JSON.stringify(Date.now()) });
        const id = hash + Date.now().toString(36);
        await fetch(`${DB}/users/${u}/pendingSms/${id}.json`, { method: 'PUT', body: JSON.stringify({ amount, store, createdAt: Date.now(), purchasedAt }) });

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
