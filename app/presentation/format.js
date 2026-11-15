export const STATUS_LABELS = {
    'idle': 'Idle',
    'running': 'Running',
    'queued': 'Queued',
    'checking': 'Checking',
    'finalizing': 'Finalizing',
    'paused': 'Paused',
    'stopped': 'Stopped',
    'draft': 'Draft',
    'waiting-source': 'Source missing',
    'waiting-destination': 'Destination missing',
    'waiting-idle': 'Waiting for idle',
    'offline': 'Offline',
    'no-space': 'Not enough disk space',
    'error': 'Error',
    'needs-auth': 'Needs authentication',
    'delete-guard': 'Deleting blocked',
    'disabled': 'Disabled',
};

export const RESULT_LABELS = {
    'success': 'Success',
    'noop': 'No changes',
    'error': 'Error',
    'cancelled': 'Cancelled',
};

export function formatBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024;
        unit++;
    }
    return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatWhen(iso, nowMs = Date.now()) {
    if (!iso)
        return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return '';
    const diff = nowMs - date.getTime();
    if (diff < 60_000)
        return 'just now';
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)} h ago`;
    return `${Math.floor(diff / 86_400_000)} d ago`;
}

export function truncate(text, max = 60) {
    const value = String(text || '');
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function backupRootDisplay(job) {
    if (job.destination.kind === 'remote') {
        const path = job.destination.path
            ? `${job.destination.path.replace(/\/+$/, '')}/SaveMe/${job.id}`
            : `SaveMe/${job.id}`;
        return `${job.destination.remote}:${path}`;
    }
    return `${String(job.destination.path || '').replace(/\/+$/, '')}/SaveMe/${job.id}`;
}

export function statusLabel(status) {
    return STATUS_LABELS[status] || status || 'Idle';
}

export function displayStatus(status, phase = null) {
    if (status !== 'running')
        return status || 'idle';
    if (phase === 'checking')
        return 'checking';
    if (phase === 'cleanup' || phase === 'done')
        return 'finalizing';
    return 'running';
}

export function formatDateTime(iso) {
    if (!iso)
        return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return '';
    const pad = value => String(value).padStart(2, '0');
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/` +
        `${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function cleanError(message) {
    return String(message || '')
        .replace(/^GDBus\.Error:[^\s]+:\s*/i, '')
        .replace(/^Error:\s*/i, '');
}

export function resultClass(result) {
    if (result === 'error')
        return 'saveme-status-error';
    if (result === 'cancelled')
        return 'saveme-status-paused';
    return 'saveme-status-idle';
}

export function runDuration(run) {
    const start = Date.parse(run.startedAt || '');
    const end = Date.parse(run.finishedAt || '');
    if (!Number.isFinite(start) || !Number.isFinite(end))
        return '';
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatEta(value) {
    const total = Number(value);
    if (!Number.isFinite(total) || total < 0)
        return '-';
    const seconds = Math.round(total);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

export function statusIconName(status) {
    if (['error', 'needs-auth', 'delete-guard'].includes(status))
        return 'dialog-error-symbolic';
    if (status === 'running')
        return 'emblem-synchronizing-symbolic';
    if (status === 'checking' || status === 'finalizing')
        return 'emblem-synchronizing-symbolic';
    if (status === 'paused' || status === 'disabled')
        return 'media-playback-pause-symbolic';
    if (status === 'stopped')
        return 'media-playback-stop-symbolic';
    if (status === 'draft')
        return 'document-edit-symbolic';
    if (status === 'queued')
        return 'appointment-soon-symbolic';
    if (['waiting-source', 'waiting-destination', 'waiting-idle', 'offline', 'no-space']
        .includes(status))
        return 'dialog-warning-symbolic';
    return 'emblem-ok-symbolic';
}

export function typeLabel(type) {
    return type === 'backup' ? 'Backup' : 'Sync';
}

export function remoteTypeLabel(type) {
    return {
        drive: 'Google Drive',
        onedrive: 'Microsoft OneDrive',
        dropbox: 'Dropbox',
    }[type] || type;
}
