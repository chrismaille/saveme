export const STATUS_LABELS = {
    'idle': 'Idle',
    'running': 'Running',
    'paused': 'Paused',
    'waiting-source': 'Source missing',
    'waiting-destination': 'Destination missing',
    'offline': 'Offline',
    'error': 'Error',
    'needs-auth': 'Needs authentication',
    'delete-guard': 'Deleting blocked',
    'disabled': 'Disabled',
};

const STATUS_ICONS = {
    'idle': 'emblem-ok-symbolic',
    'running': 'emblem-synchronizing-symbolic',
    'paused': 'media-playback-pause-symbolic',
    'disabled': 'media-playback-pause-symbolic',
    'waiting-source': 'dialog-warning-symbolic',
    'waiting-destination': 'dialog-warning-symbolic',
    'offline': 'dialog-warning-symbolic',
    'error': 'dialog-error-symbolic',
    'needs-auth': 'dialog-error-symbolic',
    'delete-guard': 'dialog-error-symbolic',
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

export function formatWhen(iso, nowMs = Date.now(), translate = value => value) {
    if (!iso)
        return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return '';
    const diff = nowMs - date.getTime();
    if (diff < 60_000)
        return translate('just now');
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)} min`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)} h`;
    return `${Math.floor(diff / 86_400_000)} d`;
}

export function shortFile(path, max = 42) {
    if (!path)
        return '';
    const name = String(path).split('/').filter(Boolean).pop() || '';
    return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
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

export function statusLabel(status) {
    return STATUS_LABELS[status] || status || 'Idle';
}

export function statusIconName(status) {
    return STATUS_ICONS[status] || STATUS_ICONS.idle;
}

export function jobDetail(job, {nowMs = Date.now(), translate = value => value} = {}) {
    const state = job.state || {};
    const status = state.status || 'idle';
    let detail = job.type === 'backup' ? translate('Backup') : translate('Sync');
    if (status === 'running') {
        detail += ` · ${translate('running now')}`;
    } else if (state.lastRunAt) {
        detail += ` · ${translate('last run')} ${formatWhen(state.lastRunAt, nowMs, translate)}`;
        if (state.lastResult)
            detail += ` · ${state.lastResult}`;
    }
    return detail;
}

export function progressView(state) {
    if (state.status === 'running' && state.progress) {
        const progress = state.progress;
        const percent = Number(progress.percent || 0);
        let text = `${percent.toFixed(0)}% · ${formatBytes(progress.bytes)}`;
        if (progress.totalBytes)
            text += ` / ${formatBytes(progress.totalBytes)}`;
        if (progress.eta !== null && progress.eta !== undefined)
            text += ` · ETA ${formatEta(progress.eta)}`;
        return {
            visible: true,
            percent,
            text,
            file: shortFile(progress.currentFile),
            showBar: true,
        };
    }
    if (state.message) {
        return {
            visible: true,
            percent: 0,
            text: state.message,
            file: '',
            showBar: false,
        };
    }
    return {visible: false, percent: 0, text: '', file: '', showBar: false};
}
