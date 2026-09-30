// Runs on GitHub Actions (free, no card) so reminders arrive even when the app is closed.
// The workflow runs every hour; the rules below decide who actually gets a message.
//
// Normal rules (same as the in-app check in index.html), 1pm-8pm Riyadh, at most one message per user per day:
//   allowance day (4th Friday)  >  Thursday  >  N days since the last logged purchase
//   N = "days between reminders" — set in the Admin Panel for everyone (reminderSettings/intervalDays)
//   or for one user (users/<n>/reminderIntervalDays). Default 3.
//
// Custom time: if the Admin Panel set users/<n>/nextReminderAt, that exact time replaces the normal
// rules for that user. When it passes, the reminder goes out (any hour), the field is cleared and the
// normal rules take over again.
//
// Needs Node 18+ (built-in fetch). Talks to Firebase over its REST API, so your
// Realtime Database rules must allow read/write on users/<n>/... without login
// (the app itself currently works that way).

const DB = 'https://money-e560a-default-rtdb.firebaseio.com';
const OFFSET_MS = 3 * 60 * 60 * 1000; // Riyadh, UTC+3
const DAY_MS = 24 * 60 * 60 * 1000;
const FORCE = process.env.FORCE === '1'; // manual test: ignore the rules and send to everyone

const dayStr = (shifted) => shifted.toISOString().slice(0, 10);
const get = async (path) => (await fetch(`${DB}/${path}.json`)).json();
const patch = (path, body) =>
    fetch(`${DB}/${path}.json`, { method: 'PATCH', body: JSON.stringify(body) });
const del = (path) => fetch(`${DB}/${path}.json`, { method: 'DELETE' });

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

// days = whole days since the last logged purchase (null = unknown)
function buildMessage(name, allowanceDay, thursday, days) {
    if (allowanceDay) return `🎉 **It's allowance day, ${name}!** Tap "I Got Allowance" and make sure to log your spending.`;
    if (thursday) return `📝 **Thursday check-in, ${name}** — make sure to log your spending!`;
    if (days !== null && days >= 1) return `📝 **Hey ${name}** — it's been ${days}+ days. Make sure to log your spending!`;
    return `📝 **Hey ${name}** — make sure to log your spending!`;
}

const nowMs = Date.now();
const r = new Date(nowMs + OFFSET_MS);
const today = dayStr(r);
const isThursday = r.getUTCDay() === 4;
const inWindow = r.getUTCHours() >= 13 && r.getUTCHours() < 20; // 1pm-8pm Riyadh

// Days between reminders for everyone (a user's own value wins). Default 3.
const g = Number(await get('reminderSettings/intervalDays'));
const globalDays = g >= 1 ? g : 3;

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
    const [webhook, lastPurchaseAt, lastReminderDay, lastReminderAt, clockStart, anchor, ownDays, nextReminderAt] = await Promise.all([
        get(`users/${u}/discordWebhook`),
        get(`users/${u}/lastPurchaseAt`),
        get(`users/${u}/lastReminderDay`),
        get(`users/${u}/lastReminderAt`),
        get(`users/${u}/reminderClockStart`),
        get(`users/${u}/allowanceAnchor`),
        get(`users/${u}/reminderIntervalDays`),
        get(`users/${u}/nextReminderAt`),
    ]);
    if (!webhook) continue;

    const intervalDays = Number(ownDays) >= 1 ? Number(ownDays) : globalDays;
    const intervalMs = intervalDays * DAY_MS;
    const baseline = lastPurchaseAt || clockStart;
    const sinceDays = baseline ? Math.floor((nowMs - baseline) / DAY_MS) : null;

    let msg = null;
    let usedCustomTime = false;
    if (FORCE) {
        msg = `✅ Test reminder for ${name} — Money's Discord reminders are working.`;
    } else if (nextReminderAt) {
        // Custom time set from the Admin Panel: waits for that moment, ignores the normal rules
        if (nowMs < nextReminderAt) continue;
        usedCustomTime = true;
        msg = buildMessage(name, isAllowanceDay(cycleStartDay, anchor, today), isThursday, sinceDays);
    } else {
        if (!inWindow) continue;                      // normal reminders only go out 1pm-8pm Riyadh
        if (lastReminderDay === today) continue;      // at most one per day
        if (isAllowanceDay(cycleStartDay, anchor, today)) {
            msg = buildMessage(name, true, false, null);
        } else if (isThursday) {
            msg = buildMessage(name, false, true, null);
        } else {
            if (!baseline) { await patch(`users/${u}`, { reminderClockStart: nowMs }); continue; }
            if (nowMs - baseline >= intervalMs && nowMs - (lastReminderAt || 0) >= intervalMs) {
                msg = buildMessage(name, false, false, intervalDays);
            }
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
        if (usedCustomTime) await del(`users/${u}/nextReminderAt`);
    } else {
        console.log(`Discord failed for ${name}: ${res.status}`);
    }
}
console.log(`Done. Sent ${sent} reminder(s).`);
