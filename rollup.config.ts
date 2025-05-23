import { defineConfig } from 'rollup';
import typescript from "@rollup/plugin-typescript"
import dts from 'rollup-plugin-dts'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import esbuild from 'rollup-plugin-esbuild'
// import babel from '@rollup/plugin-babel'
import terser from '@rollup/plugin-terser';
import path from 'path';
import { fileURLToPath } from 'url'


const filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(filename);

export default defineConfig([
    {
        input: 'src/index.ts',
        output: [
            {
                format: 'es',
                file: path.resolve(__dirname, './dist/index.esm.js')
            },
            {
                format: "cjs",
                file: path.resolve(__dirname, './dist/index.cjs.js'),
            },
            {
                name: 'yokeTools',
                format: 'umd',
                file: path.resolve(__dirname, './dist/index.min.js'),
                plugins: [terser()],
                exports: 'named',
            },
            {
                name: 'yokeTools',
                format: 'umd',
                file: path.resolve(__dirname, './dist/index.js'),
            },
            {
                name: 'yokeTools',
                format: 'amd',
                file: path.resolve(__dirname, './dist/index.amd.js')
            },
        ],
        plugins: [
            // typescript(),
            // babel({
            //     exclude: 'node_modules/**',
            // }),
            resolve({
                preferBuiltins: true
            }),
            commonjs(),
            typescript(),
            esbuild(),
        ],
        external: ['axios', 'form-data'],
    },
    {
        input: 'src/index.ts',
        output: [
            {
                name: 'index.d.ts',
                format: 'es',
                file: './dist/index.d.ts',
            },
        ],
        plugins: [
            dts({
                respectExternal: true
            })
        ],
    }
]);