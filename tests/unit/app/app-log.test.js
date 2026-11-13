import GLib from 'gi://GLib';
import {AppLog} from '../../../app/observability/app-log.js';
import {assert, assertEqual, cleanup, suite, tempDir, test} from '../../harness.js';

export default suite('app/observability/app-log', [
    test('writes sanitized app logs and reports rotated size', () => {
        const root = tempDir('saveme-app-log');
        try {
            const path = GLib.build_filenamev([root, 'logs', 'app.log']);
            const log = new AppLog({path, maxBytes: 256, maxFiles: 1});
            log.logger.info('token = secret-value');
            log.logger.info('normal line');
            log.close();
            const tail = log.readTail(20);
            assertEqual(tail.includes('secret-value'), false);
            assertEqual(tail.includes('[REDACTED]'), true);
            const info = log.info();
            assertEqual(info.files, 1);
            assertEqual(info.totalBytes > 0, true);
            assertEqual(info.maxBytes, 256);
        } finally {
            cleanup(root);
        }
    }),
    test('clear removes the current file and backups', () => {
        const root = tempDir('saveme-app-clear');
        try {
            const path = GLib.build_filenamev([root, 'app.log']);
            const log = new AppLog({path, maxBytes: 20, maxFiles: 1});
            for (let index = 0; index < 6; index++)
                log.logger.info(`line ${index}`);
            log.close();
            assert(log.info().files > 1);
            log.clear();
            assertEqual(log.info().totalBytes, 0);
            assertEqual(log.info().files, 1);
        } finally {
            cleanup(root);
        }
    }),
    test('sanitizes the current log and rotated backup in place', () => {
        const root = tempDir('saveme-app-sanitize');
        try {
            const path = GLib.build_filenamev([root, 'app.log']);
            const backup = `${path}.1`;
            GLib.file_set_contents(path, 'access_token=live-secret\n');
            GLib.file_set_contents(backup, 'refresh_token=old-secret\n');
            const log = new AppLog({path, maxFiles: 1});
            const result = log.sanitize();
            assertEqual(result.files, 2);
            assertEqual(result.changed, 2);
            const [okLive, live] = GLib.file_get_contents(path);
            const [okOld, old] = GLib.file_get_contents(backup);
            assert(okLive && okOld);
            assert(!new TextDecoder().decode(live).includes('live-secret'));
            assert(!new TextDecoder().decode(old).includes('old-secret'));
            assertEqual(log.sanitize().changed, 0);
        } finally {
            cleanup(root);
        }
    }),
]);
