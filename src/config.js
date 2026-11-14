import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    configBackupFile,
    configDir,
    configFile,
    filtersDir,
    logsDir,
    rcloneConfigFile,
    runsDir,
    stateDir,
    tmpDir,
} from './paths.js';
import {
    atomicWriteJson,
    copyFile,
    ensureDir,
    mergeDeep,
    nowIso,
    readJson,
} from './util.js';
import {cloneJob, defaultJob, descriptorKey, jobRemoteNames, normalizeJob, validateJob} from './jobs.js';
import {DEFAULT_LOG_POLICY} from './domain/log-policy.js';
import {DEFAULT_DISK_GUARD} from './domain/disk-space.js';

export const CONFIG_VERSION = 1;

export function defaultConfig() {
    return {
        version: CONFIG_VERSION,
        settings: {
            notifications: true,
            startAtLogin: true,
            maxConcurrentJobs: 1,
            pollIntervalMinutes: 5,
            reconcileIntervalHours: 24,
            language: 'system',
            logRetentionDays: DEFAULT_LOG_POLICY.retentionDays,
            maxLogTotalBytes: DEFAULT_LOG_POLICY.maxTotalBytes,
            diskSafetyPercent: DEFAULT_DISK_GUARD.safetyPercent,
            minFreeSpaceMb: DEFAULT_DISK_GUARD.minimumFreeBytes / (1024 * 1024),
        },
        remotes: [],
        jobs: [],
    };
}

export class ConfigStore {
    constructor({path = configFile(), backupPath = configBackupFile(), logger = null} = {}) {
        this.path = path;
        this.backupPath = backupPath;
        this.logger = logger;
        this.data = null;
    }

    ensureDirs() {
        ensureDir(configDir(), 0o700);
        ensureDir(stateDir(), 0o700);
        ensureDir(runsDir(), 0o700);
        ensureDir(logsDir(), 0o700);
        ensureDir(filtersDir(), 0o700);
        ensureDir(tmpDir(), 0o700);
        const rcloneFile = Gio.File.new_for_path(rcloneConfigFile());
        if (!rcloneFile.query_exists(null)) {
            rcloneFile.replace_contents('', null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        }
        try {
            rcloneFile.set_attribute_uint32('unix::mode', 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            // Best effort.
        }
    }

    load() {
        this.ensureDirs();
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS)) {
            this.data = defaultConfig();
            this.save();
            return this.data;
        }
        try {
            const raw = readJson(this.path);
            this.data = this._normalize(raw);
        } catch (e) {
            this.logger?.warn(`Cannot read config: ${e.message}`);
            if (GLib.file_test(this.backupPath, GLib.FileTest.EXISTS)) {
                this.logger?.warn('Restoring config from backup');
                this.data = this._normalize(readJson(this.backupPath));
            } else {
                throw e;
            }
        }
        this._validateConfig();
        return this.data;
    }

    _normalize(raw) {
        const config = mergeDeep(defaultConfig(), raw || {});
        config.version = CONFIG_VERSION;
        config.remotes = Array.isArray(config.remotes) ? config.remotes : [];
        config.jobs = Array.isArray(config.jobs) ? config.jobs.map(normalizeJob) : [];
        return config;
    }

    _validateConfig() {
        const errors = [];
        const remoteNames = new Set();
        for (const remote of this.data.remotes) {
            if (!remote.name)
                errors.push('Remote sem nome.');
            else if (remoteNames.has(remote.name))
                errors.push(`Remote duplicado: ${remote.name}`);
            remoteNames.add(remote.name);
        }
        const jobIds = new Set();
        const destinations = new Map();
        for (const job of this.data.jobs) {
            if (!job.id)
                errors.push('Job sem id.');
            else if (jobIds.has(job.id))
                errors.push(`Job duplicado: ${job.id}`);
            jobIds.add(job.id);
            const jobErrors = validateJob(job, {remotes: [...remoteNames]});
            for (const error of jobErrors)
                errors.push(`${job.name || job.id}: ${error}`);
            const key = descriptorKey(job.destination);
            const other = destinations.get(key);
            if (other && !(other.type === 'backup' && job.type === 'backup')) {
                errors.push(`${job.name || job.id}: destination already used by ` +
                    `${other.name || other.id}`);
            } else if (!other) {
                destinations.set(key, job);
            }
        }
        if (errors.length > 0)
            throw new Error(`Invalid configuration:\n${errors.join('\n')}`);
    }

    save() {
        if (!this.data)
            throw new Error('Config not loaded');
        this.ensureDirs();
        if (GLib.file_test(this.path, GLib.FileTest.EXISTS)) {
            try {
                copyFile(this.path, this.backupPath);
            } catch (e) {
                this.logger?.warn(`Cannot create config backup: ${e.message}`);
            }
        }
        atomicWriteJson(this.path, this.data, 0o600);
    }

    get settings() {
        return this.data.settings;
    }

    updateSettings(patch) {
        this.data.settings = mergeDeep(this.data.settings, patch);
        this.save();
        return this.data.settings;
    }

    listJobs() {
        return this.data.jobs.map(cloneJob);
    }

    getJob(id) {
        const job = this.data.jobs.find(item => item.id === id);
        return job ? cloneJob(job) : null;
    }

    addJob(input) {
        const job = normalizeJob({...defaultJob(), ...input});
        const errors = validateJob(job, {remotes: this.listRemoteNames()});
        if (errors.length > 0)
            throw new Error(errors.join('\n'));
        if (this.data.jobs.some(item => item.id === job.id))
            throw new Error(`Job already exists: ${job.id}`);
        this._checkDestinationUnique(job);
        this.data.jobs.push(job);
        this.save();
        return cloneJob(job);
    }

    updateJob(id, patch) {
        const index = this.data.jobs.findIndex(item => item.id === id);
        if (index < 0)
            throw new Error(`Job not found: ${id}`);
        const merged = normalizeJob(mergeDeep(this.data.jobs[index], patch));
        merged.id = id;
        merged.updatedAt = nowIso();
        const errors = validateJob(merged, {remotes: this.listRemoteNames()});
        if (errors.length > 0)
            throw new Error(errors.join('\n'));
        this._checkDestinationUnique(merged, id);
        this.data.jobs[index] = merged;
        this.save();
        return cloneJob(merged);
    }

    _checkDestinationUnique(job, excludeId = null) {
        const key = descriptorKey(job.destination);
        const other = this.data.jobs.find(item =>
            item.id !== excludeId && descriptorKey(item.destination) === key);
        if (other && !(other.type === 'backup' && job.type === 'backup'))
            throw new Error(`Destination already used by job: ${other.name || other.id}`);
    }

    removeJob(id) {
        const index = this.data.jobs.findIndex(item => item.id === id);
        if (index < 0)
            throw new Error(`Job not found: ${id}`);
        const [removed] = this.data.jobs.splice(index, 1);
        this.save();
        return removed;
    }

    setJobEnabled(id, enabled) {
        return this.updateJob(id, {enabled: Boolean(enabled)});
    }

    listRemotes() {
        return this.data.remotes.map(remote => ({...remote}));
    }

    listRemoteNames() {
        return this.data.remotes.map(remote => remote.name);
    }

    getRemote(name) {
        const remote = this.data.remotes.find(item => item.name === name);
        return remote ? {...remote} : null;
    }

    addRemote(input) {
        const remote = {
            name: String(input.name || '').trim(),
            type: String(input.type || '').trim(),
            label: String(input.label || input.name || '').trim(),
            account: String(input.account || '').trim(),
            options: input.options && typeof input.options === 'object'
                ? {...input.options}
                : {},
            createdAt: nowIso(),
            updatedAt: nowIso(),
        };
        if (!/^[A-Za-z0-9_.-]+$/.test(remote.name))
            throw new Error('Remote name must contain only letters, numbers, dot, dash or underscore.');
        if (!['drive', 'onedrive', 'dropbox'].includes(remote.type))
            throw new Error(`Unsupported remote type: ${remote.type}`);
        if (this.data.remotes.some(item => item.name === remote.name))
            throw new Error(`Remote already exists: ${remote.name}`);
        this.data.remotes.push(remote);
        this.save();
        return {...remote};
    }

    updateRemote(name, patch) {
        const remote = this.data.remotes.find(item => item.name === name);
        if (!remote)
            throw new Error(`Remote not found: ${name}`);
        Object.assign(remote, patch, {name, updatedAt: nowIso()});
        this.save();
        return {...remote};
    }

    removeRemote(name) {
        const users = this.data.jobs.filter(job => jobRemoteNames(job).includes(name));
        if (users.length > 0)
            throw new Error(`Remote ${name} is used by jobs: ${users.map(job => job.name).join(', ')}`);
        const index = this.data.remotes.findIndex(item => item.name === name);
        if (index < 0)
            throw new Error(`Remote not found: ${name}`);
        this.data.remotes.splice(index, 1);
        this.save();
    }
}
