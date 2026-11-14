export const INTERVAL_UNITS = ['minutes', 'hours', 'days'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MINUTE = 60_000;

export function intervalMs(trigger = {}) {
    const raw = trigger.intervalMinutes;
    const parsed = raw === undefined || raw === null || raw === ''
        ? 60 : Number(raw);
    const minutes = Number.isFinite(parsed) ? Math.max(1, parsed) : 60;
    return minutes * MINUTE;
}

export function parseTime(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match)
        return {hours: 18, minutes: 0};
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59)
        return {hours: 18, minutes: 0};
    return {hours, minutes};
}

export function isValidTime(value) {
    return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
}

function atTime(date, time) {
    const parsed = parseTime(time);
    const value = new Date(date);
    value.setHours(parsed.hours, parsed.minutes, 0, 0);
    return value;
}

function nextWeekly(trigger, now) {
    const targetDay = Math.min(6, Math.max(0, Number(trigger.dayOfWeek ?? 1)));
    const candidate = atTime(now, trigger.time || '18:00');
    let delta = (targetDay - candidate.getDay() + 7) % 7;
    if (delta === 0 && candidate.getTime() <= now.getTime())
        delta = 7;
    candidate.setDate(candidate.getDate() + delta);
    return candidate.getTime() - now.getTime();
}

function nextMonthly(trigger, now) {
    const day = Math.min(31, Math.max(1, Number(trigger.dayOfMonth || 1)));
    const candidate = atTime(now, trigger.time || '18:00');
    const setDay = date => {
        const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        date.setDate(Math.min(day, last));
    };
    setDay(candidate);
    if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(1);
        candidate.setMonth(candidate.getMonth() + 1);
        setDay(candidate);
    }
    return candidate.getTime() - now.getTime();
}

/**
 * Milliseconds until the next scheduled run. Startup is handled by the
 * supervisor; realtime is handled by the watcher.
 */
export function nextRunDelay(trigger = {}, nowMs = Date.now()) {
    const now = new Date(nowMs);
    switch (trigger.mode) {
    case 'interval':
        return intervalMs(trigger);
    case 'weekly':
        return nextWeekly(trigger, now);
    case 'monthly':
        return nextMonthly(trigger, now);
    case 'dusk':
        return nextDaily(trigger, now, '18:00');
    case 'startup':
    case 'realtime':
    case 'manual':
        return null;
    default:
        return null;
    }
}

function nextDaily(trigger, now, fallbackTime) {
    const candidate = atTime(now, trigger.time || fallbackTime);
    if (candidate.getTime() <= now.getTime())
        candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime() - now.getTime();
}

/**
 * Timestamp of the most recent weekly/monthly/dusk occurrence at or before
 * `nowMs`. Used to catch up a schedule that was missed while the daemon was
 * stopped. Interval catch-up uses lastRunAt directly.
 */
export function previousRunMs(trigger = {}, nowMs = Date.now()) {
    const now = new Date(nowMs);
    switch (trigger.mode) {
    case 'weekly': {
        const targetDay = Math.min(6, Math.max(0, Number(trigger.dayOfWeek ?? 1)));
        const candidate = atTime(now, trigger.time || '18:00');
        let delta = (candidate.getDay() - targetDay + 7) % 7;
        if (delta === 0 && candidate.getTime() > now.getTime())
            delta = 7;
        candidate.setDate(candidate.getDate() - delta);
        return candidate.getTime();
    }
    case 'monthly': {
        const day = Math.min(31, Math.max(1, Number(trigger.dayOfMonth || 1)));
        const candidate = atTime(now, trigger.time || '18:00');
        const setDay = date => {
            const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
            date.setDate(Math.min(day, last));
        };
        setDay(candidate);
        if (candidate.getTime() > now.getTime()) {
            candidate.setDate(1);
            candidate.setMonth(candidate.getMonth() - 1);
            setDay(candidate);
        }
        return candidate.getTime();
    }
    case 'dusk': {
        const candidate = atTime(now, trigger.time || '18:00');
        if (candidate.getTime() > now.getTime())
            candidate.setDate(candidate.getDate() - 1);
        return candidate.getTime();
    }
    default:
        return null;
    }
}

export function isRunOverdue(trigger, lastRunMs, nowMs = Date.now()) {
    if (!Number.isFinite(lastRunMs))
        return false;
    const previous = previousRunMs(trigger, nowMs);
    return previous !== null && previous > lastRunMs;
}

export function triggerLabel(trigger = {}) {
    switch (trigger.mode) {
    case 'realtime': return 'Real-time';
    case 'interval': {
        const count = trigger.intervalValue ||
            Math.round(intervalMs(trigger) / MINUTE);
        const unit = trigger.intervalUnit || 'minutes';
        const singular = unit.replace(/s$/, '');
        return `Every ${count} ${count === 1 ? singular : unit}`;
    }
    case 'weekly': return `${WEEKDAYS[trigger.dayOfWeek ?? 1]} at ${trigger.time || '18:00'}`;
    case 'monthly': return `Day ${trigger.dayOfMonth || 1} at ${trigger.time || '18:00'}`;
    case 'startup': return 'At computer startup';
    case 'dusk': return `At dusk (${trigger.time || '18:00'})`;
    case 'manual': return 'Manual';
    default: return 'Manual';
    }
}
