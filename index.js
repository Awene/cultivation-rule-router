// 修仙规则路由 · Cultivation Rule Router (v0.1.0)
// 思路：玩家在配置 UI 里给"使用中的世界书"的某些条目开启【文字过滤】并填写启用条件；
// 每次生成前用 flash 模型据当前情境判断这些条目是否满足条件，未满足的在本次扫描里隐藏，
// 满足的交由 ST 原生流程（含 EjsTemplate 的 EJS/宏处理）注入。不改 UI 开关、不落盘、零改卡。
//
// 隐藏机制（源码确认）：getSortedEntries 在克隆前 emit WORLDINFO_ENTRIES_LOADED，载荷条目是
// loadWorldInfo 出来的新对象浅拷贝，改 entry.disable=true 只影响本次扫描（line 4602 跳过）。

const EXT_NAME = 'cultivation-rule-router';
const SETTINGS_KEY = 'cultivation_rule_router';

let ctx = null;
/** 本次生成要隐藏的条目键集合：`${world}::${uid}` */
let hideSet = new Set();

// ============ 设置 ============
function settings() {
  const all = ctx.extensionSettings;
  if (!all[SETTINGS_KEY]) all[SETTINGS_KEY] = {};
  const s = all[SETTINGS_KEY];
  s.api = s.api || { url: '', key: '', model: '' };
  s.filters = s.filters || {}; // filters[book][uid] = { enabled, condition, comment }
  return s;
}
function persist() {
  ctx.saveSettingsDebounced();
}
function getFilter(book, uid) {
  const f = settings().filters;
  return f[book]?.[String(uid)] || null;
}
function setFilter(book, uid, data) {
  const f = settings().filters;
  f[book] = f[book] || {};
  f[book][String(uid)] = data;
}

// ============ 读取"使用中的世界书"条目 ============
async function importGetSortedEntries() {
  for (const p of ['/scripts/world-info.js', '../../../world-info.js']) {
    try {
      const m = await import(p);
      if (typeof m.getSortedEntries === 'function') return m.getSortedEntries;
    } catch (e) {
      /* 试下一个路径 */
    }
  }
  console.warn('[规则路由] 无法 import getSortedEntries，回退到角色书');
  return null;
}

/** 返回 { 世界书名: [entry,...] }，entry 含 uid/world/comment/key/constant/disable/content */
async function inUseEntriesByBook() {
  const byBook = {};
  const add = (e) => {
    const w = e.world || '(未知世界书)';
    (byBook[w] = byBook[w] || []).push(e);
  };
  const getSorted = await importGetSortedEntries();
  if (getSorted) {
    try {
      const entries = await getSorted();
      entries.forEach(add);
      return byBook;
    } catch (e) {
      console.warn('[规则路由] getSortedEntries 调用失败，回退:', e);
    }
  }
  // 回退：仅角色书（embedded / linked）
  const c = ctx.characters?.[ctx.characterId ?? ctx.this_chid];
  const bookName = c?.data?.extensions?.world;
  if (bookName) {
    const data = await ctx.loadWorldInfo(bookName);
    if (data?.entries) {
      Object.values(data.entries).forEach((e) => add({ ...e, world: bookName }));
    }
  }
  return byBook;
}

// ============ flash 路由 ============
function recentContextText() {
  const chat = ctx.chat || [];
  const last = chat.slice(-4).map((m) => `${m.is_user ? '玩家' : 'GM'}：${(m.mes || '').slice(0, 600)}`);
  return last.join('\n');
}

async function fetchModels(url, key) {
  const base = url.replace(/\/+$/, '');
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = data?.data || data?.models || [];
  return list.map((m) => m.id || m.name).filter(Boolean);
}

/** candidates: [{book, uid, comment, condition}] → 返回应"启用"的下标集合(1-based) */
async function callFlashRouter(candidates, contextText) {
  const { url, key, model } = settings().api;
  if (!url || !key || !model) throw new Error('flash API 未配置');
  const sys =
    '你是"世界书条目路由器"。根据【当前情境】，判断下列每个【候选条目】的启用条件是否满足当前情境。' +
    '只返回条件满足的条目编号。严格输出 JSON：{"启用":[编号,...]}，不要任何解释。';
  const user =
    `【当前情境】\n${contextText || '（无）'}\n\n【候选条目】\n` +
    candidates.map((c, i) => `${i + 1}. ${c.comment} —— 启用条件：${c.condition}`).join('\n');
  const base = url.replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const txt = data?.choices?.[0]?.message?.content || '';
  const m = txt.match(/\{[\s\S]*\}/);
  const obj = m ? JSON.parse(m[0]) : { 启用: [] };
  return new Set((obj.启用 || []).map(Number));
}

// ============ 运行时：生成前算 hideSet，扫描时应用 ============
async function onBeforeGeneration() {
  hideSet = new Set();
  const s = settings();
  if (!s.api.url || !s.api.key || !s.api.model) return; // 未配置 → 不路由（全部照常）

  // 收集"已开启文字过滤"且当前在用的条目
  const byBook = await inUseEntriesByBook();
  const candidates = [];
  for (const [book, entries] of Object.entries(byBook)) {
    for (const e of entries) {
      const f = getFilter(book, e.uid);
      if (f?.enabled && f.condition?.trim()) {
        candidates.push({ book, uid: e.uid, comment: e.comment || `(uid ${e.uid})`, condition: f.condition.trim() });
      }
    }
  }
  if (!candidates.length) return;

  try {
    const keep = await callFlashRouter(candidates, recentContextText());
    candidates.forEach((c, i) => {
      if (!keep.has(i + 1)) hideSet.add(`${c.book}::${c.uid}`);
    });
    console.log(`[规则路由] 候选 ${candidates.length}，命中 ${candidates.length - hideSet.size}，隐藏 ${hideSet.size}`);
  } catch (e) {
    console.warn('[规则路由] flash 路由失败，本回合不隐藏任何条目:', e);
    hideSet = new Set();
  }
}

function onEntriesLoaded(payload) {
  if (!hideSet.size) return;
  const lists = [payload?.globalLore, payload?.characterLore, payload?.chatLore, payload?.personaLore];
  let hidden = 0;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (hideSet.has(`${e.world}::${e.uid}`)) {
        e.disable = true;
        hidden++;
      }
    }
  }
  if (hidden) console.log(`[规则路由] 本次扫描隐藏 ${hidden} 条`);
}

// ============ 配置 UI ============
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function renderFilterList(container) {
  container.innerHTML = '<div class="crr-hint">读取使用中的世界书…</div>';
  const byBook = await inUseEntriesByBook();
  const books = Object.keys(byBook);
  if (!books.length) {
    container.innerHTML = '<div class="crr-hint">未检测到使用中的世界书（请先选中角色卡）。</div>';
    return;
  }
  container.innerHTML = '';
  for (const book of books) {
    const group = el(`<div class="crr-book"><div class="crr-book-title">📖 ${escapeHtml(book)} <span class="crr-count">(${byBook[book].length})</span></div></div>`);
    for (const e of byBook[book]) {
      const f = getFilter(book, e.uid);
      const enabled = !!f?.enabled;
      const row = el(`
        <div class="crr-entry">
          <label class="crr-entry-head">
            <input type="checkbox" class="crr-chk" ${enabled ? 'checked' : ''} />
            <span class="crr-entry-name">${escapeHtml(e.comment || '(无标题 uid ' + e.uid + ')')}</span>
            <span class="crr-lamp">${e.constant ? '蓝·常驻' : e.disable ? '关' : '绿·关键词'}</span>
          </label>
          <textarea class="crr-cond text_pole" rows="2" placeholder="启用条件（flash 据此判断是否打开本条）：如 进入战斗/交手时" ${enabled ? '' : 'style="display:none"'}></textarea>
        </div>`);
      const chk = row.querySelector('.crr-chk');
      const cond = row.querySelector('.crr-cond');
      cond.value = f?.condition || '';
      chk.addEventListener('change', () => {
        cond.style.display = chk.checked ? '' : 'none';
        setFilter(book, e.uid, { enabled: chk.checked, condition: cond.value, comment: e.comment });
        persist();
      });
      cond.addEventListener('input', () => {
        setFilter(book, e.uid, { enabled: chk.checked, condition: cond.value, comment: e.comment });
        persist();
      });
      group.append(row);
    }
    container.append(group);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function openConfig() {
  const s = settings();
  const root = el(`
    <div class="crr-config">
      <h3>修仙规则路由 · 配置</h3>

      <div class="crr-section">
        <div class="crr-section-title">flash 路由模型（用于判断条目是否启用）</div>
        <label class="crr-field">接口地址 (Base URL)
          <input type="text" class="crr-url text_pole" placeholder="如 https://api.deepseek.com/v1" />
        </label>
        <label class="crr-field">API Key
          <input type="password" class="crr-key text_pole" placeholder="sk-..." />
        </label>
        <label class="crr-field">模型
          <div class="crr-model-row">
            <select class="crr-model text_pole"></select>
            <div class="menu_button crr-fetch">获取模型</div>
          </div>
        </label>
        <div class="crr-api-msg crr-hint"></div>
      </div>

      <div class="crr-section">
        <div class="crr-section-title">规则过滤
          <div class="menu_button crr-refresh">刷新</div>
        </div>
        <div class="crr-list"></div>
      </div>
    </div>
  `);

  const urlIn = root.querySelector('.crr-url');
  const keyIn = root.querySelector('.crr-key');
  const modelSel = root.querySelector('.crr-model');
  const apiMsg = root.querySelector('.crr-api-msg');
  const list = root.querySelector('.crr-list');

  urlIn.value = s.api.url || '';
  keyIn.value = s.api.key || '';
  if (s.api.model) modelSel.append(el(`<option value="${escapeHtml(s.api.model)}" selected>${escapeHtml(s.api.model)}</option>`));

  const saveApi = () => {
    s.api.url = urlIn.value.trim();
    s.api.key = keyIn.value.trim();
    s.api.model = modelSel.value;
    persist();
  };
  urlIn.addEventListener('input', saveApi);
  keyIn.addEventListener('input', saveApi);
  modelSel.addEventListener('change', saveApi);

  root.querySelector('.crr-fetch').addEventListener('click', async () => {
    apiMsg.textContent = '获取模型中…';
    try {
      const ids = await fetchModels(urlIn.value.trim(), keyIn.value.trim());
      const cur = modelSel.value;
      modelSel.innerHTML = '';
      ids.forEach((id) => modelSel.append(el(`<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)));
      if (ids.includes(cur)) modelSel.value = cur;
      saveApi();
      apiMsg.textContent = `获取到 ${ids.length} 个模型`;
    } catch (e) {
      apiMsg.textContent = '获取失败：' + e.message;
    }
  });

  root.querySelector('.crr-refresh').addEventListener('click', () => renderFilterList(list));

  // 打开即刷新一次
  renderFilterList(list);

  ctx.callGenericPopup(root, ctx.POPUP_TYPE.DISPLAY, '', {
    wide: true,
    large: true,
    okButton: '关闭',
    allowVerticalScrolling: true,
  });
}

function addWandMenuItem() {
  const menu = document.querySelector('#extensionsMenu');
  if (!menu || menu.querySelector('#crr_wand')) return;
  const item = el(`
    <div id="crr_wand_container" class="extension_container interactable" tabindex="0">
      <div id="crr_wand" class="list-group-item flex-container flexGap5 interactable" title="修仙规则路由配置" tabindex="0">
        <i class="fa-solid fa-route"></i>
        <span>规则路由配置</span>
      </div>
    </div>`);
  item.querySelector('#crr_wand').addEventListener('click', openConfig);
  menu.append(item);
}

// ============ 启动 ============
function start() {
  ctx = SillyTavern.getContext();
  const ET = ctx.eventTypes;
  ctx.eventSource.on(ET.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
  ctx.eventSource.on(ET.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);
  addWandMenuItem();
  // 魔棒菜单可能延迟渲染，补一次
  setTimeout(addWandMenuItem, 1500);
  console.log('[规则路由] v0.1.0 已加载 ✓');
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
