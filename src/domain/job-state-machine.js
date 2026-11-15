import {
    JOB_STATUS,
    shouldRetryAfterRun,
    statusFromError,
} from './run-state.js';

export function idleStatus({enabled = true, paused = false, pausedAll = false} = {}) {
    if (!enabled)
        return JOB_STATUS.DISABLED;
    if (paused || pausedAll)
        return JOB_STATUS.PAUSED;
    return JOB_STATUS.IDLE;
}

export function cancelledStatus({
    enabled = true,
    paused = false,
    stopped = false,
    pausedAll = false,
    sourceAvailable = true,
} = {}) {
    if (stopped)
        return JOB_STATUS.STOPPED;
    if (!enabled || paused || pausedAll)
        return JOB_STATUS.PAUSED;
    if (!sourceAvailable)
        return JOB_STATUS.WAITING_SOURCE;
    return JOB_STATUS.PAUSED;
}

export function failureStatus(message) {
    return statusFromError(message);
}

export class JobStateMachine {
    transition(event, context = {}) {
        switch (event) {
        case 'idle':
            return idleStatus(context);
        case 'cancelled':
            return cancelledStatus(context);
        case 'failure':
            return failureStatus(context.message || '');
        default:
            throw new Error(`Unknown job state event: ${event}`);
        }
    }

    shouldRetry(status, triggerMode) {
        return shouldRetryAfterRun(status, triggerMode);
    }
}
