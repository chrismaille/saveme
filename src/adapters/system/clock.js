export class SystemClock {
    nowMs() {
        return Date.now();
    }

    nowIso() {
        return new Date().toISOString();
    }

    newDate() {
        return new Date();
    }
}
