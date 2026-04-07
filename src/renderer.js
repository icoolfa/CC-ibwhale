/**
 * ibwhale Claude Code Desktop - Renderer
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { translate } from './translation';
const api = window.electronAPI;
const $ = (s) => document.getElementById(s);
// Sidebar
let sbOpen = true;
$('sidebar-toggle').onclick = () => { sbOpen = !sbOpen; $('sidebar').classList.toggle('hide', !sbOpen); };
// Window
let userKill = false;
$('btn-min').onclick = () => api.minimize();
$('btn-max').onclick = () => api.maximize();
$('btn-close').onclick = () => { userKill = true; api.killProcess(); api.close(); };
$('btn-kill').onclick = () => { userKill = true; api.killProcess(); setStatus('已终止', false); };
$('btn-restart').onclick = () => { userKill = false; api.killProcess(); term.reset(); term.clear(); api.spawnProcess(); setStatus('启动中...', true); };
// Input bar
const cmdInput = $('cmd-input');
$('cmd-send').onclick = sendCmd;
cmdInput.onkeydown = (e) => { if (e.key === 'Enter') {
    e.preventDefault();
    sendCmd();
} };
cmdInput.oninput = () => $('cmd-send').classList.toggle('on', cmdInput.value.length > 0);
function sendCmd() { if (!cmdInput.value)
    return; api.sendInput(cmdInput.value + '\r'); cmdInput.value = ''; cmdInput.focus(); }
// Terminal
const term = new Terminal({
    fontFamily: '"SimHei","Microsoft YaHei","Cascadia Code","JetBrains Mono","Fira Code",Consolas,monospace',
    fontSize: 14, lineHeight: 1.4, cursorBlink: true, cursorStyle: 'block', allowTransparency: true,
    theme: { background: 'rgba(42,42,42,0)', foreground: '#ececf1', cursor: '#10a37f', cursorAccent: '#2a2a2a',
        selectionBackground: 'rgba(16,163,127,0.3)', selectionForeground: '#fff',
        black: '#1a1a1a', red: '#f87171', green: '#10a37f', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#ececf1',
        brightBlack: '#5a5a5a', brightRed: '#fca5a5', brightGreen: '#34d399', brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fff' },
    scrollback: 10000, smoothScrollDuration: 100, scrollSensitivity: 4,
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open($('terminal'));
setTimeout(() => { fitAddon.fit(); api.sendResize(term.cols, term.rows); }, 100);
let rt;
const doFit = () => { clearTimeout(rt); rt = setTimeout(() => { fitAddon.fit(); api.sendResize(term.cols, term.rows); }, 80); };
window.addEventListener('resize', doFit);
new ResizeObserver(doFit).observe($('terminal'));
// Keyboard
term.onData((d) => api.sendInput(d));
term.attachCustomKeyEventHandler(() => true);
$('terminal').addEventListener('paste', (e) => { const pe = e; const t = pe.clipboardData?.getData('text'); if (t) {
    pe.preventDefault();
    api.sendInput(t);
} });
// Context menu
const ctxMenu = $('ctx-menu');
$('terminal').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ctxMenu.style.display = 'block';
    ctxMenu.style.left = Math.min(e.clientX, innerWidth - 180) + 'px';
    ctxMenu.style.top = Math.min(e.clientY, innerHeight - 150) + 'px';
    const sel = term.getSelection();
    const cb = $('ctx-copy');
    cb.disabled = !sel;
    cb.style.opacity = sel ? '1' : '0.4';
});
document.addEventListener('click', () => ctxMenu.style.display = 'none');
$('ctx-copy').onclick = () => { const s = term.getSelection(); if (s)
    navigator.clipboard.writeText(s); ctxMenu.style.display = 'none'; };
$('ctx-paste').onclick = async () => { try {
    const t = await navigator.clipboard.readText();
    if (t)
        api.sendInput(t);
}
catch { } ctxMenu.style.display = 'none'; };
$('ctx-select-all').onclick = () => { term.selectAll(); ctxMenu.style.display = 'none'; };
$('ctx-clear').onclick = () => { term.clear(); ctxMenu.style.display = 'none'; };
// Translate panel
$('tp-close').onclick = () => $('tp-overlay').classList.remove('open');
$('tp-overlay').addEventListener('click', (e) => { if (e.target.id === 'tp-overlay')
    $('tp-overlay').classList.remove('open'); });
// Translate toggle (default OFF — 选中后手动点击翻译)
let translateOn = false;
const btnTranslate = $('btn-translate');
btnTranslate.classList.add('active', translateOn);
btnTranslate.onclick = () => {
    translateOn = !translateOn;
    btnTranslate.classList.toggle('active', translateOn);
};
// Selection translate
const trBtn = $('tr-btn');
term.onSelectionChange(() => {
    const sel = term.getSelection();
    trBtn.style.display = sel ? 'flex' : 'none';
    if (translateOn && sel)
        trBtn.click();
});
trBtn.onclick = async () => {
    const text = term.getSelection();
    if (!text)
        return;
    $('tp-orig').textContent = text;
    $('tp-result').textContent = '翻译中...';
    $('tp-overlay').classList.add('open');
    try {
        let cfg;
        try {
            const raw = await api.loadConfig();
            if (raw) {
                cfg = {
                    provider: raw.provider || 'openai',
                    apiKey: raw.apiKey,
                    baseUrl: raw.baseUrl,
                    model: raw.model,
                };
            }
        }
        catch { }
        $('tp-result').textContent = await translate(text, cfg);
    }
    catch {
        $('tp-result').textContent = '翻译失败';
    }
};
// IPC — 纯净终端直通，不拦截不修改
const rm1 = api.onOutput((d) => {
    setStatus('运行中', true);
    term.write(d);
});
const rm2 = api.onExit((code) => {
    if (userKill) {
        term.write('\r\n\x1b[33m✦ 已终止\x1b[0m');
        setStatus('已终止', false);
    }
    else if (code === 0 || code === undefined) {
        term.write('\r\n\x1b[33m✦ 进程已退出\x1b[0m');
        setStatus('已退出', false);
    }
    else {
        term.write(`\r\n\x1b[31m✦ 异常退出 (代码:${code})\x1b[0m`);
        setStatus('异常退出', false);
    }
    term.write('\r\n\x1b[90m点击 ↻ 重新启动\x1b[0m');
    userKill = false;
});
// Expose terminal to inline JS (conversation management)
window.terminal = term;
window.addEventListener('beforeunload', () => { rm1(); rm2(); term.dispose(); });
function setStatus(text, running) {
    const el = $('status-text');
    el.textContent = text;
    el.style.display = 'inline';
    el.style.color = running ? 'var(--accent)' : 'var(--error)';
}
console.log('[ibwhale] 渲染器已加载');
