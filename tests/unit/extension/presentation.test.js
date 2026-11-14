import {
    STATUS_LABELS,
    formatBytes,
    formatEta,
    formatWhen,
    jobDetail,
    progressView,
    shortFile,
    statusIconName,
    statusLabel,
} from '../../../extension/presentation.js';
import {assertEqual, suite, test} from '../../harness.js';

const NOW = Date.parse('2026-01-02T12:00:00Z');

export default suite('extension/presentation', [
    test('status labels and icons cover known and unknown values', () => {
        assertEqual(STATUS_LABELS['waiting-source'], 'Source missing');
        assertEqual(STATUS_LABELS['no-space'], 'Not enough disk space');
        assertEqual(statusLabel('running'), 'Running');
        assertEqual(statusLabel(''), 'Idle');
        assertEqual(statusLabel('custom'), 'custom');
        assertEqual(statusIconName('running'), 'emblem-synchronizing-symbolic');
        assertEqual(statusIconName('disabled'), 'media-playback-pause-symbolic');
        assertEqual(statusIconName('delete-guard'), 'dialog-error-symbolic');
        assertEqual(statusIconName('offline'), 'dialog-warning-symbolic');
        assertEqual(statusIconName('no-space'), 'dialog-warning-symbolic');
        assertEqual(statusIconName('nope'), 'emblem-ok-symbolic');
    }),
    test('byte, relative time and ETA formatting', () => {
        assertEqual(formatBytes(0), '0 B');
        assertEqual(formatBytes(1024), '1.0 KiB');
        assertEqual(formatBytes(1536), '1.5 KiB');
        assertEqual(formatWhen('', NOW), '');
        assertEqual(formatWhen('bad', NOW), '');
        assertEqual(formatWhen('2026-01-02T11:59:40Z', NOW, value => `[${value}]`),
            '[just now]');
        assertEqual(formatWhen('2026-01-02T11:55:00Z', NOW), '5 min');
        assertEqual(formatWhen('2026-01-02T10:00:00Z', NOW), '2 h');
        assertEqual(formatWhen('2025-12-30T12:00:00Z', NOW), '3 d');
        assertEqual(formatEta(-1), '-');
        assertEqual(formatEta(42), '42s');
        assertEqual(formatEta(125), '2m 5s');
        assertEqual(formatEta(3720), '1h 2m');
    }),
    test('shortFile keeps only the basename and truncates long names', () => {
        assertEqual(shortFile(''), '');
        assertEqual(shortFile('/home/user/photos/cat.jpg'), 'cat.jpg');
        assertEqual(shortFile('folder/'), 'folder');
        assertEqual(shortFile('abcdefghij', 5), 'abcd…');
    }),
    test('jobDetail reflects type, running state and the last run', () => {
        assertEqual(jobDetail({type: 'sync'}), 'Sync');
        assertEqual(jobDetail({type: 'backup'}), 'Backup');
        assertEqual(jobDetail({
            type: 'backup',
            state: {status: 'running'},
        }), 'Backup · running now');
        assertEqual(jobDetail({
            type: 'sync',
            state: {
                status: 'idle',
                lastRunAt: '2026-01-02T11:55:00Z',
                lastResult: 'success',
            },
        }, {nowMs: NOW}), 'Sync · last run 5 min · success');
        assertEqual(jobDetail({
            type: 'sync',
            state: {status: 'idle', lastRunAt: '2026-01-02T11:55:00Z'},
        }, {nowMs: NOW, translate: value => value.toUpperCase()}),
        'SYNC · LAST RUN 5 min');
    }),
    test('progressView exposes progress, messages and hidden state', () => {
        const progress = progressView({
            status: 'running',
            progress: {
                percent: 42.6,
                bytes: 1536,
                totalBytes: 3072,
                eta: 125,
                currentFile: '/home/user/file.txt',
            },
        });
        assertEqual(progress.visible, true);
        assertEqual(progress.showBar, true);
        assertEqual(progress.percent, 42.6);
        assertEqual(progress.text, '43% · 1.5 KiB / 3.0 KiB · ETA 2m 5s');
        assertEqual(progress.file, 'file.txt');

        const minimal = progressView({
            status: 'running',
            progress: {percent: 0, bytes: 0, currentFile: '/a/b'},
        });
        assertEqual(minimal.text, '0% · 0 B');
        assertEqual(minimal.file, 'b');

        const message = progressView({status: 'error', message: 'Disk full'});
        assertEqual(message.visible, true);
        assertEqual(message.showBar, false);
        assertEqual(message.text, 'Disk full');
        assertEqual(message.file, '');

        assertEqual(JSON.stringify(progressView({status: 'idle'})),
            JSON.stringify({visible: false, percent: 0, text: '', file: '', showBar: false}));
        assertEqual(progressView({status: 'running'}).visible, false);
    }),
]);
