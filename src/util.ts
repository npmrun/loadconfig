import path from "node:path"
import fs from 'node:fs'
import { builtinModules } from 'node:module'
import os from 'node:os'

export interface ConfigEnv {
    command: 'build' | 'serve'
    mode: string
    /**
     * @experimental
     */
    ssrBuild?: boolean
}

export type UserConfig = any
export type UserConfigExport = any
export type InternalResolveOptionsWithOverrideConditions = any
export type LogLevel = any

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

