import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../../src/i18n.js';

export class SettingsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.blockPauseUpdate = false;
        this.blockPolicyUpdate = false;
        this.blockMaxJobsUpdate = false;
        this.blockStartAtLoginUpdate = false;
        this._maxJobsTimer = 0;
        this._policyTimer = 0;

        const daemonGroup = new Adw.PreferencesGroup({title: t('Daemon')});
        this.pauseAllRow = new Adw.SwitchRow({title: t('Pause all jobs')});
        this.pauseAllRow.connect('notify::active', () => {
            if (this.blockPauseUpdate)
                return;
            this.window.client.pauseAll(this.pauseAllRow.active)
                .catch(e => this.window.toast(e.message));
        });
        this.startAtLoginRow = new Adw.SwitchRow({
            title: t('Start automatically at login'),
            subtitle: t('Start enabled jobs when SaveMe starts at login.'),
        });
        this.startAtLoginRow.connect('notify::active', () => {
            if (this.blockStartAtLoginUpdate)
                return;
            this.window.client.updateSettings({
                startAtLogin: this.startAtLoginRow.active,
            }).then(() => this.window.toast(t('Login behaviour updated.')))
                .catch(e => this.window.toast(e.message));
        });
        this.maxJobsRow = new Adw.SpinRow({
            title: t('Concurrent jobs'),
            subtitle: t('How many jobs may transfer at the same time.'),
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 8,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        this.maxJobsRow.connect('notify::value', () => {
            if (!this.blockMaxJobsUpdate)
                this._scheduleConcurrency();
        });
        daemonGroup.add(this.pauseAllRow);
        daemonGroup.add(this.startAtLoginRow);
        daemonGroup.add(this.maxJobsRow);
        this.widget.add(daemonGroup);

        const policyGroup = new Adw.PreferencesGroup({
            title: t('Storage policy'),
            description: t('Logs are cleaned automatically; local jobs respect the free ' +
                'space limits below.'),
        });
        this.retentionRow = new Adw.SpinRow({
            title: t('Keep logs for (days)'),
            subtitle: t('Rotated daemon and run logs older than this are deleted.'),
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 365,
                step_increment: 1,
                page_increment: 7,
            }),
        });
        this.maxSizeRow = new Adw.SpinRow({
            title: t('Maximum total log size (MiB)'),
            subtitle: t('Old log files are removed after this total is reached.'),
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 1024,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        this.diskSafetyRow = new Adw.SpinRow({
            title: t('Disk safety margin (%)'),
            subtitle: t('Percentage of the destination disk kept free for the system.'),
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 50,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        this.minFreeRow = new Adw.SpinRow({
            title: t('Minimum free space (MiB)'),
            subtitle: t('A local job does not start if the destination has less free space.'),
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 10240,
                step_increment: 128,
                page_increment: 512,
            }),
        });
        for (const row of [this.retentionRow, this.maxSizeRow,
            this.diskSafetyRow, this.minFreeRow]) {
            row.connect('notify::value', () => {
                if (!this.blockPolicyUpdate)
                    this._schedulePolicy();
            });
        }
        policyGroup.add(this.retentionRow);
        policyGroup.add(this.maxSizeRow);
        policyGroup.add(this.diskSafetyRow);
        policyGroup.add(this.minFreeRow);
        this.widget.add(policyGroup);
    }

    update(snapshot) {
        const settings = snapshot.settings || {};
        this.blockPauseUpdate = true;
        this.pauseAllRow.active = Boolean(snapshot.pausedAll);
        this.blockPauseUpdate = false;
        this.blockStartAtLoginUpdate = true;
        this.startAtLoginRow.active = settings.startAtLogin !== false;
        this.blockStartAtLoginUpdate = false;
        this.blockMaxJobsUpdate = true;
        this.maxJobsRow.value = Math.max(1,
            Math.min(8, Number(settings.maxConcurrentJobs ?? 2)));
        this.blockMaxJobsUpdate = false;
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

    _scheduleConcurrency() {
        if (this._maxJobsTimer)
            GLib.source_remove(this._maxJobsTimer);
        this._maxJobsTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._maxJobsTimer = 0;
            this._saveConcurrency();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _saveConcurrency() {
        try {
            await this.window.client.updateSettings({
                maxConcurrentJobs: Math.round(this.maxJobsRow.value),
            });
        } catch (e) {
            this.window.toast(t('Cannot update concurrency: {message}',
                {message: e.message}));
        }
    }

    _schedulePolicy() {
        if (this._policyTimer)
            GLib.source_remove(this._policyTimer);
        this._policyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._policyTimer = 0;
            this._savePolicy();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _savePolicy() {
        try {
            await this.window.client.updateSettings({
                logRetentionDays: Math.round(this.retentionRow.value),
                maxLogTotalBytes: Math.round(this.maxSizeRow.value) * 1024 * 1024,
                diskSafetyPercent: Math.round(this.diskSafetyRow.value),
                minFreeSpaceMb: Math.round(this.minFreeRow.value),
            });
        } catch (e) {
            this.window.toast(t('Cannot save storage policy: {message}',
                {message: e.message}));
        }
    }
}
