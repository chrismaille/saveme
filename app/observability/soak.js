const STATUSES = [
    'running',
    'idle',
    'paused',
    'waiting-source',
    'waiting-destination',
    'error',
    'needs-auth',
    'delete-guard',
    'disabled',
];

function syntheticJob(nowMs) {
    return {
        id: 'soak_job',
        name: 'Soak job',
        type: 'sync',
        enabled: true,
        source: {kind: 'local', path: '/tmp/saveme-soak/source'},
        destination: {kind: 'local', path: '/tmp/saveme-soak/destination'},
        trigger: {mode: 'interval', intervalMinutes: 60},
        options: {maxDeletePercent: 10, maxDeleteMinimum: 5},
        filters: {exclude: []},
        backup: {retentionDays: 0},
        state: {
            status: 'idle',
            lastRunAt: new Date(nowMs).toISOString(),
            lastResult: 'success',
        },
    };
}

/**
 * Deterministic snapshot generator for the app memory soak. It exercises every
 * status path, progress widgets, messages and list rebuilds without touching
 * the daemon or the filesystem.
 */
export function buildSoakSnapshot(base, iteration, nowMs = Date.now()) {
    const snapshot = JSON.parse(JSON.stringify(base || {}));
    snapshot.version = snapshot.version || 'soak';
    snapshot.daemon = snapshot.daemon || {
        pid: 1,
        startedAt: new Date(nowMs).toISOString(),
        rclone: {version: 'soak', path: '/tmp/rclone'},
    };
    snapshot.settings = snapshot.settings || {};
    snapshot.remotes = snapshot.remotes || [];
    snapshot.volumes = snapshot.volumes || [];
    snapshot.pausedAll = iteration % 2 === 0;
    const jobs = snapshot.jobs?.length ? snapshot.jobs : [syntheticJob(nowMs)];
    snapshot.jobs = jobs.map((job, index) => {
        const status = STATUSES[(iteration + index) % STATUSES.length];
        const state = {
            ...(job.state || {}),
            status,
            lastRunAt: new Date(nowMs - Math.floor(iteration / 30) * 60_000).toISOString(),
            lastResult: iteration % 3 === 0 ? 'success' : 'noop',
            message: iteration % 11 === 0 ? `Synthetic message ${iteration}` : '',
            paused: status === 'paused',
        };
        if (status === 'running') {
            state.progress = {
                percent: (iteration * 7 + index * 3) % 100,
                bytes: iteration * 1024,
                totalBytes: 100 * 1024,
                files: iteration,
                totalFiles: 100,
                speed: 1024,
                eta: 60,
                deletes: iteration % 5,
                errors: 0,
                currentPath: `/tmp/saveme-soak/source/file-${iteration}-${index}.txt`,
            };
        } else {
            delete state.progress;
        }
        return {
            ...job,
            enabled: Math.floor(iteration / 60) % 2 === 0,
            state,
        };
    });
    return snapshot;
}
