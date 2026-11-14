import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {GioFileSystem} from '../../../src/adapters/gio/file-system.js';
import {
    assert,
    assertEqual,
    cleanup,
    suite,
    tempDir,
    test,
    writeFile,
} from '../../harness.js';

function path(...parts) {
    return GLib.build_filenamev(parts);
}

export default suite('adapters/gio/file-system', [
    test('detects files, directories and missing paths', () => {
        const root = tempDir('saveme-fs');
        try {
            const dir = path(root, 'dir');
            const file = path(dir, 'file.txt');
            writeFile(file, 'hello');
            const fs = new GioFileSystem();
            assertEqual(fs.exists(file), true);
            assertEqual(fs.exists(path(root, 'missing')), false);
            assertEqual(fs.queryType(dir), 'directory');
            assertEqual(fs.queryType(file), 'file');
            assertEqual(fs.queryType(path(root, 'missing')), null);
            assertEqual(fs.isDirectory(dir), true);
            assertEqual(fs.isDirectory(file), false);
        } finally {
            cleanup(root);
        }
    }),
    test('classifies symlinks as other and handles top-level ignores', () => {
        const root = tempDir('saveme-fs-links');
        try {
            const target = path(root, 'target');
            const link = path(root, 'link');
            writeFile(target, 'x');
            Gio.File.new_for_path(link).make_symbolic_link(target, null);
            const fs = new GioFileSystem();
            assertEqual(fs.queryType(link), 'other');
            assertEqual(fs.topLevelEntryCount(root), 2);
            assertEqual(fs.topLevelEntryCount(root, {ignore: ['link']}), 1);
        } finally {
            cleanup(root);
        }
    }),
    test('handles relative paths, joins and directory creation', () => {
        const root = tempDir('saveme-fs-paths');
        try {
            const fs = new GioFileSystem();
            assertEqual(fs.relativePath('/a/b', '/a/b/c'), 'c');
            assertEqual(fs.relativePath('/a/b', '/a/b'), '');
            assertEqual(fs.relativePath('/a/b', '/a/c'), null);
            assertEqual(fs.joinPath('/a', 'b', 'c'), '/a/b/c');
            const created = fs.ensureDir(path(root, 'new', 'dir'));
            assert(GLib.file_test(created, GLib.FileTest.IS_DIR));
        } finally {
            cleanup(root);
        }
    }),
    test('writes and removes text files', () => {
        const root = tempDir('saveme-fs-write');
        try {
            const fs = new GioFileSystem();
            assert(fs.freeSpace(root) > 0);
            const file = path(root, 'nested', 'file.txt');
            fs.writeText(file, 'content', 0o600);
            const [ok, bytes] = GLib.file_get_contents(file);
            assert(ok);
            assertEqual(new TextDecoder().decode(bytes), 'content');
            const defaultMode = path(root, 'nested', 'default.txt');
            fs.writeText(defaultMode, 'default');
            assertEqual(fs.exists(defaultMode), true);
            fs.removeIfExists(file);
            assertEqual(fs.exists(file), false);
            fs.removeIfExists(file);
        } finally {
            cleanup(root);
        }
    }),
]);
