import GLib from 'gi://GLib';
import system from 'system';
import {removeRecursive} from '../src/util.js';
import utilSuite from './unit/util.test.js';
import i18nSuite from './unit/i18n.test.js';
import jobsSuite from './unit/jobs.test.js';import queueSuite from './unit/queue.test.js';
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
import retryPolicySuite from './unit/domain/retry-policy.test.js';
import jobStateMachineSuite from './unit/domain/job-state-machine.test.js';
import errorsSuite from './unit/domain/errors.test.js';
import logPolicySuite from './unit/domain/log-policy.test.js';
import diskSpaceSuite from './unit/domain/disk-space.test.js';
import backupManifestSuite from './unit/domain/backup-manifest.test.js';
import includeFilterSuite from './unit/domain/include-filter.test.js';
import scheduleSuite from './unit/domain/schedule.test.js';
import syncServiceSuite from './unit/application/sync-service.test.js';
import backupServiceSuite from './unit/application/backup-service.test.js';
import restoreServiceSuite from './unit/application/restore-service.test.js';
import runCoordinatorSuite from './unit/application/run-coordinator.test.js';
import runExecutorSuite from './unit/application/run-executor.test.js';
import schedulerSuite from './unit/application/scheduler.test.js';
import daemonServiceSuite from './unit/application/daemon-service.test.js';
import logServiceSuite from './unit/application/log-service.test.js';
import supervisorNotificationsSuite from './unit/application/supervisor-notifications.test.js';
import supervisorScheduleSuite from './unit/application/supervisor-schedule.test.js';
import jobTargetSuite from './unit/application/job-target.test.js';
import changePlannerSuite from './unit/application/change-planner.test.js';
import fileSystemAdapterSuite from './unit/adapters/file-system.test.js';
import systemAdapterSuite from './unit/adapters/system.test.js';
import systemMetricsSuite from './unit/adapters/system-metrics.test.js';
import idleMonitorSuite from './unit/adapters/idle-monitor.test.js';
import dbusApiSuite from './unit/adapters/dbus-api.test.js';
import appFormatSuite from './unit/app/format.test.js';
import appGatewaySuite from './unit/app/daemon-gateway.test.js';
import appLauncherSuite from './unit/app/system-launcher.test.js';
import extensionPresentationSuite from './unit/extension/presentation.test.js';
import extensionDaemonClientSuite from './unit/extension/daemon-client.test.js';
import extensionLauncherSuite from './unit/extension/system-launcher.test.js';
import appProcessMetricsSuite from './unit/app/process-metrics.test.js';
import appMonitorSuite from './unit/app/app-monitor.test.js';
import appLogSuite from './unit/app/app-log.test.js';
import appSoakSuite from './unit/app/soak.test.js';
import runnerSuite from './integration/runner.test.js';
import watcherSuite from './integration/watcher.test.js';
import {setLanguage} from '../src/i18n.js';

setLanguage('en');

const base = GLib.dir_make_tmp('saveme-tests-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', `${base}/config`, true);
GLib.setenv('XDG_STATE_HOME', `${base}/state`, true);
GLib.setenv('XDG_CACHE_HOME', `${base}/cache`, true);
GLib.setenv('XDG_RUNTIME_DIR', `${base}/run`, true);

const suites = [
    utilSuite,
    i18nSuite,
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
    retryPolicySuite,
    jobStateMachineSuite,
    errorsSuite,
    logPolicySuite,
    diskSpaceSuite,
    backupManifestSuite,
    includeFilterSuite,
    scheduleSuite,
    syncServiceSuite,
    backupServiceSuite,
    restoreServiceSuite,
    runCoordinatorSuite,
    runExecutorSuite,
    schedulerSuite,
    daemonServiceSuite,
    logServiceSuite,
    supervisorNotificationsSuite,
    supervisorScheduleSuite,
    jobTargetSuite,
    changePlannerSuite,
    fileSystemAdapterSuite,
    systemAdapterSuite,
    systemMetricsSuite,
    idleMonitorSuite,
    dbusApiSuite,
    appFormatSuite,
    appGatewaySuite,
    appLauncherSuite,
    extensionPresentationSuite,
    extensionDaemonClientSuite,
    extensionLauncherSuite,
    appProcessMetricsSuite,
    appMonitorSuite,
    appLogSuite,
    appSoakSuite,
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
