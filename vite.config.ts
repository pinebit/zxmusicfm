import react from '@vitejs/plugin-react';
import path from 'node:path';

import { build as viteBuild } from 'vite';
import { defineConfig } from 'vitest/config';

const WORKLET_ENTRY = 'src/playback/worklet/chipProcessor.ts';
const WORKLET_DEV_PATH = '/@zxmusicfm/chipProcessor.js';
// Anything the worklet bundle is built from. A change to one of these has to
// drop the memoized build below, or a dev reload keeps serving stale audio code.
const WORKLET_SOURCE_DIRECTORIES = ['src/playback/worklet', 'vendor/ym2149'];

async function bundleDevelopmentWorklet(): Promise<string> {
  const result = await viteBuild({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        // The generated glue's default init path resolves the `.wasm` beside
        // itself. A library build in IIFE format has no `import.meta.url` to
        // resolve it against, so Vite inlines the file as 1.7 MB of base64 that
        // nothing ever reads: the worklet is handed a compiled module over its
        // port and only ever calls `initSync`. Cut the dead branch so the dev
        // bundle stays near the 17 kB the production worklet ships.
        name: 'zxmusicfm-worklet-drop-wasm-url',
        enforce: 'pre',
        transform(code: string, id: string) {
          if (!id.endsWith('vendor/ym2149/ym2149_wasm.js')) return null;
          const marker =
            "module_or_path = new URL('ym2149_wasm_bg.wasm', import.meta.url);";
          if (!code.includes(marker)) {
            throw new Error(
              'The vendored glue no longer resolves its own wasm URL; re-check the worklet bundle size.',
            );
          }
          return code.replace(
            marker,
            "throw new Error('The worklet initializes the engine with initSync.');",
          );
        },
      },
    ],
    build: {
      write: false,
      target: 'es2023',
      minify: true,
      sourcemap: false,
      lib: {
        entry: path.resolve(WORKLET_ENTRY),
        name: 'ZxMusicFmChipProcessor',
        formats: ['iife'],
        fileName: () => 'chipProcessor.js',
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) =>
    'output' in output
      ? output.output.filter((item) => item.type === 'chunk')
      : [],
  );
  const chunk = chunks[0];
  if (chunk?.type !== 'chunk') {
    throw new Error('The worklet build did not emit JavaScript.');
  }
  return chunk.code;
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      {
        name: 'zxmusicfm-development-worklet',
        configureServer(server) {
          // `addModule` is requested on every first play, and the bundle is a
          // full nested Vite build, so memoize it and let the watcher decide
          // when it is stale.
          let bundle: Promise<string> | undefined;
          const invalidate = (file: string): void => {
            const relative = path.relative(process.cwd(), file);
            if (
              WORKLET_SOURCE_DIRECTORIES.some(
                (directory) =>
                  !path.relative(directory, relative).startsWith('..'),
              )
            ) {
              bundle = undefined;
            }
          };
          server.watcher.on('change', invalidate);
          server.watcher.on('add', invalidate);
          server.watcher.on('unlink', invalidate);

          server.middlewares.use((request, response, next) => {
            void (async () => {
              if (request.url?.split('?', 1)[0] !== WORKLET_DEV_PATH) {
                next();
                return;
              }
              bundle ??= bundleDevelopmentWorklet();
              const code = await bundle.catch((error: unknown) => {
                bundle = undefined;
                throw error;
              });
              response.statusCode = 200;
              response.setHeader(
                'Content-Type',
                'text/javascript; charset=utf-8',
              );
              response.setHeader('Cache-Control', 'no-cache');
              response.end(code);
            })().catch(next);
          });
        },
      },
    ],
    build: {
      // Emitted but not linked from the bundles, so browsers never fetch them and
      // no `sourceMappingURL` points at project sources from public output. Load
      // them deliberately in devtools when a production trace needs decoding.
      sourcemap: 'hidden',
    },
    worker: {
      // AudioWorklet addModule() is not consistently module-aware. Keep its
      // same-origin asset self-contained with the WASM glue inlined.
      format: 'iife',
    },
    test: {
      environment: 'jsdom',
      exclude: ['dist/**', 'node_modules/**', 'tests/e2e/**'],
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
