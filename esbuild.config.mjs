import esbuild from 'esbuild';
import { builtinModules } from 'module';

const production = process.argv.includes('production');

async function main() {
  await esbuild.build({
    entryPoints: ['main.ts'],
    bundle: true,
    external: ['obsidian'],
    keepNames: true,
    minifyWhitespace: production,
    minifySyntax: production,
    minifyIdentifiers: production,
    platform: 'node',
    format: 'cjs',
    sourcemap: production ? false : 'inline',
    outfile: 'main.js',
    target: 'ES2020',
    define: {
      'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
    },
  });
}

main().catch(() => process.exit(1));
