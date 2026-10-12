const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const os = require('os');
const { exec } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');

// ----------------------------------------------------
// Chromium Flags for Audio Sink Routing & Background Media
// ----------------------------------------------------
app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// Safe robotjs loading with fallback
let robot = null;
try {
  robot = require('@jitsi/robotjs');
} catch (e1) {
  try {
    robot = require('robotjs');
  } catch (e2) {
    console.warn('[Warning] RobotJS could not be loaded. Events will fall back to virtual Electron IPC handling.');
  }
}

// ----------------------------------------------------
// Generate 6-Digit Dynamic Pairing ID & Network IP
// ----------------------------------------------------
const PAIRING_ID = Math.floor(100000 + Math.random() * 900000).toString();

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIpAddress();
const PORT = 3000;

// QR Code Payload (Formal JSON Schema for Standalone Android Scanner)
const qrPayload = JSON.stringify({
  type: 'SMART_TV_REMOTE',
  version: '1.0',
  ip: localIp,
  port: PORT,
  id: PAIRING_ID,
  serverUrl: `http://${localIp}:${PORT}`
});

// ----------------------------------------------------
// Express & Socket.io Server Setup
// ----------------------------------------------------
const expressApp = express();
const server = http.createServer(expressApp);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

expressApp.get('/status', (req, res) => {
  res.json({
    status: 'running',
    pairingId: PAIRING_ID,
    localIp,
    port: PORT,
    qrPayload
  });
});

let tvWindow = null;
let targetDisplayBounds = { x: 0, y: 0, width: 1920, height: 1080 };
let tvCursor = { x: 0, y: 0 };
let connectedRemotesCount = 0;

// ----------------------------------------------------
// Background Automated Windows Audio Routing
// ----------------------------------------------------
function routeProcessAudioInWindows(targetDeviceKeyword = 'LG TV') {
  if (process.platform !== 'win32') return;

  const psScript = `
    $devices = Get-CimInstance Win32_SoundDevice | Where-Object { $_.Name -like '*${targetDeviceKeyword}*' -or $_.Name -like '*HDMI*' }
    if ($devices) {
      Write-Output "FOUND_AUDIO_DEVICE:$($devices[0].Name)"
    } else {
      Write-Output "NO_SPECIFIC_HDMI_FOUND"
    }
  `;

  exec(`powershell -NoProfile -Command "${psScript.replace(/\r?\n/g, ' ')}"`, (err, stdout) => {
    if (!err && stdout) {
      console.log(`[Audio Router] Windows CoreAudio Detection:`, stdout.trim());
    }
  });
}

function setupSocketEvents() {
  io.on('connection', (socket) => {
    console.log(`[Socket.io] Android App Connected: ${socket.id}`);

    // Join room strictly based on scanned Pairing ID
    socket.on('join_pairing', (id, callback) => {
      const sanitizedId = String(id).trim();
      if (sanitizedId === PAIRING_ID) {
        socket.join(PAIRING_ID);
        connectedRemotesCount++;
        console.log(`[Socket.io] Android App paired successfully into room ${PAIRING_ID}`);

        if (typeof callback === 'function') {
          callback({ success: true, pairingId: PAIRING_ID, bounds: targetDisplayBounds, cursor: tvCursor });
        }

        if (tvWindow && !tvWindow.isDestroyed()) {
          tvWindow.webContents.send('remote_status_changed', { connected: true, remotesCount: connectedRemotesCount });
        }
      } else {
        console.warn(`[Socket.io] Invalid pairing attempt: "${sanitizedId}" expected "${PAIRING_ID}"`);
        if (typeof callback === 'function') {
          callback({ success: false, message: 'Invalid Pairing Code' });
        }
      }
    });

    // 1. Mouse Movement (Scoped to private room)
    socket.on('mouse_move', (data) => {
      if (!socket.rooms.has(PAIRING_ID)) return;
      const dx = Number(data.dx) || 0;
      const dy = Number(data.dy) || 0;

      tvCursor.x = Math.max(0, Math.min(targetDisplayBounds.width - 1, tvCursor.x + dx));
      tvCursor.y = Math.max(0, Math.min(targetDisplayBounds.height - 1, tvCursor.y + dy));

      const absX = Math.round(targetDisplayBounds.x + tvCursor.x);
      const absY = Math.round(targetDisplayBounds.y + tvCursor.y);

      if (robot && data.moveHardwareCursor) {
        try { robot.moveMouse(absX, absY); } catch (err) {}
      }

      if (tvWindow && !tvWindow.isDestroyed()) {
        tvWindow.webContents.send('tv_cursor_update', { x: tvCursor.x, y: tvCursor.y, absX, absY });
      }
    });

    // 2. Mouse Click
    socket.on('mouse_click', (data) => {
      if (!socket.rooms.has(PAIRING_ID)) return;
      const button = (data && data.button) || 'left';
      const double = Boolean(data && data.double);

      if (robot && data && data.hardwareClick) {
        try { robot.mouseClick(button, double); } catch (err) {}
      }

      if (tvWindow && !tvWindow.isDestroyed()) {
        tvWindow.webContents.send('tv_mouse_click', { x: tvCursor.x, y: tvCursor.y, button, double });
      }
    });

    // 3. Mouse Scroll
    socket.on('mouse_scroll', (data) => {
      if (!socket.rooms.has(PAIRING_ID)) return;
      const scrollY = Number(data.dy) || 0;
      if (robot && data && data.hardwareScroll) {
        try { robot.scrollMouse(0, scrollY); } catch (err) {}
      }
      if (tvWindow && !tvWindow.isDestroyed()) {
        tvWindow.webContents.send('tv_scroll', { dy: scrollY });
      }
    });

    // 4. Virtual Keyboard Input
    socket.on('keyboard_input', (data) => {
      if (!socket.rooms.has(PAIRING_ID)) return;
      const { key, text, type } = data;

      if (robot && data.hardwareKeyboard !== false) {
        try {
          if (text) {
            robot.typeString(text);
          } else if (key) {
            const validKeys = ['backspace', 'delete', 'enter', 'tab', 'escape', 'up', 'down', 'right', 'left', 'space'];
            const lowerKey = key.toLowerCase();
            if (validKeys.includes(lowerKey) || lowerKey.length === 1) {
              robot.keyTap(lowerKey);
            }
          }
        } catch (err) {}
      }

      if (tvWindow && !tvWindow.isDestroyed()) {
        tvWindow.webContents.send('tv_keyboard_input', { key, text, type });
      }
    });

    // 5. Navigation Actions (D-Pad, Shortcuts)
    socket.on('nav_action', (action) => {
      if (!socket.rooms.has(PAIRING_ID)) return;
      if (tvWindow && !tvWindow.isDestroyed()) {
        tvWindow.webContents.send('tv_nav_action', action);
      }
    });

    // 6. Dedicated TV Volume Control
    socket.on('tv_volume_change', (data) => {
      if (!socket.rooms.has(PAIRING_ID)) return;
      const vol = Math.max(0, Math.min(100, Number(data.value) || 0));
      console.log(`[Volume Control] Adjusting TV Volume to ${vol}%`);

      // A. Update volume of all media elements & iframes on the TV display
      if (tvWindow && !tvWindow.isDestroyed()) {
        tvWindow.webContents.send('tv_volume_update', { value: vol });
      }

      // B. Optional OS-level multimedia volume key taps via RobotJS if relative stepped change
      if (robot && data.action === 'step_up') {
        try { robot.keyTap('audio_vol_up'); } catch (e) {}
      } else if (robot && data.action === 'step_down') {
        try { robot.keyTap('audio_vol_down'); } catch (e) {}
      } else if (robot && data.action === 'mute') {
        try { robot.keyTap('audio_mute'); } catch (e) {}
      }
    });

    socket.on('disconnect', () => {
      if (socket.rooms.has(PAIRING_ID)) {
        connectedRemotesCount = Math.max(0, connectedRemotesCount - 1);
        if (tvWindow && !tvWindow.isDestroyed()) {
          tvWindow.webContents.send('remote_status_changed', {
            connected: connectedRemotesCount > 0,
            remotesCount: connectedRemotesCount
          });
        }
      }
    });
  });
}

// ----------------------------------------------------
// Electron TV Window Configuration
// ----------------------------------------------------
function createTVWindow() {
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const secondaryDisplay = displays.find(d => d.id !== primaryDisplay.id) || primaryDisplay;

  targetDisplayBounds = secondaryDisplay.bounds;
  tvCursor = {
    x: Math.floor(targetDisplayBounds.width / 2),
    y: Math.floor(targetDisplayBounds.height / 2)
  };

  tvWindow = new BrowserWindow({
    x: targetDisplayBounds.x,
    y: targetDisplayBounds.y,
    width: targetDisplayBounds.width,
    height: targetDisplayBounds.height,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0c',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      webSecurity: false
    }
  });

  tvWindow.loadFile(path.join(__dirname, 'tv_display.html'));

  tvWindow.webContents.once('did-finish-load', () => {
    tvWindow.webContents.send('init_pairing_info', {
      pairingId: PAIRING_ID,
      ip: localIp,
      port: PORT,
      qrPayload
    });

    tvWindow.webContents.send('route_hdmi_audio', {
      preferredKeywords: ['LG TV', 'High Definition Audio', 'HDMI', 'LG']
    });
  });

  tvWindow.on('closed', () => {
    tvWindow = null;
  });
}

app.whenReady().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`[Smart TV Server] Running at: http://${localIp}:${PORT}`);
    console.log(`[Pairing Code]    ${PAIRING_ID}`);
    console.log(`[QR Payload]     ${qrPayload}`);
    console.log(`====================================================`);
  });

  routeProcessAudioInWindows('LG TV');
  setupSocketEvents();
  createTVWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createTVWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
