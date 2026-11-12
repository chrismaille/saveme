import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Logger} from '../../src/log.js';
import {RecursiveWatcher} from '../../src/watcher.js';
import {sleep} from '../../src/util.js';
import {
    assert,
    assertEqual,
    cleanup,
    suite,
    tempDir,
    test,
    writeFile,
} from '../harness.js';

function changesFor(changes, relative) {
    return changes.filter(change => change.path.endsWith(`/${relative}`));
}

export default suite('watcher (integration)', [
    test('reports create, update, rename and delete', async () => {
        const root = tempDir('saveme-watcher');
        const logger = new Logger({name: 'watcher-test', echo: false});
        const changes = [];
        const watcher = new RecursiveWatcher({
            rootPath: root,
            logger,
            onChange: change => changes.push(change),
        });
        try {
            await watcher.start();
            assert(watcher.watchCount >= 1);

            writeFile(GLib.build_filenamev([root, 'a.txt']), 'one');
            await sleep(300);
            let matches = changesFor(changes, 'a.txt');
            assert(matches.some(change => change.kind === 'upsert'),
                `create events: ${JSON.stringify(changes)}`);
            assert(!matches.some(change => /\.\w{6}$/.test(change.path)),
                `temporary file leaked: ${JSON.stringify(matches)}`);

            changes.length = 0;
            writeFile(GLib.build_filenamev([root, 'a.txt']), 'two');
            await sleep(300);
            matches = changesFor(changes, 'a.txt');
            assert(matches.some(change => change.kind === 'upsert'),
                `update events: ${JSON.stringify(changes)}`);

            changes.length = 0;
            GLib.rename(GLib.build_filenamev([root, 'a.txt']),
                GLib.build_filenamev([root, 'b.txt']));
            await sleep(300);
            assert(changesFor(changes, 'a.txt').some(change => change.kind === 'delete'),
                `rename delete events: ${JSON.stringify(changes)}`);
            assert(changesFor(changes, 'b.txt').some(change => change.kind === 'upsert'),
                `rename create events: ${JSON.stringify(changes)}`);

            changes.length = 0;
            Gio.File.new_for_path(GLib.build_filenamev([root, 'b.txt'])).delete(null);
            await sleep(300);
            assert(changesFor(changes, 'b.txt').some(change => change.kind === 'delete'),
                `delete events: ${JSON.stringify(changes)}`);
        } finally {
            watcher.stop();
            cleanup(root);
        }
    }),
]);
