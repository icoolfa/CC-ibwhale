/**
 * ibwhale Claude Code Desktop - Main Process
 * 单实例锁 + 多PTY会话管理 + node-pty
 */
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');
const os = require('os');
const zlib = require('zlib');

// ===== Badclaude Overlay =====
let keybd_event, VkKeyScanA;
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    keybd_event = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
    VkKeyScanA = user32.func('int16_t __stdcall VkKeyScanA(int ch)');
  } catch (e) { console.warn('[badclaude] koffi unavailable:', e.message); }
}

let overlay = null;
let overlayReady = false;
let spawnQueued = false;

const VK_CONTROL = 0x11, VK_RETURN = 0x0D, VK_C = 0x43, VK_MENU = 0x12, VK_TAB = 0x09, KEYUP = 0x0002;

function refocusPreviousApp() {
  if (process.platform !== 'win32' || !keybd_event) return;
  setTimeout(() => {
    keybd_event(VK_MENU, 0, 0, 0); keybd_event(VK_TAB, 0, 0, 0);
    keybd_event(VK_TAB, 0, KEYUP, 0); keybd_event(VK_MENU, 0, KEYUP, 0);
  }, 80);
}

function createOverlay() {
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    const { x, y, width, height } = d.bounds;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }
  overlay = new BrowserWindow({
    x: minX, y: minY, width: maxX - minX, height: maxY - minY,
    transparent: true, frame: false, alwaysOnTop: true, focusable: false,
    skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'badclaude', 'preload.js'),
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlayReady = false;
  overlay.loadFile(path.join(__dirname, 'badclaude', 'overlay.html'));
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (spawnQueued && overlay && overlay.isVisible()) { spawnQueued = false; overlay.webContents.send('spawn-whip'); }
  });
  overlay.on('closed', () => { overlay = null; overlayReady = false; spawnQueued = false; });
}

function toggleOverlay() {
  if (overlay && overlay.isVisible()) { overlay.webContents.send('drop-whip'); return; }
  if (!overlay) createOverlay();
  overlay.show();
  if (overlayReady) { overlay.webContents.send('spawn-whip'); }
  else { spawnQueued = true; }
}

ipcMain.on('toggle-whip', () => { console.log('[badclaude] toggle-whip called'); toggleOverlay(); });

const phrases = [
  '快点快点快点', '搞快点', '别摸鱼了', '速度速度', '小屁屁欠打了',
  '干活别磨蹭', '给爷冲', '再慢打死你', '滚去干活', '就这速度？',
  'Holy shit!', 'What the fuck!', 'Go go go!',
  'バカヤロウ', '遅いぞこの野郎',
];

function sendMacroWindows(text) {
  if (!keybd_event || !VkKeyScanA) return;
  const tapKey = vk => { keybd_event(vk, 0, 0, 0); keybd_event(vk, 0, KEYUP, 0); };
  const tapChar = ch => {
    const packed = VkKeyScanA(ch.charCodeAt(0));
    if (packed === -1) return;
    const vk = packed & 0xff, shiftState = (packed >> 8) & 0xff;
    if (shiftState & 1) keybd_event(0x10, 0, 0, 0);
    tapKey(vk);
    if (shiftState & 1) keybd_event(0x10, 0, KEYUP, 0);
  };
  for (const ch of text) tapChar(ch);
  keybd_event(VK_RETURN, 0, 0, 0); keybd_event(VK_RETURN, 0, KEYUP, 0);
}

ipcMain.on('whip-crack', () => {
  // Sound is played in overlay, no keyboard macro needed
});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });

// ===== 本地配置持久化 =====
const CONFIG_DIR = path.join(app.getPath('userData'), 'ibwhale');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadLocalConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  // Fallback: parse .env file
  try {
    const projectRoot = path.join(__dirname, '..');
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf-8');
      const env = {};
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      const provider = env.MODEL_PROVIDER || 'anthropic';
      return {
        providerId: provider,
        apiKey: env.ANTHROPIC_AUTH_TOKEN,
        baseUrl: env.ANTHROPIC_BASE_URL,
        selectedModelId: env.ANTHROPIC_MODEL,
        customModel: env.ANTHROPIC_MODEL,
      };
    }
  } catch {}
  return null;
}

function saveLocalConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg), 'utf-8');
  } catch (err) {
    console.error('[ibwhale] 保存配置失败:', err.message);
  }
  // 同步写入 .env 文件
  if (cfg && cfg.apiKey && cfg.baseUrl) {
    try {
      const projectRoot = path.join(__dirname, '..');
      const envFile = path.join(projectRoot, '.env');
      const lines = [
        '# ibwhale API 配置',
        `MODEL_PROVIDER=${cfg.providerId || 'anthropic'}`,
        `ANTHROPIC_BASE_URL=${cfg.baseUrl}`,
        `ANTHROPIC_AUTH_TOKEN=${cfg.apiKey}`,
        `ANTHROPIC_MODEL=${cfg.customModel || cfg.selectedModelId || 'claude-sonnet-4-6'}`,
        ...(cfg.customApiUrl ? [`CUSTOM_API_URL=${cfg.customApiUrl}`] : []),
        '',
        '# 其他配置',
        'API_TIMEOUT_MS=3000000',
        'DISABLE_TELEMETRY=1',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      ];
      fs.writeFileSync(envFile, lines.join('\n'), 'utf-8');
      console.log('[ibwhale] .env 已更新');
    } catch (err) {
      console.error('[ibwhale] 写入 .env 失败:', err.message);
    }
  }
}

let mainWindow = null;

// ===== 多窗口管理 =====
// { BrowserWindow: { id: conversationId, activeConvId: string, convIds: Set<string> } }
const windowMap = new Map();

function getWindowForConvId(convId) {
  for (const [win, info] of windowMap) {
    if (info.id === convId) return win;
  }
  return null;
}

function getWindowInfo(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const info = windowMap.get(win);
  return { win, info };
}

// { id: string, title: string, ptyProcess: object }
const conversations = new Map();

function getShellEnv() {
  return {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Program Files\\Git\\bin\\bash.exe',
  };
}

function spawnPtyForConversation(convId) {
  // Kill existing PTY for this conversation if exists
  const existing = conversations.get(convId);
  if (existing && existing.ptyProcess) {
    try { existing.ptyProcess.kill(); } catch {}
  }

  const pty = require('node-pty');
  const projectRoot = path.join(__dirname, '..');
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
  const batFile = path.join(projectRoot, 'run.bat');
  const args = process.platform === 'win32' ? ['/c', batFile] : [batFile];

  try {
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      useConpty: false,
      cwd: projectRoot,
      env: getShellEnv(),
    });

    ptyProcess.onData((data) => {
      const targetWin = getWindowForConvId(convId);
      // 只要窗口存在就发送输出，不再限制 activeConvId
      // （所有对话共享一个 PTY，输出总是发往窗口）
      if (targetWin && !targetWin.isDestroyed()) {
        targetWin.webContents.send('pty-output', data);
      }
    });

    ptyProcess.onExit(() => {
      const targetWin = getWindowForConvId(convId);
      if (targetWin && !targetWin.isDestroyed()) {
        targetWin.webContents.send('conv-exit', convId);
      }
      const conv = conversations.get(convId);
      if (conv) conv.ptyProcess = null;
    });

    const conv = conversations.get(convId);
    if (conv) {
      conv.ptyProcess = ptyProcess;
      conv.pid = ptyProcess.pid;
    }

    console.log(`[ibwhale] Conv "${convId}" PID:`, ptyProcess.pid);
    return true;
  } catch (err) {
    console.error(`[ibwhale] Conv "${convId}" 启动失败:`, err.message);
    return false;
  }
}

function killAllPtys() {
  for (const [id, conv] of conversations) {
    if (conv.ptyProcess) {
      try { conv.ptyProcess.kill(); } catch {}
      conv.ptyProcess = null;
    }
  }
}

// ===== 单实例锁 =====
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    icon: path.join(__dirname, 'img', 'logo.ico'),
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: true,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 允许渲染进程用 target="_blank" 打开外部链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 渲染进程通过 IPC 打开外部链接
  ipcMain.on('open-url', (_event, url) => {
    shell.openExternal(url);
  });

  // 捕获渲染进程控制台输出写入文件
  const logFile = path.join(__dirname, 'error.log');
  mainWindow.webContents.on('console-message', (level, message, line, source) => {
    if (level >= 1) {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message} (${source}:${line})\n`);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    const info = windowMap.get(mainWindow);
    if (info) {
      for (const convId of info.convIds) {
        const conv = conversations.get(convId);
        if (conv && conv.ptyProcess) {
          try { conv.ptyProcess.kill(); } catch {}
        }
        conversations.delete(convId);
      }
    }
    windowMap.delete(mainWindow);
    mainWindow = null;
  });
}

/**
 * 打开一个新的终端窗口（独立 PTY 会话）
 */
function spawnNewWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    icon: path.join(__dirname, 'img', 'logo.ico'),
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: true,
    },
    show: false,
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 新窗口独立 PTY
  const id = 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  conversations.set(id, { id, title: '新项目', ptyProcess: null, pid: null });
  windowMap.set(win, { id, activeConvId: id, convIds: new Set([id]) });
  spawnPtyForConversation(id);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.on('closed', () => {
    const info = windowMap.get(win);
    if (info) {
      for (const convId of info.convIds) {
        const c = conversations.get(convId);
        if (c && c.ptyProcess) {
          try { c.ptyProcess.kill(); } catch {}
        }
        conversations.delete(convId);
      }
    }
    windowMap.delete(win);
  });
}

// ===== IPC: PTY =====
ipcMain.on('pty-input', (event, data) => {
  const { info } = getWindowInfo(event);
  const conv = info ? conversations.get(info.activeConvId) : null;
  if (conv && conv.ptyProcess) conv.ptyProcess.write(data);
});

ipcMain.on('pty-resize', (event, { cols, rows }) => {
  const { info } = getWindowInfo(event);
  const conv = info ? conversations.get(info.activeConvId) : null;
  if (conv && conv.ptyProcess) {
    try { conv.ptyProcess.resize(cols, rows); } catch {}
  }
});

// ===== IPC: 对话管理 =====
ipcMain.handle('conv-new', (event) => {
  const { win, info } = getWindowInfo(event);
  if (!win || !info) return { ok: false };
  const id = 'conv-' + Date.now().toString(36);
  // 新对话不绑定独立 PTY，复用窗口的原始 PTY（info.id 对应的那个）
  const ownerConv = conversations.get(info.id);
  conversations.set(id, {
    id,
    title: '新对话',
    ptyProcess: ownerConv?.ptyProcess || null,
    pid: ownerConv?.pid || null,
  });
  info.activeConvId = id;
  info.convIds.add(id);
  return { id, title: '新对话', pid: info.id, ok: true };
});

ipcMain.handle('conv-switch', (event, convId) => {
  const { win, info } = getWindowInfo(event);
  if (!win || !info || !conversations.has(convId)) return { ok: false };
  info.activeConvId = convId;
  return { ok: true };
});

ipcMain.handle('conv-delete', (event, convId) => {
  const conv = conversations.get(convId);
  // 不杀 PTY（共享终端），只删除对话条目
  conversations.delete(convId);
  return { ok: true };
});

ipcMain.handle('conv-rename', (_event, { id, title }) => {
  const conv = conversations.get(id);
  if (conv) {
    conv.title = title;
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('conv-list', (event) => {
  const { info } = getWindowInfo(event);
  const activeId = info?.activeConvId;
  const convIds = info?.convIds;
  const list = [];
  for (const [id, conv] of conversations) {
    if (convIds && !convIds.has(id)) continue;
    list.push({ id, title: conv.title, pid: conv.pid, active: id === activeId });
  }
  return list;
});

ipcMain.on('conv-kill', (_event, convId) => {
  const conv = conversations.get(convId);
  if (conv && conv.ptyProcess) {
    try { conv.ptyProcess.kill(); } catch {}
    conv.ptyProcess = null;
    conv.pid = null;
  }
});

ipcMain.on('conv-restart', (_event, convId) => {
  if (conversations.has(convId)) {
    spawnPtyForConversation(convId);
  }
});

// Set model env and restart active PTY
ipcMain.on('set-model-env', (event, cfg) => {
  const { info } = getWindowInfo(event);
  const targetConvId = info?.activeConvId;
  if (!targetConvId) return;
  const conv = conversations.get(targetConvId);
  if (conv && conv.ptyProcess) {
    try { conv.ptyProcess.kill(); } catch {}
    conv.ptyProcess = null;
    conv.pid = null;
  }
  setTimeout(() => {
    if (conv && targetConvId) spawnPtyForConversation(targetConvId);
  }, 500);
});

ipcMain.handle('config-load', () => loadLocalConfig());
ipcMain.handle('config-save', (_event, cfg) => saveLocalConfig(cfg));

// ===== 检查更新 =====
const { version: APP_VERSION } = require('./package.json');
const GITHUB_API = 'api.github.com';
const GITHUB_REPO = '/repos/icoolfa/CC-ibwhale/releases/latest';

ipcMain.handle('get-app-version', () => APP_VERSION);

ipcMain.handle('check-update', async () => {
  try {
    const result = await githubRequest(GITHUB_API, GITHUB_REPO);
    if (!result || !result.tag_name) return { ok: false, error: '获取版本失败' };

    const latestTag = result.tag_name.replace(/^v/, '');
    const current = APP_VERSION;
    const hasUpdate = compareVersions(latestTag, current) > 0;

    return {
      ok: true,
      hasUpdate,
      current,
      latest: latestTag,
      name: result.name || latestTag,
      body: result.body || '',
      htmlUrl: result.html_url || 'https://github.com/icoolfa/CC-ibwhale/releases',
      assets: (result.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })),
    };
  } catch (err) {
    console.error('[ibwhale] 检查更新失败:', err.message);
    return { ok: false, error: err.message };
  }
});

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function githubRequest(host, path) {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      hostname: host,
      port: 443,
      path,
      headers: { 'User-Agent': 'ibwhale', 'Accept': 'application/vnd.github.v3+json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode === 404) { resolve(null); return; }
          if (res.statusCode && res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          resolve(JSON.parse(data));
        } catch { reject(new Error('无效响应')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// ===== 自动更新 =====
const UPDATE_PROGRESS_INTERVAL = 500;

// 文件不更新列表
const SKIP_FILES = ['.env', 'config.json', 'error.log', 'node_modules', '.git', '.gitignore', 'package-lock.json'];

ipcMain.handle('auto-update', async () => {
  try {
    // 1. 获取最新版本信息
    const release = await githubRequest(GITHUB_API, GITHUB_REPO);
    if (!release || !release.tag_name) return { ok: false, error: '获取版本失败' };

    const latestTag = release.tag_name.replace(/^v/, '');
    if (compareVersions(latestTag, APP_VERSION) <= 0) {
      return { ok: true, message: '已是最新版本' };
    }

    // 2. 找到 ZIP 资产（优先 ibwhale.zip，其次 Source code）
    const zipAsset = (release.assets || []).find(a => {
      if (a.name === 'ibwhale.zip') return true;
      if (a.name.endsWith('.zip') && (a.name.includes('Source') || a.name.includes('source'))) return true;
      return false;
    });
    if (!zipAsset) return { ok: false, error: '未找到 ZIP 更新包' };

    // 3. 下载 ZIP 到临时目录
    const tmpDir = path.join(os.tmpdir(), 'ibwhale-update-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, 'update.zip');

    await downloadFile(zipAsset.browser_download_url, zipPath, (pct) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-progress', { stage: 'downloading', progress: pct });
      }
      // Also notify all other windows
      for (const [win] of windowMap) {
        if (win !== mainWindow && !win.isDestroyed()) {
          win.webContents.send('update-progress', { stage: 'downloading', progress: pct });
        }
      }
    });

    // 4. 解压
    const notifyAll = (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', data);
      for (const [win] of windowMap) {
        if (win !== mainWindow && !win.isDestroyed()) win.webContents.send('update-progress', data);
      }
    };
    notifyAll({ stage: 'extracting', progress: 0 });
    const extractDir = path.join(tmpDir, 'extracted');
    await extractZip(zipPath, extractDir);

    // 5. 找到解压后的文件夹（通常是 CC-ibwhale-xxx/）
    const updateDir = fs.readdirSync(extractDir).find(f => fs.statSync(path.join(extractDir, f)).isDirectory());
    if (!updateDir) return { ok: false, error: '解压后未找到更新目录' };
    const sourceDir = path.join(extractDir, updateDir);

    // 6. 复制文件（跳过不需要更新的文件）
    const targetDir = path.join(__dirname);
    await copyUpdateFiles(sourceDir, targetDir);

    // 7. 清理临时文件
    cleanupTemp(tmpDir);

    // 8. 重启应用
    notifyAll({ stage: 'restarting', progress: 100 });
    // 延迟重启确保 UI 能显示完成状态
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 1500);

    return { ok: true, version: latestTag };
  } catch (err) {
    console.error('[ibwhale] 自动更新失败:', err.message, err.stack);
    return { ok: false, error: err.message };
  }
});

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;
    transport.get(url, { headers: { 'User-Agent': 'ibwhale' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        transport.get(res.headers.location, { headers: { 'User-Agent': 'ibwhale' } }, (res2) => {
          doDownload(res2, dest, onProgress).then(resolve).catch(reject);
        }).on('error', reject);
        return;
      }
      doDownload(res, dest, onProgress).then(resolve).catch(reject);
    }).on('error', reject);
  });
}

function doDownload(res, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let downloaded = 0;
    const file = fs.createWriteStream(dest);
    let lastProgress = 0;

    res.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total > 0) {
        const pct = Math.round((downloaded / total) * 100);
        if (pct !== lastProgress) {
          lastProgress = pct;
          onProgress(pct);
        }
      }
    });

    res.pipe(file);
    file.on('finish', () => {
      file.close();
      resolve();
    });
    file.on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // 使用 PowerShell 解压（Windows 内置）
    const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    ps.stderr.on('data', (d) => (stderr += d.toString()));

    ps.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`PowerShell 解压失败: ${stderr.slice(0, 300)}`));
      }
    });
    ps.on('error', reject);
  });
}

function copyUpdateFiles(srcDir, targetDir) {
  const items = fs.readdirSync(srcDir);
  for (const item of items) {
    if (SKIP_FILES.includes(item)) continue;
    const srcPath = path.join(srcDir, item);
    const targetPath = path.join(targetDir, item);
    const stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true });
      copyUpdateFiles(srcPath, targetPath);
    } else {
      fs.copyFileSync(srcPath, targetPath);
    }
  }
}

function cleanupTemp(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

// ===== 翻译 (主进程，无 CORS 限制) =====
ipcMain.handle('translate', async (_event, text) => {
  const cfg = loadLocalConfig();
  if (!cfg?.apiKey || !cfg?.baseUrl || !cfg?.selectedModelId) {
    return '请先配置 API';
  }
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed.length > 2000) {
    return trimmed.slice(0, 2000) + '...';
  }

  const provider = (cfg.providerId || 'anthropic').toLowerCase();
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const model = cfg.customModel || cfg.selectedModelId;
  const isAnthropic = provider === 'claude' || provider === 'anthropic' || provider === 'aliyun' || baseUrl.includes('/anthropic');

  const systemPrompt = '请将以下文本翻译成中文，只返回翻译结果，不解释。';

  let body;
  if (isAnthropic) {
    body = JSON.stringify({
      model,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: trimmed }],
    });
  } else {
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
      max_tokens: 512,
    });
  }

  const urlPath = isAnthropic
    ? (baseUrl.endsWith('/v1') ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`)
    : (baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`);

  try {
    const result = await httpRequest(urlPath, body, {
      'Content-Type': 'application/json',
      ...(isAnthropic
        ? { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }
        : { 'Authorization': `Bearer ${cfg.apiKey}` }),
    });

    if (isAnthropic) {
      if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block.text && block.type === 'text') {
            return block.text.trim();
          }
        }
        const first = result.content[0];
        if (first?.text) return first.text.trim();
      }
      return '翻译失败（无文本响应）';
    }
    return result.choices?.[0]?.message?.content?.trim() || '翻译失败';
  } catch (err) {
    console.error('[ibwhale] 翻译请求失败:', err.message);
    return '翻译失败: ' + err.message;
  }
});

function httpRequest(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === 'https:' ? https : http;
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        'Connection': 'close',
      },
    };
    const req = transport.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            return;
          }
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`无效响应: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', (e) => {
      console.error('[ibwhale] 翻译请求错误:', e.code, e.message);
      reject(new Error(e.message));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.setTimeout(30000);
    req.write(body, 'utf8');
    req.end();
  });
}

// ===== IPC: PTY 控制 =====
ipcMain.on('pty-kill', (event) => {
  const { info } = getWindowInfo(event);
  const conv = info ? conversations.get(info.activeConvId) : null;
  if (conv && conv.ptyProcess) {
    try { conv.ptyProcess.kill(); } catch {}
    conv.ptyProcess = null;
    conv.pid = null;
  }
});

ipcMain.on('pty-spawn', (event) => {
  const { info } = getWindowInfo(event);
  const conv = info ? conversations.get(info.activeConvId) : null;
  if (conv && !conv.ptyProcess) {
    spawnPtyForConversation(info.activeConvId);
  }
});

ipcMain.on('open-new-window', () => {
  spawnNewWindow();
});

ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.minimize();
});
ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) win.unmaximize();
  else win?.maximize();
});
ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const winInfo = windowMap.get(win);
  if (winInfo) {
    for (const convId of winInfo.convIds) {
      const conv = conversations.get(convId);
      if (conv && conv.ptyProcess) {
        try { conv.ptyProcess.kill(); } catch {}
      }
      conversations.delete(convId);
    }
    windowMap.delete(win);
  }
  win?.close();
});

// ===== App 生命周期 =====
app.whenReady().then(() => {
  createWindow();
  // Create initial conversation
  const id = 'conv-' + Date.now().toString(36);
  conversations.set(id, { id, title: '新对话', ptyProcess: null, pid: null });
  windowMap.set(mainWindow, { id, activeConvId: id, convIds: new Set([id]) });
  spawnPtyForConversation(id);
});

app.on('window-all-closed', () => {
  killAllPtys();
  app.quit();
});

app.on('will-quit', () => killAllPtys());
