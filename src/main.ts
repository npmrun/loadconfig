import path from "node:path"
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { pathToFileURL } from "node:url"
import { builtinModules, createRequire } from 'node:module'
import createDebug from 'debug'
import { build } from 'esbuild'
import { ConfigEnv, DEFAULT_CONFIG_FILES, isBuiltin, isObject, LogLevel, lookupFile, normalizePath, UserConfig, UserConfigExport, usingDynamicImport } from "./util"

const debug = createDebug("config:warn")
const debugError = createDebug("config:error")

export async function loadConfigFromFile(
    configEnv: ConfigEnv,
    configFile?: string | string[],
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

    if (configFile && !Array.isArray(configFile)) {
        // explicit config path is always resolved from cwd
        resolvedPath = path.resolve(configFile)
    } else if (configFile && Array.isArray(configFile)) {
        // explicit config path is always resolved from cwd
        for (const filename of configFile) {
            const filePath = path.resolve(configRoot, filename)
            if (!fs.existsSync(filePath)) continue

            resolvedPath = filePath
            break
        }
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
        debug('no config file found.')
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
        debug(`bundled config file loaded in ${getTime()}`)

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
        debugError(`failed to load config from ${resolvedPath}`)
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
                    build.onResolve({ filter: /.*/ }, ({ path: id, importer, kind }) => {
                        if (
                            kind === 'entry-point' ||
                            path.isAbsolute(id) ||
                            isBuiltin(id)
                        ) {
                            return
                        }

                        // partial deno support as `npm:` does not work with esbuild
                        if (id.startsWith('npm:')) {
                            return { external: true }
                        }
                        return {
                            external: true,
                        }
                        // if (args.path[0] !== '.' && !path.isAbsolute(args.path)) {
                        //     return { external: true }
                        // }
                    })
                    // const options: InternalResolveOptionsWithOverrideConditions = {
                    //     root: path.dirname(fileName),
                    //     isBuild: true,
                    //     isProduction: true,
                    //     preferRelative: false,
                    //     tryIndex: true,
                    //     mainFields: [],
                    //     browserField: false,
                    //     conditions: [],
                    //     overrideConditions: ['node'],
                    //     dedupe: [],
                    //     extensions: DEFAULT_EXTENSIONS,
                    //     preserveSymlinks: false,
                    //     packageCache: new Map(),
                    // }

                    // // externalize bare imports
                    // build.onResolve(
                    //     { filter: /^[^.].*/ },
                    //     async ({ path: id, importer, kind }) => {
                    //         if (
                    //             kind === 'entry-point' ||
                    //             path.isAbsolute(id) ||
                    //             isBuiltin(id)
                    //         ) {
                    //             return
                    //         }

                    //         // partial deno support as `npm:` does not work with esbuild
                    //         if (id.startsWith('npm:')) {
                    //             return { external: true }
                    //         }

                    //         const isIdESM = isESM || kind === 'dynamic-import'
                    //         let idFsPath = tryNodeResolve(
                    //             id,
                    //             importer,
                    //             { ...options, isRequire: !isIdESM },
                    //             false,
                    //         )?.id
                    //         if (idFsPath && isIdESM) {
                    //             idFsPath = pathToFileURL(idFsPath).href
                    //         }
                    //         return {
                    //             path: idFsPath,
                    //             external: true,
                    //         }
                    //     },
                    // )
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
const dynamicImport = usingDynamicImport
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
            return (await import(fileUrl)).default
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
