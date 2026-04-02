import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'dist-test/tests/integration/**/*.test.js',
  version: 'stable',
  extensionDevelopmentPath: '.'
});
