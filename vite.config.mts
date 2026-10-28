import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * Política de seguridad de contenido para la interfaz empaquetada.
 * En desarrollo no se inyecta porque el servidor de Vite necesita scripts en línea
 * para la recarga en caliente de React.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'efc-content-security-policy',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!-- EFC:CSP -->',
        `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`,
      );
    },
  };
}

export default defineConfig({
  root: resolve(projectRoot, 'src'),
  base: './',
  publicDir: false,
  plugins: [react(), contentSecurityPolicy()],
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: resolve(projectRoot, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        wheel: resolve(projectRoot, 'src/wheel.html'),
        toast: resolve(projectRoot, 'src/toast.html'),
        settings: resolve(projectRoot, 'src/settings.html'),
      },
    },
  },
});
