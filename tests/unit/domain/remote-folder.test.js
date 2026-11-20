import {
    isValidRemoteFolderName,
    normalizeRemoteFolderName,
} from '../../../src/domain/remote-folder.js';
import {assertEqual, suite, test} from '../../harness.js';

export default suite('domain/remote-folder', [
    test('normalizes and validates cloud folder names', () => {
        assertEqual(normalizeRemoteFolderName('  Minha pasta  '), 'Minha pasta');
        assertEqual(isValidRemoteFolderName('Minha pasta'), true);
        assertEqual(isValidRemoteFolderName('Conexão'), true);
        assertEqual(isValidRemoteFolderName(''), false);
        assertEqual(isValidRemoteFolderName('   '), false);
        assertEqual(isValidRemoteFolderName('.'), false);
        assertEqual(isValidRemoteFolderName('..'), false);
        assertEqual(isValidRemoteFolderName('a/b'), false);
        assertEqual(isValidRemoteFolderName('a\\b'), false);
        assertEqual(isValidRemoteFolderName('a\nb'), false);
    }),
]);
