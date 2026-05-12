/**
 * 444 Claude Code Desktop - Renderer
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

declare global {
  interface Window {
    electronAPI: {
      getFilePath(file: File): string;
      sendInput(data: string): void;
      sendResize(cols: number, rows: number): void;
      killProcess(): void;
      spawnProcess(): void;
      onOutput(cb: (data: string) => void): () => void;
      onExit(cb: (code: number) => void): () => void;
      minimize(): void;
      maximize(): void;
      close(): void;
      tileWindows(): void;
      translate(text: string): Promise<string>;
      // Conversation
      newConv(): Promise<{ id: string; title: string; pid: number | null; ok: boolean }>;
      switchConv(id: string): Promise<{ ok: boolean }>;
      deleteConv(id: string): Promise<{ ok: boolean }>;
      renameConv(id: string, title: string): Promise<{ ok: boolean }>;
      getConvList(): Promise<Array<{ id: string; title: string; pid: number | null; active: boolean }>>;
      killConv(id: string): void;
      restartConv(id: string): void;
      onConvExit(cb: (id: string) => void): () => void;
      loadConfig(): Promise<any>;
      saveConfig(cfg: any): Promise<void>;
    };
    terminal: Terminal;
  }
}

const api = window.electronAPI;
const $ = (s: string) => document.getElementById(s)!;

// 与 Claude Code 200K tokens 上下文对齐（按最保守 ~2 chars/token 估算）
const MAX_INPUT_CHARS = 400000;
function guardInput(data: string): string {
  if (data.length > MAX_INPUT_CHARS) {
    return data.slice(data.length - MAX_INPUT_CHARS);
  }
  return data;
}

// Sidebar
let sbOpen = true;
$('sidebar-toggle').onclick = () => { sbOpen = !sbOpen; $('sidebar').classList.toggle('hide', !sbOpen); api.tileWindows(); };

// Window
let userKill = false;
$('btn-min').onclick = () => api.minimize();
$('btn-max').onclick = () => api.maximize();
$('btn-close').onclick = () => { userKill = true; api.killProcess(); api.close(); };
$('btn-tile').onclick = () => api.tileWindows();
$('btn-kill').onclick = () => { userKill = true; api.killProcess(); setStatus('已终止', false); };
$('btn-restart').onclick = () => { userKill = false; api.killProcess(); term.reset(); term.clear(); api.spawnProcess(); setStatus('启动中...', true); };

// Input bar
const cmdInput = $('cmd-input') as HTMLInputElement;
$('cmd-send').onclick = sendCmd;
cmdInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendCmd(); } };
cmdInput.oninput = () => $('cmd-send').classList.toggle('on', cmdInput.value.length > 0);
function sendCmd() { if (!cmdInput.value) return; api.sendInput(guardInput(cmdInput.value + '\r')); cmdInput.value = ''; cmdInput.focus(); }

// Terminal
const term = new Terminal({
  fontFamily: '"SimHei","Microsoft YaHei","Cascadia Code","JetBrains Mono","Fira Code",Consolas,monospace',
  fontSize: 14, lineHeight: 1.4, cursorBlink: true, cursorStyle: 'block', allowTransparency: true,
  theme: { background:'rgba(42,42,42,0)', foreground:'#ececf1', cursor:'#10a37f', cursorAccent:'#2a2a2a',
    selectionBackground:'rgba(16,163,127,0.3)', selectionForeground:'#fff',
    black:'#1a1a1a',red:'#f87171',green:'#10a37f',yellow:'#fbbf24',blue:'#60a5fa',magenta:'#c084fc',cyan:'#22d3ee',white:'#ececf1',
    brightBlack:'#5a5a5a',brightRed:'#fca5a5',brightGreen:'#34d399',brightYellow:'#fcd34d',brightBlue:'#93c5fd',brightMagenta:'#d8b4fe',brightCyan:'#67e8f9',brightWhite:'#fff' },
  scrollback: 10000, smoothScrollDuration: 100, scrollSensitivity: 4,
});
// 暴露终端配色更新接口，供 index.html 切换主题时调用
(window as any).updateTerminalColors = (colors: { foreground?: string; background?: string }) => {
  if (colors.foreground) term.options.theme = { ...term.options.theme, foreground: colors.foreground };
};
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open($('terminal'));
setTimeout(() => { fitAddon.fit(); api.sendResize(term.cols, term.rows); }, 100);
let rt: ReturnType<typeof setTimeout>;
const doFit = () => { clearTimeout(rt); rt = setTimeout(() => { fitAddon.fit(); api.sendResize(term.cols, term.rows); }, 80); };
window.addEventListener('resize', doFit);
new ResizeObserver(doFit).observe($('terminal'));

// Keyboard
term.onData((d: string) => api.sendInput(guardInput(d)));
term.attachCustomKeyEventHandler(() => true);
$('terminal').addEventListener('paste', (e: Event) => { const pe = e as ClipboardEvent; const t = pe.clipboardData?.getData('text'); if (t) { pe.preventDefault(); api.sendInput(guardInput(t)); } });

// Drag & drop — global capture on document so xterm.js internal elements
// (canvas, textarea, etc.) can never block the events. Supports both the
// terminal area and the command input bar.
const termWrap = document.querySelector('.term-wrap') as HTMLElement;

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  const dt = (e as DragEvent).dataTransfer;
  if (dt) dt.dropEffect = 'copy';
  // Visual feedback: highlight the terminal area
  const t = e.target as HTMLElement;
  if (termWrap?.contains(t)) {
    termWrap.classList.add('drag-over');
  }
}, true);

document.addEventListener('dragleave', (e) => {
  const t = e.target as HTMLElement;
  const rt = (e as DragEvent).relatedTarget as Node | null;
  if (termWrap?.contains(t) && !termWrap.contains(rt)) {
    termWrap.classList.remove('drag-over');
  }
}, true);

document.addEventListener('drop', (e) => {
  e.preventDefault();
  termWrap?.classList.remove('drag-over');
  const dt = (e as DragEvent).dataTransfer;
  if (!dt) return;

  let data = '';
  if (dt.files && dt.files.length > 0) {
    const parts: string[] = [];
    for (let i = 0; i < dt.files.length; i++) {
      const fp = api.getFilePath(dt.files[i]);
      if (fp) parts.push(fp.includes(' ') ? `"${fp}"` : fp);
    }
    data = parts.join(' ');
  }
  if (!data) data = dt.getData('text/plain');
  if (!data) return;

  const t = e.target as HTMLElement;
  const inputWrap = document.querySelector('.input-wrapper');
  if (inputWrap?.contains(t)) {
    // Dropped onto the command input bar — insert into textarea
    const ta = $('cmd-input') as HTMLTextAreaElement;
    ta.focus();
    const s = ta.selectionStart;
    ta.setRangeText(data, s, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (termWrap?.contains(t)) {
    // Dropped onto the terminal area — send to PTY
    api.sendInput(guardInput(data));
  }
  // Dropped elsewhere (sidebar, topbar, etc.): silently ignore
}, true);

// Context menu
const ctxMenu = $('ctx-menu') as HTMLElement;
$('terminal').addEventListener('contextmenu', (e: MouseEvent) => {
  e.preventDefault(); ctxMenu.style.display = 'block';
  ctxMenu.style.left = Math.min(e.clientX, innerWidth - 180) + 'px';
  ctxMenu.style.top = Math.min(e.clientY, innerHeight - 150) + 'px';
  const sel = term.getSelection(); const cb = $('ctx-copy') as any; cb.disabled = !sel; cb.style.opacity = sel ? '1' : '0.4';
});
document.addEventListener('click', () => ctxMenu.style.display = 'none');
$('ctx-copy').onclick = () => { const s = term.getSelection(); if (s) navigator.clipboard.writeText(s); ctxMenu.style.display = 'none'; };
$('ctx-paste').onclick = async () => { try { const t = await navigator.clipboard.readText(); if (t) api.sendInput(guardInput(t)); } catch {} ctxMenu.style.display = 'none'; };
$('ctx-select-all').onclick = () => { term.selectAll(); ctxMenu.style.display = 'none'; };
$('ctx-clear').onclick = () => { term.clear(); ctxMenu.style.display = 'none'; };

// Translate panel
$('tp-close').onclick = () => $('tp-overlay').classList.remove('open');
$('tp-overlay').addEventListener('click', (e) => { if ((e.target as HTMLElement).id === 'tp-overlay') $('tp-overlay').classList.remove('open'); });

// Translate toggle (default OFF — 选中后手动点击翻译)
let translateOn = false;
const btnTranslate = $('btn-translate') as HTMLElement;
btnTranslate.classList.add('active', translateOn);
btnTranslate.onclick = () => {
  translateOn = !translateOn;
  btnTranslate.classList.toggle('active', translateOn);
};

// Selection translate
const trBtn = $('tr-btn') as HTMLElement;
term.onSelectionChange(() => {
  const sel = term.getSelection();
  trBtn.style.display = sel ? 'flex' : 'none';
  if (translateOn && sel) trBtn.click();
});
trBtn.onclick = async () => {
  const text = term.getSelection();
  if (!text) return;
  $('tp-orig').textContent = text;
  $('tp-result').textContent = '翻译中...';
  $('tp-overlay').classList.add('open');
  try {
    $('tp-result').textContent = await api.translate(text);
  } catch (e: any) { $('tp-result').textContent = '翻译失败: ' + (e?.message || e || ''); }
};

// IPC — 纯净终端直通，不拦截不修改
const rm1 = api.onOutput((d: string) => {
  setStatus('运行中', true);
  term.write(d);
});
const rm2 = api.onExit((code: number) => {
  if (userKill) {
    term.write('\r\n\x1b[33m✦ 已终止\x1b[0m');
    setStatus('已终止', false);
  } else if (code === 0 || code === undefined) {
    term.write('\r\n\x1b[33m✦ 进程已退出\x1b[0m');
    setStatus('已退出', false);
  } else {
    term.write(`\r\n\x1b[31m✦ 异常退出 (代码:${code})\x1b[0m`);
    setStatus('异常退出', false);
  }
  term.write('\r\n\x1b[90m点击 ↻ 重新启动\x1b[0m');
  userKill = false;
});

// Expose terminal to inline JS (conversation management)
(window as any).fitAddon = fitAddon;
window.terminal = term;

window.addEventListener('beforeunload', () => { rm1(); rm2(); term.dispose(); });

function setStatus(text: string, running: boolean) {
  const el = $('status-text'); el.textContent = text; el.style.display = 'inline';
  el.style.color = running ? 'var(--accent)' : 'var(--error)';
}

console.log('[444] 渲染器已加载');
