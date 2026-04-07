/**
 * 翻译模块 - 选中终端文本翻译为中文
 * 策略: 直接调用用户配置的大模型进行翻译
 */

export interface TranslateConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export async function translate(text: string, config?: TranslateConfig): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (!config?.apiKey || !config?.baseUrl || !config?.model) {
    return '请先配置 API';
  }
  return await llmTranslate(trimmed, config);
}

async function llmTranslate(text: string, config: TranslateConfig): Promise<string> {
  const provider = (config.provider || 'openai').toLowerCase();
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const isAnthropic = provider === 'claude' || baseUrl.includes('/anthropic');
  const maxLen = 2000;
  if (text.length > maxLen) text = text.slice(0, maxLen) + '...';

  if (isAnthropic) {
    const url = baseUrl.endsWith('/v1') ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1024,
        system: '你是一个翻译助手。请将以下文本翻译成中文。只返回翻译结果，不要解释。保留原始格式和换行。',
        messages: [{ role: 'user', content: `Translate to Chinese:\n${text}` }],
      }),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const json = await resp.json();
    return json.content?.[0]?.text?.trim() || '翻译失败';
  }

  // OpenAI 兼容格式
  const url = baseUrl.endsWith('/v1')
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: '你是一个翻译助手。请将以下文本翻译成中文。只返回翻译结果，不要解释。保留原始格式和换行。' },
        { role: 'user', content: `Translate to Chinese:\n${text}` },
      ],
      max_tokens: 1024,
    }),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() || '翻译失败';
}
