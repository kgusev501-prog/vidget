'use strict';

// The update feed is optional. When VIDGET_UPDATE_URL is set the build also
// writes latest.yml next to the installer, which is what the widget reads to
// notice a newer version; without it the build simply produces an installer.
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
  ...(updateUrl ? { publish: [{ provider: 'generic', url: updateUrl }] } : { publish: null }),
};
