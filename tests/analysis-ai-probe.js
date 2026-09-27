// 临时诊断：不发送经营数据或凭据到日志，只打印模型响应形状。
const fs = require('fs');
const path = require('path');
(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  const profile = (cfg.aiProfiles || []).find(item => item.id === cfg.activeAiProfileId);
  if (!profile) throw new Error('没有当前模型配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify({ model: profile.model, temperature: 0.1, max_tokens: 4096,
        messages: [
          { role: 'system', content: '你是餐饮经营分析专员。只基于给定的虚构测试数据，输出观察、依据、建议、待核实四段简短中文结论，不展示思维链。' },
          { role: 'user', content: JSON.stringify({ test_only: true, store: '虚构测试店', dates: 26, pos_revenue: 123456.78, product_income: 119000.12, expense: 40000.01, platform_actual: null, warning: '缺少平台真实账单' }) },
        ] }),
    });
    const payload = await response.json().catch(() => ({}));
    const choice = payload.choices?.[0] || {};
    console.log(JSON.stringify({ http_status: response.status, response_keys: Object.keys(payload),
      error_type: payload.error?.type || '', error_code: payload.error?.code || '',
      choices: payload.choices?.length || 0, finish_reason: choice.finish_reason || '',
      message_keys: Object.keys(choice.message || {}),
      content_type: typeof choice.message?.content, content_length: String(choice.message?.content || '').length,
      reasoning_length: String(choice.message?.reasoning_content || '').length, usage: payload.usage || {} }, null, 2));
  } finally { clearTimeout(timer); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
