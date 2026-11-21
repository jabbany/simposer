import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Every file under dir, as paths relative to dir, sorted. */
function listFiles(dir: string, root: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, root));
    } else if (entry.isFile()) {
      out.push(relative(root, full));
    }
  }
  return out.sort();
}

/**
 * Names the service worker's cache after a hash of the built files. The
 * worker serves models and assets cache-first, so without a new cache name a
 * returning visitor would keep the old files after a deployment.
 */
function versionServiceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'simposer-sw-version',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle() {
      const swPath = join(outDir, 'sw.js');
      const hash = createHash('sha256');
      for (const file of listFiles(outDir)) {
        if (file === 'sw.js') {
          continue;
        }
        hash.update(file);
        hash.update(readFileSync(join(outDir, file)));
      }
      const version = hash.digest('hex').slice(0, 12);
      const source = readFileSync(swPath, 'utf8');
      const marker = "const CACHE = 'simposer-dev';";
      if (!source.includes(marker)) {
        throw new Error(`sw.js: cache name marker not found (${marker})`);
      }
      writeFileSync(swPath, source.replace(marker, `const CACHE = 'simposer-${version}';`));
    },
  };
}

export default defineConfig({
  // Relative URLs, so the build works from any subpath, such as
  // https://<user>.github.io/<repo>/ on GitHub Pages.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  plugins: [versionServiceWorker()],
});
