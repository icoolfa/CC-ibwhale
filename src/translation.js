/**
 * 翻译模块 - 选中终端文本翻译为中文
 * 策略: 本地词典优先(即时) + MyMemory API(完整句子) + 大模型翻译(兜底)
 */
// ===== 开发术语词典 =====
const DICT = {
    // CLI / Terminal
    'error': '错误', 'warning': '警告', 'info': '信息', 'success': '成功',
    'failed': '失败', 'fatal': '致命错误', 'critical': '严重',
    'permission': '权限', 'denied': '拒绝', 'unauthorized': '未授权',
    'forbidden': '禁止', 'timeout': '超时', 'connection': '连接',
    'refused': '拒绝', 'unreachable': '不可达', 'not found': '未找到',
    'already exists': '已存在', 'file': '文件', 'directory': '目录',
    'folder': '文件夹', 'path': '路径', 'command': '命令',
    'option': '选项', 'argument': '参数', 'flag': '标志',
    'usage': '用法', 'help': '帮助', 'version': '版本',
    'unknown': '未知', 'invalid': '无效', 'required': '必需',
    'optional': '可选', 'deprecated': '已弃用', 'removed': '已移除',
    'updated': '已更新', 'installed': '已安装', 'uninstalled': '已卸载',
    'missing': '缺失', 'found': '找到', 'created': '已创建',
    'deleted': '已删除', 'modified': '已修改', 'changed': '已更改',
    'completed': '已完成', 'running': '运行中', 'stopped': '已停止',
    'starting': '正在启动', 'stopping': '正在停止', 'restarting': '正在重启',
    'loading': '加载中', 'saving': '保存中', 'building': '构建中',
    'compiling': '编译中', 'testing': '测试中', 'deploying': '部署中',
    // Git
    'commit': '提交', 'branch': '分支', 'merge': '合并', 'rebase': '变基',
    'push': '推送', 'pull': '拉取', 'clone': '克隆', 'checkout': '检出',
    'repository': '仓库', 'remote': '远程', 'origin': '源',
    'conflict': '冲突', 'staged': '已暂存', 'unstaged': '未暂存',
    'untracked': '未跟踪', 'stashed': '已储藏',
    // Code
    'function': '函数', 'variable': '变量', 'constant': '常量',
    'class': '类', 'module': '模块', 'import': '导入', 'export': '导出',
    'parameter': '参数', 'return': '返回', 'type': '类型',
    'interface': '接口', 'method': '方法', 'property': '属性',
    'constructor': '构造函数', 'instance': '实例', 'prototype': '原型',
    'callback': '回调', 'promise': 'Promise', 'async': '异步',
    'await': '等待', 'syntax': '语法', 'reference': '引用',
    'undefined': '未定义', 'null': '空值', 'exception': '异常',
    'stack trace': '堆栈跟踪', 'breakpoint': '断点',
    // Claude Code 专用
    'thinking': '思考中', 'tool': '工具', 'input': '输入',
    'output': '输出', 'result': '结果', 'response': '响应',
    'request': '请求', 'message': '消息', 'prompt': '提示词',
    'context': '上下文', 'token': '令牌', 'model': '模型',
    'api': '接口', 'key': '密钥', 'config': '配置',
    'setting': '设置', 'preference': '偏好设置',
    'allow': '允许', 'deny': '拒绝',
    'approve': '批准', 'reject': '拒绝', 'confirm': '确认',
    'cancel': '取消', 'continue': '继续', 'proceed': '继续执行',
    'abort': '中止', 'retry': '重试', 'skip': '跳过',
    'undo': '撤销', 'redo': '重做', 'apply': '应用',
    'discard': '丢弃', 'save': '保存', 'load': '加载',
    // 文件操作
    'read': '读取', 'write': '写入', 'copy': '复制', 'move': '移动',
    'rename': '重命名', 'search': '搜索', 'replace': '替换',
    'insert': '插入', 'append': '追加', 'prepend': '前置',
    'overwrite': '覆盖', 'backup': '备份', 'restore': '恢复',
    // 常用词
    'the': '', 'is': '是', 'are': '是', 'was': '曾是', 'were': '曾是',
    'be': '是', 'been': '已是', 'being': '正在是', 'have': '有',
    'has': '有', 'had': '有', 'do': '做', 'does': '做', 'did': '做了',
    'will': '将', 'would': '将', 'should': '应该', 'could': '可以',
    'may': '可能', 'might': '可能', 'must': '必须', 'can': '能',
    'need': '需要', 'want': '想要', 'please': '请',
    'yes': '是的', 'no': '否', 'ok': '好的', 'okay': '好的',
    'done': '完成', 'ready': '就绪',
    // Claude Code 界面短语
    'esc to cancel': '按 Esc 取消', 'enter to confirm': '按回车确认',
    'press enter': '按回车', 'press esc': '按 Esc',
    'tab to switch': '按 Tab 切换', 'arrow keys': '方向键',
    'select an option': '选择一个选项', 'type to search': '输入以搜索',
    'no results': '无结果', 'loading...': '加载中...',
    'thinking...': '思考中...', 'processing...': '处理中...',
    'generating...': '生成中...', 'analyzing...': '分析中...',
    'reading file': '读取文件', 'writing file': '写入文件',
    'creating file': '创建文件', 'deleting file': '删除文件',
    'editing file': '编辑文件', 'executing command': '执行命令',
    'running tests': '运行测试', 'installing dependencies': '安装依赖',
    'building project': '构建项目', 'compiling code': '编译代码',
    'linting code': '代码检查', 'formatting code': '格式化代码',
    'committing changes': '提交更改', 'pushing changes': '推送更改',
    'pulling changes': '拉取更改', 'fetching updates': '获取更新',
    'resolving conflicts': '解决冲突', 'merging branches': '合并分支',
    'creating branch': '创建分支', 'switching branch': '切换分支',
};
// ===== 翻译函数 =====
function localTranslate(text) {
    const lower = text.toLowerCase().trim();
    if (DICT[lower] !== undefined && DICT[lower] !== '')
        return DICT[lower];
    // 逐词翻译
    const words = lower.split(/\s+/);
    const translated = words.map((w) => {
        const t = DICT[w];
        if (t !== undefined)
            return t || '';
        return w;
    }).filter(Boolean);
    if (translated.length === 0)
        return text;
    return translated.join(' ');
}
export async function translate(text, config) {
    const trimmed = text.trim();
    if (!trimmed)
        return '';
    // 1. 调用免费 API (MyMemory, 无需密钥) — 总是优先尝试 API 翻译长文本
    if (trimmed.split(/\s+/).length > 2) {
        try {
            const resp = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed.slice(0, 5000))}&langpair=en|zh-CN`);
            if (resp.ok) {
                const json = await resp.json();
                if (json.responseStatus === 200 && json.responseData?.translatedText) {
                    const result = json.responseData.translatedText;
                    if (result !== trimmed) {
                        return result;
                    }
                }
            }
        }
        catch {
            // 网络不可用，静默降级
        }
    }
    // 2. 本地词典
    const local = localTranslate(trimmed);
    if (local !== trimmed)
        return local;
    // 3. 大模型翻译兜底
    if (config?.apiKey && config?.baseUrl && config?.model) {
        try {
            const llmResult = await llmTranslate(trimmed, config);
            if (llmResult)
                return llmResult;
        }
        catch {
            // LLM 翻译失败，静默降级
        }
    }
    // 4. 无法翻译,返回原文
    return trimmed;
}
async function llmTranslate(text, config) {
    const provider = (config.provider || 'openai').toLowerCase();
    const maxLen = 500;
    if (text.length > maxLen)
        text = text.slice(0, maxLen);
    const anthropicProviders = ['aliyun', 'deepseek', 'zhipu', 'moonshot', 'claude', 'anthropic'];
    const isAnthropic = anthropicProviders.includes(provider) || (config.baseUrl || '').includes('/anthropic');
    if (isAnthropic) {
        const resp = await fetch(`${config.baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: config.model,
                max_tokens: 512,
                system: '你是一个翻译助手。请将以下文本翻译成中文。只返回翻译结果，不要解释。',
                messages: [{ role: 'user', content: `Translate to Chinese: ${text}` }],
            }),
        });
        if (resp.ok) {
            const json = await resp.json();
            return json.content?.[0]?.text?.trim() || null;
        }
    }
    else {
        // OpenAI 兼容格式 (OpenAI, Qwen, 等)
        const url = config.baseUrl.endsWith('/v1')
            ? `${config.baseUrl}/chat/completions`
            : `${config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                model: config.model,
                messages: [
                    { role: 'system', content: '你是一个翻译助手。请将以下文本翻译成中文。只返回翻译结果，不要解释。' },
                    { role: 'user', content: `Translate to Chinese: ${text}` },
                ],
                max_tokens: 512,
            }),
        });
        if (resp.ok) {
            const json = await resp.json();
            return json.choices?.[0]?.message?.content?.trim() || null;
        }
    }
    return null;
}
