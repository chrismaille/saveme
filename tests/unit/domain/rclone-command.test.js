import {
    DEFAULT_EXCLUDES,
    backupArgs,
    commonJobArgs,
    copyArgs,
    deleteArgs,
    escapeFilterPath,
    filterRules,
    moveArgs,
    rmdirsArgs,
    syncArgs,
    withDryRun,
    withFastList,
    withMaxDelete,
} from '../../../src/domain/rclone-command.js';
import {assert, assertEqual, suite, test} from '../../harness.js';

function job(overrides = {}) {
    return {
        options: {
            transfers: 4,
            checkers: 8,
            preserveMetadata: false,
            followSymlinks: false,
            bandwidthLimit: '',
            ...overrides.options,
        },
        filters: {exclude: [], ...overrides.filters},
    };
}

export default suite('domain/rclone-command', [
    test('escapes rclone filter metacharacters', () => {
        assertEqual(escapeFilterPath('a\\b*c?d[e]'), 'a\\\\b\\*c\\?d\\[e\\]');
    }),
    test('filterRules adds defaults, custom rules, ignores comments and deduplicates', () => {
        const rules = filterRules(job({
            filters: {
                exclude: ['', '# comment', 'custom', '- explicit', '+ include',
                    'custom', 'custom'],
            },
        }));
        for (const expected of DEFAULT_EXCLUDES)
            assert(rules.includes(`- ${expected}`), expected);
        assert(rules.includes('- custom'));
        assert(rules.includes('- explicit'));
        assert(rules.includes('+ include'));
        assertEqual(rules.filter(rule => rule === '- custom').length, 1);
    }),
    test('filterRules handles missing filters', () => {
        assertEqual(filterRules({}).length, DEFAULT_EXCLUDES.length);
    }),
    test('sync include selection is ordered after excludes', () => {
        const rules = filterRules({
            type: 'sync',
            filters: {
                exclude: ['private/**'],
                include: ['/docs/', 'photos', 'photo[1].jpg'],
            },
            options: {},
        });
        const excludeIndex = rules.indexOf('- private/**');
        const docsIndex = rules.indexOf('+ /docs');
        assert(excludeIndex >= 0);
        assert(docsIndex > excludeIndex);
        assert(rules.includes('+ /docs/**'));
        assert(rules.includes('+ /photos'));
        assert(rules.includes('+ /photo\\[1\\].jpg'));
        assertEqual(rules.at(-1), '- **');
        assertEqual(filterRules({
            type: 'backup',
            filters: {include: ['docs']},
            options: {},
        }).includes('+ /docs'), false);
    }),
    test('commonJobArgs includes copy and optional flags', () => {
        assertEqual(JSON.stringify(commonJobArgs(job(), '/tmp/filter')), JSON.stringify([
            '--filter-from', '/tmp/filter',
            '--transfers', '4',
            '--checkers', '8',
            '--create-empty-src-dirs',
        ]));
        assertEqual(JSON.stringify(commonJobArgs({}, '/tmp/filter')), JSON.stringify([
            '--filter-from', '/tmp/filter',
            '--transfers', '4',
            '--checkers', '8',
            '--create-empty-src-dirs',
        ]));
        assertEqual(JSON.stringify(commonJobArgs({
            options: {transfers: 0, checkers: 0},
        }, '/tmp/filter')), JSON.stringify([
            '--filter-from', '/tmp/filter',
            '--transfers', '4',
            '--checkers', '8',
            '--create-empty-src-dirs',
        ]));
        assertEqual(JSON.stringify(commonJobArgs(job(), '/tmp/filter', {copy: false})),
            JSON.stringify([
                '--filter-from', '/tmp/filter',
                '--transfers', '4',
                '--checkers', '8',
            ]));
        assertEqual(JSON.stringify(commonJobArgs(job({
            options: {
                preserveMetadata: true,
                followSymlinks: true,
                bandwidthLimit: '1M',
            },
        }), '/tmp/filter')), JSON.stringify([
            '--filter-from', '/tmp/filter',
            '--transfers', '4',
            '--checkers', '8',
            '--create-empty-src-dirs',
            '--metadata',
            '--copy-links',
            '--bwlimit', '1M',
        ]));
    }),
    test('builders emit commands in the expected order', () => {
        assertEqual(JSON.stringify(syncArgs('src', 'dst', 'f', job())),
            JSON.stringify(['sync', 'src', 'dst', '--filter-from', 'f',
                '--transfers', '4', '--checkers', '8', '--create-empty-src-dirs']));
        assertEqual(JSON.stringify(syncArgs('src', 'dst', 'f', job(), {copy: false})),
            JSON.stringify(['sync', 'src', 'dst', '--filter-from', 'f',
                '--transfers', '4', '--checkers', '8']));
        assertEqual(JSON.stringify(backupArgs('src', 'current', 'versions', 'f', job())),
            JSON.stringify(['sync', 'src', 'current', '--filter-from', 'f',
                '--transfers', '4', '--checkers', '8', '--create-empty-src-dirs',
                '--backup-dir', 'versions']));
        assertEqual(JSON.stringify(backupArgs('src', 'current', 'versions', 'f', job(), {
            copy: false,
        })), JSON.stringify(['sync', 'src', 'current', '--filter-from', 'f',
            '--transfers', '4', '--checkers', '8', '--backup-dir', 'versions']));
        assertEqual(JSON.stringify(copyArgs('src', 'dst', 'f', job())),
            JSON.stringify(['copy', 'src', 'dst', '--filter-from', 'f',
                '--transfers', '4', '--checkers', '8', '--create-empty-src-dirs']));
        assertEqual(JSON.stringify(copyArgs('src', 'dst', 'f', job(), {
            noTraverse: true,
            backupDir: 'versions',
        })), JSON.stringify(['copy', 'src', 'dst', '--no-traverse',
            '--filter-from', 'f', '--transfers', '4', '--checkers', '8',
            '--create-empty-src-dirs', '--backup-dir', 'versions']));
        assertEqual(JSON.stringify(copyArgs('src', 'dst', 'f', job(), {
            copy: false,
        })), JSON.stringify(['copy', 'src', 'dst', '--filter-from', 'f',
            '--transfers', '4', '--checkers', '8']));
        assertEqual(JSON.stringify(copyArgs('src', 'dst', 'f', job(), {
            copy: true,
        })), JSON.stringify(['copy', 'src', 'dst', '--filter-from', 'f',
            '--transfers', '4', '--checkers', '8', '--create-empty-src-dirs']));
        assertEqual(JSON.stringify(moveArgs('src', 'dst', 'f', job())),
            JSON.stringify(['move', 'src', 'dst', '--filter-from', 'f',
                '--transfers', '4', '--checkers', '8']));
        assertEqual(JSON.stringify(moveArgs('src', 'dst', 'f', job(), {noTraverse: false})),
            JSON.stringify(['move', 'src', 'dst', '--filter-from', 'f',
                '--transfers', '4', '--checkers', '8']));
        assertEqual(JSON.stringify(moveArgs('src', 'dst', 'f', job(), {
            noTraverse: true,
            copy: true,
        })), JSON.stringify(['move', 'src', 'dst', '--no-traverse',
            '--filter-from', 'f', '--transfers', '4', '--checkers', '8',
            '--create-empty-src-dirs']));
        assertEqual(JSON.stringify(deleteArgs('dst', 'f', job())),
            JSON.stringify(['delete', 'dst', '--filter-from', 'f',
                '--transfers', '4', '--checkers', '8']));
        assertEqual(JSON.stringify(rmdirsArgs('dst', 'f', job())),
            JSON.stringify(['rmdirs', 'dst', '--leave-root', '--filter-from', 'f',
                '--transfers', '4', '--checkers', '8']));
    }),
    test('argument decorators append flags', () => {
        assertEqual(JSON.stringify(withDryRun(['sync'])), JSON.stringify(['sync', '--dry-run']));
        assertEqual(JSON.stringify(withFastList(['sync'])), JSON.stringify(['sync', '--fast-list']));
        assertEqual(JSON.stringify(withMaxDelete(['sync'], 0)), JSON.stringify(['sync', '--max-delete', '0']));
    }),
]);
