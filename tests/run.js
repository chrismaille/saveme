import GLib from 'gi://GLib';
import system from 'system';
import {removeRecursive} from '../src/util.js';
import utilSuite from './unit/util.test.js';
import jobsSuite from './unit/jobs.test.js';
import queueSuite from './unit/queue.test.js';
import configSuite from './unit/config.test.js';
import objectSuite from './unit/domain/object.test.js';
import timeSuite from './unit/domain/time.test.js';
import backupLayoutSuite from './unit/domain/backup-layout.test.js';
import deleteGuardSuite from './unit/domain/delete-guard.test.js';
import retentionSuite from './unit/domain/retention.test.js';
import changeBatcherSuite from './unit/domain/change-batcher.test.js';
import rcloneCommandSuite from './unit/domain/rclone-command.test.js';
import rcloneLogSuite from './unit/domain/rclone-log.test.js';
import jobSuite from './unit/domain/job.test.js';
import runStateSuite from './unit/domain/run-state.test.js';
import errorsSuite from './unit/domain/errors.test.js';
import runnerSuite from './integration/runner.test.js';
import watcherSuite from './integration/watcher.test.js';

const base = GLib.dir_make_tmp('saveme-tests-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${base}/config`, true);
GLib.setenv('XDG_STATE_HOME', `${base}/state`, true);
GLib.setenv('XDG_CACHE_HOME', `${base}/cache`, true);
GLib.setenv('XDG_RUNTIME_DIR', `${base}/run`, true);

const suites = [
    utilSuite,
    jobsSuite,
    queueSuite,
    configSuite,
    objectSuite,
    timeSuite,
    backupLayoutSuite,
    deleteGuardSuite,
    retentionSuite,
    changeBatcherSuite,
    rcloneCommandSuite,
    rcloneLogSuite,
    jobSuite,
    runStateSuite,
    errorsSuite,
    runnerSuite,
    watcherSuite,
];

let passed = 0;
let failed = 0;

for (const suite of suites) {
    print(`# ${suite.name}`);
    for (const test of suite.tests) {
        try {
            await test.fn();
            passed++;
            print(`ok - ${test.name}`);
        } catch (e) {
            failed++;
            print(`not ok - ${test.name}`);
            print(`  ${e.message}`);
            if (e.stack)
                print(e.stack.split('\n').slice(1, 6).join('\n'));
        }
    }
}

removeRecursive(base);
print(`\n${passed} passed, ${failed} failed`);
system.exit(failed > 0 ? 1 : 0);
