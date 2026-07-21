import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const siteUrl = loadEnv(mode, process.cwd(), 'VITE_').VITE_SITE_URL;
  let canonicalUrl: string | undefined;
  if (siteUrl !== undefined && siteUrl !== '') {
    const parsed = new URL(siteUrl);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      throw new Error('VITE_SITE_URL must be a credential-free HTTPS URL.');
    }
    canonicalUrl = parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
  }

  return {
    plugins: [
      react(),
      {
        name: 'zxmusicfm-production-metadata',
        transformIndexHtml: {
          order: 'post',
          handler: (html) => {
            if (canonicalUrl === undefined) return html;
            return {
              html,
              tags: [
                {
                  tag: 'link',
                  attrs: { rel: 'canonical', href: canonicalUrl },
                  injectTo: 'head',
                },
                {
                  tag: 'meta',
                  attrs: { property: 'og:url', content: canonicalUrl },
                  injectTo: 'head',
                },
                {
                  tag: 'meta',
                  attrs: {
                    property: 'og:image',
                    content: new URL('og-preview.png', canonicalUrl).href,
                  },
                  injectTo: 'head',
                },
              ],
            };
          },
        },
      },
    ],
    build: {
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      exclude: ['dist/**', 'node_modules/**', 'tests/e2e/**'],
      setupFiles: ['./src/test/setup.ts'],
    },
  };
});
