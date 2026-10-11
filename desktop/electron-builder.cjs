// electron-builder's settings for the Steam builds: plain folders ("dir" targets), no installers. Steam
// takes a folder per depot (see docs/STEAM.md).
//   npm run dist           both:     dist/win-unpacked/ and dist/linux-unpacked/
//   npm run dist:win       Windows   (from Linux too: no code signing needed for a Steam depot)
//   npm run dist:linux     Linux / Steam Deck
// NMD_FUSES=0 leaves Electron's fuses alone (the desktop test drives a packaged build over --inspect).
const fuses = process.env.NMD_FUSES !== '0';
module.exports = {
  appId: 'com.nomoneydown.game',
  productName: 'NO MONEY DOWN',
  copyright: 'Copyright (c) 2026 No Money Down Inc.',
  directories: { output: process.env.NMD_OUT || 'dist', buildResources: 'desktop/build' },
  // keep every pattern in this one list: a platform-level "files" gets an implicit "**/*" in front of it
  // and packs the whole folder (tests, tools, screenshots)
  files: [
    'package.json',
    'desktop/*.cjs', 'desktop/*.mjs', 'desktop/steam/*.cjs', 'desktop/icon.png',
    '!desktop/electron-builder.cjs', '!desktop/make-icons.mjs',
    'server/**', 'shared/**', 'client/**',
    '!client/gallery.html', '!client/preview.html',
    '!**/*.map', '!**/*.d.ts', '!**/*.md', '!**/*.ts',
    '!node_modules/three/**',                                          // the page loads client/vendor/three.module.js
    '!node_modules/@dimforge/rapier3d-compat/dist/rapier_wasm3d*',     // the compat build inlines its wasm in rapier.mjs
    '!node_modules/@types/**', '!node_modules/undici-types/**',        // type definitions steamworks.js depends on
    '!node_modules/steamworks.js/dist/osx/**', '!node_modules/steamworks.js/dist/win64/*.lib',
  ],
  extraFiles: [{ from: 'desktop/THIRD_PARTY_NOTICES.txt', to: 'THIRD_PARTY_NOTICES.txt' }],   // node tools/notices.mjs
  asar: true,
  asarUnpack: ['node_modules/steamworks.js/dist/**'],                  // the .node addon and steam_api64.dll / libsteam_api.so beside it
  electronLanguages: ['en-US'],                                        // drops ~45 MB of Chromium's UI translations
  ...(fuses && { electronFuses: {
    runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, enableCookieEncryption: false,
  } }),
  win: { target: [{ target: 'dir', arch: ['x64'] }], icon: 'desktop/build/icon.ico', executableName: 'NoMoneyDown', signAndEditExecutable: true },
  linux: { target: [{ target: 'dir', arch: ['x64'] }], icon: 'desktop/build/icon.png', executableName: 'nomoneydown', category: 'Game' },
  publish: null,                                                       // Steam ships the updates
  // each build keeps only its own platform's Steam library
  afterPack: async ({ appOutDir, electronPlatformName }) => {
    const fs = require('node:fs'), path = require('node:path');
    const dir = path.join(appOutDir, 'resources/app.asar.unpacked/node_modules/steamworks.js/dist');
    const other = electronPlatformName === 'win32' ? 'linux64' : 'win64';
    fs.rmSync(path.join(dir, other), { recursive: true, force: true });
  },
};
