import esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Copy mermaid.min.js to dist/webview/ for dialog panel
mkdirSync('dist/webview', { recursive: true });
copyFileSync('node_modules/mermaid/dist/mermaid.min.js', 'dist/webview/mermaid.min.js');

const problemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[build] started');
    });
    build.onEnd(result => {
      for (const error of result.errors) {
        if (!error.location) {
          console.error(`✘ [ERROR] ${error.text}`);
          continue;
        }
        console.error(`✘ [ERROR] ${error.text}`);
        console.error(`    ${error.location.file}:${error.location.line}:${error.location.column}`);
      }
      console.log('[build] finished');
    });
  }
};

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  sourcemap: !production,
  minify: production,
  target: 'node18',
  external: ['vscode'],
  logLevel: 'silent',
  plugins: [problemMatcherPlugin]
};

const webviewConfig = {
  entryPoints: ['media/main.ts'],
  bundle: true,
  outdir: 'dist/webview',
  format: 'esm',
  platform: 'browser',
  sourcemap: !production,
  minify: production,
  target: 'es2022',
  loader: {
    '.css': 'css'
  },
  logLevel: 'silent'
};

const dialogConfig = {
  entryPoints: ['media/dialog.ts'],
  bundle: true,
  outfile: 'dist/webview/dialog.js',
  format: 'iife',
  platform: 'browser',
  sourcemap: !production,
  minify: production,
  target: 'es2020',
  logLevel: 'silent'
};

if (watch) {
  const ctx1 = await esbuild.context({ ...extensionConfig, plugins: [...extensionConfig.plugins] });
  const ctx2 = await esbuild.context(webviewConfig);
  const ctx3 = await esbuild.context(dialogConfig);
  await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch()]);
  console.log('[watch] watching for changes...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
    esbuild.build(dialogConfig)
  ]);
}
