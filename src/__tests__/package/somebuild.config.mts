// https://github.com/vitejs/vite/blob/main/playground/config/__tests__/load.spec.ts
import a from "./a.json"

export default {
    "name": "anybuild",
    "type": "module",
    "version": "0.0.1-beta.16",
    "main": "./dist/bin.js",
    "types": "./dist/bin.d.ts",
    "bin": {
        "anybuild": "./dist/bin.js"
    },
    "a": a,
    "files": [
        "dist",
        "html"
    ]
}