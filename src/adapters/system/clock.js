import GLib from 'gi://GLib';

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

    setTimeout(callback, delayMs) {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Number(delayMs) || 0), () => {
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    clearTimeout(id) {
        if (id)
            GLib.source_remove(id);
    }
}
