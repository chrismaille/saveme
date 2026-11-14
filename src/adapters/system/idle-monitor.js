import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Best-effort system idle detection through logind's session IdleHint.
 * If logind is unavailable we do not block scheduled jobs.
 */
export class IdleMonitor {
    constructor({
        bus = null,
        path = '/org/freedesktop/login1/session/auto',
        timeout = 2000,
    } = {}) {
        this._bus = bus;
        this.path = path;
        this.timeout = timeout;
    }

    isIdle() {
        try {
            const bus = this._bus || Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            this._bus = bus;
            const reply = bus.call_sync(
                'org.freedesktop.login1',
                this.path,
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', [
                    'org.freedesktop.login1.Session',
                    'IdleHint',
                ]),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                this.timeout,
                null);
            const variant = reply.deepUnpack()[0];
            const value = variant?.deepUnpack ? variant.deepUnpack() : variant;
            return Boolean(value);
        } catch (_) {
            return true;
        }
    }
}
