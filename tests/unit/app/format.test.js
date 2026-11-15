import {
    RESULT_LABELS,
    STATUS_LABELS,
    backupRootDisplay,
    cleanError,
    displayStatus,
    formatBytes,
    formatDateTime,
    formatEta,
    formatWhen,
    remoteTypeLabel,
    resultClass,
    runDuration,
    statusIconName,
    statusLabel,
    truncate,
    typeLabel,
} from '../../../app/presentation/format.js';
import {assertEqual, suite, test} from '../../harness.js';

const NOW = Date.parse('2026-01-02T12:00:00Z');

export default suite('app/presentation/format', [
    test('byte, duration and ETA formatting', () => {
        assertEqual(formatBytes(0), '0 B');
        assertEqual(formatBytes(1023), '1023 B');
        assertEqual(formatBytes(1024), '1.0 KiB');
        assertEqual(formatBytes(1536), '1.5 KiB');
        assertEqual(formatBytes(1024 ** 3), '1.0 GiB');
        assertEqual(formatEta(-1), '-');
        assertEqual(formatEta(Number.NaN), '-');
        assertEqual(formatEta(42), '42s');
        assertEqual(formatEta(125), '2m 5s');
        assertEqual(formatEta(3720), '1h 2m');
        assertEqual(runDuration({
            startedAt: '2026-01-02T12:00:00Z',
            finishedAt: '2026-01-02T12:00:42Z',
        }), '42s');
        assertEqual(runDuration({
            startedAt: '2026-01-02T12:00:00Z',
            finishedAt: '2026-01-02T12:02:05Z',
        }), '2m 5s');
        assertEqual(runDuration({
            startedAt: '2026-01-02T12:00:00Z',
            finishedAt: '2026-01-02T13:03:00Z',
        }), '1h 3m');
        assertEqual(runDuration({}), '');
        assertEqual(runDuration({startedAt: 'bad', finishedAt: 'bad'}), '');
    }),
    test('relative timestamps use the supplied clock', () => {
        assertEqual(formatWhen('', NOW), '');
        assertEqual(formatWhen('not-a-date', NOW), '');
        assertEqual(formatWhen('2026-01-02T11:59:40Z', NOW), 'just now');
        assertEqual(formatWhen('2026-01-02T11:55:00Z', NOW), '5 min ago');
        assertEqual(formatWhen('2026-01-02T10:00:00Z', NOW), '2 h ago');
        assertEqual(formatWhen('2025-12-30T12:00:00Z', NOW), '3 d ago');
    }),
    test('display status exposes checking and queue phases', () => {
        assertEqual(displayStatus('running', 'checking'), 'checking');
        assertEqual(displayStatus('running', 'syncing'), 'running');
        assertEqual(displayStatus('running', 'cleanup'), 'finalizing');
        assertEqual(displayStatus('queued'), 'queued');
        assertEqual(displayStatus('stopped'), 'stopped');
        assertEqual(displayStatus(null), 'idle');
        assertEqual(formatDateTime('2026-11-15T12:30:00'), '15/11/2026 12:30');
        assertEqual(formatDateTime(''), '');
        assertEqual(cleanError(
            'GDBus.Error:org.gnome.gjs.JS.Error: Job is already running.'),
        'Job is already running.');
        assertEqual(cleanError('plain error'), 'plain error');
    }),
    test('labels and icons map every job status', () => {
        assertEqual(statusLabel('running'), 'Running');
        assertEqual(statusLabel('queued'), 'Queued');
        assertEqual(statusLabel('checking'), 'Checking');
        assertEqual(statusLabel('waiting-source'), 'Source missing');
        assertEqual(statusLabel('no-space'), 'Not enough disk space');
        assertEqual(statusLabel('unknown'), 'unknown');
        assertEqual(statusLabel(''), 'Idle');
        assertEqual(STATUS_LABELS.disabled, 'Disabled');
        assertEqual(RESULT_LABELS.noop, 'No changes');
        assertEqual(statusIconName('error'), 'dialog-error-symbolic');
        assertEqual(statusIconName('needs-auth'), 'dialog-error-symbolic');
        assertEqual(statusIconName('delete-guard'), 'dialog-error-symbolic');
        assertEqual(statusIconName('running'), 'emblem-synchronizing-symbolic');
        assertEqual(statusIconName('paused'), 'media-playback-pause-symbolic');
        assertEqual(statusIconName('queued'), 'appointment-soon-symbolic');
        assertEqual(statusIconName('disabled'), 'media-playback-pause-symbolic');
        assertEqual(statusIconName('waiting-destination'), 'dialog-warning-symbolic');
        assertEqual(statusIconName('offline'), 'dialog-warning-symbolic');
        assertEqual(statusIconName('no-space'), 'dialog-warning-symbolic');
        assertEqual(statusIconName('idle'), 'emblem-ok-symbolic');
        assertEqual(statusIconName('unknown'), 'emblem-ok-symbolic');
        assertEqual(typeLabel('backup'), 'Backup');
        assertEqual(typeLabel('sync'), 'Sync');
        assertEqual(remoteTypeLabel('drive'), 'Google Drive');
        assertEqual(remoteTypeLabel('onedrive'), 'Microsoft OneDrive');
        assertEqual(remoteTypeLabel('dropbox'), 'Dropbox');
        assertEqual(remoteTypeLabel('s3'), 's3');
    }),
    test('result classes and text truncation', () => {
        assertEqual(resultClass('error'), 'saveme-status-error');
        assertEqual(resultClass('cancelled'), 'saveme-status-paused');
        assertEqual(resultClass('success'), 'saveme-status-idle');
        assertEqual(truncate('short', 10), 'short');
        assertEqual(truncate('abcdef', 5), 'abcd…');
        assertEqual(truncate(null, 5), '');
    }),
    test('backup root display handles local and remote destinations', () => {
        assertEqual(backupRootDisplay({
            id: 'job_1',
            destination: {kind: 'local', path: '/dst/'},
        }), '/dst/SaveMe/job_1');
        assertEqual(backupRootDisplay({
            id: 'job_1',
            destination: {kind: 'remote', remote: 'drive', path: 'backups/'},
        }), 'drive:backups/SaveMe/job_1');
        assertEqual(backupRootDisplay({
            id: 'job_1',
            destination: {kind: 'remote', remote: 'drive', path: ''},
        }), 'drive:SaveMe/job_1');
    }),
]);
