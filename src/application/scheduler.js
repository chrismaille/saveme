export class Scheduler {
    constructor({clock, logger = null}) {
        this.clock = clock;
        this.logger = logger;
        this._timers = new Map();
    }

    start(name, delayMs, callback) {
        this.clear(name);
        const delay = Math.max(0, Number(delayMs) || 0);
        const id = this.clock.setTimeout(() => {
            this._timers.delete(name);
            try {
                callback();
            } catch (e) {
                this.logger?.warn(`Scheduled task ${name} failed: ${e.message}`);
            }
        }, delay);
        this._timers.set(name, id);
        return id;
    }

    clear(name) {
        const id = this._timers.get(name);
        if (id !== undefined && id !== null) {
            this.clock.clearTimeout(id);
            this._timers.delete(name);
        }
    }

    clearAll() {
        for (const name of [...this._timers.keys()])
            this.clear(name);
    }

    has(name) {
        return this._timers.has(name);
    }

    get size() {
        return this._timers.size;
    }
}
