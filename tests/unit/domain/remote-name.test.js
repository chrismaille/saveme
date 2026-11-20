import {isValidRemoteName, sanitizeRemoteName} from '../../../src/domain/remote-name.js';
import {assertEqual, suite, test} from '../../harness.js';

export default suite('domain/remote-name', [
    test('strips accents and invalid characters', () => {
        assertEqual(sanitizeRemoteName('Conexão do OneDrive'), 'Conexao do OneDrive');
        assertEqual(sanitizeRemoteName('a/b:c'), 'a b c');
        assertEqual(sanitizeRemoteName('  Meu   Drive  '), 'Meu Drive');
        assertEqual(sanitizeRemoteName(''), 'Cloud connection');
    }),
    test('validates the rclone config name rules', () => {
        assertEqual(isValidRemoteName('OneDrive connection'), true);
        assertEqual(isValidRemoteName('Conexão do OneDrive'), false);
        assertEqual(isValidRemoteName('a/b'), false);
        assertEqual(isValidRemoteName(''), false);
    }),
]);
