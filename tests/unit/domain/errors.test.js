import {
    DeleteGuardError,
    DestinationUnavailableError,
    EmptySourceError,
    SourceUnavailableError,
} from '../../../src/domain/errors.js';
import {assert, assertEqual, suite, test} from '../../harness.js';

export default suite('domain/errors', [
    test('source and destination errors preserve their names and messages', () => {
        const source = new SourceUnavailableError('missing source');
        assert(source instanceof Error);
        assertEqual(source.name, 'SourceUnavailableError');
        assertEqual(source.message, 'missing source');

        const destination = new DestinationUnavailableError('missing destination');
        assert(destination instanceof Error);
        assertEqual(destination.name, 'DestinationUnavailableError');
        assertEqual(destination.message, 'missing destination');
    }),
    test('empty source error includes the last count', () => {
        const error = new EmptySourceError(12);
        assertEqual(error.name, 'EmptySourceError');
        assertEqual(error.lastCount, 12);
        assert(/12 files/.test(error.message));
    }),
    test('delete guard error includes all guard values', () => {
        const error = new DeleteGuardError(5, 2, 10, 20);
        assertEqual(error.name, 'DeleteGuardError');
        assertEqual(error.deletes, 5);
        assertEqual(error.allowed, 2);
        assertEqual(error.total, 10);
        assertEqual(error.percent, 20);
        assert(/Delete guard/.test(error.message));
        assert(/5 file/.test(error.message));
    }),
]);
