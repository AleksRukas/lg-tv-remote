const express = require('express');
const WebSocket = require('ws');
const app = express();
app.use(express.json());

const TV_STORE = {};

/* ── Connect main WS ── */
function connectMainWS(ip) {
  return new Promise((resolve, reject) => {
    const urls = [
      `ws://${ip}:3000/`,
      `wss://${ip}:3001/`
    ];
    let tried = 0;
    function tryNext() {
      if (tried >= urls.length) { reject(new Error('All main WS connection attempts failed')); return; }
      const url = urls[tried++];
      const ws = new WebSocket(url, { perMessageDeflate: false, rejectUnauthorized: false });
      let done = false;
      ws.on('open', () => { if (!done) { done = true; resolve(ws); } });
      ws.on('error', () => { if (!done) tryNext(); });
      setTimeout(() => { if (!done) { ws.close(); tryNext(); } }, 3000);
    }
    tryNext();
  });
}

/* ── Connect input WS to socket path ── */
function connectInputWS(ip, socketPath) {
  return new Promise((resolve, reject) => {
    const url = socketPath.startsWith('ws://') || socketPath.startsWith('wss://')
      ? socketPath
      : `ws://${ip}:3000${socketPath}`;
    const ws = new WebSocket(url, { perMessageDeflate: false, rejectUnauthorized: false });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/* ── Send JSON SSAP on main WS ── */
function sendSSAP(ip, uri, payload = {}) {
  const entry = TV_STORE[ip];
  if (!entry || !entry.mainWs || entry.mainWs.readyState !== WebSocket.OPEN) return false;
  entry.commandCount++;
  const msg = JSON.stringify({
    id: entry.commandCount,
    type: 'request',
    uri: uri.startsWith('ssap://') ? uri : `ssap://${uri}`,
    payload
  });
  entry.mainWs.send(msg);
  return true;
}

/* ── Send button via input WS (text format) ── */
function sendButtonRaw(ip, name) {
  const entry = TV_STORE[ip];
  if (!entry || !entry.inputWs || entry.inputWs.readyState !== WebSocket.OPEN) return false;
  entry.inputWs.send(`type:button\nname:${name.toUpperCase()}\n\n`);
  return true;
}

/* ── Try SSAP button method (for C9 which doesn't support pointer input socket) ── */
function sendButtonSSAP(ip, name) {
  const key = name.toLowerCase();
  // SSAP methods with known-correct URIs for C9
  const ssapMap = {
    home: { uri: 'system.launcher/launch', payload: { id: 'com.webos.app.home' } },
    back: { uri: 'system.launcher/launch', payload: { id: 'com.webos.app.back' } },
    enter: { uri: 'com.webos.service.ime/sendEnterKey', payload: {} },
    menu: { uri: 'system.launcher/launch', payload: { id: 'com.webos.app.menu' } },
    qmenu: { uri: 'system.launcher/launch', payload: { id: 'com.webos.app.qmenu' } },
    info: { uri: 'system.launcher/launch', payload: { id: 'com.webos.app.info' } },
    guide: { uri: 'system.launcher/launch', payload: { id: 'com.webos.app.guide' } },
    myapps: { uri: 'system.launcher/launch', payload: { id: 'com.webos.app.myapps' } },
    recent: { uri: 'system.launcher/launch', payload: { id: 'com.webos.app.recent' } },
    inputHub: { uri: 'system.launcher/launch', payload: { id: 'com.webos.app.inputhub' } },
    exit: { uri: 'system/turnOff', payload: {} },
  };
  if (ssapMap[key]) {
    return sendSSAP(ip, ssapMap[key].uri, ssapMap[key].payload);
  }
  // Volume via SSAP
  if (key === 'volumeup') return sendSSAP(ip, 'audio/volumeUp', {});
  if (key === 'volumedown') return sendSSAP(ip, 'audio/volumeDown', {});
  if (key === 'mute') return sendSSAP(ip, 'audio/setMute', { mute: true });
  // Channel via SSAP
  if (key === 'channelup') return sendSSAP(ip, 'tv/channels/chUp', {});
  if (key === 'channeldown') return sendSSAP(ip, 'tv/channels/chDown', {});
  return false;
}

/* ── Listen for messages ── */
function attachEvents(ip) {
  console.log(`[TV ${ip}] attachEvents called`);
  const entry = TV_STORE[ip];

  // Main WS messages
  entry.mainWs.on('message', (data) => {
    console.log(`[TV ${ip}] ← main: received ${data.length} bytes`);
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[TV ${ip}] ← main: type=${msg.type}`, JSON.stringify(msg).substring(0, 200));

      if (msg.type === 'registered') {
        const newKey = msg.payload?.['client-key'];
        console.log(`[TV ${ip}] ✓ PAIRED — key: [REDACTED]`);
        entry.paired = true;
        entry.clientKey = newKey;
        // Save client key to disk for future auto-pairing
        try {
          const fs = require('fs');
          const dir = '/data/lg-remote-keys/';
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(`${dir}${ip}.json`, JSON.stringify({ clientKey: newKey }));
          console.log(`[TV ${ip}] Key saved to disk`);
        } catch(e) {
          console.log(`[TV ${ip}] Could not save key: ${e.message}`);
        }
        // Try to open input socket and fetch app list after pairing
        if (!entry.socketRequested) {
          entry.socketRequested = true;
          setTimeout(() => tryOpenInputSocket(ip), 1000);
          setTimeout(() => fetchLaunchPoints(ip), 3000);
        }
      }

      if (msg.type === 'response' && msg.payload?.socketPath) {
        // socketPath may be a full URL or just a path
        const socketUrl = msg.payload.socketPath.startsWith('ws://') || msg.payload.socketPath.startsWith('wss://')
          ? msg.payload.socketPath
          : `ws://${ip}:3000${msg.payload.socketPath}`;
        console.log(`[TV ${ip}] → Opening input WS: ${socketUrl}`);
        connectInputWS(ip, socketUrl).then((inputWs) => {
          entry.inputWs = inputWs;
          console.log(`[TV ${ip}] ✓ Input WS OPEN`);
        }).catch((e) => {
          console.log(`[TV ${ip}] ✗ Input WS error: ${e.message}`);
        });
      }

      if (msg.type === 'response' && msg.payload?.launchPoints) {
        // Cache installed app list
        const apps = (msg.payload.launchPoints || [])
          .filter(a => a.visible !== false)
          .map(a => ({
            id: a.id,
            name: a.title || a.id,
            color: a.bgColor || '#333',
            icon: a.iconImage || ''
          }));
        entry.launchPoints = apps;
        console.log(`[TV ${ip}] ✓ Found ${apps.length} apps`);
      }

      if (msg.type === 'error') {
        // Ignore 404 errors for services not supported on C9
        const code = msg.error || '';
        if (!code.includes('404') && !code.includes('Application error')) {
          console.log(`[TV ${ip}] ✗ ${JSON.stringify(msg).substring(0, 200)}`);
        }
      }
    } catch (e) {}
  });
}

function tryOpenInputSocket(ip) {
  const entry = TV_STORE[ip];
  if (!entry || !entry.mainWs || entry.mainWs.readyState !== WebSocket.OPEN) return;
  sendSSAP(ip, 'com.webos.service.networkinput/getPointerInputSocket', {});
}

/* ── Fetch installed apps ── */
function fetchLaunchPoints(ip) {
  const entry = TV_STORE[ip];
  if (!entry || !entry.mainWs || entry.mainWs.readyState !== WebSocket.OPEN) return;
  sendSSAP(ip, 'com.webos.applicationManager/listLaunchPoints', {});
}

/* ── REST API ── */

app.get('/api/status', (req, res) => {
  const ip = req.query.ip;
  if (!ip) return res.json({ connected: false });
  const e = TV_STORE[ip];
  res.json({
    connected: !!(e && e.mainWs && e.mainWs.readyState === WebSocket.OPEN),
    paired: !!e?.paired,
    hasInputWs: !!(e?.inputWs && e.inputWs.readyState === WebSocket.OPEN),
    ip
  });
});

app.post('/api/connect', async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });

  // Check if we already have a paired connection for this IP
  const existing = TV_STORE[ip];
  if (existing?.mainWs?.readyState === WebSocket.OPEN && existing.paired) {
    // Already connected and paired — just confirm status
    return res.json({
      success: true,
      ip,
      paired: true,
      message: 'Already connected and paired.'
    });
  }

  // Disconnect old
  const old = TV_STORE[ip];
  if (old?.mainWs) { old.mainWs.close(); }
  if (old?.inputWs) { old.inputWs.close(); }
  delete TV_STORE[ip];
  // Wait a moment for old connection to fully tear down
  await new Promise(r => setTimeout(r, 1500));

  // Get saved client key for auto-pairing
  let savedKey = null;
  try {
    const fs = require('fs');
    const keyPath = `/data/lg-remote-keys/${ip}.json`;
    if (fs.existsSync(keyPath)) {
      savedKey = JSON.parse(fs.readFileSync(keyPath, 'utf8')).clientKey;
      console.log(`[TV ${ip}] Using saved key: [REDACTED]...`);
    }
  } catch(e) {}

  try {
    const mainWs = await connectMainWS(ip);
    const entry = {
      mainWs,
      inputWs: null,
      paired: false,
      clientKey: savedKey,
      commandCount: 0,
      buttonSocket: null,
      launchPoints: null
    };
    TV_STORE[ip] = entry;
    attachEvents(ip);

    // Build registration message with optional client-key
    const regPayload = {
      forcePairing: !savedKey,  // force only when no saved key
      manifest: {
        appVersion: '1.1',
        manifestVersion: 1,
        permissions: [
          'APP_TO_APP','CLOSE','CONTROL_AUDIO','CONTROL_DISPLAY',
          'CONTROL_INPUT_JOYSTICK','CONTROL_INPUT_MEDIA_PLAYBACK',
          'CONTROL_INPUT_MEDIA_RECORDING','CONTROL_INPUT_TEXT',
          'CONTROL_INPUT_TV','CONTROL_MOUSE_AND_KEYBOARD',
          'CONTROL_POWER','CONTROL_TV_SCREEN','LAUNCH','LAUNCH_WEBAPP',
          'READ_APP_STATUS','READ_COUNTRY_INFO','READ_CURRENT_CHANNEL',
          'READ_INPUT_DEVICE_LIST','READ_INSTALLED_APPS',
          'READ_NETWORK_STATE','READ_NOTIFICATIONS','READ_POWER_STATE',
          'READ_RUNNING_APPS','READ_SETTINGS','READ_TV_CHANNEL_LIST',
          'READ_TV_CURRENT_TIME','READ_UPDATE_INFO','SEARCH',
          'TEST_OPEN','TEST_PROTECTED','TEST_SECURE',
          'UPDATE_FROM_REMOTE_APP',
          'WRITE_NOTIFICATION_ALERT','WRITE_NOTIFICATION_TOAST','WRITE_SETTINGS'
        ]
      }
    };
    if (savedKey) regPayload['client-key'] = savedKey;
    const regMsg = JSON.stringify({ type: 'register', id: 'register_0', payload: regPayload });

    console.log(`[TV ${ip}] → register${savedKey ? ' (key: [REDACTED]...)' : ''}`);
    mainWs.send(regMsg);

    res.json({
      success: true,
      ip,
      needsPairing: !savedKey,
      message: savedKey ? 'Auto-pairing with saved key.' : 'Connected — accept the pairing prompt on your TV screen.'
    });
  } catch (err) {
    console.log(`[TV ${ip}] Connection failed: ${err.message}`);
    res.json({ error: 'Connection failed', message: err.message });
  }
});

app.post('/api/register', (req, res) => {
  const { ip } = req.body;
  const entry = TV_STORE[ip];
  if (entry?.mainWs?.readyState === WebSocket.OPEN) {
    const regMsg = JSON.stringify({
      type: 'register',
      id: 'register_0',
      payload: {
        forcePairing: false,
        pairingType: 'PROMPT',
        manifest: { appVersion: '1.1', manifestVersion: 1, permissions: [] }
      }
    });
    entry.mainWs.send(regMsg);
  }
  res.json({ success: true });
});

app.post('/api/disconnect', (req, res) => {
  const { ip } = req.body;
  const e = TV_STORE[ip];
  if (e?.mainWs) e.mainWs.close();
  if (e?.inputWs) e.inputWs.close();
  delete TV_STORE[ip];
  res.json({ success: true });
});

app.post('/api/power', (req, res) => {
  const { ip, action } = req.body;
  const e = TV_STORE[ip];
  if (!e || !e.mainWs || e.mainWs.readyState !== WebSocket.OPEN) return res.status(400).json({ error: 'TV not connected' });
  if (action === 'on') sendSSAP(ip, 'system/turnOn');
  else sendSSAP(ip, 'system/turnOff');
  res.json({ success: true });
});

app.post('/api/volume/set', (req, res) => {
  const { ip, volume } = req.body;
  sendSSAP(ip, 'audio/setVolume', { value: parseInt(volume) || 0 });
  res.json({ success: true });
});

app.post('/api/mute', (req, res) => {
  const { ip, toggle } = req.body;
  // toggle=true means set to muted (on), toggle=false means unmute (off)
  const isMuted = toggle !== undefined ? toggle : true;
  sendSSAP(ip, 'audio/setMute', { mute: isMuted });
  res.json({ success: true });
});

app.post('/api/unmute', (req, res) => {
  const { ip } = req.body;
  sendSSAP(ip, 'audio/setMute', { mute: false });
  res.json({ success: true });
});

app.post('/api/button', (req, res) => {
  const { ip, action } = req.body;
  if (!action || !ip) return res.status(400).json({ error: 'action + IP required' });
  // Input WS is primary — works on C9 pointer socket
  if (sendButtonRaw(ip, action)) {
    res.json({ success: true, method: 'input_socket' });
  } else {
    res.json({ success: false, method: 'none' });
  }
});

app.post('/api/volume', (req, res) => {
  const { ip, action, value } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
  const entry = TV_STORE[ip];
  // Try input WS first
  const volAction = action === 'up' ? 'volumeup' : action === 'down' ? 'volumedown' : 'mute';
  if (sendButtonRaw(ip, volAction)) {
    return res.json({ success: true, method: 'input_socket' });
  }
  // Fallback: SSAP
  if (action === 'up') return sendSSAP(ip, 'audio/volumeUp', {});
  if (action === 'down') return sendSSAP(ip, 'audio/volumeDown', {});
  if (action === 'mute') return sendSSAP(ip, 'audio/setMute', { mute: true });
  if (action === 'set' && value !== undefined) {
    return sendSSAP(ip, 'audio/setVolume', { volume: Math.min(100, Math.max(0, parseInt(value))) });
  }
  res.json({ success: false });
});

app.post('/api/input/switch', (req, res) => {
  const { ip, inputId } = req.body;
  if (!inputId || !ip) return res.status(400).json({ error: 'inputId + IP required' });
  const entry = TV_STORE[ip];
  if (!entry || !entry.mainWs || entry.mainWs.readyState !== WebSocket.OPEN) {
    return res.json({ success: false });
  }
  // Use ssap://tv/switchInput with native input IDs (HDMI_1, HDMI_2, etc.)
  const inputMap = {
    'HDMI_1': 'HDMI_1',
    'HDMI_2': 'HDMI_2',
    'HDMI_3': 'HDMI_3',
    'HDMI_4': 'HDMI_4',
  };
  const tvInputId = inputMap[inputId] || inputId;
  sendSSAP(ip, 'tv/switchInput', { inputId: tvInputId });
  res.json({ success: true, method: 'ssap', inputId: tvInputId });
});

app.post('/api/launch', (req, res) => {
  const { ip, appId } = req.body;
  if (!appId || !ip) return res.status(400).json({ error: 'appId + IP required' });
  // HDMI inputs mapped from the input_ prefix — use tv/switchInput
  const hdmiMap = {
    'input_1': 'HDMI_1',
    'input_2': 'HDMI_2',
    'input_3': 'HDMI_3',
    'input_4': 'HDMI_4',
  };
  const mapped = hdmiMap[appId];
  if (mapped) {
    sendSSAP(ip, 'tv/switchInput', { inputId: mapped });
    res.json({ success: true, method: 'ssap', appId: mapped });
  } else if (appId === 'tv') {
    // Live TV
    sendSSAP(ip, 'system.launcher/launch', { id: 'com.webos.app.livetv' });
    res.json({ success: true, method: 'ssap', appId: 'com.webos.app.livetv' });
  } else if (appId === 'youtube') {
    // YouTube app
    sendSSAP(ip, 'system.launcher/launch', { id: 'com.webos.app.youtube' });
    res.json({ success: true, method: 'ssap', appId: 'com.webos.app.youtube' });
  } else {
    sendSSAP(ip, 'system.launcher/launch', { id: appId });
    res.json({ success: true });
  }
});

app.post('/api/media', (req, res) => {
  const { ip, action } = req.body;
  const m = { play:'PLAY',pause:'PAUSE',stop:'STOP',rewind:'REWIND',fastForward:'FORWARD' };
  sendSSAP(ip, 'media.controls/' + (m[action] || action));
  res.json({ success: true });
});

app.get('/api/apps', (req, res) => {
  const ip = req.query.ip;
  if (!ip) return res.json([]);
  const entry = TV_STORE[ip];
  if (entry?.launchPoints) return res.json(entry.launchPoints);
  // No cached list — try fetching it
  if (entry?.mainWs?.readyState === WebSocket.OPEN) {
    fetchLaunchPoints(ip);
  }
  res.json([]);
});

app.post('/api/apps/refresh', (req, res) => {
  const ip = req.body?.ip;
  if (!ip) return res.json([]);
  const entry = TV_STORE[ip];
  if (!entry?.mainWs?.readyState === WebSocket.OPEN) return res.json([]);
  fetchLaunchPoints(ip);
  setTimeout(() => {
    const updated = entry?.launchPoints || [];
    res.json(updated);
  }, 1500);
});

app.get('/api/apps/common', (req, res) => res.json([]));

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`LG WebOS Remote API on port ${PORT}`));
