'use strict';

// Updates come from the releases of this repository. The address is baked into
// the build, so an installed copy knows where to look without being told.
// VIDGET_UPDATE_URL overrides it when the files live somewhere else instead.
const updateUrl = process.env.VIDGET_UPDATE_URL;

module.exports = {
  appId: 'com.vidget.overlay',
  productName: 'Vidget',
  directories: { output: 'dist', buildResources: 'assets' },
  files: ['src/**/*', 'assets/**/*', 'package.json'],
  asarUnpack: ['src/ps/**'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'assets/icon-256.png',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: 'Vidget',
    installerLanguages: ['ru_RU', 'en_US'],
  },
  publish: updateUrl
    ? [{ provider: 'generic', url: updateUrl }]
    : [{ provider: 'github', owner: 'kgusev501-prog', repo: 'vidget' }],
};
