import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // WhatsApp agent is strictly read-only: forbid Baileys send functions anywhere.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name=/^(sendMessage|relayMessage|sendPresenceUpdate|sendReceipt|sendReadReceipt|readMessages)$/]",
          message: 'agentdeck never sends WhatsApp messages or receipts (read-only by design).',
        },
      ],
    },
  },
);
