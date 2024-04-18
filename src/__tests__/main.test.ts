import { loadConfigFromFile } from "../main"

import { describe, expect, test, afterEach, vi } from 'vitest'
import path from "path"

describe('测试是否正确读取配置文件', () => {
    test('loadConfigFromFile正常读取', async () => {
        expect.assertions(1)
        const result = await loadConfigFromFile({} as any, ['somebuild.config.mts', 'somebuild.config.ts'], path.join(__dirname, "./package"))

        expect(result?.config).toStrictEqual({
            "name": "anybuild",
            "type": "module",
            "version": "0.0.1-beta.16",
            "main": "./dist/bin.js",
            "types": "./dist/bin.d.ts",
            "bin": {
                "anybuild": "./dist/bin.js"
            },
            "a": {
                "a": "aaaaaaaaaaaaa"
            },
            "files": [
                "dist",
                "html"
            ]
        })
    })
})

