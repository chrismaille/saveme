import {RestoreService} from '../../../src/application/restore-service.js';
import {assert, assertEqual, assertThrows, suite, test} from '../../harness.js';
import {FakeTransfer, makeJob} from './fakes.js';

function restoreContext() {
    const transfer = new FakeTransfer();
    const service = new RestoreService({transfer});
    return {transfer, service};
}

export default suite('application/restore-service', [
    test('restores the current backup tree', () => {
        const {transfer, service} = restoreContext();
        const job = makeJob('backup');
        const result = service.restore({
            job,
            destination: '/dst',
            payload: {target: '/restore', path: '', version: '', dryRun: false},
        });
        assertEqual(result.ok, true);
        assertEqual(result.source, '/dst/SaveMe/job_test/current');
        assertEqual(JSON.stringify(transfer.captures[0].slice(0, 3)),
            JSON.stringify(['copy', result.source, '/restore']));
    }),
    test('restores a file from a dated version', () => {
        const {transfer, service} = restoreContext();
        const job = makeJob('backup');
        const version = '20260102T030405-000-run_1';
        const result = service.restore({
            job,
            destination: '/dst',
            payload: {target: '/restore', path: '/a/b.txt', version, dryRun: false},
        });
        assertEqual(result.source,
            `/dst/SaveMe/job_test/versions/${version}/a/b.txt`);
        assertEqual(transfer.captures[0][1], result.source);
    }),
    test('restores a sync destination and supports dry-run', () => {
        const {transfer, service} = restoreContext();
        const result = service.restore({
            job: makeJob('sync'),
            destination: '/dst',
            payload: {target: '/restore', path: '', version: '', dryRun: true},
        });
        assertEqual(result.source, '/dst');
        assert(transfer.captures[0].includes('--dry-run'));
        assertEqual(result.dryRun, true);
    }),
    test('rejects missing targets, unsafe paths and invalid versions', async () => {
        const {service} = restoreContext();
        const job = makeJob('backup');
        await assertThrows(() => service.restore({
            job, destination: '/dst', payload: {},
        }), /target/);
        await assertThrows(() => service.restore({
            job, destination: '/dst', payload: {target: '/restore', path: '../x'},
        }), /Invalid restore path/);
        await assertThrows(() => service.restore({
            job, destination: '/dst', payload: {target: '/restore', version: 'nope'},
        }), /Invalid version name/);
    }),
    test('surfaces transfer failures', async () => {
        const {transfer, service} = restoreContext();
        transfer.captureHandler = () => ({
            exitCode: 7,
            stdout: '',
            stderr: 'restore failed',
            ok: false,
        });
        await assertThrows(() => service.restore({
            job: makeJob('backup'),
            destination: '/dst',
            payload: {target: '/restore'},
        }), /restore failed/);
    }),
    test('rejects missing jobs and uses the exit-code message when stderr is empty', async () => {
        const {transfer, service} = restoreContext();
        await assertThrows(() => service.restore({
            job: null, destination: '/dst', payload: {target: '/restore'},
        }), /Job not found/);
        transfer.captureHandler = () => ({
            exitCode: 7,
            stdout: '',
            stderr: '',
            ok: false,
        });
        await assertThrows(() => service.restore({
            job: makeJob('backup'),
            destination: '/dst',
            payload: {target: '/restore'},
        }), /Restore failed: Fatal error/);
    }),
]);
