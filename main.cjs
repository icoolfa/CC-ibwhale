/**
 * ibwhale Claude Code Desktop - Main Process
 * 单实例锁 + 多PTY会话管理 + node-pty
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

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
let activeConvId = null;

// ===== 对话管理 =====
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
      if (mainWindow && !mainWindow.isDestroyed() && convId === activeConvId) {
        mainWindow.webContents.send('pty-output', data);
      }
    });

    ptyProcess.onExit(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('conv-exit', convId);
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
    killAllPtys();
    mainWindow = null;
  });
}

// ===== IPC: PTY =====
ipcMain.on('pty-input', (_event, data) => {
  const conv = conversations.get(activeConvId);
  if (conv && conv.ptyProcess) conv.ptyProcess.write(data);
});

ipcMain.on('pty-resize', (_event, { cols, rows }) => {
  const conv = conversations.get(activeConvId);
  if (conv && conv.ptyProcess) {
    try { conv.ptyProcess.resize(cols, rows); } catch {}
  }
});

// ===== IPC: 对话管理 =====
ipcMain.handle('conv-new', () => {
  const id = 'conv-' + Date.now().toString(36);
  conversations.set(id, { id, title: '新对话', ptyProcess: null, pid: null });
  activeConvId = id;
  const ok = spawnPtyForConversation(id);
  return { id, title: '新对话', pid: conversations.get(id)?.pid || null, ok };
});

ipcMain.handle('conv-switch', (_event, convId) => {
  if (!conversations.has(convId)) return { ok: false };
  activeConvId = convId;
  const conv = conversations.get(convId);
  // If no PTY yet, spawn one
  if (!conv.ptyProcess) {
    spawnPtyForConversation(convId);
  }
  return { ok: true, pid: conv.pid || null };
});

ipcMain.handle('conv-delete', (_event, convId) => {
  const conv = conversations.get(convId);
  if (conv && conv.ptyProcess) {
    try { conv.ptyProcess.kill(); } catch {}
  }
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

ipcMain.handle('conv-list', () => {
  const list = [];
  for (const [id, conv] of conversations) {
    list.push({ id, title: conv.title, pid: conv.pid, active: id === activeConvId });
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
ipcMain.on('set-model-env', (_event, cfg) => {
  const conv = conversations.get(activeConvId);
  if (conv && conv.ptyProcess) {
    try { conv.ptyProcess.kill(); } catch {}
    conv.ptyProcess = null;
    conv.pid = null;
  }
  setTimeout(() => {
    if (conv && activeConvId) spawnPtyForConversation(activeConvId);
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

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => {
  killAllPtys();
  mainWindow?.close();
});

// ===== App 生命周期 =====
app.whenReady().then(() => {
  createWindow();
  // Create initial conversation
  const id = 'conv-' + Date.now().toString(36);
  conversations.set(id, { id, title: '新对话', ptyProcess: null, pid: null });
  activeConvId = id;
  spawnPtyForConversation(id);
});

app.on('window-all-closed', () => {
  killAllPtys();
  app.quit();
});

app.on('will-quit', () => killAllPtys());
