/**
 * Minimal runtime contracts for the SaveMe ports.
 *
 * JavaScript has no interfaces, so the composition root checks method presence
 * once at startup. Application services depend on these shapes, never on the
 * concrete adapters.
 */

export const PORT_METHODS = Object.freeze({
    transferEngine: ['run', 'runCapture', 'size', 'sizeAsync'],
    fileSystem: [
        'exists',
        'isDirectory',
        'queryType',
        'topLevelEntryCount',
        'relativePath',
        'joinPath',
        'ensureDir',
        'writeText',
        'removeIfExists',
        'freeSpace',
    ],
    clock: ['nowMs', 'nowIso', 'newDate', 'setTimeout', 'clearTimeout'],
    logger: ['debug', 'info', 'warn', 'error', 'child', 'close'],
    stateRepository: ['getJobState', 'setJobState', 'updateProgress'],
    runRepository: ['recordRun', 'getRun', 'listRuns'],
    volumeCatalog: ['resolve', 'volumeName', 'makeDescriptor', 'isAvailable'],
    paths: ['filtersDir', 'logsDir', 'tmpDir', 'join'],
    rawLogFactory: ['create'],
});

export function assertPort(name, value, methods) {
    if (!value || typeof value !== 'object')
        throw new Error(`Invalid ${name} port`);
    for (const method of methods) {
        if (typeof value[method] !== 'function')
            throw new Error(`${name} port is missing ${method}()`);
    }
    return value;
}

export function assertPorts(ports) {
    for (const [name, methods] of Object.entries(PORT_METHODS)) {
        if (ports[name] !== undefined)
            assertPort(name, ports[name], methods);
    }
    return ports;
}
