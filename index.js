// 修仙规则路由 —— 最小验证版 (v0.0.1)
// 目标：验证「生成前拦截 → setExtensionPrompt 注入文本 → 进入发给模型的提示词」这条管路。
// 方案甲：EJS/宏交给 ST 既有的 EjsTemplate 扩展处理，本扩展只负责"决定开哪些 + 注入原文"。
// 本验证版先固定注入一段带 标记/EJS/宏 的文本，用来确认：
//   1) 注入是否进入合并后的提示词（hasMarker）
//   2) EjsTemplate 是否会处理我们注入的 EJS（ejsEvaluated）

const MODULE_KEY = 'cultivation_rule_router';
const MARKER = 'RULE_ROUTER_OK';

function buildInjection() {
  return [
    '【规则路由·验证注入】',
    `标记: ${MARKER}`,
    'EJS自检: <%= 1 + 1 %>',
    '宏自检: {{user}}',
    '（本段来自「修仙规则路由」扩展，用于验证注入管路；若模型能看到本段即注入成功）',
  ].join('\n');
}

function start() {
  const ctx = SillyTavern.getContext();
  const ET = ctx.eventTypes;

  // —— 生成前：设置注入 ——
  // 方案甲(增强)：复用 EjsTemplate.evalTemplate 处理 EJS/宏/变量，注入"已求值"成品。
  // （EjsTemplate 的 inject_loader 默认关闭，不会自动处理 setExtensionPrompt 内容，故主动调用其引擎。）
  // setExtensionPrompt(key, value, position, depth, scan?, role?)
  // position: IN_PROMPT=0 / IN_CHAT=1 / BEFORE_PROMPT=2 ；role: SYSTEM=0
  ctx.eventSource.on(ET.GENERATION_AFTER_COMMANDS, async () => {
    let text = buildInjection();
    try {
      if (window.EjsTemplate?.evalTemplate) {
        text = await window.EjsTemplate.evalTemplate(text);
      }
    } catch (e) {
      console.warn('[规则路由] EjsTemplate.evalTemplate 失败，改注入原文', e);
    }
    ctx.setExtensionPrompt(MODULE_KEY, text, 1, 4, false, 0);
    console.log('[规则路由] 已设置注入(经 EjsTemplate 处理):\n' + text);
  });

  // —— 合并后：把发给模型的内容暂存，供外部检查注入是否进入 ——
  ctx.eventSource.on(ET.GENERATE_AFTER_COMBINE_PROMPTS, (data) => {
    try {
      let s = '';
      try {
        s = typeof data === 'string' ? data : JSON.stringify(data);
      } catch {
        s = String(data);
      }
      window.__ruleRouterDebug = {
        at: Date.now(),
        hasMarker: s.includes(MARKER),
        ejsEvaluated: s.includes('EJS自检: 2'),
        ejsRaw: s.includes('<%= 1 + 1 %>'),
        length: s.length,
        sample: s.slice(0, 6000),
      };
      console.log(
        '[规则路由] 合并后: 含标记=' +
          window.__ruleRouterDebug.hasMarker +
          ' EJS已求值=' +
          window.__ruleRouterDebug.ejsEvaluated +
          ' EJS原样残留=' +
          window.__ruleRouterDebug.ejsRaw,
      );
    } catch (e) {
      console.warn('[规则路由] 合并检查失败', e);
    }
  });

  console.log('[规则路由] 验证扩展已加载 ✓');
}

if (globalThis.SillyTavern?.getContext) {
  start();
} else {
  const t = setInterval(() => {
    if (globalThis.SillyTavern?.getContext) {
      clearInterval(t);
      start();
    }
  }, 200);
}
