import path from "node:path"
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL } from "node:url"
import { builtinModules, createRequire } from 'node:module'
import os from 'node:os'
import { build } from 'esbuild'

export interface ConfigEnv {
    command: 'build' | 'serve'
    mode: string
    /**
     * @experimental
     */
    ssrBuild?: boolean
}

type UserConfig = any
type UserConfigExport = any
type InternalResolveOptionsWithOverrideConditions = any
type LogLevel = any

export const DEFAULT_CONFIG_FILES = [
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.ts',
    'vite.config.cjs',
    'vite.config.mts',
    'vite.config.cts',
]
export const DEFAULT_EXTENSIONS = [
    '.mjs',
    '.js',
    '.mts',
    '.ts',
    '.jsx',
    '.tsx',
    '.json',
]

//TODO: revisit later to see if the edge case that "compiling using node v12 code to be run in node v16 in the server" is what we intend to support.
const builtins = new Set([
    ...builtinModules,
    'assert/strict',
    'diagnostics_channel',
    'dns/promises',
    'fs/promises',
    'path/posix',
    'path/win32',
    'readline/promises',
    'stream/consumers',
    'stream/promises',
    'stream/web',
    'timers/promises',
    'util/types',
    'wasi',
])

const NODE_BUILTIN_NAMESPACE = 'node:'
export function isBuiltin(id: string): boolean {
    return builtins.has(
        id.startsWith(NODE_BUILTIN_NAMESPACE)
            ? id.slice(NODE_BUILTIN_NAMESPACE.length)
            : id,
    )
}
export function tryStatSync(file: string): fs.Stats | undefined {
    try {
        return fs.statSync(file, { throwIfNoEntry: false })
    } catch {
        // Ignore errors
    }
}
export function lookupFile(
    dir: string,
    fileNames: string[],
): string | undefined {
    while (dir) {
        for (const fileName of fileNames) {
            const fullPath = path.join(dir, fileName)
            if (tryStatSync(fullPath)?.isFile()) return fullPath
        }
        const parentDir = path.dirname(dir)
        if (parentDir === dir) return

        dir = parentDir
    }
}
export function isObject(value: unknown): value is Record<string, any> {
    return Object.prototype.toString.call(value) === '[object Object]'
}
export const isWindows = os.platform() === 'win32'
const windowsSlashRE = /\\/g
export function slash(p: string): string {
    return p.replace(windowsSlashRE, '/')
}
export function normalizePath(id: string): string {
    return path.posix.normalize(isWindows ? slash(id) : id)
}
// @ts-expect-error jest only exists when running Jest
export const usingDynamicImport = typeof jest === 'undefined'


export async function loadConfigFromFile(
    configEnv: ConfigEnv,
    configFile?: string,
    configRoot: string = process.cwd(),
    logLevel?: LogLevel,
): Promise<{
    path: string
    config: UserConfig
    dependencies: string[]
} | null> {
    const start = performance.now()
    const getTime = () => `${(performance.now() - start).toFixed(2)}ms`

    let resolvedPath: string | undefined

    if (configFile) {
        // explicit config path is always resolved from cwd
        resolvedPath = path.resolve(configFile)
    } else {
        // implicit config file loaded from inline root (if present)
        // otherwise from cwd
        for (const filename of DEFAULT_CONFIG_FILES) {
            const filePath = path.resolve(configRoot, filename)
            if (!fs.existsSync(filePath)) continue

            resolvedPath = filePath
            break
        }
    }

    if (!resolvedPath) {
        console?.warn('no config file found.')
        return null
    }

    let isESM = false
    if (/\.m[jt]s$/.test(resolvedPath)) {
        isESM = true
    } else if (/\.c[jt]s$/.test(resolvedPath)) {
        isESM = false
    } else {
        // check package.json for type: "module" and set `isESM` to true
        try {
            const pkg = lookupFile(configRoot, ['package.json'])
            isESM =
                !!pkg && JSON.parse(fs.readFileSync(pkg, 'utf-8')).type === 'module'
        } catch (e) { }
    }

    try {
        const bundled = await bundleConfigFile(resolvedPath, isESM)
        const userConfig = await loadConfigFromBundledFile(
            resolvedPath,
            bundled.code,
            isESM,
        )
        console.warn?.(`bundled config file loaded in ${getTime()}`)

        const config = await (typeof userConfig === 'function'
            ? userConfig(configEnv)
            : userConfig)
        if (!isObject(config)) {
            throw new Error(`config must export or return an object.`)
        }
        return {
            path: normalizePath(resolvedPath),
            config,
            dependencies: bundled.dependencies,
        }
    } catch (e) {
        console.error(`failed to load config from ${resolvedPath}`)
        throw e
    }
}

async function bundleConfigFile(
    fileName: string,
    isESM: boolean,
): Promise<{ code: string; dependencies: string[] }> {
    const dirnameVarName = '__vite_injected_original_dirname'
    const filenameVarName = '__vite_injected_original_filename'
    const importMetaUrlVarName = '__vite_injected_original_import_meta_url'
    const result = await build({
        absWorkingDir: process.cwd(),
        entryPoints: [fileName],
        outfile: 'out.js',
        write: false,
        target: ['node14.18', 'node16'],
        platform: 'node',
        bundle: true,
        format: isESM ? 'esm' : 'cjs',
        mainFields: ['main'],
        sourcemap: 'inline',
        metafile: true,
        define: {
            __dirname: dirnameVarName,
            __filename: filenameVarName,
            'import.meta.url': importMetaUrlVarName,
        },
        plugins: [
            {
                name: 'externalize-deps',
                setup(build) {
                    build.onResolve({ filter: /.*/ }, (args) => {
                        if (args.path[0] !== '.' && !path.isAbsolute(args.path)) {
                            return { external: true }
                        }
                    })
                },
            },
            {
                name: 'inject-file-scope-variables',
                setup(build) {
                    build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
                        const contents = await fs.promises.readFile(args.path, 'utf8')
                        const injectValues =
                            `const ${dirnameVarName} = ${JSON.stringify(
                                path.dirname(args.path),
                            )};` +
                            `const ${filenameVarName} = ${JSON.stringify(args.path)};` +
                            `const ${importMetaUrlVarName} = ${JSON.stringify(
                                pathToFileURL(args.path).href,
                            )};`

                        return {
                            loader: args.path.endsWith('ts') ? 'ts' : 'js',
                            contents: injectValues + contents,
                        }
                    })
                },
            },
        ],
    })
    const { text } = result.outputFiles[0]
    return {
        code: text,
        dependencies: result.metafile ? Object.keys(result.metafile.inputs) : [],
    }
}

interface NodeModuleWithCompile extends NodeModule {
    _compile(code: string, filename: string): any
}

const _require = createRequire(import.meta.url)
/**
 * Dynamically import files. It will make sure it's not being compiled away by TS/Rollup.
 *
 * As a temporary workaround for Jest's lack of stable ESM support, we fallback to require
 * if we're in a Jest environment.
 * See https://github.com/vitejs/vite/pull/5197#issuecomment-938054077
 *
 * @param file File path to import.
 */
export const dynamicImport = usingDynamicImport
    ? new Function('file', 'return import(file)')
    : _require


async function loadConfigFromBundledFile(
    fileName: string,
    bundledCode: string,
    isESM: boolean,
): Promise<UserConfigExport> {
    // for esm, before we can register loaders without requiring users to run node
    // with --experimental-loader themselves, we have to do a hack here:
    // write it to disk, load it with native Node ESM, then delete the file.
    if (isESM) {
        const fileBase = `${fileName}.timestamp-${Date.now()}-${Math.random()
            .toString(16)
            .slice(2)}`
        const fileNameTmp = `${fileBase}.mjs`
        const fileUrl = `${pathToFileURL(fileBase)}.mjs`
        await fsp.writeFile(fileNameTmp, bundledCode)
        try {
            return (await dynamicImport(fileUrl)).default
        } finally {
            fs.unlink(fileNameTmp, () => { }) // Ignore errors
        }
    }
    // for cjs, we can register a custom loader via `_require.extensions`
    else {
        const extension = path.extname(fileName)
        const realFileName = await fsp.realpath(fileName)
        const loaderExt = extension in _require.extensions ? extension : '.js'
        const defaultLoader = _require.extensions[loaderExt]!
        _require.extensions[loaderExt] = (module: NodeModule, filename: string) => {
            if (filename === realFileName) {
                ; (module as NodeModuleWithCompile)._compile(bundledCode, filename)
            } else {
                defaultLoader(module, filename)
            }
        }
        // clear cache in case of server restart
        delete _require.cache[_require.resolve(fileName)]
        const raw = _require(fileName)
        _require.extensions[loaderExt] = defaultLoader
        return raw.__esModule ? raw.default : raw
    }
}
