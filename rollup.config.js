import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const banner = `/**
 * ${pkg.name} v${pkg.version}
 * ${pkg.description}
 * (c) ${new Date().getFullYear()} ${pkg.author}
 * Released under the ${pkg.license} License
 */`;

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