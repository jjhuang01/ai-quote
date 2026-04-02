import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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

if (watch) {
  const ctx1 = await esbuild.context({ ...extensionConfig, plugins: [...extensionConfig.plugins] });
  const ctx2 = await esbuild.context(webviewConfig);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
  console.log('[watch] watching for changes...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig)
  ]);
}
