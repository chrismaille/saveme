import {TRIGGER_MODES} from './job.js';

export const JOB_STATUS = {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    WAITING_SOURCE: 'waiting-source',
    WAITING_DESTINATION: 'waiting-destination',
    WAITING_IDLE: 'waiting-idle',
    OFFLINE: 'offline',
    NO_SPACE: 'no-space',
    ERROR: 'error',
    NEEDS_AUTH: 'needs-auth',
    DELETE_GUARD: 'delete-guard',
    DISABLED: 'disabled',
};

export {BACKOFF_MS, nextBackoffDelay} from './retry-policy.js';

export function statusFromError(message) {
    if (/source.*(unavailable|does not exist|not a directory)|source volume/i.test(message))
        return JOB_STATUS.WAITING_SOURCE;
    if (/destination.*(unavailable|not a directory)|destination volume/i.test(message))
        return JOB_STATUS.WAITING_DESTINATION;
    if (/auth|token|unauthorized|forbidden|\b401\b|\b403\b|reauth/i.test(message))
        return JOB_STATUS.NEEDS_AUTH;
    if (/Delete guard/i.test(message))
        return JOB_STATUS.DELETE_GUARD;
    if (/not enough (free )?disk space|no space left|filesystem.*full|disk.*full|quota exceeded/i
        .test(message))
        return JOB_STATUS.NO_SPACE;
    return JOB_STATUS.ERROR;
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
