import {LogService} from '../../../src/application/log-service.js';
import {assert, assertEqual, assertThrows, suite, test} from '../../harness.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-01-31T12:00:00Z');

function fakeStore(entries) {
    return {
        entries,
        removed: [],
        sanitized: [],
        list() {
            return this.entries;
        },
        remove(items) {
            this.removed.push(...items);
            return {
                deleted: items.length,
                bytesFreed: items.reduce((sum, item) => sum + item.size, 0),
            };
        },
        sanitize(items) {
            this.sanitized.push(...items);
            return {files: items.length, changed: 1, bytes: 10};
        },
    };
}

function entries() {
    return [
        {path: '/daemon.log', area: 'daemon', size: 100, mtimeMs: NOW - DAY},
        {path: '/old.log', area: 'jobs', jobId: 'job', runId: 'old',
            size: 200, mtimeMs: NOW - 40 * DAY},
        {path: '/new.log', area: 'jobs', jobId: 'job', runId: 'new',
            size: 300, mtimeMs: NOW - DAY},
        {path: '/app.log', area: 'app', size: 400, mtimeMs: NOW - DAY},
    ];
}

function makeService({settings = {}, store = fakeStore(entries()), clearDaemon = null,
    closeDaemon = null, logger = null} = {}) {
    return {
        store,
        service: new LogService({
            store,
            getSettings: () => settings,
            clock: {nowMs: () => NOW},
            logger,
            onClearDaemon: clearDaemon,
            onCloseDaemonLog: closeDaemon,
        }),
    };
}

export default suite('application/log-service', [
    test('info summarizes managed areas and exposes policy', () => {
        const {service} = makeService({
            settings: {logRetentionDays: 7, maxLogTotalBytes: 1024},
        });
        const info = service.info();
        assertEqual(info.totalBytes, 600);
        assertEqual(info.files, 3);
        assertEqual(info.areas.daemon.files, 1);
        assertEqual(info.areas.jobs.files, 2);
        assertEqual(info.areas.app, undefined);
        assertEqual(info.policy.retentionDays, 7);
        assertEqual(info.policy.maxTotalBytes, 1024);
    }),
    test('prune removes expired logs and returns the remaining inventory', () => {
        const {service, store} = makeService();
        const result = service.prune();
        assertEqual(JSON.stringify(store.removed.map(entry => entry.path)),
            JSON.stringify(['/old.log']));
        assertEqual(result.deleted, 1);
        assertEqual(result.bytesFreed, 200);
        assertEqual(result.remaining.files, 3);
    }),
    test('clear handles daemon, runs and all scopes', () => {
        let cleared = 0;
        const {service, store} = makeService({clearDaemon: () => {
            cleared++;
        }});
        const runs = service.clear('run-logs');
        assertEqual(runs.deleted, 2);
        assertEqual(cleared, 0);
        const daemon = service.clear('daemon');
        assertEqual(daemon.deleted, 1);
        assertEqual(cleared, 1);
        const all = service.clear('all');
        assertEqual(all.deleted, 3);
        assertEqual(cleared, 2);
        assert(store.removed.some(entry => entry.path === '/app.log') === false);
    }),
    test('clear rejects unknown scopes', async () => {
        const {service} = makeService();
        await assertThrows(() => service.clear('everything'), /Invalid log scope/);
    }),
    test('sanitize delegates managed files only and skips active files', () => {
        let closed = 0;
        const recent = {
            path: '/recent.log', area: 'jobs', size: 50, mtimeMs: NOW - 1000,
        };
        const store = fakeStore([...entries(), recent]);
        const {service} = makeService({
            store,
            closeDaemon: () => {
                closed++;
            },
        });
        const result = service.sanitize();
        assertEqual(result.changed, 1);
        assertEqual(result.skipped, 1);
        assertEqual(store.sanitized.length, 3);
        assert(store.sanitized.every(entry => entry.area !== 'app'));
        assert(store.sanitized.every(entry => entry.path !== '/recent.log'));
        assertEqual(closed, 1);
    }),
    test('policy defends against invalid settings', () => {
        const {service} = makeService({
            settings: {logRetentionDays: -1, maxLogTotalBytes: 'x'},
        });
        const policy = service.policy();
        assertEqual(policy.retentionDays, 30);
        assertEqual(policy.maxTotalBytes, 50 * 1024 * 1024);
    }),
    test('constructor defaults and empty store operations', () => {
        const store = fakeStore([]);
        const service = new LogService({store});
        assertEqual(service.policy().retentionDays, 30);
        assertEqual(service.prune().deleted, 0);
        assertEqual(service.clear().scope, 'run-logs');
        assertEqual(service.sanitize().skipped, 0);
        const nullSettings = new LogService({
            store,
            getSettings: () => null,
        });
        assertEqual(nullSettings.policy().retentionDays, 30);
    }),
    test('logs prune, clear and sanitize operations with a logger', () => {
        const logger = {
            sink: [],
            info(message, fields) {
                this.sink.push({message, fields});
            },
        };
        const store = fakeStore([
            {path: '/new.log', area: 'jobs', size: 10, mtimeMs: NOW - DAY},
        ]);
        const {service} = makeService({store, logger});
        service.prune();
        service.clear('run-logs');
        service.sanitize();
        assertEqual(logger.sink.length, 3);
        assertEqual(logger.sink[0].message, 'Log cleanup completed');
        assertEqual(logger.sink[1].message, 'Logs cleared');
        assertEqual(logger.sink[2].message, 'Logs sanitized');
    }),
]);
