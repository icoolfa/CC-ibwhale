/**
 * ibwhale Claude Code Desktop - Main Process
 * 单实例锁 + 多PTY会话管理 + node-pty
 */
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn, execFile, execSync } = require('child_process');
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
let cursorTrackInterval = null;

function getCursorDisplay() {
  const pt = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(pt);
}

function startCursorTracking() {
  stopCursorTracking();
  let lastDisplayId = getCursorDisplay().id;
  cursorTrackInterval = setInterval(() => {
    try {
      if (!overlay || overlay.isDestroyed() || !overlayReady) { stopCursorTracking(); return; }
      const d = getCursorDisplay();
      const { x, y } = screen.getCursorScreenPoint();
      if (d.id !== lastDisplayId) {
        lastDisplayId = d.id;
        overlay.setBounds(d.bounds);
      }
      if (overlay.isVisible()) {
        overlay.webContents.send('cursor-pos', x - d.bounds.x, y - d.bounds.y);
      }
    } catch { stopCursorTracking(); }
  }, 16);
}

function stopCursorTracking() {
  if (cursorTrackInterval) { clearInterval(cursorTrackInterval); cursorTrackInterval = null; }
}

// ===== IPC: toggle-whip
const VK_CONTROL = 0x11, VK_RETURN = 0x0D, VK_C = 0x43, KEYUP = 0x0002;

function createOverlay() {
  const d = getCursorDisplay();
  overlay = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
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
    startCursorTracking();
    if (spawnQueued && overlay && overlay.isVisible()) { spawnQueued = false; overlay.webContents.send('spawn-whip'); }
  });
  overlay.on('closed', () => { stopCursorTracking(); overlay = null; overlayReady = false; spawnQueued = false; });
}

function toggleOverlay() {
  if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
    overlay.webContents.send('drop-whip'); return;
  }
  if (!overlay || overlay.isDestroyed()) createOverlay();
  overlay.show();
  if (overlayReady) { overlay.webContents.send('spawn-whip'); }
  else { spawnQueued = true; }
}

ipcMain.on('toggle-whip', () => { toggleOverlay(); });

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

ipcMain.on('whip-crack', () => {});
ipcMain.on('hide-overlay', () => { if (overlay) overlay.hide(); });

// ===== 本地配置持久化 =====
const CONFIG_DIR = path.join(app.getPath('userData'), 'ibwhale');

function getConfigFile(userName) {
  const safe = (userName || 'default').replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, '_');
  return path.join(CONFIG_DIR, `config_${safe}.json`);
}

function loadLocalConfig(userName) {
  try {
    const file = getConfigFile(userName);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveLocalConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const file = getConfigFile(cfg.userName);
    fs.writeFileSync(file, JSON.stringify(cfg), 'utf-8');
  } catch (err) {
    console.error('[ibwhale] 保存配置失败:', err.message);
  }
  // 同步写入 .env 文件
  if (cfg && cfg.apiKey && cfg.baseUrl) {
    try {
      const projectRoot = path.join(__dirname, '..');
      const envFile = path.join(projectRoot, '.env');
      const openaiUrl = cfg.openaiBaseUrl || cfg.baseUrl.replace(/\/anthropic$/, '').replace(/\/apps\/anthropic$/, '').replace(/\/$/, '') + '/v1';
      const lines = [
        `MODEL_PROVIDER=${cfg.providerId || 'anthropic'}`,
        `ANTHROPIC_BASE_URL=${cfg.baseUrl}`,
        `OPENAI_BASE_URL=${openaiUrl}`,
        `ANTHROPIC_AUTH_TOKEN=${cfg.apiKey}`,
        `ANTHROPIC_MODEL=${cfg.customModel || cfg.selectedModelId || 'claude-sonnet-4-6'}`,
        ...(cfg.customApiUrl ? [`CUSTOM_API_URL=${cfg.customApiUrl}`] : []),
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

// { id: string, title: string, ptyProcess: object, agentType: string }
const conversations = new Map();

// ===== Hermes Auth 凭据池清理 =====
function clearHermesCredentialPool() {
  try {
    const hermesDir = path.join(os.homedir(), '.hermes');
    const authFile = path.join(hermesDir, 'auth.json');
    if (fs.existsSync(authFile)) {
      const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      if (auth.credential_pool) {
        auth.credential_pool = {};
        fs.writeFileSync(authFile, JSON.stringify(auth, null, 2), 'utf-8');
        console.log('[ibwhale] Hermes auth.json credential_pool 已清除');
      }
    }
  } catch (err) {
    console.error('[ibwhale] 清除 Hermes 凭据池失败:', err.message);
  }
}

// ===== Hermes 配置文件写入 =====
// Hermes CLI 从 config.yaml 读取 providers/model 配置。
// providers.<name> 定义自定义端点，model.provider 引用它。
// 同时写入 .env 作为后备（供 agent 内部 env var 读取路径使用）。
function writeHermesConfig(apiKey, baseUrl, model) {
  try {
    const hermesDir = path.join(os.homedir(), '.hermes');
    if (!fs.existsSync(hermesDir)) fs.mkdirSync(hermesDir, { recursive: true });

    // 确保 URL 以 /v1 结尾（Hermes 使用 OpenAI 兼容端点）
    let url = baseUrl || '';
    url = url.replace(/\/anthropic$/, '').replace(/\/apps\/anthropic$/, '');
    if (url && !url.endsWith('/v1')) url += '/v1';

    const configFile = path.join(hermesDir, 'config.yaml');

    // 读取已有配置，替换 providers 和 model section
    let preservedSections = '';
    if (fs.existsSync(configFile)) {
      try {
        const content = fs.readFileSync(configFile, 'utf-8');
        const lines = content.split('\n');
        const kept = [];
        let inProviders = false;
        let inModel = false;
        for (const line of lines) {
          if (/^providers\s*:/.test(line)) { inProviders = true; continue; }
          if (/^model\s*:/.test(line)) { inModel = true; continue; }
          if (inProviders && /^[a-z]/i.test(line) && !/^\s/.test(line)) { inProviders = false; }
          if (inModel && /^[a-z]/i.test(line) && !/^\s/.test(line)) { inModel = false; }
          if (!inProviders && !inModel) kept.push(line);
        }
        preservedSections = kept.join('\n').trim();
      } catch {}
    }

    const providerName = 'ibwhale';
    const modelName = model || 'claude-sonnet-4-6';

    const providersSection = [
      'providers:',
      `  ${providerName}:`,
      `    name: ibwhale`,
      `    base_url: ${url}`,
      `    api_key: ${apiKey || ''}`,
      `    default_model: ${modelName}`,
    ].join('\n');

    const modelSection = [
      'model:',
      `  provider: ${providerName}`,
      `  default: ${modelName}`,
    ].join('\n');

    let yaml;
    if (preservedSections) {
      if (!/^version\s*:/m.test(preservedSections)) {
        yaml = 'version: 23\n' + preservedSections + '\n' + providersSection + '\n' + modelSection;
      } else {
        yaml = preservedSections + '\n' + providersSection + '\n' + modelSection;
      }
    } else {
      yaml = 'version: 23\n' + providersSection + '\n' + modelSection;
    }

    fs.writeFileSync(configFile, yaml, 'utf-8');

    // 同时写入 .env 作为后备（Hermes 的 env var fallback 路径会读取这些）
    const envFile = path.join(hermesDir, '.env');
    fs.writeFileSync(envFile, [
      `HERMES_API_KEY=${apiKey || ''}`,
      `HERMES_API_BASE=${url}`,
      `HERMES_DEFAULT_MODEL=${modelName}`,
      `DEEPSEEK_API_KEY=${apiKey || ''}`,
      `DEEPSEEK_BASE_URL=${url}`,
      `OPENAI_API_KEY=${apiKey || ''}`,
      `OPENAI_BASE_URL=${url}`,
      '',
    ].join('\n'), 'utf-8');

    console.log('[ibwhale] Hermes config.yaml 已更新 (provider: ibwhale)');
  } catch (err) {
    console.error('[ibwhale] 写入 Hermes 配置失败:', err.message);
  }
}

// ===== Codex CLI 配置文件写入 =====
// Codex CLI 0.128.0+: TOML 格式，root keys (model, model_provider) 必须在所有 [section] 之前
function writeCodexConfig(apiKey, baseUrl, model) {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

    // Codex 0.128.0+ 强制 wire_api="responses"，通过本地代理翻译协议
    // base_url 指向内置代理，代理会将 /v1/responses 翻译为 /v1/chat/completions
    const localProxyUrl = 'http://127.0.0.1:' + CODEX_PROXY_PORT + '/v1';

    const configFile = path.join(codexDir, 'config.toml');
    const modelName = model || 'claude-sonnet-4-6';

    // 读取已有配置，保留所有 [section] 块（projects, windows, tui, marketplaces 等）
    // 同时移除旧的 model_provider 相关内容
    let preservedSections = '';
    if (fs.existsSync(configFile)) {
      try {
        const content = fs.readFileSync(configFile, 'utf-8');
        const lines = content.split('\n');
        const kept = [];
        let inProviders = false;
        for (const line of lines) {
          // 跳过旧的 [model_providers.*] section 及其内容
          if (/^\[model_providers/.test(line)) { inProviders = true; continue; }
          if (inProviders && /^\[/.test(line)) { inProviders = false; }
          // 跳过旧的 root keys（会重新生成）
          if (!inProviders && /^model\s*=/.test(line)) continue;
          if (!inProviders && /^model_provider\s*=/.test(line)) continue;
          if (!inProviders) kept.push(line);
        }
        // 去掉开头和结尾的空行
        preservedSections = kept.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
      } catch {}
    }

    // ===== 构建新配置：root keys 必须在所有 [section] 之前 =====
    const rootKeys = [
      `model = "${modelName}"`,
      'model_provider = "ibwhale"',
    ].join('\n');

    const providerSection = [
      '[model_providers.ibwhale]',
      'name = "ibwhale"',
      `base_url = "${localProxyUrl}"`,
      'env_key = "OPENAI_API_KEY"',
      'wire_api = "responses"',
    ].join('\n');

    const parts = [rootKeys, '', providerSection];
    if (preservedSections) parts.push('', preservedSections);

    const toml = parts.join('\n') + '\n';

    fs.writeFileSync(configFile, toml, 'utf-8');

    console.log('[ibwhale] Codex config.toml 已更新 (model=' + modelName + ', proxy=' + localProxyUrl + ')');
  } catch (err) {
    console.error('[ibwhale] 写入 Codex 配置失败:', err.message);
  }
}

// ===== Codex CLI Responses → Chat Completions 协议代理 =====
// Codex 0.128.0+ 强制 wire_api="responses"，但第三方中转站只支持 /v1/chat/completions
// 本地 HTTP 代理实时翻译两个协议的请求和流式响应
let codexProxyServer = null;
const CODEX_PROXY_PORT = 18928;
const PROXY_LOG = path.join(os.tmpdir(), 'ibwhale-proxy.log');

function proxyLog(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = '[' + ts + '] ' + msg + '\n';
  try { fs.appendFileSync(PROXY_LOG, line); } catch {}
  console.log('[ibwhale-proxy] ' + msg);
}

function startCodexProxy() {
  if (codexProxyServer) return;
  proxyLog('启动代理端口 ' + CODEX_PROXY_PORT + '...');

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Connection', 'close');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    proxyLog('收到 ' + req.method + ' ' + req.url + ' from ' + (req.socket?.remoteAddress || '?'));
    req.on('error', (e) => proxyLog('请求错误: ' + e.message));
    res.on('error', (e) => proxyLog('响应错误: ' + e.message));

    if (req.method === 'POST' && req.url.includes('/responses')) {
      handleCodexProxy(req, res); return;
    }
    if (req.method === 'GET' && req.url.includes('/models')) {
      proxyLog('GET /models → 返回空列表');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] })); return;
    }
    // 其他请求透传到上游
    proxyToUpstream(req, res);
  });
  server.listen(CODEX_PROXY_PORT, '127.0.0.1', () => {
    proxyLog('代理已启动: http://127.0.0.1:' + CODEX_PROXY_PORT);
    // 自检：验证上游连通性
    const upstream = getProxyUpstream();
    proxyLog('上游: ' + upstream.url + ' model=' + upstream.model + ' key=' + (upstream.apiKey ? '***' + upstream.apiKey.slice(-4) : '无'));
    const u = new URL(upstream.url);
    const agent = u.protocol === 'https:' ? https : http;
    const pingReq = agent.request({
      hostname: u.hostname, port: u.port || 443, path: '/v1/models', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + upstream.apiKey },
      timeout: 10000, rejectUnauthorized: false,
    }, (pingRes) => {
      proxyLog('上游连通性检测: ' + pingRes.statusCode);
    });
    pingReq.on('error', (e) => proxyLog('上游连通性检测失败: ' + e.message));
    pingReq.end();
  });
  server.on('error', (err) => { console.error('[ibwhale] Codex 代理启动失败:', err.message); });
  codexProxyServer = server;
}

function stopCodexProxy() {
  if (codexProxyServer) { codexProxyServer.close(); codexProxyServer = null; }
}

function getProxyUpstream() {
  const env = readIbwhaleEnv();
  const baseUrl = env.ANTHROPIC_BASE_URL || '';
  const apiKey = env.ANTHROPIC_AUTH_TOKEN || '';
  let url = baseUrl.replace(/\/anthropic$/, '').replace(/\/apps\/anthropic$/, '');
  if (url && !url.endsWith('/v1')) url += '/v1';
  return { url, apiKey, model: env.ANTHROPIC_MODEL || 'deepseek-v4-flash' };
}

// 将 Responses API 的 input 数组翻译为 Chat Completions 的 messages 数组
function translateInputToMessages(input) {
  const messages = [];
  for (const item of input) {
    if (!item) continue;
    // 用户/系统/开发者消息
    if (item.role === 'user' || item.role === 'system' || item.role === 'developer') {
      let content = item.content;
      if (Array.isArray(content)) {
        content = content.map(p => (p.type === 'input_text' || p.type === 'text') ? p.text : '').join('');
      }
      messages.push({ role: item.role, content: content || '' });
    }
    // 助手消息（可能带 tool_calls）
    else if (item.role === 'assistant') {
      const msg = { role: 'assistant' };
      if (item.content) {
        let content = item.content;
        if (Array.isArray(content)) content = content.map(p => p.text || '').join('');
        msg.content = content || null;
      } else { msg.content = null; }
      if (item.tool_calls) msg.tool_calls = item.tool_calls;
      messages.push(msg);
    }
    // Responses API function_call → Chat Completions assistant + tool_calls
    else if (item.type === 'function_call') {
      messages.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: item.call_id || '0', type: 'function', function: { name: item.name || '', arguments: item.arguments || '' } }]
      });
    }
    // 工具结果
    else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', content: item.output || '', tool_call_id: item.call_id || '0' });
    }
  }
  return messages;
}

// 翻译工具定义：Responses 平铺格式 → Chat Completions 嵌套格式
function translateTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map(t => {
    if (t.function) return t;
    return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || {} } };
  });
}

function translateToChatCompletions(body) {
  const messages = [];
  // instructions → system message
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  // input → messages
  if (Array.isArray(body.input)) messages.push(...translateInputToMessages(body.input));

  const chatBody = {
    model: body.model || getProxyUpstream().model,
    messages,
    stream: body.stream !== false,
  };
  const tools = translateTools(body.tools);
  if (tools && tools.length > 0) chatBody.tools = tools;
  if (body.max_output_tokens) chatBody.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;

  return chatBody;
}

function genId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// SSE 流式响应翻译状态机
function createSSETranslator(res, model) {
  const responseId = genId('resp');
  const msgId = genId('msg');
  let state = 'init'; // init → text / tool_call → done
  let opened = false;
  let ended = false;
  let textBuf = '';
  let usage = null;
  let tcArgs = {}; // call_id → accumulated arguments
  let tcName = '';

  function send(evt, data) {
    if (ended) return;
    try { res.write('event: ' + evt + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch { ended = true; }
  }

  function openText() {
    if (opened) return; opened = true;
    send('response.created', { type: 'response.created', response: { id: responseId, object: 'response', model, status: 'in_progress', output: [] } });
    send('response.in_progress', { type: 'response.in_progress', response_id: responseId });
    send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] } });
    send('response.content_part.added', { type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
  }

  function openToolCall(name) {
    if (opened) return; opened = true;
    tcName = name || '';
    send('response.created', { type: 'response.created', response: { id: responseId, object: 'response', model, status: 'in_progress', output: [] } });
    send('response.in_progress', { type: 'response.in_progress', response_id: responseId });
    send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: msgId, status: 'in_progress', call_id: '0', name: tcName, arguments: '' } });
  }

  function finish() {
    if (ended || state === 'done') return;
    state = 'done'; ended = true;
    if (!opened) openText();

    const usageOut = usage ? { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 } : null;

    if (Object.keys(tcArgs).length > 0) {
      for (const [cid, args] of Object.entries(tcArgs)) {
        send('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: msgId, output_index: 0, call_id: cid, arguments: args });
      }
      send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: msgId, status: 'completed', call_id: '0', name: tcName, arguments: tcArgs['0'] || '' } });
      send('response.completed', {
        type: 'response.completed',
        response: { id: responseId, object: 'response', model, status: 'completed',
          output: [{ type: 'function_call', id: msgId, status: 'completed', call_id: '0', name: tcName, arguments: tcArgs['0'] || '' }],
          ...(usageOut ? { usage: usageOut } : {}) }
      });
    } else {
      send('response.output_text.done', { type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text: textBuf });
      send('response.content_part.done', { type: 'response.content_part.done', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: textBuf } });
      send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: textBuf }] } });
      send('response.completed', {
        type: 'response.completed',
        response: { id: responseId, object: 'response', model, status: 'completed',
          output: [{ type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: textBuf }] }],
          ...(usageOut ? { usage: usageOut } : {}) }
      });
    }
    try { res.end(); } catch {}
  }

  function process(chunk) {
    if (ended || state === 'done') return;
    if (!chunk || !chunk.choices) return;
    const c = chunk.choices[0];
    if (!c) return;
    const delta = c.delta || {};
    if (chunk.usage) usage = chunk.usage;

    // 文本增量
    if (delta.content) {
      if (state === 'init') { state = 'text'; openText(); }
      if (state === 'text') {
        textBuf += delta.content;
        send('response.output_text.delta', { type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: delta.content });
      }
    }
    // 工具调用增量
    if (delta.tool_calls) {
      if (state === 'init' || state === 'text') { state = 'tool_call'; }
      for (const tc of delta.tool_calls) {
        const cid = tc.id || tc.index?.toString() || '0';
        if (tc.function) {
          if (tc.function.name) openToolCall(tc.function.name);
          if (tc.function.arguments) {
            tcArgs[cid] = (tcArgs[cid] || '') + tc.function.arguments;
            send('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: msgId, output_index: 0, call_id: cid, delta: tc.function.arguments });
          }
        }
      }
    }
    // 结束
    if (c.finish_reason) {
      if (c.finish_reason === 'tool_calls' && Object.keys(tcArgs).length > 0) {
        for (const [cid, args] of Object.entries(tcArgs)) {
          send('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: msgId, output_index: 0, call_id: cid, arguments: args });
        }
        const outputItem = { type: 'function_call', id: msgId, status: 'completed', call_id: '0', name: tcName, arguments: tcArgs['0'] || '' };
        send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: outputItem });
        // 必须发送 response.completed，否则 Codex 认为流异常断开
        const tcUsage = usage ? { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 } : null;
        send('response.completed', {
          type: 'response.completed',
          response: { id: responseId, object: 'response', model, status: 'completed', output: [outputItem], ...(tcUsage ? { usage: tcUsage } : {}) }
        });
        state = 'done'; ended = true;
        try { res.end(); } catch {}
      } else if (c.finish_reason === 'stop') {
        finish();
      }
    }
  }

  return { process, finish, getState: () => state, isEnded: () => ended };
}

function handleCodexProxy(req, res) {
  const reqId = genId('req');
  proxyLog(reqId + ' 开始处理 POST /v1/responses');

  const upstream = getProxyUpstream();
  if (!upstream.url || !upstream.apiKey) {
    proxyLog(reqId + ' 错误: API 未配置');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'API 未配置' } })); return;
  }
  let resEnded = false;
  function safeEnd() { if (!resEnded) { resEnded = true; try { res.end(); } catch {} } }
  res.on('error', () => { resEnded = true; });

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks);
      let body;
      if (req.headers['content-encoding'] === 'zstd' || req.headers['content-encoding'] === 'zst') {
        try { body = JSON.parse(require('zlib').zstdDecompressSync(raw).toString('utf-8')); }
        catch { body = JSON.parse(raw.toString('utf-8')); }
      } else {
        body = JSON.parse(raw.toString('utf-8'));
      }
      const chatBody = translateToChatCompletions(body);
      proxyLog(reqId + ' model=' + chatBody.model + ' msgs=' + chatBody.messages.length + ' stream=' + chatBody.stream + ' tools=' + (chatBody.tools ? chatBody.tools.length : 0));
      const streamMode = chatBody.stream !== false;
      const u = new URL(upstream.url);
      const isHttps = u.protocol === 'https:';
      const agentType = isHttps ? https : http;
      const opts = {
        hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
        path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + upstream.apiKey,
          'Accept': streamMode ? 'text/event-stream' : 'application/json' },
        timeout: 600000,
        rejectUnauthorized: false,
      };
      const upReq = agentType.request(opts, (upRes) => {
        proxyLog(reqId + ' 上游响应 ' + upRes.statusCode);
        if (upRes.statusCode >= 400) {
          let errBuf = '';
          upRes.on('data', d => errBuf += d);
          upRes.on('end', () => {
            console.error('[ibwhale-proxy] ' + reqId + ' 上游错误 ' + upRes.statusCode + ':', errBuf.slice(0, 500));
            safeEnd();
          });
          // Forward error to client in Responses format
          res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '上游 API 错误: ' + upRes.statusCode } }));
          resEnded = true;
          return;
        }
        if (streamMode) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
          const tr = createSSETranslator(res, chatBody.model);
          let buf = '';
          upRes.on('data', d => {
            if (resEnded || tr.isEnded()) return;
            buf += d.toString('utf-8');
            const lines = buf.split('\n'); buf = lines.pop() || '';
            for (const line of lines) {
              if (resEnded || tr.isEnded()) break;
              if (line.startsWith('data: ')) {
                const js = line.slice(6).trim();
                if (js === '[DONE]') { proxyLog(reqId + ' [DONE]'); tr.finish(); return; }
                try { tr.process(JSON.parse(js)); } catch {}
              }
            }
          });
          upRes.on('end', () => {
            proxyLog(reqId + ' 上游流结束');
            // 处理遗留在 buffer 中的 [DONE] (可能没有尾随换行)
            if (buf.trim() === 'data: [DONE]' || buf.includes('[DONE]')) {
              proxyLog(reqId + ' 残余 [DONE]');
            }
            tr.finish();
          });
          upRes.on('error', (e) => { console.error('[ibwhale-proxy] ' + reqId + ' SSE 流错误:', e.message); tr.finish(); });
        } else {
          let rbuf = '';
          upRes.on('data', d => rbuf += d);
          upRes.on('end', () => {
            if (resEnded) return;
            try {
              const cr = JSON.parse(rbuf.toString('utf-8'));
              const rid = genId('resp'); const mid = genId('msg');
              const text = cr.choices?.[0]?.message?.content || '';
              const toolCalls = cr.choices?.[0]?.message?.tool_calls;
              let output;
              if (toolCalls) {
                output = toolCalls.map((tc, i) => ({ type: 'function_call', id: mid, call_id: tc.id || String(i), name: tc.function?.name || '', arguments: tc.function?.arguments || '' }));
              } else {
                output = [{ type: 'message', id: mid, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }];
              }
              const respBody = {
                id: rid, object: 'response', model: chatBody.model, status: 'completed', output,
                ...(cr.usage ? { usage: { input_tokens: cr.usage.prompt_tokens || 0, output_tokens: cr.usage.completion_tokens || 0, total_tokens: cr.usage.total_tokens || 0 } } : {})
              };
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(respBody));
              resEnded = true;
            } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '翻译失败' } })); resEnded = true; }
          });
        }
      });
      upReq.on('error', (e) => { console.error('[ibwhale-proxy] ' + reqId + ' 上游连接失败:', e.message); if (!resEnded) { res.writeHead(502); res.end(JSON.stringify({ error: { message: '上游不可达' } })); resEnded = true; } });
      upReq.on('timeout', () => { console.error('[ibwhale-proxy] ' + reqId + ' 上游超时'); upReq.destroy(); if (!resEnded) { res.writeHead(504); res.end(JSON.stringify({ error: { message: '上游超时' } })); resEnded = true; } });
      upReq.write(JSON.stringify(chatBody));
      upReq.end();
    } catch (e) {
      console.error('[ibwhale-proxy] ' + reqId + ' 解析错误:', e.message);
      if (!resEnded) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '请求解析失败' } })); resEnded = true; }
    }
  });
}

function proxyToUpstream(req, res) {
  const upstream = getProxyUpstream();
  if (!upstream.url) { res.writeHead(500); res.end(); return; }
  const u = new URL(upstream.url);
  const isHttps = u.protocol === 'https:';
  const agent = isHttps ? https : http;
  const opts = {
    hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
    path: req.url, method: req.method,
    headers: { ...req.headers, host: u.hostname, 'Authorization': 'Bearer ' + upstream.apiKey },
    timeout: 120000,
    rejectUnauthorized: false,
  };
  const upReq = agent.request(opts, (upRes) => { res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res); });
  upReq.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upReq);
}

// ===== Agent 注册表 =====
// env: { envVarName: 'sourceKey' } — sourceKey 指向 ibwhale .env 中的键名
//       envVarName 为 null 表示不需要映射（agent 用独立配置体系）
// setup: 首次启动前需要的配置命令或指引
// providerEnv: 按 provider 分发不同变量名的映射
const AGENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: '\u{1F9E0}',
    desc: 'Anthropic 官方 CLI Agent',
    detect: { type: 'builtin', commands: [] },
    install: null,
    launch: {
      command: 'node bin\\claude-code --dangerously-skip-permissions',
      cwd: path.join(__dirname, '..'),
      env: { ANTHROPIC_BASE_URL: 'ANTHROPIC_BASE_URL', ANTHROPIC_AUTH_TOKEN: 'ANTHROPIC_AUTH_TOKEN', ANTHROPIC_MODEL: 'ANTHROPIC_MODEL' },
    },
    setup: null,
    builtin: true,
  },
  {
    id: 'claude-code-official',
    name: 'Claude Code 官方',
    icon: '\u{1F4E6}',
    desc: 'Anthropic 官方 Claude Code CLI (npm 全局安装)',
    detect: { type: 'command', commands: ['claude'] },
    install: { type: 'npm', command: 'npm install -g @anthropic-ai/claude-code' },
    launch: {
      command: 'claude --dangerously-skip-permissions',
      cwd: null,
      // 官方版 Claude Code 环境变量：官方 API 用 ANTHROPIC_API_KEY，第三方用 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL
      providerEnv: {
        anthropic:  { envVar: 'ANTHROPIC_API_KEY', baseUrl: null },
        aliyun:     { envVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'ANTHROPIC_BASE_URL' },
        deepseek:   { envVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'ANTHROPIC_BASE_URL' },
        zhipu:      { envVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'ANTHROPIC_BASE_URL' },
        moonshot:   { envVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'ANTHROPIC_BASE_URL' },
        linktoken:  { envVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'ANTHROPIC_BASE_URL' },
        openrouter: { envVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'ANTHROPIC_BASE_URL' },
        local:      { envVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'ANTHROPIC_BASE_URL' },
        custom:     { envVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: 'ANTHROPIC_BASE_URL' },
      },
      // 对于官方版，ANTHROPIC_BASE_URL 保持 /anthropic 后缀（不需要转换到 OpenAI 格式）
      keepAnthropicSuffix: true,
    },
    setup: null,
  },
  {
    id: 'hermes',
    name: 'Hermes',
    icon: '\u{1F52E}',
    desc: '开源多模型 Agent 框架',
    detect: { type: 'command', commands: ['hermes', 'hermes-agent'] },
    install: { type: 'pip', command: 'pip install hermes-agent' },
    launch: {
      command: 'hermes',
      cwd: null,
      useConpty: true,
      // Hermes 读取 ~/.hermes/config.yaml，env 变量作为后备
      // envVar=API key变量, baseUrl=端点变量, modelVar=模型变量
      providerEnv: {
        deepseek:    { envVar: 'DEEPSEEK_API_KEY', baseUrl: 'DEEPSEEK_BASE_URL', modelVar: 'DEEPSEEK_MODEL' },
        linktoken:   { envVar: 'DEEPSEEK_API_KEY', baseUrl: 'DEEPSEEK_BASE_URL', modelVar: 'DEEPSEEK_MODEL' },
        anthropic:   { envVar: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL', modelVar: 'ANTHROPIC_MODEL' },
        openai:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL', modelVar: 'OPENAI_MODEL' },
        aliyun:      { envVar: 'DASHSCOPE_API_KEY', baseUrl: 'DASHSCOPE_BASE_URL', modelVar: 'DASHSCOPE_MODEL' },
        moonshot:    { envVar: 'MOONSHOT_API_KEY', baseUrl: 'MOONSHOT_BASE_URL', modelVar: 'MOONSHOT_MODEL' },
        zhipu:       { envVar: 'ZHIPU_API_KEY', baseUrl: 'ZHIPU_BASE_URL', modelVar: 'ZHIPU_MODEL' },
        openrouter:  { envVar: 'OPENROUTER_API_KEY', baseUrl: 'OPENROUTER_BASE_URL', modelVar: 'OPENROUTER_MODEL' },
        local:       { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL', modelVar: 'OPENAI_MODEL' },
        custom:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL', modelVar: 'OPENAI_MODEL' },
      },
      fallbackEnv: { envVar: 'HERMES_API_KEY', baseUrl: 'HERMES_API_BASE', modelVar: 'HERMES_DEFAULT_MODEL' },
      extraEnv: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', LANG: 'en_US.UTF-8' },
    },
    setup: { command: 'hermes setup', desc: '运行 hermes setup 配置 API key 和模型' },
  },
  {
    id: 'aider',
    name: 'Aider',
    icon: '\u{1F6E0}',
    hidden: true,
    desc: 'AI 结对编程工具',
    detect: { type: 'command', commands: ['aider'] },
    install: { type: 'pip', command: 'pip install aider-chat' },
    launch: {
      command: 'aider',
      cwd: null,
      useConpty: true,
      providerEnv: {
        anthropic:   { envVar: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
        openai:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        deepseek:    { envVar: 'DEEPSEEK_API_KEY', baseUrl: 'DEEPSEEK_BASE_URL' },
        openrouter:  { envVar: 'OPENROUTER_API_KEY', baseUrl: 'OPENROUTER_BASE_URL' },
        aliyun:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        zhipu:       { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        moonshot:    { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        linktoken:   { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        local:       { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        custom:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
      },
      fallbackEnv: { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    },
    setup: { command: 'aider --help', desc: 'Aider 通过环境变量读取 API key' },
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    icon: '\u{1F916}',
    hidden: true,
    desc: 'OpenAI 官方 CLI Agent',
    detect: { type: 'command', commands: ['codex', 'openai-codex'] },
    install: { type: 'npm', command: 'npm install -g @openai/codex' },
    launch: {
      command: 'codex',
      cwd: null,
      useConpty: true,
      extraEnv: { NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' },
      // Codex 是 OpenAI SDK 的 CLI 包装，需要 OPENAI_API_KEY 和 OPENAI_BASE_URL
      providerEnv: {
        openai:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        custom:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        deepseek:    { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        linktoken:   { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        aliyun:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        zhipu:       { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        moonshot:    { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        openrouter:  { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        local:       { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
      },
      fallbackEnv: { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    },
    setup: { command: 'codex login', desc: '运行 codex login 登录 OpenAI 账号' },
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    icon: '\u{1F31F}',
    hidden: true,
    desc: 'Google Gemini CLI',
    detect: { type: 'command', commands: ['gemini', 'google-gemini'] },
    install: { type: 'npm', command: 'npm install -g @google/gemini-cli' },
    launch: {
      command: 'gemini',
      cwd: null,
      providerEnv: {
        google:    { envVar: 'GEMINI_API_KEY' },
        deepseek:  { envVar: 'DEEPSEEK_API_KEY', baseUrl: 'DEEPSEEK_BASE_URL' },
        openai:    { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        anthropic: { envVar: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
      },
      fallbackEnv: { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    },
    setup: { command: 'gemini auth', desc: '运行 gemini auth 配置认证' },
  },
  {
    id: 'cline',
    name: 'Cline',
    icon: '\u{1F40C}',
    hidden: true,
    desc: 'VS Code AI 编程助手 CLI',
    detect: { type: 'command', commands: ['cline'] },
    install: { type: 'npm', command: 'npm install -g cline' },
    launch: {
      command: 'cline',
      cwd: null,
      providerEnv: {
        anthropic:   { envVar: 'ANTHROPIC_API_KEY', baseUrl: 'ANTHROPIC_BASE_URL' },
        openai:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        deepseek:    { envVar: 'DEEPSEEK_API_KEY', baseUrl: 'DEEPSEEK_BASE_URL' },
        openrouter:  { envVar: 'OPENROUTER_API_KEY', baseUrl: 'OPENROUTER_BASE_URL' },
        aliyun:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        zhipu:       { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        moonshot:    { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        linktoken:   { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        local:       { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
        custom:      { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
      },
      fallbackEnv: { envVar: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL' },
    },
    setup: null,
  },
  {
    id: 'custom',
    name: '自定义命令',
    icon: '\u{2699}',
    hidden: true,
    desc: '输入任意命令行启动',
    detect: { type: 'always', commands: [] },
    install: null,
    launch: { command: '', cwd: null },
    setup: null,
  },
];

// ===== Agent 配置持久化 =====
function getAgentConfigFile() {
  return path.join(CONFIG_DIR, 'agent_configs.json');
}

function loadAgentConfigs() {
  try {
    const file = getAgentConfigFile();
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return {};
}

function saveAgentConfig(agentId, cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const configs = loadAgentConfigs();
    configs[agentId] = cfg;
    fs.writeFileSync(getAgentConfigFile(), JSON.stringify(configs, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ibwhale] 保存 agent 配置失败:', err.message);
  }
}

function deleteAgentConfig(agentId) {
  try {
    const configs = loadAgentConfigs();
    delete configs[agentId];
    fs.writeFileSync(getAgentConfigFile(), JSON.stringify(configs, null, 2), 'utf-8');
  } catch {}
}

// 从 ibwhale .env 读取当前配置
function readIbwhaleEnv() {
  const projectRoot = path.join(__dirname, '..');
  const envFile = path.join(projectRoot, '.env');
  const env = {};
  if (fs.existsSync(envFile)) {
    try {
      const content = fs.readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            env[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
          }
        }
      }
    } catch {}
  }
  return env;
}

function findGitBash() {
  // 1. Common installation paths (most reliable for standard installs)
  const candidates = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // 2. Fallback: derive from `where git` output
  //    D:\Program Files\Git\mingw64\bin\git.exe → 向上三层 → D:\Program Files\Git\bin\bash.exe
  try {
    const gitPath = execSync('where git', { encoding: 'utf8' }).trim().split('\n')[0];
    if (gitPath) {
      const base = path.dirname(path.dirname(path.dirname(gitPath)));
      const bash = path.join(base, 'bin', 'bash.exe');
      if (fs.existsSync(bash)) return bash;
    }
  } catch {}

  return null;
}

function getShellEnv(agentType) {
  const gitBash = findGitBash();
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  };
  // 加载 .env 文件到环境变量
  const projectRoot = path.join(__dirname, '..');
  const envFile = path.join(projectRoot, '.env');
  const ibwhaleEnv = {};
  if (fs.existsSync(envFile)) {
    try {
      const content = fs.readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.substring(0, eq).trim();
            const val = trimmed.substring(eq + 1).trim();
            env[key] = val;
            ibwhaleEnv[key] = val;
          }
        }
      }
    } catch {}
  }
  if (gitBash) {
    env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
  }

  // ===== Agent 特定环境变量注入 =====
  if (agentType && agentType !== 'claude-code') {
    const agent = AGENTS.find(a => a.id === agentType);
    if (agent && agent.launch) {
      // 1. 注入额外环境变量（如 Python 编码修复）
      if (agent.launch.extraEnv) {
        Object.assign(env, agent.launch.extraEnv);
      }

      // 2. 加载用户手动保存的 agent 特定配置（用于 config 文件写入和 env 覆盖）
      const agentConfigs = loadAgentConfigs();
      const savedConfig = agentConfigs[agentType];

      // Hermes: 清除 auth.json 凭据池 + 写入 config.yaml (provider: custom)
      if (agentType === 'hermes') {
        clearHermesCredentialPool();
        const effectiveKey = (savedConfig && savedConfig.apiKey) || ibwhaleEnv.ANTHROPIC_AUTH_TOKEN || '';
        const effectiveUrl = (savedConfig && savedConfig.baseUrl) || ibwhaleEnv.OPENAI_BASE_URL || ibwhaleEnv.ANTHROPIC_BASE_URL || '';
        const effectiveModel = (savedConfig && savedConfig.model) || ibwhaleEnv.ANTHROPIC_MODEL || '';
        if (effectiveKey) {
          writeHermesConfig(effectiveKey, effectiveUrl, effectiveModel);
        }
      }

      // Codex CLI: 写入 config.toml (自定义 model_providers)
      if (agentType === 'codex') {
        const effectiveKey = (savedConfig && savedConfig.apiKey) || ibwhaleEnv.ANTHROPIC_AUTH_TOKEN || '';
        const effectiveUrl = (savedConfig && savedConfig.baseUrl) || ibwhaleEnv.OPENAI_BASE_URL || ibwhaleEnv.ANTHROPIC_BASE_URL || '';
        const effectiveModel = (savedConfig && savedConfig.model) || ibwhaleEnv.ANTHROPIC_MODEL || '';
        if (effectiveKey) {
          writeCodexConfig(effectiveKey, effectiveUrl, effectiveModel);
        }
      }

      // 3. 根据 provider 映射 env 变量
      const provider = ibwhaleEnv.MODEL_PROVIDER || '';
      const providerEnv = agent.launch.providerEnv;
      const fallbackEnv = agent.launch.fallbackEnv;

      if (providerEnv && providerEnv[provider]) {
        const mapping = providerEnv[provider];
        if (mapping.envVar && ibwhaleEnv.ANTHROPIC_AUTH_TOKEN) {
          env[mapping.envVar] = ibwhaleEnv.ANTHROPIC_AUTH_TOKEN;
        }
        if (mapping.baseUrl && ibwhaleEnv.ANTHROPIC_BASE_URL) {
          let url;
          if (agent.launch.keepAnthropicSuffix) {
            // 官方 Claude Code 等需要保留 /anthropic 后缀
            url = ibwhaleEnv.ANTHROPIC_BASE_URL;
          } else if (ibwhaleEnv.OPENAI_BASE_URL) {
            // 优先使用 .env 中预设的 OpenAI 格式 URL（各 provider 的正确端点不同）
            url = ibwhaleEnv.OPENAI_BASE_URL;
          } else {
            // 兜底：将 Anthropic 格式的 URL 转为 OpenAI 兼容格式
            url = ibwhaleEnv.ANTHROPIC_BASE_URL.replace(/\/anthropic$/, '').replace(/\/apps\/anthropic$/, '');
            if (!url.endsWith('/v1')) url += '/v1';
          }
          env[mapping.baseUrl] = url;
        }
        if (mapping.modelVar && ibwhaleEnv.ANTHROPIC_MODEL) {
          env[mapping.modelVar] = ibwhaleEnv.ANTHROPIC_MODEL;
        }
      } else if (fallbackEnv) {
        if (fallbackEnv.envVar && ibwhaleEnv.ANTHROPIC_AUTH_TOKEN) {
          env[fallbackEnv.envVar] = ibwhaleEnv.ANTHROPIC_AUTH_TOKEN;
        }
        if (fallbackEnv.baseUrl && ibwhaleEnv.ANTHROPIC_BASE_URL) {
          let url;
          if (agent.launch.keepAnthropicSuffix) {
            // 保持原样
            url = ibwhaleEnv.ANTHROPIC_BASE_URL;
          } else if (ibwhaleEnv.OPENAI_BASE_URL) {
            // 优先使用 .env 中预设的 OpenAI 格式 URL
            url = ibwhaleEnv.OPENAI_BASE_URL;
          } else {
            url = ibwhaleEnv.ANTHROPIC_BASE_URL.replace(/\/anthropic$/, '').replace(/\/apps\/anthropic$/, '');
            if (!url.endsWith('/v1')) url += '/v1';
          }
          env[fallbackEnv.baseUrl] = url;
        }
        if (fallbackEnv.modelVar && ibwhaleEnv.ANTHROPIC_MODEL) {
          env[fallbackEnv.modelVar] = ibwhaleEnv.ANTHROPIC_MODEL;
        }
      }

      // 4. 用户手动保存的 agent 特定配置覆盖自动映射（savedConfig 已在上面加载）
      if (savedConfig) {
        if (savedConfig.apiKey) {
          const effectiveVar = (providerEnv && providerEnv[provider]?.envVar) || fallbackEnv?.envVar || 'API_KEY';
          env[effectiveVar] = savedConfig.apiKey;
        }
        if (savedConfig.baseUrl) {
          const effectiveBase = (providerEnv && providerEnv[provider]?.baseUrl) || fallbackEnv?.baseUrl || 'API_BASE';
          env[effectiveBase] = savedConfig.baseUrl;
        }
        if (savedConfig.model) {
          const effectiveModel = (providerEnv && providerEnv[provider]?.modelVar) || (fallbackEnv && fallbackEnv.modelVar) || 'DEFAULT_MODEL';
          env[effectiveModel] = savedConfig.model;
        }
      }

      // Codex: 强制 OPENAI_BASE_URL 指向本地代理（而非上游 URL）
      // Codex 0.128.0+ 强制 wire_api="responses"，必须通过本地代理翻译协议
      if (agentType === 'codex') {
        env.OPENAI_BASE_URL = 'http://127.0.0.1:' + CODEX_PROXY_PORT + '/v1';
      }
    }
  }

  return env;
}

function buildAgentCommand(agentType, projectRoot) {
  const agent = AGENTS.find(a => a.id === agentType);
  if (!agent || !agent.launch) {
    // Fallback to Claude Code
    return ['/c', 'pushd ' + projectRoot + ' && node bin\\claude-code --dangerously-skip-permissions'];
  }
  const { command, cwd } = agent.launch;
  const workDir = cwd || process.cwd();
  if (process.platform === 'win32') {
    if (workDir && workDir !== projectRoot) {
      return ['/c', 'pushd ' + workDir + ' && ' + command];
    }
    return ['/c', 'pushd ' + projectRoot + ' && ' + command];
  } else {
    return ['-c', 'cd ' + workDir + ' && ' + command];
  }
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
  const agentType = (existing && existing.agentType) || 'claude-code';
  const args = buildAgentCommand(agentType, projectRoot);

  // Per-agent PTY settings (Python TUI agents need ConPTY for proper console I/O forwarding)
  const agent = AGENTS.find(a => a.id === agentType);
  const useConpty = (agent && agent.launch && agent.launch.useConpty) ? true : false;

  try {
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      useConpty: useConpty,
      env: getShellEnv(agentType),
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
      // 仅当退出的 pty 仍是当前 pty 时才清空，防止旧 pty onExit 覆盖新 pty
      const conv = conversations.get(convId);
      if (conv && conv.ptyProcess === ptyProcess) conv.ptyProcess = null;
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
    show: true,
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
    show: true,
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 新窗口独立 PTY
  const id = 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  conversations.set(id, { id, title: '新项目', ptyProcess: null, pid: null, agentType: 'claude-code' });
  windowMap.set(win, { id, activeConvId: id, convIds: new Set([id]), startTime: Date.now() });
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

/**
 * 平铺所有窗口 - 按网格布局自动排列
 */
function tileAllWindows() {
  const wins = [];
  for (const [win] of windowMap) {
    if (!win.isDestroyed()) wins.push(win);
  }
  if (wins.length === 0) return;

  const GAP = 4;
  const display = screen.getPrimaryDisplay();
  const { x: waX, y: waY, width: waW, height: waH } = display.workArea;

  const n = wins.length;

  // Determine grid dimensions (reference: PowerToys FancyZones, Rectangle, i3)
  let cols, rows;
  if (n === 1) { cols = 1; rows = 1; }
  else if (n === 2) { cols = 2; rows = 1; }
  else if (n === 3) { cols = 3; rows = 1; }
  else if (n === 4) { cols = 2; rows = 2; }
  else if (n === 5) { cols = 3; rows = 2; }       // row0: 3, row1: 2 centered
  else if (n === 6) { cols = 3; rows = 2; }       // 3×2
  else if (n === 7) { cols = 4; rows = 2; }       // row0: 4, row1: 3 centered
  else { cols = Math.ceil(Math.sqrt(n)); rows = Math.ceil(n / cols); } // 8+ generic

  const cellW = Math.floor((waW - (cols + 1) * GAP) / cols);
  const cellH = Math.floor((waH - (rows + 1) * GAP) / rows);

  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;

    // For rows with fewer cells than cols, center them
    const cellsInThisRow = (r === rows - 1 && n % cols !== 0) ? (n % cols) : cols;
    const rowOffset = Math.floor((cols - cellsInThisRow) * (cellW + GAP) / 2);

    const wx = waX + GAP + c * (cellW + GAP) + (r === rows - 1 ? rowOffset : 0);
    const wy = waY + GAP + r * (cellH + GAP);

    wins[i].setBounds({ x: wx, y: wy, width: cellW, height: cellH });
  }
}

// ===== IPC: PTY =====
const PTY_CHUNK_SIZE = 4096; // 4KB per chunk, safe for all PTY implementations
const PTY_CHUNK_DELAY_MS = 5; // 5ms delay between chunks

ipcMain.on('pty-input', (event, data) => {
  const { info } = getWindowInfo(event);
  const conv = info ? conversations.get(info.activeConvId) : null;
  if (!conv || !conv.ptyProcess) return;
  if (data.length <= PTY_CHUNK_SIZE) {
    conv.ptyProcess.write(data);
  } else {
    let offset = 0;
    const writeNext = () => {
      if (offset >= data.length) return;
      const chunk = data.slice(offset, offset + PTY_CHUNK_SIZE);
      conv.ptyProcess.write(chunk);
      offset += PTY_CHUNK_SIZE;
      setTimeout(writeNext, PTY_CHUNK_DELAY_MS);
    };
    writeNext();
  }
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
    agentType: ownerConv?.agentType || 'claude-code',
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
    list.push({ id, title: conv.title, pid: conv.pid, active: id === activeId, agentType: conv.agentType || 'claude-code' });
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

// ===== Agent 管理 =====

// 检测本地已安装的 agent — 三级搜索：where/which → npm global → 常见路径
async function detectAgent(agent) {
  if (agent.detect.type === 'builtin') return { installed: true, version: null };
  if (agent.detect.type === 'always') return { installed: true, version: null };
  if (agent.detect.type === 'command') {
    for (const cmd of agent.detect.commands) {
      const cmdName = cmd.split(' ')[0];

      // 1. where/which 命令
      try {
        const whichCmd = process.platform === 'win32' ? 'where ' + cmdName : 'which ' + cmdName;
        const result = execSync(whichCmd, { encoding: 'utf8', timeout: 5000 }).trim();
        if (result && !result.includes('Could not find') && !result.includes('not found')) {
          let version = null;
          try {
            const verResult = execSync(cmdName + ' --version', { encoding: 'utf8', timeout: 5000 }).trim();
            version = verResult.split('\n')[0].slice(0, 80);
          } catch {}
          return { installed: true, version };
        }
      } catch {}

      // 2. npm global prefix 搜索
      try {
        const npmPrefix = execSync('npm config get prefix', { encoding: 'utf8', timeout: 5000 }).trim();
        if (npmPrefix && npmPrefix !== 'undefined') {
          const npmBin = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
          const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
          for (const ext of exts) {
            const candidate = path.join(npmBin, cmdName + ext);
            if (fs.existsSync(candidate)) return { installed: true, version: candidate };
          }
        }
      } catch {}

      // 3. 常见安装路径动态搜索（适配不同用户/系统）
      const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
      const commonDirs = process.platform === 'win32' ? [
        path.join(os.homedir(), 'AppData', 'Local', 'bin'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
        path.join(process.env.LOCALAPPDATA || '', 'bin'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs'),
        path.join(process.env.APPDATA || '', 'npm'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', cmdName),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', cmdName),
      ] : [
        '/usr/local/bin',
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), 'bin'),
      ];

      for (const dir of commonDirs) {
        try {
          for (const ext of exts) {
            const candidate = path.join(dir, cmdName + ext);
            if (fs.existsSync(candidate)) return { installed: true, version: candidate };
          }
          // Also check for subdirectory with same name (e.g. Program Files\Hermes\hermes.exe)
          const subDir = path.join(dir, cmdName);
          if (fs.existsSync(subDir)) {
            for (const ext of exts) {
              const candidate = path.join(subDir, cmdName + ext);
              if (fs.existsSync(candidate)) return { installed: true, version: candidate };
            }
          }
        } catch {}
      }

      // 4. 检测通过 pip 安装的命令（Python Scripts 目录）
      if (process.platform === 'win32') {
        try {
          const pythonDirs = [
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python'),
            path.join(os.homedir(), 'AppData', 'Roaming', 'Python'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python'),
          ];
          for (const pyBase of pythonDirs) {
            try {
              if (!fs.existsSync(pyBase)) continue;
              for (const pyVer of fs.readdirSync(pyBase)) {
                const scriptsDir = path.join(pyBase, pyVer, 'Scripts');
                if (fs.existsSync(scriptsDir)) {
                  for (const ext of exts) {
                    const candidate = path.join(scriptsDir, cmdName + ext);
                    if (fs.existsSync(candidate)) return { installed: true, version: candidate };
                  }
                }
              }
            } catch {}
          }
        } catch {}
      }
    }
    return { installed: false, version: null };
  }
  return { installed: false, version: null };
}

ipcMain.handle('agent-get-all', async () => {
  const agentConfigs = loadAgentConfigs();
  return AGENTS.filter(a => !a.hidden).map(a => ({
    id: a.id, name: a.name, icon: a.icon, desc: a.desc,
    builtin: !!a.builtin, hasInstall: !!a.install, hasSetup: !!a.setup,
    detect: a.detect, install: a.install, setup: a.setup,
    hasConfig: !!agentConfigs[a.id],
  }));
});

ipcMain.handle('agent-scan', async () => {
  const results = [];
  for (const agent of AGENTS) {
    const status = await detectAgent(agent);
    results.push({ id: agent.id, installed: status.installed, version: status.version });
  }
  return results;
});

ipcMain.handle('agent-get-config', async (_event, agentId) => {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent) return { ok: false, error: '未知的 Agent' };
  const configs = loadAgentConfigs();
  const saved = configs[agentId] || {};
  const ibwhaleEnv = readIbwhaleEnv();
  return {
    ok: true,
    agentId,
    saved,
    ibwhaleProvider: ibwhaleEnv.MODEL_PROVIDER || '',
    ibwhaleBaseUrl: ibwhaleEnv.ANTHROPIC_BASE_URL || '',
    hasIbwhaleKey: !!ibwhaleEnv.ANTHROPIC_AUTH_TOKEN,
    needsSetup: agent.setup && !saved.apiKey && !ibwhaleEnv.ANTHROPIC_AUTH_TOKEN,
  };
});

ipcMain.handle('agent-save-config', async (_event, { agentId, apiKey, baseUrl, model }) => {
  saveAgentConfig(agentId, { apiKey: apiKey || '', baseUrl: baseUrl || '', model: model || '' });
  return { ok: true };
});

ipcMain.handle('agent-install', async (event, agentId) => {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent || !agent.install) return { ok: false, error: 'Agent 不支持安装' };
  const { info } = getWindowInfo(event);
  const conv = info ? conversations.get(info.activeConvId) : null;
  if (conv && conv.ptyProcess) {
    conv.ptyProcess.write(agent.install.command + '\r\n');
    return { ok: true };
  }
  return { ok: false, error: '没有活跃的终端会话' };
});

ipcMain.handle('agent-run-setup', async (event, agentId) => {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent || !agent.setup) return { ok: false, error: 'Agent 不支持 setup' };
  const { info } = getWindowInfo(event);
  const conv = info ? conversations.get(info.activeConvId) : null;
  if (conv && conv.ptyProcess) {
    conv.ptyProcess.write(agent.setup.command + '\r\n');
    return { ok: true };
  }
  return { ok: false, error: '没有活跃的终端会话' };
});

ipcMain.handle('agent-switch', async (event, agentId) => {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent) return { ok: false, error: '未知的 Agent' };

  // 对于非 builtin 的 agent，先检测是否安装
  if (!agent.builtin && agent.detect.type !== 'always') {
    const status = await detectAgent(agent);
    if (!status.installed) return { ok: false, error: 'Agent 未安装' };
  }

  const { win, info } = getWindowInfo(event);
  if (!win || !info) return { ok: false, error: '无法获取窗口信息' };

  const convId = info.activeConvId;
  const conv = conversations.get(convId);
  if (!conv) return { ok: false, error: '对话不存在' };

  // 检查 agent 是否需要配置（非 claude-code 且有 provider 映射但无有效配置）
  if (agentId !== 'claude-code' && agentId !== 'custom' && agent.launch && (agent.launch.providerEnv || agent.launch.fallbackEnv)) {
    const configs = loadAgentConfigs();
    const saved = configs[agentId];
    const ibwhaleEnv = readIbwhaleEnv();
    const hasKey = (saved && saved.apiKey) || ibwhaleEnv.ANTHROPIC_AUTH_TOKEN;
    if (!hasKey) {
      return { ok: false, error: '未配置 API key', needsSetup: true, agentId };
    }
  }

  // Kill existing PTY
  if (conv.ptyProcess) {
    try { conv.ptyProcess.kill(); } catch {}
    conv.ptyProcess = null;
    conv.pid = null;
  }

  // Update agent type
  conv.agentType = agentId;

  // Restart PTY with new agent
  spawnPtyForConversation(convId);

  return { ok: true, agentId, agentName: agent.name };
});

// Set model env and restart active PTY
ipcMain.on('set-model-env', (event, cfg) => {
  const { info } = getWindowInfo(event);
  const targetConvId = info?.activeConvId;
  if (!targetConvId) return;
  // 先保存配置（更新 .env 文件）
  if (cfg) {
    // setModelEnv 传入的是 { apiKey, baseUrl, model }，需要映射为 saveLocalConfig 的格式
    const saveCfg = {
      providerId: cfg.providerId || 'custom',
      baseUrl: cfg.baseUrl,
      openaiBaseUrl: cfg.openaiBaseUrl || '',
      apiKey: cfg.apiKey,
      customModel: cfg.model || cfg.customModel || '',
      selectedModelId: cfg.selectedModelId || '',
      userName: cfg.userName || info?.userName || 'default',
      customApiUrl: cfg.customApiUrl || '',
    };
    saveLocalConfig(saveCfg);
  }
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

ipcMain.handle('config-load', (_event, userName) => loadLocalConfig(userName));
ipcMain.handle('config-save', (_event, cfg) => saveLocalConfig(cfg));
ipcMain.handle('config-rename', (_event, { oldName, newName }) => {
  try {
    const oldFile = getConfigFile(oldName);
    const newFile = getConfigFile(newName);
    if (fs.existsSync(oldFile)) {
      const data = fs.readFileSync(oldFile, 'utf-8');
      fs.writeFileSync(newFile, data, 'utf-8');
      fs.unlinkSync(oldFile);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('config-delete', (_event, userName) => {
  try {
    const file = getConfigFile(userName);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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
      if (a.name.startsWith('ibwhale') && a.name.endsWith('.zip')) return true;
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

    // 5. 找到解压后的源目录：单个顶层目录则深入，否则直接用根目录
    const entries = fs.readdirSync(extractDir);
    const dirs = entries.filter(f => fs.statSync(path.join(extractDir, f)).isDirectory());
    const files = entries.filter(f => fs.statSync(path.join(extractDir, f)).isFile());
    const sourceDir = (dirs.length === 1 && files.length === 0) ? path.join(extractDir, dirs[0]) : extractDir;

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

function isLocalUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.startsWith('192.168.') || host.startsWith('10.');
  } catch { return false; }
}

function findActiveConfig() {
  // Try default config first
  const cfg = loadLocalConfig();
  if (cfg?.baseUrl) return cfg;
  // Fallback: find any config with baseUrl set
  try {
    const files = fs.readdirSync(CONFIG_DIR).filter(f => f.startsWith('config_') && f.endsWith('.json'));
    let best = null;
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf-8'));
      if (data?.baseUrl && (!best || fs.statSync(path.join(CONFIG_DIR, f)).mtimeMs > best.mtime)) {
        best = { ...data, mtime: fs.statSync(path.join(CONFIG_DIR, f)).mtimeMs };
      }
    }
    return best;
  } catch {}
  return null;
}

ipcMain.handle('translate', async (_event, text) => {
  const cfg = findActiveConfig();
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (!cfg?.baseUrl) {
    return '请先配置 API';
  }

  // Determine model - support both customModel and selectedModelId
  const model = cfg.customModel || cfg.selectedModelId;
  if (!model) {
    return '请先配置模型';
  }

  // For local API (localhost), apiKey is optional — just try the request
  const local = isLocalUrl(cfg.baseUrl);
  if (!local && !cfg.apiKey) {
    return '请先配置 API Key';
  }

  if (trimmed.length > 2000) {
    return trimmed.slice(0, 2000) + '...';
  }

  const provider = (cfg.providerId || 'anthropic').toLowerCase();
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const anthropicProviders = ['aliyun', 'deepseek', 'zhipu', 'moonshot'];
  const isAnthropic = provider === 'claude' || provider === 'anthropic' ||
                      anthropicProviders.includes(provider) ||
                      baseUrl.includes('/anthropic');

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

  const headers = {
    'Content-Type': 'application/json',
    ...(isAnthropic
      ? { 'x-api-key': cfg.apiKey || 'ollama', 'anthropic-version': '2023-06-01' }
      : cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {}),
  };

  try {
    const result = await httpRequest(urlPath, body, headers, local ? 120000 : 30000);

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

function httpRequest(urlStr, body, headers, timeoutMs) {
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
    req.setTimeout(timeoutMs || 30000);
    req.write(body, 'utf8');
    req.end();
  });
}

// ===== Fetch Models List =====
ipcMain.handle('fetch-models', async (_event, { baseUrl, apiKey }) => {
  if (!baseUrl) return { error: '请配置 API 地址', models: [] };

  // Derive models URL from baseUrl: strip path, append /v1/models
  let modelsUrl;
  try {
    const u = new URL(baseUrl);
    modelsUrl = u.protocol + '//' + u.host + '/v1/models';
  } catch {
    return { error: '无效的 API 地址', models: [] };
  }

  // Special handling for Ollama
  if (baseUrl.includes('localhost:11434') || baseUrl.includes('127.0.0.1:11434')) {
    modelsUrl = baseUrl.replace(/\/+$/, '') + '/api/tags';
  }

  return new Promise((resolve) => {
    const url = new URL(modelsUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const options = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Connection': 'close' },
      timeout: 15000,
    };
    if (apiKey && !modelsUrl.includes('/api/tags')) {
      options.headers['Authorization'] = 'Bearer ' + apiKey;
    }

    const req = transport.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            let msg = 'HTTP ' + res.statusCode;
            if (res.statusCode === 401) msg = 'API Key 无效';
            else if (res.statusCode === 403) msg = '无权限访问该接口';
            else if (res.statusCode === 404) msg = '不支持获取模型列表';
            return resolve({ error: msg, models: [] });
          }
          const json = JSON.parse(data);
          let models = [];

          // Ollama format: { models: [{ name: "llama3:latest", ... }] }
          if (json.models && Array.isArray(json.models) && typeof json.models[0] === 'object' && json.models[0].name) {
            models = json.models.map(m => ({
              id: m.name,
              label: m.name,
            }));
          }
          // OpenAI format: { data: [{ id: "model-name", ... }] }
          else if (json.data && Array.isArray(json.data)) {
            models = json.data.map(m => ({
              id: m.id,
              label: m.id.split('/').pop(),
            }));
          }

          resolve({ models, error: null });
        } catch {
          resolve({ error: '响应解析失败', models: [] });
        }
      });
    });
    req.on('error', (e) => {
      let msg = '网络错误: ' + (e.code || e.message);
      if (e.code === 'ENOTFOUND') msg = '无法连接到该 API 地址';
      else if (e.code === 'ECONNREFUSED') msg = '连接被拒绝';
      else if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET') msg = '请求超时';
      resolve({ error: msg, models: [] });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时', models: [] }); });
    req.end();
  });
});

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

ipcMain.on('tile-windows', () => {
  tileAllWindows();
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
  // Close overlay if it exists (invisible skipTaskbar window would prevent app quit)
  if (overlay && !overlay.isDestroyed()) {
    overlay.close();
  }
  win?.close();
});

// ===== Token Usage =====
const { calcCost, getPrice } = require('./pricing.js');

let _tokenUsageCache = {}; // { cacheKey: { result, time } }

ipcMain.handle('get-token-usage', (_event, filter = {}) => {
  try {
    // 获取请求来源窗口的启动时间
    const senderWin = BrowserWindow.fromWebContents(_event.sender);
    const winInfo = senderWin ? windowMap.get(senderWin) : null;
    const winStartMs = winInfo ? winInfo.startTime : 0;

    // 缓存键加窗口隔离
    const cacheKey = (winInfo ? winInfo.id : 'orphan') + '|' + JSON.stringify(filter);
    const now = Date.now();
    const cached = _tokenUsageCache[cacheKey];
    if (cached && now - cached.time < 10000) return cached.result;

    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return { ok: false };

    // 只扫描 ibwhale 自己的项目目录（排除机器上其他 Claude Code 实例的数据）
    const ibwhaleProjectRoot = path.join(__dirname, '..');
    const ibwhaleProjectDir = ibwhaleProjectRoot.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-+|-+$/g, '');
    const projectPath = path.join(projectsDir, ibwhaleProjectDir);
    if (!fs.existsSync(projectPath)) return { ok: false };

    // 时间过滤下界：窗口启动时间（精确到毫秒）永为下界
    const today = new Date();
    const winStartISO = winStartMs ? new Date(winStartMs).toISOString() : '';
    const todayISO = today.toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const d7ISO = new Date(today - 7 * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z';

    let sinceISO;
    if (filter.since === 'today') {
      sinceISO = winStartISO > todayISO ? winStartISO : todayISO;
    } else if (filter.since === '7days') {
      sinceISO = winStartISO > d7ISO ? winStartISO : d7ISO;
    } else {
      // 默认按窗口启动时间（含 'session' 或未指定）
      sinceISO = winStartISO;
    }

    let totalInput = 0, totalOutput = 0, entryCount = 0;
    const modelStats = {}; // { model: { input, output, count } }

    // 只读 ibwhale 项目目录下的 jsonl
    for (const sessionFile of fs.readdirSync(projectPath)) {
      if (!sessionFile.endsWith('.jsonl')) continue;
      try {
        const content = fs.readFileSync(path.join(projectPath, sessionFile), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const ts = obj?.timestamp; // 完整 ISO: "2026-05-06T09:34:04.230Z"
            if (sinceISO && ts && ts < sinceISO) continue;

            const msg = obj?.message;
            const u = msg?.usage;
            if (u && (u.input_tokens > 0 || u.output_tokens > 0)) {
              const inp = u.input_tokens || 0;
              const out = u.output_tokens || 0;
              totalInput += inp;
              totalOutput += out;
              entryCount++;
              const m = msg.model || '';
              if (m && m !== '<synthetic>' && m !== 'unknown') {
                if (!modelStats[m]) modelStats[m] = { input: 0, output: 0, count: 0 };
                modelStats[m].input += inp;
                modelStats[m].output += out;
                modelStats[m].count++;
              }
            }
          } catch {}
        }
      } catch {}
    }

    // Build per-model breakdown sorted by usage
    const totalTokens = totalInput + totalOutput;
    const models = Object.entries(modelStats)
      .map(([name, s]) => {
        const p = getPrice(name);
        const mCost = p ? s.input * p.input + s.output * p.output : 0;
        const pct = totalTokens > 0 ? ((s.input + s.output) / totalTokens * 100).toFixed(1) : 0;
        return { name, input: s.input, output: s.output, cost: mCost, pct };
      })
      .sort((a, b) => (b.input + b.output) - (a.input + a.output));

    // Total cost = sum of per-model costs
    const totalCost = models.reduce((sum, m) => sum + m.cost, 0);

    const result = {
      ok: true,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cost: totalCost,
      count: entryCount,
      models, // [{ name, input, output, cost, pct }, ...]
    };

    _tokenUsageCache[cacheKey] = { result, time: now };
    return result;
  } catch (e) {
    console.error('[ibwhale] get-token-usage error:', e.message);
    return { ok: false };
  }
});

// ===== App 生命周期 =====
app.whenReady().then(() => {
  startCodexProxy();
  createWindow();
  // Create initial conversation
  const id = 'conv-' + Date.now().toString(36);
  conversations.set(id, { id, title: '新对话', ptyProcess: null, pid: null, agentType: 'claude-code' });
  windowMap.set(mainWindow, { id, activeConvId: id, convIds: new Set([id]), startTime: Date.now() });
  spawnPtyForConversation(id);
});

app.on('window-all-closed', () => {
  killAllPtys();
  app.quit();
});

app.on('will-quit', () => { stopCodexProxy(); killAllPtys(); });
