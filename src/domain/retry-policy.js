export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export function nextBackoffDelay(index, backoff = BACKOFF_MS) {
    return backoff[Math.min(Math.max(0, Number(index) || 0), backoff.length - 1)];
}

export class RetryPolicy {
    constructor(backoff = BACKOFF_MS) {
        this.backoff = backoff;
        this.attempt = 0;
    }

    nextDelay() {
        const delay = nextBackoffDelay(this.attempt, this.backoff);
        this.attempt++;
        return delay;
    }

    reset() {
        this.attempt = 0;
    }
}
