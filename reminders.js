// api/reminders.js  —  runs on Vercel (free Hobby plan, no card).
//
// Replaces BOTH the old api/check-inactivity.js (Firebase push) and the GitHub Action
// scripts/discord-reminders.mjs. One endpoint now does everything:
//   1. Publishes a scheduled app update (Admin: Settings -> Send Update -> Schedule) once its time has passed
//   2. Sends Discord spending reminders (same rules as before: allowance day > Thursday > N days
//      since the last purchase, per-user/global reminder hours, custom nextReminderAt, ...)
//
// UptimerRobot pings  https://YOUR-PROJECT.vercel.app/api/reminders  every 5 minutes, so a scheduled
// update or custom reminder time goes out within ~5 minutes even when nobody has the app open.
//
// Environment variables (Vercel dashboard -> Project -> Settings -> Environment Variables):
//   UPDATE_DISCORD_WEBHOOK  (optional) Discord webhook that announces scheduled updates
//   CRON_SECRET             (optional) any long random text; needed only for the manual test (?force=1&key=...)
//   FIREBASE_DATABASE_URL   (optional) defaults to your money-e560a database below
//
// Talks to Firebase over its REST API, so your Realtime Database rules must allow read/write
// on users/<n>/... without login (the app already works that way).

const DB = (process.env.FIREBASE_DATABASE_URL || 'https://money-e560a-default-rtdb.firebaseio.com').replace(/\/$/, '');
const OFFSET_MS = 3 * 60 * 60 * 1000; // Riyadh, UTC+3 (no DST)
const DAY_MS = 24 * 60 * 60 * 1000;

const dayStr = (shifted) => shifted.toISOString().slice(0, 10);
const get = async (path, query = '') => {
    const res = await fetch(`${DB}/${path}.json${query}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch {
        throw new Error(`Firebase sent a web page instead of data for "${path}" (status ${res.status}). Check FIREBASE_DATABASE_URL and your database rules.`);
    }
};
const patch = (path, body) => fetch(`${DB}/${path}.json`, { method: 'PATCH', body: JSON.stringify(body) });
const del = (path) => fetch(`${DB}/${path}.json`, { method: 'DELETE' });

// Allowance day is the SAME for every user: every 4th Friday counted from the shared anchor
// (the latest month-cycle start, or the day Zezo last set the week, whichever is later).
// Exactly the same rule as the app's Week counter. Per-user anchors are ignored.
function isAllowanceDay(cycleStartDay, anchor, todayStr) {
    const d = new Date(anchor + 'T00:00:00Z');
    let fridays = 0, last = null;
    for (let i = 0; i < 800; i++) {
        d.setUTCDate(d.getUTCDate() + 1);
        const s = d.toISOString().slice(0, 10);
        if (s > todayStr) break;
        if (d.getUTCDay() === 5 && ++fridays % 4 === 0) last = s;
    }
    return last === todayStr;
}

const MESSAGES = [
    (n) => `Hey ${n}, don't forget to add your spending.`,
    (n) => `Hi ${n}, remember to log what you spent.`,
    (n) => `Hey ${n}, have you added your spending yet? Take a minute to log it.`,
];
function buildMessage(name, allowanceDay, idx) {
    if (allowanceDay) return `Hey ${name}, today is allowance day. Add your allowance and your spending.`;
    return MESSAGES[((Number(idx) || 0) % 3 + 3) % 3](name);
}

const DEFAULT_WINDOW = { s: 13 * 60, e: 20 * 60 };          // 1pm-8pm
const DEFAULT_THURSDAY_WINDOW = { s: 17 * 60, e: 22 * 60 }; // Thursday 5pm-10pm
const validWin = (w) => w && Number.isInteger(w.s) && Number.isInteger(w.e) && w.s >= 0 && w.e <= 1440 && w.e > w.s;
function resolveWindow(dateStr, weekday, userWins, userDays, gWins, gDays) {
    const pick = (o, k) => (o && validWin(o[k]) ? o[k] : null);
    return pick(userDays, dateStr) || pick(gDays, dateStr) || pick(userWins, 'd' + weekday) || pick(gWins, 'd' + weekday)
        || (weekday === 4 ? DEFAULT_THURSDAY_WINDOW : DEFAULT_WINDOW);
}

// ---- Scheduled app update ----
// "Claiming" it is an atomic conditional delete (ETag), so it goes out exactly once even if
// an open app grabs it at the same moment.
async function publishScheduledUpdate(nowMs) {
    try {
        const sres = await fetch(`${DB}/appUpdates/scheduled.json`, { headers: { 'X-Firebase-ETag': 'true' } });
        const etag = sres.headers.get('ETag');
        const sched = await sres.json();
        if (!(sched && sched.sendAt && sched.sendAt <= nowMs && etag)) return null;

        const claim = await fetch(`${DB}/appUpdates/scheduled.json`, { method: 'DELETE', headers: { 'if-match': etag } });
        if (!claim.ok) return null;

        const slides = Array.isArray(sched.slides) ? sched.slides : Object.values(sched.slides || {});
        await fetch(`${DB}/appUpdates/latest.json`, {
            method: 'PUT',
            body: JSON.stringify({
                version: sched.version,
                description: sched.description || 'General improvements and bug fixes.',
                slides,
                releasedAt: nowMs,
                releasedBy: sched.scheduledBy || 'zezo',
            }),
        });

        let discord = 'no webhook set';
        const hook = process.env.UPDATE_DISCORD_WEBHOOK;
        if (hook) {
            const text = String(sched.announcement || `${sched.version} is out! Open the app and tap the update pop-up to get it.`).slice(0, 1900);
            const dres = await fetch(hook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'Money', content: text, allowed_mentions: { parse: [] } }),
            });
            discord = dres.status;
        }
        return { version: sched.version, discord };
    } catch (e) {
        return { error: e.message };
    }
}

async function run(force) {
    const nowMs = Date.now();
    const r = new Date(nowMs + OFFSET_MS);
    const today = dayStr(r);
    const dow = r.getUTCDay();
    const isThursday = dow === 4;
    const nowMin = r.getUTCHours() * 60 + r.getUTCMinutes();

    const gWins = (await get('reminderSettings/windows')) || {};
    const gDays = (await get('reminderSettings/dayOverrides')) || {};
    for (const k of Object.keys(gDays)) if (k < today) await del(`reminderSettings/dayOverrides/${k}`);

    const g = Number(await get('reminderSettings/intervalDays'));
    const globalDays = g >= 1 ? g : 3;

    const cycles = Object.values((await get('financialCycle/history')) || {});
    const latestCycle = cycles.map((c) => new Date(c.startDate).getTime()).filter(Boolean).sort((a, b) => a - b).pop();
    const cycleStartDay = latestCycle ? dayStr(new Date(latestCycle + OFFSET_MS)) : today.slice(0, 8) + '01';
    const cycleStartMs = latestCycle || (Date.parse(today.slice(0, 8) + '01T00:00:00Z') - OFFSET_MS);
    const wk = await get('financialCycle/weekAnchor');
    const sharedAnchor = wk && wk.day && wk.setAt >= cycleStartMs ? wk.day : cycleStartDay;
    const allowanceToday = isAllowanceDay(cycleStartDay, sharedAnchor, today);

    const update = force ? null : await publishScheduledUpdate(nowMs);

    const usernames = Object.keys((await get('users', '?shallow=true')) || {});

    // Manual scheduled messages (Admin Panel): scheduledMessages/<id> = { to: username | '*', text, sendAt }
    let manual = 0;
    if (!force) {
        const msgs = (await get('scheduledMessages')) || {};
        for (const [id, m] of Object.entries(msgs)) {
            if (!m || !m.text || !m.sendAt || m.sendAt > nowMs) continue;
            await del(`scheduledMessages/${id}`); // claim it first so it is never sent twice
            for (const name of m.to === '*' ? usernames : [m.to]) {
                const hook = await get(`users/${encodeURIComponent(name)}/discordWebhook`);
                if (!hook) continue;
                const res = await fetch(hook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: 'Money', content: String(m.text).slice(0, 1900), allowed_mentions: { parse: [] } }),
                }).catch(() => null);
                if (res && res.ok) manual++;
            }
        }
    }

    async function handleUser(name) {
        const u = encodeURIComponent(name);
        const [webhook, lastPurchaseAt, lastReminderDay, lastReminderAt, clockStart, anchor, ownDays, nextReminderAt, lastMsgIndex, userWins, userDayWins] = await Promise.all([
            get(`users/${u}/discordWebhook`),
            get(`users/${u}/lastPurchaseAt`),
            get(`users/${u}/lastReminderDay`),
            get(`users/${u}/lastReminderAt`),
            get(`users/${u}/reminderClockStart`),
            get(`users/${u}/allowanceAnchor`),
            get(`users/${u}/reminderIntervalDays`),
            get(`users/${u}/nextReminderAt`),
            get(`users/${u}/reminderMsgIndex`),
            get(`users/${u}/reminderWindows`),
            get(`users/${u}/reminderDayOverrides`),
        ]);
        if (!webhook) return false;

        const intervalMs = (Number(ownDays) >= 1 ? Number(ownDays) : globalDays) * DAY_MS;
        const baseline = lastPurchaseAt || clockStart;
        const nextIdx = ((Number.isInteger(lastMsgIndex) ? lastMsgIndex : -1) + 1) % 3;

        let msg = null;
        let usedCustomTime = false;
        if (force) {
            msg = `Hey ${name}, this is a test reminder. Discord reminders are working.`;
        } else if (nextReminderAt) {
            if (nowMs < nextReminderAt) return false;
            usedCustomTime = true;
            msg = buildMessage(name, allowanceToday, nextIdx);
        } else {
            const win = resolveWindow(today, dow, userWins, userDayWins, gWins, gDays);
            if (nowMin < win.s || nowMin >= win.e) return false;
            if (lastReminderDay === today) return false;
            if (allowanceToday) {
                msg = buildMessage(name, true, nextIdx);
            } else if (isThursday) {
                msg = buildMessage(name, false, nextIdx);
            } else {
                if (!baseline) { await patch(`users/${u}`, { reminderClockStart: nowMs }); return false; }
                if (nowMs - baseline >= intervalMs && nowMs - (lastReminderAt || 0) >= intervalMs) {
                    msg = buildMessage(name, false, nextIdx);
                }
            }
        }
        if (!msg) return false;

        // Mark as sent BEFORE posting so two overlapping runs can't double-send.
        if (!force) await patch(`users/${u}`, { lastReminderDay: today, lastReminderAt: nowMs, reminderMsgIndex: nextIdx });
        const res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'Money', content: msg, allowed_mentions: { parse: [] } }),
        });
        if (res.ok) {
            if (usedCustomTime) await del(`users/${u}/nextReminderAt`);
            return true;
        }
        // Discord rejected it: undo the "sent" mark so the next run retries.
        if (!force) await patch(`users/${u}`, { lastReminderDay: lastReminderDay ?? null, lastReminderAt: lastReminderAt ?? null });
        return false;
    }

    let sent = 0;
    for (let i = 0; i < usernames.length; i += 10) {
        const results = await Promise.all(usernames.slice(i, i + 10).map((n) => handleUser(n).catch(() => false)));
        sent += results.filter(Boolean).length;
    }
    return { ok: true, force, riyadhTime: r.toISOString().replace('T', ' ').slice(0, 16), sent, manualMessages: manual, scheduledUpdate: update };
}

export default async function handler(req, res) {
    try {
        const wantsForce = req.query && req.query.force === '1';
        if (wantsForce && !(process.env.CRON_SECRET && req.query.key === process.env.CRON_SECRET)) {
            return res.status(401).json({ error: 'force needs ?key=YOUR_CRON_SECRET' });
        }
        return res.status(200).json(await run(wantsForce));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
