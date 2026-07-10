import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import replace from '@rollup/plugin-replace';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const banner = `/**
 * ${pkg.name} v${pkg.version}
 * ${pkg.description}
 * (c) ${new Date().getFullYear()} ${pkg.author}
 * Released under the ${pkg.license} License
 */`;

// 9.A.3: inject the sdk_version literal from package.json at build time. The
// constant used to be hand-maintained in src/index.ts and drifted (payloads said
// 1.7.4 while the package was 1.7.5) — with the placeholder replaced here it can
// never drift again. Runs BEFORE typescript so the emitted JS (and its sourcemap)
// carries the real version string, which scripts/check-bundle.js then verifies
// against package.json in the deployable bundles.
const injectSdkVersion = () => replace({
  preventAssignment: true,
  values: { __SDK_VERSION__: pkg.version }
});

export default [
  // Browser build (IIFE)
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/datalyr.js',
        format: 'iife',
        name: 'Datalyr',
        banner,
        sourcemap: true
      },
      {
        file: 'dist/datalyr.min.js',
        format: 'iife',
        name: 'Datalyr',
        banner,
        plugins: [terser()],
        sourcemap: true
      }
    ],
    plugins: [
      injectSdkVersion(),
      resolve({
        browser: true,
        preferBuiltins: false
      }),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
        declarationMap: false
      })
    ]
  },
  
  // ESM build
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/datalyr.esm.js',
        format: 'es',
        banner,
        sourcemap: true
      },
      {
        file: 'dist/datalyr.esm.min.js',
        format: 'es',
        banner,
        plugins: [terser()],
        sourcemap: true
      }
    ],
    plugins: [
      injectSdkVersion(),
      resolve({
        browser: true,
        preferBuiltins: false
      }),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
        declaration: true,
        declarationDir: 'dist',
        declarationMap: true
      })
    ]
  },
  
  // CommonJS build
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/datalyr.cjs.js',
        format: 'cjs',
        banner,
        sourcemap: true
      }
    ],
    plugins: [
      injectSdkVersion(),
      resolve({
        browser: true,
        preferBuiltins: false
      }),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
        declarationMap: false
      })
    ]
  }
];