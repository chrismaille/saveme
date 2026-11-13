import {TRIGGER_MODES} from './job.js';

export const JOB_STATUS = {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    WAITING_SOURCE: 'waiting-source',
    WAITING_DESTINATION: 'waiting-destination',
    OFFLINE: 'offline',
    ERROR: 'error',
    NEEDS_AUTH: 'needs-auth',
    DELETE_GUARD: 'delete-guard',
    DISABLED: 'disabled',
};

export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export function statusFromError(message) {
    if (/source.*(unavailable|does not exist|not a directory)|source volume/i.test(message))
        return JOB_STATUS.WAITING_SOURCE;
    if (/destination.*(unavailable|not a directory)|destination volume/i.test(message))
        return JOB_STATUS.WAITING_DESTINATION;
    if (/auth|token|unauthorized|forbidden|\b401\b|\b403\b|reauth/i.test(message))
        return JOB_STATUS.NEEDS_AUTH;
    if (/Delete guard/i.test(message))
        return JOB_STATUS.DELETE_GUARD;
    return JOB_STATUS.ERROR;
}

export function nextBackoffDelay(index, backoff = BACKOFF_MS) {
    return backoff[Math.min(Math.max(0, Number(index) || 0), backoff.length - 1)];
}

export function isSuccessfulRun(result) {
    return result === 'success' || result === 'noop';
}

export function isCancelledRun(result) {
    return result === 'cancelled';
}

export function shouldRetryAfterRun(status, triggerMode) {
    if (status === JOB_STATUS.WAITING_SOURCE || status === JOB_STATUS.WAITING_DESTINATION)
        return true;
    if (status === JOB_STATUS.NEEDS_AUTH || status === JOB_STATUS.DELETE_GUARD)
        return false;
    return triggerMode !== TRIGGER_MODES.MANUAL;
}
