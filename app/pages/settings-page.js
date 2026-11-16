import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {LogDialog} from '../log-dialog.js';
import {t} from '../../src/i18n.js';
import {formatBytes, formatWhen} from '../presentation/format.js';

export class SettingsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.blockPauseUpdate = false;
        this.blockPolicyUpdate = false;
        this.blockMaxJobsUpdate = false;
        this.maxJobsDirty = false;
        this.policyDirty = false;
        const daemonGroup = new Adw.PreferencesGroup({title: t('Daemon')});
        this.statusRow = new Adw.ActionRow({title: t('Status'), subtitle: t('Unknown')});
        this.rcloneRow = new Adw.ActionRow({title: 'rclone', subtitle: t('Unknown')});
        this.pauseAllRow = new Adw.SwitchRow({title: t('Pause all jobs')});
        this.pauseAllRow.connect('notify::active', () => {
            if (this.blockPauseUpdate)
                return;
            this.window.client.pauseAll(this.pauseAllRow.active)
                .catch(e => this.window.toast(e.message));
        });
        this.maxJobsRow = new Adw.SpinRow({
            title: t('Concurrent jobs'),
            subtitle: t('jobs running at the same time'),
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 8,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        const applyMaxJobs = new Gtk.Button({
            label: t('Apply'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        applyMaxJobs.connect('clicked', () => this._saveConcurrency());
        this.maxJobsRow.add_suffix(applyMaxJobs);
        this.maxJobsRow.connect('notify::value', () => {
            if (!this.blockMaxJobsUpdate)
                this.maxJobsDirty = true;
        });
        this.doctorRow = new Adw.ActionRow({
            title: t('Diagnostics'),
            subtitle: t('Check rclone, configuration and volumes.'),
        });
        const doctorButton = new Gtk.Button({
            label: t('Run doctor'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        doctorButton.connect('clicked', () => this._runDoctor());
        this.doctorRow.add_suffix(doctorButton);
        this.logsRow = new Adw.ActionRow({
            title: t('Log files'),
            subtitle: t('Open the log folder.'),
        });
        const logsButton = new Gtk.Button({
            label: t('Open folder'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        logsButton.connect('clicked', () => this._openLogsFolder());
        this.logsRow.add_suffix(logsButton);
        daemonGroup.add(this.statusRow);
        daemonGroup.add(this.rcloneRow);
        daemonGroup.add(this.pauseAllRow);
        daemonGroup.add(this.maxJobsRow);
        daemonGroup.add(this.doctorRow);
        daemonGroup.add(this.logsRow);
        this.widget.add(daemonGroup);

        const performanceGroup = new Adw.PreferencesGroup({
            title: t('Performance'),
            description: t('Sampled from this app process and written to the application log.'),
        });
        this.memoryRow = new Adw.ActionRow({title: t('App memory'), subtitle: t('Waiting for sample')});
        this.cpuRow = new Adw.ActionRow({title: t('App CPU'), subtitle: t('Waiting for sample')});
        this.daemonMemoryRow = new Adw.ActionRow({
            title: t('Daemon memory'),
            subtitle: t('Waiting for daemon sample'),
        });
        this.machineCpuRow = new Adw.ActionRow({
            title: t('Machine CPU'),
            subtitle: t('Waiting for sample'),
        });
        this.machineMemoryRow = new Adw.ActionRow({
            title: t('Machine memory'),
            subtitle: t('Waiting for sample'),
        });
        this.perfStatusRow = new Adw.ActionRow({title: t('App budget'), subtitle: t('Waiting for sample')});
        this.perfSamplesRow = new Adw.ActionRow({title: t('App samples'), subtitle: '-'});
        performanceGroup.add(this.memoryRow);
        performanceGroup.add(this.cpuRow);
        performanceGroup.add(this.daemonMemoryRow);
        performanceGroup.add(this.machineCpuRow);
        performanceGroup.add(this.machineMemoryRow);
        performanceGroup.add(this.perfStatusRow);
        performanceGroup.add(this.perfSamplesRow);
        this.widget.add(performanceGroup);

        const policyGroup = new Adw.PreferencesGroup({
            title: t('Storage policy'),
            description: t('Logs are sanitized and cleaned automatically; local syncs respect free space.'),
        });
        this.retentionRow = new Adw.SpinRow({
            title: t('Keep logs for'),
            subtitle: t('days'),
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 365,
                step_increment: 1,
                page_increment: 7,
            }),
        });
        this.maxSizeRow = new Adw.SpinRow({
            title: t('Maximum total log size'),
            subtitle: 'MiB',
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 1024,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        for (const row of [this.retentionRow, this.maxSizeRow]) {
            row.connect('notify::value', () => {
                if (!this.blockPolicyUpdate)
                    this.policyDirty = true;
            });
        }
        this.diskSafetyRow = new Adw.SpinRow({
            title: t('Disk safety margin'),
            subtitle: '%',
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 50,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        this.minFreeRow = new Adw.SpinRow({
            title: t('Minimum free space'),
            subtitle: 'MiB',
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 10240,
                step_increment: 128,
                page_increment: 512,
            }),
        });
        for (const row of [this.diskSafetyRow, this.minFreeRow]) {
            row.connect('notify::value', () => {
                if (!this.blockPolicyUpdate)
                    this.policyDirty = true;
            });
        }
        this.savePolicyRow = new Adw.ActionRow({
            title: t('Apply storage policy'),
            subtitle: t('Save retention, log size and disk safety limits to the daemon.'),
        });
        const savePolicyButton = new Gtk.Button({
            label: t('Save'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        savePolicyButton.connect('clicked', () => this._saveLogPolicy());
        this.savePolicyRow.add_suffix(savePolicyButton);
        policyGroup.add(this.retentionRow);
        policyGroup.add(this.maxSizeRow);
        policyGroup.add(this.diskSafetyRow);
        policyGroup.add(this.minFreeRow);
        policyGroup.add(this.savePolicyRow);
        this.widget.add(policyGroup);

        const aboutGroup = new Adw.PreferencesGroup({title: t('About')});
        this.versionRow = new Adw.ActionRow({title: t('Version')});
        aboutGroup.add(this.versionRow);
        this.widget.add(aboutGroup);
    }

    update(snapshot) {
        const daemon = snapshot.daemon || {};
        this.statusRow.set_subtitle(t('Running · PID {pid} · started {when}', {
            pid: daemon.pid ?? '?',
            when: formatWhen(daemon.startedAt),
        }));
        this.rcloneRow.set_subtitle(
            `${daemon.rclone?.version || t('unknown')} · ${daemon.rclone?.path || '-'}`);
        const process = daemon.process;
        this.daemonMemoryRow.set_subtitle(process
            ? `${formatBytes(process.rssBytes)} · ${t('peak')} ${formatBytes(process.peakRssBytes)}`
            : t('Waiting for daemon sample'));
        const system = snapshot.system;
        this.machineCpuRow.set_subtitle(system
            ? `${Number(system.cpuPercent).toFixed(1)}%`
            : t('Waiting for sample'));
        this.machineMemoryRow.set_subtitle(system?.memory
            ? `${formatBytes(system.memory.usedBytes)} / ${formatBytes(system.memory.totalBytes)}`
            : t('Waiting for sample'));
        this.blockPauseUpdate = true;
        this.pauseAllRow.active = Boolean(snapshot.pausedAll);
        this.blockPauseUpdate = false;
        this.versionRow.set_subtitle(snapshot.version || '-');
        const settings = snapshot.settings || {};
        if (!this.maxJobsDirty) {
            this.blockMaxJobsUpdate = true;
            this.maxJobsRow.value = Math.max(1,
                Math.min(8, Number(settings.maxConcurrentJobs ?? 1)));
            this.blockMaxJobsUpdate = false;
        }
        if (!this.policyDirty) {
            this.blockPolicyUpdate = true;
            this.retentionRow.value = Number(settings.logRetentionDays ?? 30);
            this.maxSizeRow.value = Math.max(1,
                Math.round(Number(settings.maxLogTotalBytes ?? 50 * 1024 * 1024) /
                    (1024 * 1024)));
            this.diskSafetyRow.value = Math.max(0,
                Math.round(Number(settings.diskSafetyPercent ?? 10)));
            this.minFreeRow.value = Math.max(0,
                Math.round(Number(settings.minFreeSpaceMb ?? 512)));
            this.blockPolicyUpdate = false;
        }
    }

    updatePerformance(metrics) {
        if (!metrics) {
            this.memoryRow.set_subtitle(t('Waiting for sample'));
            this.cpuRow.set_subtitle(t('Waiting for sample'));
            this.perfStatusRow.set_subtitle(t('Waiting for sample'));
            this.perfSamplesRow.set_subtitle('-');
            return;
        }
        this.memoryRow.set_subtitle(
            `${formatBytes(metrics.rssBytes)} · ${t('peak')} ${formatBytes(metrics.peakRssBytes)}`);
        this.cpuRow.set_subtitle(`${metrics.cpuPercent.toFixed(1)}%`);
        this.perfStatusRow.set_subtitle(metrics.budgetExceeded
            ? t('Budget exceeded — check the application log')
            : t('Within budget'));
        this.perfSamplesRow.set_subtitle(
            `${metrics.samples} · ${t('last sample')} ${formatWhen(metrics.sampledAt)}`);
    }

    async _saveConcurrency() {
        try {
            await this.window.client.updateSettings({
                maxConcurrentJobs: Math.round(this.maxJobsRow.value),
            });
            this.maxJobsDirty = false;
            this.window.toast(t('Concurrency updated.'));
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    async _saveLogPolicy() {
        try {
            await this.window.client.updateSettings({
                logRetentionDays: Math.round(this.retentionRow.value),
                maxLogTotalBytes: Math.round(this.maxSizeRow.value) * 1024 * 1024,
                diskSafetyPercent: Math.round(this.diskSafetyRow.value),
                minFreeSpaceMb: Math.round(this.minFreeRow.value),
            });
            this.policyDirty = false;
            this.window.toast(t('Storage policy saved.'));
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    async _runDoctor() {
        try {
            const data = await this.window.client.doctor();
            new LogDialog(this.window, t('Doctor'), JSON.stringify(data, null, 2)).present();
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    _openLogsFolder() {
        const path = GLib.build_filenamev([GLib.get_user_state_dir(), 'saveme', 'logs']);
        try {
            this.window.launcher.openPath(path);
        } catch (e) {
            this.window.toast(e.message);
        }
    }
}
