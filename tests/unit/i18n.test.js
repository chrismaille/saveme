import {SUPPORTED_LANGUAGES, setLanguage, t} from '../../src/i18n.js';
import {assertEqual, suite, test} from '../harness.js';

export default suite('i18n', [
    test('translates core UI strings and falls back to English', () => {
        assertEqual(SUPPORTED_LANGUAGES.length, 16);
        setLanguage('pt_BR');
        assertEqual(t('Running'), 'Em execução');
        assertEqual(t('Backup completed successfully'), 'Backup concluído com sucesso');
        assertEqual(t('No files were changed.'), 'Nenhum arquivo foi modificado.');
        assertEqual(t('Unknown key'), 'Unknown key');
        setLanguage('es');
        assertEqual(t('Settings'), 'Configuración');
        setLanguage('en');
        assertEqual(t('Running'), 'Running');
        assertEqual(t('Settings'), 'Settings');
    }),
    test('replacement values are interpolated', () => {
        setLanguage('en');
        assertEqual(t('Hello {name}', {name: 'SaveMe'}), 'Hello SaveMe');
    }),
]);
