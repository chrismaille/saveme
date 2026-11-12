import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
    atomicWriteJson,
    expandUser,
    humanBytes,
    mergeDeep,
    pathsOverlap,
    readJson,
    relativePath,
    versionTimestamp,
} from '../../src/util.js';
import {
    assert,
    assertEqual,
    assertThrows,
    cleanup,
    suite,
    tempDir,
    test,
} from '../harness.js';

export default suite('util', [
    test('pathsOverlap detects nested and equal paths', () => {
        assert(pathsOverlap('/tmp/a', '/tmp/a/b'));
        assert(pathsOverlap('/tmp/a/b', '/tmp/a'));
        assert(pathsOverlap('/tmp/a', '/tmp/a'));
        assert(!pathsOverlap('/tmp/a', '/tmp/ab'));
        assert(!pathsOverlap('/tmp/a', '/tmp/b'));
    }),
    test('relativePath returns paths relative to the root', () => {
        assertEqual(relativePath('/tmp/a', '/tmp/a/b/c'), 'b/c');
        assertEqual(relativePath('/tmp/a', '/tmp/a'), '');
        assertEqual(relativePath('/tmp/a', '/tmp/b'), null);
    }),
    test('expandUser expands ~', () => {
        const home = GLib.get_home_dir();
        assertEqual(expandUser('~'), home);
        assertEqual(expandUser('~/Documents'), `${home}/Documents`);
    }),
    test('versionTimestamp is sortable', () => {
        const date = new Date(2026, 0, 2, 3, 4, 5);
        assertEqual(versionTimestamp(date), '20260102T030405');
    }),
    test('humanBytes formats values', () => {
        assertEqual(humanBytes(1536), '1.5 KiB');
        assertEqual(humanBytes(0), '0 B');
    }),
    test('mergeDeep merges nested objects', () => {
        assertEqual(
            JSON.stringify(mergeDeep({a: {b: 1, c: 2}}, {a: {c: 3}})),
            JSON.stringify({a: {b: 1, c: 3}}));
    }),
    test('atomicWriteJson writes mode 0600 and reads back', async () => {
        const dir = tempDir('saveme-util');
        try {
            const path = GLib.build_filenamev([dir, 'config.json']);
            atomicWriteJson(path, {hello: 'world'}, 0o600);
            assertEqual(readJson(path).hello, 'world');
            const info = Gio.File.new_for_path(path).query_info(
                'unix::mode', Gio.FileQueryInfoFlags.NONE, null);
            assertEqual(info.get_attribute_uint32('unix::mode') & 0o777, 0o600);
        } finally {
            cleanup(dir);
        }
    }),
    test('readJson rejects invalid JSON', async () => {
        const dir = tempDir('saveme-util-json');
        try {
            const path = GLib.build_filenamev([dir, 'bad.json']);
            GLib.file_set_contents(path, '{nope');
            await assertThrows(() => readJson(path), /Invalid JSON/);
        } finally {
            cleanup(dir);
        }
    }),
]);
