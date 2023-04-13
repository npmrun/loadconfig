import path from "node:path"
import fs from "node:fs"
import { isBuiltin } from "./loadConfigFromFile"

type InternalResolveOptionsWithOverrideConditions = any
type DepsOptimizer = any
type PartialResolvedId = any

export const bareImportRE = /^[\w@](?!.*:\/\/)/
export const deepImportRE = /^([^@][^/]*)\/|^(@[^/]+\/[^/]+)\//
const postfixRE = /[?#].*$/s
export function cleanUrl(url: string): string {
    return url.replace(postfixRE, '')
}
// special id for paths marked with browser: false
// https://github.com/defunctzombie/package-browser-field-spec#ignore-a-module
export const browserExternalId = '__vite-browser-external'
// special id for packages that are optional peer deps
export const optionalPeerDepId = '__vite-optional-peer-dep'

export function tryNodeResolve(
    id: string,
    importer: string | null | undefined,
    options: InternalResolveOptionsWithOverrideConditions,
    targetWeb: boolean,
    depsOptimizer?: DepsOptimizer,
    ssr: boolean = false,
    externalize?: boolean,
    allowLinkedExternal: boolean = true,
): PartialResolvedId | undefined {
    const { root, dedupe, isBuild, preserveSymlinks, packageCache } = options

    // check for deep import, e.g. "my-lib/foo"
    const deepMatch = id.match(deepImportRE)
    const pkgId = deepMatch ? deepMatch[1] || deepMatch[2] : id

    let basedir: string
    if (dedupe?.includes(pkgId)) {
        basedir = root
    } else if (
        importer &&
        path.isAbsolute(importer) &&
        // css processing appends `*` for importer
        (importer[importer.length - 1] === '*' || fs.existsSync(cleanUrl(importer)))
    ) {
        basedir = path.dirname(importer)
    } else {
        basedir = root
    }

    const pkg = resolvePackageData(pkgId, basedir, preserveSymlinks, packageCache)
    if (!pkg) {
        // if import can't be found, check if it's an optional peer dep.
        // if so, we can resolve to a special id that errors only when imported.
        if (
            basedir !== root && // root has no peer dep
            !isBuiltin(id) &&
            !id.includes('\0') &&
            bareImportRE.test(id)
        ) {
            const mainPkg = findNearestMainPackageData(basedir, packageCache)?.data
            if (mainPkg) {
                if (
                    mainPkg.peerDependencies?.[id] &&
                    mainPkg.peerDependenciesMeta?.[id]?.optional
                ) {
                    return {
                        id: `${optionalPeerDepId}:${id}:${mainPkg.name}`,
                    }
                }
            }
        }
        return
    }

    const resolveId = deepMatch ? resolveDeepImport : resolvePackageEntry
    const unresolvedId = deepMatch ? '.' + id.slice(pkgId.length) : pkgId

    let resolved: string | undefined
    try {
        resolved = resolveId(unresolvedId, pkg, targetWeb, options)
    } catch (err) {
        if (!options.tryEsmOnly) {
            throw err
        }
    }
    if (!resolved && options.tryEsmOnly) {
        resolved = resolveId(unresolvedId, pkg, targetWeb, {
            ...options,
            isRequire: false,
            mainFields: DEFAULT_MAIN_FIELDS,
            extensions: DEFAULT_EXTENSIONS,
        })
    }
    if (!resolved) {
        return
    }

    const processResult = (resolved: PartialResolvedId) => {
        if (!externalize) {
            return resolved
        }
        // don't external symlink packages
        if (!allowLinkedExternal && !isInNodeModules(resolved.id)) {
            return resolved
        }
        const resolvedExt = path.extname(resolved.id)
        // don't external non-js imports
        if (
            resolvedExt &&
            resolvedExt !== '.js' &&
            resolvedExt !== '.mjs' &&
            resolvedExt !== '.cjs'
        ) {
            return resolved
        }
        let resolvedId = id
        if (deepMatch && !pkg?.data.exports && path.extname(id) !== resolvedExt) {
            resolvedId = resolved.id.slice(resolved.id.indexOf(id))
            debug?.(`[processResult] ${colors.cyan(id)} -> ${colors.dim(resolvedId)}`)
        }
        return { ...resolved, id: resolvedId, external: true }
    }

    if (
        !options.idOnly &&
        ((!options.scan && isBuild && !depsOptimizer) || externalize)
    ) {
        // Resolve package side effects for build so that rollup can better
        // perform tree-shaking
        return processResult({
            id: resolved,
            moduleSideEffects: pkg.hasSideEffects(resolved),
        })
    }

    const ext = path.extname(resolved)

    if (
        !options.ssrOptimizeCheck &&
        (!isInNodeModules(resolved) || // linked
            !depsOptimizer || // resolving before listening to the server
            options.scan) // initial esbuild scan phase
    ) {
        return { id: resolved }
    }

    // if we reach here, it's a valid dep import that hasn't been optimized.
    const isJsType = depsOptimizer
        ? isOptimizable(resolved, depsOptimizer.options)
        : OPTIMIZABLE_ENTRY_RE.test(resolved)

    let exclude = depsOptimizer?.options.exclude
    let include = depsOptimizer?.options.include
    if (options.ssrOptimizeCheck) {
        // we don't have the depsOptimizer
        exclude = options.ssrConfig?.optimizeDeps?.exclude
        include = options.ssrConfig?.optimizeDeps?.include
    }

    const skipOptimization =
        !isJsType ||
        (importer && isInNodeModules(importer)) ||
        exclude?.includes(pkgId) ||
        exclude?.includes(id) ||
        SPECIAL_QUERY_RE.test(resolved) ||
        // During dev SSR, we don't have a way to reload the module graph if
        // a non-optimized dep is found. So we need to skip optimization here.
        // The only optimized deps are the ones explicitly listed in the config.
        (!options.ssrOptimizeCheck && !isBuild && ssr) ||
        // Only optimize non-external CJS deps during SSR by default
        (ssr &&
            !(
                ext === '.cjs' ||
                (ext === '.js' &&
                    findNearestPackageData(path.dirname(resolved), options.packageCache)
                        ?.data.type !== 'module')
            ) &&
            !(include?.includes(pkgId) || include?.includes(id)))

    if (options.ssrOptimizeCheck) {
        return {
            id: skipOptimization
                ? injectQuery(resolved, `__vite_skip_optimization`)
                : resolved,
        }
    }

    if (skipOptimization) {
        // excluded from optimization
        // Inject a version query to npm deps so that the browser
        // can cache it without re-validation, but only do so for known js types.
        // otherwise we may introduce duplicated modules for externalized files
        // from pre-bundled deps.
        if (!isBuild) {
            const versionHash = depsOptimizer!.metadata.browserHash
            if (versionHash && isJsType) {
                resolved = injectQuery(resolved, `v=${versionHash}`)
            }
        }
    } else {
        // this is a missing import, queue optimize-deps re-run and
        // get a resolved its optimized info
        const optimizedInfo = depsOptimizer!.registerMissingImport(id, resolved)
        resolved = depsOptimizer!.getOptimizedDepId(optimizedInfo)
    }

    if (!options.idOnly && !options.scan && isBuild) {
        // Resolve package side effects for build so that rollup can better
        // perform tree-shaking
        return {
            id: resolved,
            moduleSideEffects: pkg.hasSideEffects(resolved),
        }
    } else {
        return { id: resolved! }
    }
}
type PackageData = any
type InternalResolveOptions = any
export function isObject(value: unknown): value is Record<string, any> {
    return Object.prototype.toString.call(value) === '[object Object]'
}
function resolveDeepImport(
    id: string,
    {
      webResolvedImports,
      setResolvedCache,
      getResolvedCache,
      dir,
      data,
    }: PackageData,
    targetWeb: boolean,
    options: InternalResolveOptions,
  ): string | undefined {
    const cache = getResolvedCache(id, targetWeb)
    if (cache) {
      return cache
    }
  
    let relativeId: string | undefined | void = id
    const { exports: exportsField, browser: browserField } = data
  
    // map relative based on exports data
    if (exportsField) {
      if (isObject(exportsField) && !Array.isArray(exportsField)) {
        // resolve without postfix (see #7098)
        const { file, postfix } = splitFileAndPostfix(relativeId)
        const exportsId = resolveExportsOrImports(
          data,
          file,
          options,
          targetWeb,
          'exports',
        )
        if (exportsId !== undefined) {
          relativeId = exportsId + postfix
        } else {
          relativeId = undefined
        }
      } else {
        // not exposed
        relativeId = undefined
      }
      if (!relativeId) {
        throw new Error(
          `Package subpath '${relativeId}' is not defined by "exports" in ` +
            `${path.join(dir, 'package.json')}.`,
        )
      }
    } else if (targetWeb && options.browserField && isObject(browserField)) {
      // resolve without postfix (see #7098)
      const { file, postfix } = splitFileAndPostfix(relativeId)
      const mapped = mapWithBrowserField(file, browserField)
      if (mapped) {
        relativeId = mapped + postfix
      } else if (mapped === false) {
        return (webResolvedImports[id] = browserExternalId)
      }
    }
  
    if (relativeId) {
      const resolved = tryFsResolve(
        path.join(dir, relativeId),
        options,
        !exportsField, // try index only if no exports field
        targetWeb,
      )
      if (resolved) {
        debug?.(
          `[node/deep-import] ${colors.cyan(id)} -> ${colors.dim(resolved)}`,
        )
        setResolvedCache(id, resolved, targetWeb)
        return resolved
      }
    }
  }
  