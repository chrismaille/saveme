import {GioFileSystem} from '../adapters/gio/file-system.js';
import {GioRawLogFactory} from '../adapters/gio/raw-log.js';
import {StateRunRepository} from '../adapters/persistence/run-repository.js';
import {SystemClock} from '../adapters/system/clock.js';
import {SystemPaths} from '../adapters/system/paths.js';
import {assertPorts} from '../ports/index.js';
import {BackupService} from '../application/backup-service.js';
import {RestoreService} from '../application/restore-service.js';
import {RunCoordinator} from '../application/run-coordinator.js';
import {RunExecutor} from '../application/run-executor.js';
import {SyncService} from '../application/sync-service.js';
import {JobRunner} from '../runner.js';
import {uniqueId} from '../util.js';

export function createJobRunner({
    rclone,
    volumes,
    logger,
    state,
    files = new GioFileSystem(),
    clock = new SystemClock(),
    paths = new SystemPaths(),
    rawLogFactory = new GioRawLogFactory(),
    idFactory = prefix => uniqueId(prefix),
} = {}) {
    const runRepository = new StateRunRepository({state});
    assertPorts({
        transferEngine: rclone,
        fileSystem: files,
        clock,
        logger,
        stateRepository: state,
        runRepository,
        volumeCatalog: volumes,
        paths,
        rawLogFactory,
    });

    const executor = new RunExecutor({
        transfer: rclone,
        files,
        logger,
        state,
        runRepository,
        clock,
        paths,
        rawLogFactory,
        idFactory,
    });
    const sync = new SyncService({executor, files, volumes});
    const backup = new BackupService({executor, files, volumes});
    const coordinator = new RunCoordinator({sync, backup});
    return new JobRunner({coordinator, volumes});
}

export function createRestoreService({rclone}) {
    return new RestoreService({transfer: rclone});
}
