const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');
const security = require('eslint-plugin-security');

module.exports = [
  js.configs.recommended,
  security.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Faux positifs trop fréquents dans ce codebase (accès obj[variable] légitimes,
      // chemins de fichiers dynamiques intentionnels côté serveur)
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'public/', 'logs/', 'migrations/'],
  },
];
