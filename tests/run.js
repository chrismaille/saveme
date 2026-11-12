import GLib from 'gi://GLib';
import system from 'system';
import {removeRecursive} from '../src/util.js';
import utilSuite from './unit/util.test.js';
import jobsSuite from './unit/jobs.test.js';
import queueSuite from './unit/queue.test.js';
import configSuite from './unit/config.test.js';
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
