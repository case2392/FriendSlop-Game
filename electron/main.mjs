// NO MONEY DOWN desktop shell for Steam.
// Boots the game server inside the Electron main process, then opens the
// client pointed at it. Friends connect over the internet to the same room
// code via any hosted server; solo trips work fully offline.
import { app, BrowserWindow, shell } from 'electron';

const PORT = 31337;
process.env.PORT = String(PORT);

app.whenReady().then(async () => {
  // Importing the server module starts it listening on PORT (after the
  // physics engine's WASM initializes — the import resolves after that).
  await import('../server/index.js');

  const win = new BrowserWindow({
    width: 1600,
    height: 940,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#14101f',
    autoHideMenuBar: true,
    title: 'NO MONEY DOWN',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External links (if any ever appear) open in the OS browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(`http://localhost:${PORT}`);
});

app.on('window-all-closed', () => app.quit());
