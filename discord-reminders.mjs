// Runs on GitHub Actions (free, no card) so reminders arrive even when the app is closed.
// Same rules as the in-app check in index.html:
//   allowance day (4th Friday)  >  Thursday  >  3+ days since the last logged purchase
// At most one message per user per day (shares lastReminderDay with the app).
//
// Needs Node 18+ (built-in fetch). Talks to Firebase over its REST API, so your
// Realtime Database rules must allow read/write on users/<name>/... without login
// (the app itself currently works that way).

const DB = 'https://money-e560a-default-rtdb.firebaseio.com';
const OFFSET_MS = 3 * 60 * 60 * 1000; // Riyadh, UTC+3
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const FORCE = process.env.FORCE === '1'; // manual test: ignore the rules and send to everyone

const dayStr = (shifted) => shifted.toISOString().slice(0, 10);
const get = async (path) => (await fetch(`${DB}/${path}.json`)).json();
const patch = (path, body) =>
    fetch(`${DB}/${path}.json`, { method: 'PATCH', body: JSON.stringify(body) });

// Allowance day = today is the 4th Friday of the 4-week cycle (same rule as the app).
// Cycle start = latest month-cycle start, or the user's allowanceAnchor if that is later.
function isAllowanceDay(cycleStartDay, anchor, todayStr) {
    let start = cycleStartDay;
    if (anchor && anchor > start) start = anchor;
    const d = new Date(start + 'T00:00:00Z');
    let fridays = 0, fourth = null;
    for (let i = 0; i < 400; i++) {
        d.setUTCDate(d.getUTCDate() + 1);
        const s = d.toISOString().slice(0, 10);
        if (s > todayStr) break;
        if (d.getUTCDay() === 5 && ++fridays === 4) fourth = s;
    }
    return fourth === todayStr;
}

const nowMs = Date.now();
const r = new Date(nowMs + OFFSET_MS);
const today = dayStr(r);
const isThursday = r.getUTCDay() === 4;

// Shared month-cycle start (Riyadh day). With no cycles recorded, the app uses the 1st of the current month.
const cycles = Object.values((await get('financialCycle/history')) || {});
const latestCycle = cycles.map((c) => new Date(c.startDate).getTime()).filter(Boolean).sort((a, b) => a - b).pop();
const cycleStartDay = latestCycle
    ? dayStr(new Date(latestCycle + OFFSET_MS))
    : today.slice(0, 8) + '01';

const usernames = Object.keys((await get('users?shallow=true')) || {});
let sent = 0;

for (const name of usernames) {
    const u = encodeURIComponent(name);
    const [webhook, lastPurchaseAt, lastReminderDay, lastReminderAt, clockStart, anchor] = await Promise.all([
        get(`users/${u}/discordWebhook`),
        get(`users/${u}/lastPurchaseAt`),
        get(`users/${u}/lastReminderDay`),
        get(`users/${u}/lastReminderAt`),
        get(`users/${u}/reminderClockStart`),
        get(`users/${u}/allowanceAnchor`),
    ]);
    if (!webhook) continue;
    if (!FORCE && lastReminderDay === today) continue;

    let msg = null;
    if (FORCE) {
        msg = `✅ Test reminder for ${name} — Money's Discord reminders are working.`;
    } else if (isAllowanceDay(cycleStartDay, anchor, today)) {
        msg = `🎉 **It's allowance day, ${name}!** Tap "I Got Allowance" and make sure to log your spending.`;
    } else if (isThursday) {
        msg = `📝 **Thursday check-in, ${name}** — make sure to log your spending!`;
    } else {
        const baseline = lastPurchaseAt || clockStart;
        if (!baseline) { await patch(`users/${u}`, { reminderClockStart: nowMs }); continue; }
        if (nowMs - baseline >= THREE_DAYS_MS && nowMs - (lastReminderAt || 0) >= THREE_DAYS_MS) {
            msg = `📝 **Hey ${name}** — it's been 3+ days. Make sure to log your spending!`;
        }
    }
    if (!msg) continue;

    const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Money', content: msg, allowed_mentions: { parse: [] } }),
    });
    if (res.ok) {
        sent++;
        if (!FORCE) await patch(`users/${u}`, { lastReminderDay: today, lastReminderAt: nowMs });
    } else {
        console.log(`Discord failed for ${name}: ${res.status}`);
    }
}
console.log(`Done. Sent ${sent} reminder(s).`);
