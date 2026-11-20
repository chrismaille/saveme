#!/usr/bin/env -S gjs -m

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import system from 'system';
import {Logger} from '../src/adapters/system/logger.js';
import {ConfigStore} from '../src/adapters/persistence/config-repository.js';
import {StateStore} from '../src/adapters/persistence/state-repository.js';
import {VolumeResolver} from '../src/adapters/gio/volume-catalog.js';
import {RcloneTransferEngine as Rclone} from '../src/adapters/rclone/transfer-engine.js';
import {createJobRunner} from '../src/composition/runner.js';
import {RecursiveWatcher, WatcherLimitError, getInotifyLimit} from '../src/adapters/gio/watcher.js';
import {ChangeQueue} from '../src/queue.js';
import {
    JOB_TYPES,
    TRIGGER_MODES,
    descriptorFromString,
    descriptorDisplay,
    localPathFor,
} from '../src/jobs.js';
import {
    DAEMON_BUS_NAME,
    DAEMON_INTERFACE,
    DAEMON_OBJECT_PATH,
    EXTENSION_UUID,
    rcloneConfigFile,
    configDir,
    logsDir,
    filtersDir,
    stateDir,
    tmpDir,
} from '../src/paths.js';
import {humanBytes, removeRecursive, sleep} from '../src/util.js';

const VERSION = '1.0.0-dev';
const BOOLEAN_OPTIONS = new Set([
    'dry-run', 'force', 'help', 'no-initial', 'verbose', 'json',
    'purge', 'yes',
]);

const USAGE = `SaveMe ${VERSION}

Usage:
  saveme                  Open the SaveMe application
  saveme doctor
  saveme status
  saveme job list
  saveme job add --name NAME --type sync|backup --source PATH --dest PATH [options]
  saveme job remove ID
  saveme job enable ID
  saveme job disable ID
  saveme run ID [--dry-run] [--force]
  saveme watch ID [--no-initial] [--force]
  saveme uninstall [--purge] --yes
  saveme version

Common options:
  --config-dir PATH   Override config directory (mainly for tests)
  --state-dir PATH    Override state directory (mainly for tests)
  --verbose           Debug logging
  --help              Show this help
`;

function parseArgs(argv) {
    const options = {_: []};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            if (BOOLEAN_OPTIONS.has(key)) {
                options[key] = true;
                continue;
            }
            const value = argv[++i];
            if (value === undefined)
                throw new Error(`Missing value for --${key}`);
            if (key === 'exclude')
                (options.exclude ??= []).push(value);
            else
                options[key] = value;
        } else {
            options._.push(arg);
        }
    }
    return options;
}

function makeContext(options) {
    const logger = new Logger({
        name: 'saveme',
        level: options.verbose ? 'debug' : 'info',
        echo: true,
    });
    const config = new ConfigStore({logger});
    config.load();
    const state = new StateStore({logger});
    state.load();
    const volumes = new VolumeResolver();
    const rclone = new Rclone({
        configPath: rcloneConfigFile(),
        logger,
    });
    const runner = createJobRunner({
        rclone,
        volumes,
        logger,
        state,
        getSettings: () => config.settings,
    });
    return {logger, config, state, volumes, rclone, runner};
}

function printJob(job, state, volumes) {
    const jobState = state.getJobState(job.id);
    print(`${job.id}`);
    print(`  name:        ${job.name}`);
    print(`  type:        ${job.type}`);
    print(`  enabled:     ${job.enabled ? 'yes' : 'no'}`);
    print(`  source:      ${descriptorDisplay(job.source, volumes)}`);
    print(`  destination: ${descriptorDisplay(job.destination, volumes)}`);
    print(`  trigger:     ${job.trigger.mode}`);
    print(`  status:      ${jobState.status}${jobState.message ? ` (${jobState.message})` : ''}`);
    print(`  last run:    ${jobState.lastRunAt || '-'} ${jobState.lastResult || ''}`);
    print('');
}

function printRun(run) {
    print(`Run ${run.id}: ${run.result}`);
    print(`  files:   ${run.stats.transfers}`);
    print(`  bytes:   ${humanBytes(run.stats.bytes)}`);
    print(`  deletes: ${run.stats.deletes}`);
    print(`  errors:  ${run.stats.errors}`);
    if (run.message)
        print(`  message: ${run.message}`);
    print(`  log:     ${run.logFile}`);
    if (run.versionsDir)
        print(`  versions:${run.versionsDir}`);
}

function progressPrinter() {
    let last = 0;
    return progress => {
        const now = Date.now();
        if (now - last < 2000)
            return;
        last = now;
        const current = progress.currentFile ? ` ${progress.currentFile}` : '';
        print(`${progress.phase}: ${progress.percent.toFixed(1)}% ` +
            `(${progress.files}/${progress.totalFiles} files, ` +
            `${humanBytes(progress.bytes)})${current}`);
    };
}

async function commandDoctor(options) {
    const {logger, config, state, volumes, rclone} = makeContext(options);
    print(`SaveMe ${VERSION}`);
    print(`GJS: ${imports.system.version}`);
    print(`Config: ${configDir()}`);
    print(`State:  ${stateDir()}`);
    print(`rclone: ${rclone.binary}`);
    try {
        const version = rclone.getVersion();
        print(`rclone version: ${version.text}`);
        if (!rclone.checkVersion('1.60.0'))
            print('WARN: rclone is older than 1.60.0');
    } catch (e) {
        print(`ERROR: ${e.message}`);
    }
    print(`inotify max_user_watches: ${getInotifyLimit()}`);
    print(`Volumes: ${volumes.list().length}`);
    for (const volume of volumes.list())
        print(`  ${volume.name} ${volume.uuid} ${volume.mountPoint}`);
    print(`Jobs: ${config.listJobs().length}`);
    print(`Remotes: ${config.listRemoteNames().join(', ') || '-'}`);
    print(`Paused: ${state.pausedAll ? 'yes' : 'no'}`);
    print(`Logs: ${logger.filePath || '(stderr only)'}`);
}

async function commandStatus(options) {
    const {config, state, volumes} = makeContext(options);
    if (config.listJobs().length === 0) {
        print('No jobs configured. Use "saveme job add ...".');
        return;
    }
    print(`Paused all: ${state.pausedAll ? 'yes' : 'no'}\n`);
    for (const job of config.listJobs())
        printJob(job, state, volumes);
}

async function commandJobList(options) {
    await commandStatus(options);
}

async function commandJobAdd(options) {
    const {config, volumes, logger} = makeContext(options);
    if (!options.name)
        throw new Error('--name is required');
    if (!options.source || !options.dest)
        throw new Error('--source and --dest are required');
    const remotes = config.listRemoteNames();
    const triggerMode = options.trigger || TRIGGER_MODES.REALTIME;
    const job = config.addJob({
        name: options.name,
        type: options.type || JOB_TYPES.SYNC,
        source: descriptorFromString(options.source, {remotes, volumes}),
        destination: descriptorFromString(options.dest, {remotes, volumes}),
        trigger: {
            mode: triggerMode,
            intervalMinutes: Number(options.interval || 0),
        },
        filters: {exclude: options.exclude || []},
        backup: {retentionDays: Number(options.retention ?? 30)},
    });
    logger.info(`Job created: ${job.id}`);
    print(`Created ${job.id}`);
    print(`Preview with: saveme run ${job.id} --dry-run`);
}

async function commandJobRemove(options) {
    const {config} = makeContext(options);
    const id = options._[0];
    if (!id)
        throw new Error('Job id is required');
    config.removeJob(id);
    print(`Removed ${id}`);
}

async function commandJobEnable(options, enabled) {
    const {config} = makeContext(options);
    const id = options._[0];
    if (!id)
        throw new Error('Job id is required');
    config.setJobEnabled(id, enabled);
    print(`${enabled ? 'Enabled' : 'Disabled'} ${id}`);
}

async function commandRun(options) {
    const {config, runner, logger} = makeContext(options);
    const id = options._[0];
    if (!id)
        throw new Error('Job id is required');
    const job = config.getJob(id);
    if (!job)
        throw new Error(`Job not found: ${id}`);
    logger.info(`Running ${job.name}`, {dryRun: Boolean(options['dry-run'])});
    const run = await runner.runFull(job, {
        dryRun: Boolean(options['dry-run']),
        force: Boolean(options.force),
        reason: 'manual',
        onProgress: progressPrinter(),
    });
    printRun(run);
    return run.result === 'success' || run.result === 'noop' ? 0 : 1;
}

async function commandWatch(options) {    const {config, runner, volumes, logger} = makeContext(options);
    const id = options._[0];
    if (!id)
        throw new Error('Job id is required');
    const job = config.getJob(id);
    if (!job)
        throw new Error(`Job not found: ${id}`);
    if (job.source.kind !== 'local')
        throw new Error('watch requires a local source');
    const sourcePath = localPathFor(job.source, volumes);
    if (!sourcePath)
        throw new Error('Cannot resolve source path');

    if (!options['no-initial']) {
        const initial = await runner.runFull(job, {
            reason: 'initial',
            force: Boolean(options.force),
            onProgress: progressPrinter(),
        });
        printRun(initial);
        if (initial.result === 'error')
            return 1;
    }

    let queue = null;
    try {
        const watcher = new RecursiveWatcher({
            rootPath: sourcePath,
            logger,
            onChange: change => queue?.add(change.path, change.kind),
            onUnavailable: () => logger.error('Source became unavailable; stopping watcher'),
        });
        queue = new ChangeQueue({
            logger,
            onFlush: async changes => {
                const run = await runner.runIncremental(job, changes, {
                    force: Boolean(options.force),
                    onProgress: progressPrinter(),
                });
                printRun(run);
            },
        });
        await watcher.start();
        print(`Watching ${sourcePath}. Press Ctrl+C to stop.`);
        await new Promise(() => {});
    } catch (e) {
        if (e instanceof WatcherLimitError) {
            logger.warn(`${e.message}; falling back to polling every 5 minutes`);
            while (true) {
                await sleep(5 * 60 * 1000);
                const run = await runner.runFull(job, {
                    reason: 'poll',
                    force: Boolean(options.force),
                    onProgress: progressPrinter(),
                });
                printRun(run);
            }
        }
        throw e;
    }
}

function runCommand(argv) {
    try {
        const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        process.wait(null);
        return process.get_if_exited() ? process.get_exit_status() : -1;
    } catch (_) {
        return -1;
    }
}

async function quitDaemon() {
    try {
        const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        await new Promise((resolve, reject) => {
            bus.call(
                DAEMON_BUS_NAME,
                DAEMON_OBJECT_PATH,
                DAEMON_INTERFACE,
                'Quit',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                3000,
                null,
                (connection, result) => {
                    try {
                        connection.call_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    } catch (_) {
        // The daemon is not running.
    }
}

async function commandUninstall(options) {
    const purge = Boolean(options.purge);
    if (!options.yes) {
        print('This will stop the SaveMe daemon and remove the GNOME extension.');
        if (purge)
            print('It will also delete configuration, OAuth tokens, logs and history.');
        else
            print('Logs, caches, filters and temporary files will be removed; jobs and configuration will be kept.');
        print('Re-run with --yes to confirm:');
        print(`  saveme uninstall${purge ? ' --purge' : ''} --yes`);
        return 1;
    }

    print('Stopping daemon…');
    await quitDaemon();
    await sleep(300);
    runCommand(['pkill', '-TERM', '-f', '/usr/lib/saveme/app/main.js']);

    print('Disabling systemd user service…');
    runCommand(['systemctl', '--user', 'disable', '--now', 'saveme.service']);

    print('Removing GNOME Shell extension…');
    const extensionExit = runCommand(['gnome-extensions', 'uninstall', EXTENSION_UUID]);
    if (extensionExit !== 0) {
        const extensionDir = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'gnome-shell', 'extensions', EXTENSION_UUID,
        ]);
        if (GLib.file_test(extensionDir, GLib.FileTest.EXISTS)) {
            removeRecursive(extensionDir);
            print(`Removed ${extensionDir}`);
        }
    } else {
        print('Extension removed.');
    }

    if (purge) {
        print('Removing user data…');
        const paths = [
            configDir(),
            stateDir(),
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'saveme']),
            GLib.build_filenamev([
                GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_tmp_dir(),
                'saveme',
            ]),
            GLib.build_filenamev([
                GLib.path_get_dirname(stateDir()),
                'saveme-install.log',
            ]),
        ];
        for (const path of paths) {
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                removeRecursive(path);
                print(`Removed ${path}`);
            }
        }
        print('Configuration, tokens, logs and history removed.');
    } else {
        print('Removing logs, caches, filters and temporary files…');
        const transient = [
            logsDir(),
            tmpDir(),
            filtersDir(),
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'saveme']),
        ];
        const runtime = GLib.build_filenamev([
            GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_tmp_dir(),
            'saveme',
        ]);
        transient.push(runtime);
        for (const path of transient) {
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                removeRecursive(path);
                print(`Removed ${path}`);
            }
        }
        print('Jobs, configuration and state kept at:');
        print(`  ${configDir()}`);
        print(`  ${stateDir()}`);
        print('Use --purge to remove them.');
    }

    print('');
    print('Now remove the system package:');
    print('  sudo apt remove saveme');
    return 0;
}

async function main() {
    const options = parseArgs(system.programArgs);
    if (options.help) {
        print(USAGE);
        return 0;
    }
    const command = options._.shift();
    if (!command || command === 'help') {
        print(USAGE);
        return 0;
    }
    switch (command) {
    case 'version':
        print(VERSION);
        return 0;
    case 'doctor':
        await commandDoctor(options);
        return 0;
    case 'status':
        await commandStatus(options);
        return 0;
    case 'job': {
        const sub = options._.shift();
        if (sub === 'list')
            return await commandJobList(options), 0;
        if (sub === 'add')
            return await commandJobAdd(options), 0;
        if (sub === 'remove')
            return await commandJobRemove(options), 0;
        if (sub === 'enable')
            return await commandJobEnable(options, true), 0;
        if (sub === 'disable')
            return await commandJobEnable(options, false), 0;
        throw new Error(`Unknown job command: ${sub}`);
    }
    case 'run':
        return await commandRun(options);
    case 'watch':
        return await commandWatch(options);
    case 'uninstall':
        return await commandUninstall(options);
    default:
        throw new Error(`Unknown command: ${command}`);
    }
}

try {
    const code = await main();
    system.exit(code ?? 0);
} catch (e) {
    printerr(`saveme: ${e.message}`);
    if (e.stack)
        printerr(e.stack);
    system.exit(1);
}
