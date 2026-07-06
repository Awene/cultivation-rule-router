// 规则路由 · Cultivation Rule Router (v0.11.3)
// 玩家在配置 UI 给"使用中的世界书"的某些条目开启【文字过滤】并填写启用条件；
// 每次生成前用 flash 模型据当前情境判断这些条目是否满足条件，未满足的在本次扫描里隐藏，
// 满足的交由 ST 原生流程（含 EjsTemplate 的 EJS/宏处理）注入。不改 UI 开关、不落盘、零改卡。
//
// 隐藏机制（源码确认）：getSortedEntries 在克隆前 emit WORLDINFO_ENTRIES_LOADED，载荷条目是
// loadWorldInfo 出来的新对象浅拷贝，改 entry.disable=true 只影响本次扫描（line 4602 跳过）。

const SETTINGS_KEY = 'cultivation_rule_router';

const DEFAULT_PROMPT =
  '你是"世界书条目路由器"，工作是决定AIRP中本轮应当开启哪些世界书条目：根据【当前情境】与【本轮玩家输入】，逐条判断下列【候选条目】的启用条件，决定本轮是否启用这些【候选条目】。\n' +
  '- 只选出条件确实满足的条目编号；拿不准、无明确迹象则不选。\n' +
  '- 严格只输出 JSON：{"启用":[编号,...]}，不要任何解释或多余文本。';
const DEFAULT_STRIP_TAGS = 'StatusPlaceHolderImpl,disclaimer,UpdateVariable,options';

let ctx = null;
/** 本次生成要隐藏的条目键集合：`${world}::${uid}` */
let hideSet = new Set();
/** flash 结果缓存（LRU）：请求提示词哈希 -> 启用编号数组。用于重生成/swipe/回退同输入时复用 */
const routeCache = new Map();
let lastRouteCached = false;
let lastRouteHash = '';
/** 上一次路由的记录，待挂到即将收到的 AI 楼层 extra 上（供逐层查看） */
let pendingRoute = null;

/** 轻量字符串哈希（djb2），用于缓存键与楼层记录标识 */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
/** routeCache 按完整提示词字符串存；这里按哈希查/删（缓存很小，遍历即可） */
function cacheHasHash(hash) {
  for (const k of routeCache.keys()) if (hashStr(k) === hash) return true;
  return false;
}
function cacheDeleteByHash(hash) {
  for (const k of routeCache.keys())
    if (hashStr(k) === hash) {
      routeCache.delete(k);
      return true;
    }
  return false;
}

// ============ 设置 ============
function settings() {
  const all = ctx.extensionSettings;
  if (!all[SETTINGS_KEY]) all[SETTINGS_KEY] = {};
  const s = all[SETTINGS_KEY];
  s.api = s.api || { url: '', key: '', model: '' };
  s.filters = s.filters || {}; // filters[book][uid] = { enabled, condition, comment }
  if (typeof s.prompt !== 'string') s.prompt = DEFAULT_PROMPT;
  if (typeof s.enabled !== 'boolean') s.enabled = true; // 插件总开关
  if (typeof s.cotSeparator !== 'string') s.cotSeparator = '</think>'; // 思维链分隔符
  if (typeof s.historyCount !== 'number') s.historyCount = 4; // 收录最近 N 条 GM 回复
  if (typeof s.stripTags !== 'string') s.stripTags = DEFAULT_STRIP_TAGS; // 标签剔除（逗号分隔的标签名）
  if (typeof s.cacheSize !== 'number') s.cacheSize = 5; // flash 结果缓存条数（0=关闭）
  if (typeof s.manualMode !== 'boolean') s.manualMode = false; // 手动预览模式：跳过 flash，用手动名单
  if (!Array.isArray(s.manualHidden)) s.manualHidden = []; // 手动隐藏名单：["book::uid", ...]
  return s;
}
function toast() {
  return window.toastr || { info() {}, success() {}, warning() {}, clear() {} };
}
// 该 ST 的 toastr.clear(toast) 不做定向移除，直接删元素
function clearToast(t) {
  try {
    if (t && t[0]) t[0].remove();
    else if (t && typeof t.remove === 'function') t.remove();
  } catch (e) {
    /* ignore */
  }
}
function persist() {
  ctx.saveSettingsDebounced();
}
// 过滤配置按「条目名称(comment)」存储，而非 uid：tavern_sync push 会重新生成 uid，
// 按名称存可跨 push / 跨导入稳定复用。运行时再由名称解析回当次的 live uid。
function getFilter(book, name) {
  return settings().filters[book]?.[String(name)] || null;
}
function setFilter(book, name, data) {
  const f = settings().filters;
  f[book] = f[book] || {};
  f[book][String(name)] = data;
}
/** 被某个「已启用源」关联的条目 uid 集合（这些条目变为被动，不能独立开启） */
function targetUidsOf(book) {
  const f = settings().filters[book] || {};
  const t = new Set();
  for (const cfg of Object.values(f)) {
    if (cfg.enabled && Array.isArray(cfg.linked)) cfg.linked.forEach((l) => t.add(String(l)));
  }
  return t;
}
/** 关联了某被动条目的源条目名（用于 UI 显示「由 X 关联」）。linked 存的是名称。 */
function sourceNamesForTarget(book, targetName) {
  const f = settings().filters[book] || {};
  const names = [];
  for (const cfg of Object.values(f)) {
    if (cfg.enabled && (cfg.linked || []).includes(targetName)) names.push(cfg.comment || '条目');
  }
  return names;
}

/**
 * 一次性迁移：把过滤配置的存储键从旧的 uid 改为条目名称(comment)，linked 同样 uid→名称。
 * 兼容 tavern_sync push 后 uid 重新生成、导致旧配置对不上的历史数据。
 * 幂等：已是名称键的书跳过；可反复调用。需要 byBook 以把 linked 里的旧 uid 解析成名称。
 */
function migrateFiltersToNames(byBook) {
  const s = settings();
  const isNumeric = (k) => /^\d+$/.test(String(k));
  let changed = false;
  for (const [book, map] of Object.entries(s.filters || {})) {
    if (!map || !Object.keys(map).some(isNumeric)) continue; // 无数字键 → 已是名称键
    const uidToName = new Map((byBook[book] || []).map((e) => [String(e.uid), e.comment]));
    const next = {};
    for (const [key, cfg] of Object.entries(map)) {
      // 源条目名：优先用配置里存的 comment（对 stale uid 也有效），否则用 live uid 反查，再否则键本身
      const name = cfg.comment || (isNumeric(key) ? uidToName.get(String(key)) : key);
      if (!name) continue; // 无从得知名称（坏配置）→ 丢弃
      // linked：旧 uid → 名称；已是名称的保留；解析不到的（stale）丢弃
      const linked = [...new Set((cfg.linked || []).map((l) => (isNumeric(l) ? uidToName.get(String(l)) : l)).filter(Boolean))];
      next[name] = { ...cfg, comment: name, linked };
    }
    s.filters[book] = next;
    changed = true;
  }
  if (changed) {
    s.manualHidden = []; // 手动名单是按 book::name 存的临时态，键格式变了 → 清空
    persist();
    console.log('[规则路由] 已把过滤配置迁移为按条目名称存储');
  }
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
      (await getSorted()).forEach(add);
      return byBook;
    } catch (e) {
      console.warn('[规则路由] getSortedEntries 调用失败，回退:', e);
    }
  }
  const c = ctx.characters?.[ctx.characterId ?? ctx.this_chid];
  const bookName = c?.data?.extensions?.world;
  if (bookName) {
    const data = await ctx.loadWorldInfo(bookName);
    if (data?.entries) Object.values(data.entries).forEach((e) => add({ ...e, world: bookName }));
  }
  return byBook;
}

// ============ flash 路由 ============
/** 剥思维链：分隔符（默认 </think>）之前的内容视为思维链，丢弃，仅保留其后 */
function stripCoT(text, sep) {
  if (!sep) return text;
  const i = text.indexOf(sep);
  return i >= 0 ? text.slice(i + sep.length) : text;
}
/** 解析标签名列表（逗号/空白分隔，兼容带尖括号/斜杠的写法） */
function parseTagList(str) {
  return (str || '')
    .split(/[,，\s]+/)
    .map((t) => t.replace(/[<>/]/g, '').trim())
    .filter(Boolean);
}
/** 标签剔除：删除每个 <tag>...</tag> 整段（含内容）；并清掉自闭合 <tag/> 与残留单标签 */
function stripTagsFromText(text, tags) {
  let t = text;
  for (const tag of tags) {
    const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`<${esc}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${esc}>`, 'gi'), ''); // 成对：整段删
    t = t.replace(new RegExp(`<\\/?${esc}(?:\\s[^>]*)?\\/?>`, 'gi'), ''); // 自闭合 / 残留单标签
  }
  return t;
}
/** 最近 N 条 GM 回复（剥思维链+标签剔除、不截断）+ 本轮玩家输入（仅最新一条玩家，历史玩家输入不收录） */
function routerContext() {
  const s = settings();
  const chat = ctx.chat || [];
  const tags = parseTagList(s.stripTags);
  let current = '';
  if (chat.length && chat[chat.length - 1].is_user) current = chat[chat.length - 1].mes || '';
  const gm = chat.filter((m) => !m.is_user).slice(-Math.max(1, s.historyCount));
  const hist = gm
    .map((m) => stripTagsFromText(stripCoT(m.mes || '', s.cotSeparator), tags).trim())
    .filter(Boolean)
    .join('\n\n---\n\n');
  return { hist, current };
}

/** 收集"已开启文字过滤且当前在用"的候选条目；返回候选 + 全量 byBook（供解析关联名） */
async function gatherCandidates() {
  const byBook = await inUseEntriesByBook();
  migrateFiltersToNames(byBook); // 旧 uid 键配置 → 名称键（幂等）
  const candidates = [];
  for (const [book, entries] of Object.entries(byBook)) {
    const nameToUid = new Map(entries.map((e) => [e.comment, e.uid])); // 名称 → 本次 live uid
    for (const e of entries) {
      const f = getFilter(book, e.comment);
      // 任何"启用+有条件"的条目都是候选（即便同时被别人关联，也可自主判定）
      if (f?.enabled && f.condition?.trim()) {
        // linked 存的是名称 → 解析成本次 live uid（供 hideSet/onEntriesLoaded 按 uid 匹配）；解析不到的忽略
        const linked = (f.linked || []).map((nm) => nameToUid.get(nm)).filter((u) => u !== undefined);
        candidates.push({ book, uid: e.uid, comment: e.comment || `(uid ${e.uid})`, condition: f.condition.trim(), linked });
      }
    }
  }
  return { candidates, byBook };
}

/** 拼装 flash 实际收到的消息（system + user）。currentInput 可传占位符用于预览。
 *  稳定前缀（提示词 + 候选条目）放 system、可变内容（剧情 + 本轮输入）放 user → 利于上下文缓存命中。 */
function buildRouterMessages(candidates, currentInput) {
  const s = settings();
  const { hist } = routerContext();
  const candText = candidates.length
    ? candidates.map((c, i) => `${i + 1}. ${c.comment} —— 启用条件：${c.condition}`).join('\n')
    : '（无：未配置任何文字过滤条目）';
  const system = `${s.prompt || DEFAULT_PROMPT}\n\n【候选条目】\n${candText}`;
  const user = `【最近剧情（最近 ${s.historyCount} 条 GM 回复）】\n${hist || '（无）'}\n\n【本轮玩家输入】\n${currentInput || '（无）'}`;
  return { system, user };
}

async function fetchModels(url, key) {
  const base = url.replace(/\/+$/, '');
  const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data?.data || data?.models || []).map((m) => m.id || m.name).filter(Boolean);
}

/** candidates: [{book, uid, comment, condition}] → 返回应"启用"的下标集合(1-based) */
async function callFlashRouter(candidates) {
  const s = settings();
  const { url, key, model } = s.api;
  if (!url || !key || !model) throw new Error('flash API 未配置');
  const { system, user } = buildRouterMessages(candidates, routerContext().current);
  const cacheKey = `${system} ${user}`;
  lastRouteCached = false;
  lastRouteHash = hashStr(cacheKey);

  // 命中缓存：提示词逐字节相同（重生成/swipe/回退同输入）→ 直接复用，不再调 flash
  if (s.cacheSize > 0 && routeCache.has(cacheKey)) {
    const cached = routeCache.get(cacheKey);
    routeCache.delete(cacheKey);
    routeCache.set(cacheKey, cached); // 提为最近使用
    lastRouteCached = true;
    return new Set(cached);
  }

  const base = url.replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const txt = data?.choices?.[0]?.message?.content || '';
  const m = txt.match(/\{[\s\S]*\}/);
  const obj = m ? JSON.parse(m[0]) : { 启用: [] };
  const keepArr = [...new Set((obj.启用 || []).map(Number))];

  if (s.cacheSize > 0) {
    routeCache.set(cacheKey, keepArr);
    while (routeCache.size > s.cacheSize) routeCache.delete(routeCache.keys().next().value); // 淘汰最旧
  }
  return new Set(keepArr);
}

/**
 * 把本回合路由结果写入 chat 变量，供角色卡（EJS `getvar('...')` 或宏 `{{getvar::...}}`）读取。
 * 均为 JSON 数组字符串：
 * - 路由命中规则：flash 直接命中开启的候选
 * - 路由关联规则：被命中源关联而开启的被动条目
 * - 路由隐藏规则：本回合被隐藏/关闭的条目 ← 卡侧应据此判断"被隐藏才不插入"（常驻/未设条件的规则不在此列，故照常显示）
 * - 路由激活规则：命中 + 关联（因路由而开的全部；保留兼容）
 * 未路由/未配置/失败时全部写空数组 []（＝没有任何条目被隐藏 → 卡侧显示全部）。
 */
function setRouteVars(kept, linked, hidden) {
  // 取实时 chatMetadata（ST 换聊天时会重建该对象，start() 缓存的 ctx.chatMetadata 会过期）
  const cm = SillyTavern.getContext().chatMetadata;
  if (!cm) return;
  cm.variables = cm.variables || {};
  cm.variables['路由命中规则'] = JSON.stringify(kept || []);
  cm.variables['路由关联规则'] = JSON.stringify(linked || []);
  cm.variables['路由隐藏规则'] = JSON.stringify(hidden || []);
  cm.variables['路由激活规则'] = JSON.stringify([...(kept || []), ...(linked || [])]);
}

// ============ 运行时 ============
/**
 * 给定应"启用"的候选下标集合 keep（1-based），计算命中/关联/隐藏，写入 hideSet + 路由变量 + 本层记录。
 * flash 路由与手动预览共用这段下游逻辑（关联触发、被动隐藏、统计完全一致）。
 * meta: { cached?, hash?, manual? } 仅用于本层记录标注来源。
 */
function applyRouting(keep, candidates, byBook, meta) {
  const nameOf = (book, uid) => (byBook[book] || []).find((e) => String(e.uid) === String(uid))?.comment || `#${uid}`;
  const onUids = new Set();
  const keptNames = [];
  const linkedNames = [];
  // 命中的条目
  candidates.forEach((c, i) => {
    if (keep.has(i + 1)) {
      onUids.add(`${c.book}::${c.uid}`);
      keptNames.push(c.comment);
    }
  });
  // 关联触发：命中条目强制拉起其 linked 条目
  candidates.forEach((c, i) => {
    if (!keep.has(i + 1)) return;
    for (const luid of c.linked || []) {
      const key = `${c.book}::${luid}`;
      if (!onUids.has(key)) {
        onUids.add(key);
        linkedNames.push(nameOf(c.book, luid));
      }
    }
  });
  // 被动（被关联）条目默认隐藏，仅被命中源拉起时才保留
  const targetKeys = new Set();
  const targetInfo = new Map(); // key -> {book, uid}
  candidates.forEach((c) =>
    (c.linked || []).forEach((luid) => {
      const key = `${c.book}::${luid}`;
      targetKeys.add(key);
      targetInfo.set(key, { book: c.book, uid: luid });
    }),
  );
  // hideSet = (候选 ∪ 被动条目) 中最终不保留的
  const hiddenNames = [];
  candidates.forEach((c) => {
    const key = `${c.book}::${c.uid}`;
    if (!onUids.has(key) && !hideSet.has(key)) {
      hideSet.add(key);
      hiddenNames.push(c.comment);
    }
  });
  targetKeys.forEach((key) => {
    // 条目可能同时是候选与被关联目标，已计入则跳过（避免重复计数/重复名）
    if (!onUids.has(key) && !hideSet.has(key)) {
      hideSet.add(key);
      const info = targetInfo.get(key);
      hiddenNames.push(nameOf(info.book, info.uid));
    }
  });
  const statLine = `候选 ${candidates.length}，命中 ${keptNames.length}，关联 ${linkedNames.length}，隐藏 ${hideSet.size}`;
  // 记录本次路由，稍后挂到即将收到的 AI 楼层
  pendingRoute = { statLine, kept: keptNames, linked: linkedNames, hidden: hiddenNames, cached: !!meta?.cached, hash: meta?.hash || '', manual: !!meta?.manual };
  // 写入路由结果（命中/关联/隐藏），供角色卡 COT 条件拼装
  setRouteVars(keptNames, linkedNames, hiddenNames);
  return { statLine, keptNames, linkedNames, hiddenNames };
}

// 事件参数：(type, options, dryRun)。
// dryRun=令牌重算/提示词预览（如删楼、改楼后其它扩展的后台重算）；quiet=后台生成（总结等）；impersonate=替玩家代写。
// 这些都不是"玩家推进正文"，不应路由，也不应改动 hideSet（以免打断正在进行的真实生成）。
// 注意：酒馆助手「提示词查看器」刷新时发的是非 dryRun 的 normal 生成，故此处照常运行——查看器即可显示"路由后"的提示词。
async function onBeforeGeneration(type, _options, dryRun) {
  if (dryRun || type === 'quiet' || type === 'impersonate') return;
  hideSet = new Set();
  pendingRoute = null;
  const s = settings();
  if (!s.enabled) return setRouteVars([], [], []); // 总开关关闭 → 不路由（无隐藏 → 卡侧显示全部）

  const { candidates, byBook } = await gatherCandidates();
  if (!candidates.length) return setRouteVars([], [], []);

  // —— 手动预览模式：跳过 flash，所见即所得（勾选=激活，未勾选=隐藏；无视关联，不需要 API）——
  // manualHidden 存的是"未勾选(隐藏)"的 book::名称。配合「提示词查看器」刷新即可预览该状态下的最终提示词。
  if (s.manualMode) {
    const hiddenKeys = new Set(s.manualHidden || []);
    const keptNames = [];
    const hiddenNames = [];
    candidates.forEach((c) => {
      if (hiddenKeys.has(`${c.book}::${c.comment}`)) {
        hideSet.add(`${c.book}::${c.uid}`); // 未勾选 → 本次扫描隐藏该条目
        hiddenNames.push(c.comment);
      } else {
        keptNames.push(c.comment); // 勾选 → 激活（无视关联，不拉起任何被动条目）
      }
    });
    const statLine = `候选 ${candidates.length}，激活 ${keptNames.length}，隐藏 ${hiddenNames.length}（手动·无视关联）`;
    pendingRoute = { statLine, kept: keptNames, linked: [], hidden: hiddenNames, cached: false, hash: '', manual: true };
    setRouteVars(keptNames, [], hiddenNames);
    toast().success(`手动预览：${statLine}（到提示词查看器点刷新查看）`, '🔧 规则路由·手动模式', { timeOut: 4000 });
    console.log(`[规则路由·手动] ${statLine}`);
    return;
  }

  if (!s.api.url || !s.api.key || !s.api.model) return setRouteVars([], [], []);

  const t0 = toast().info('正在判断世界书条目开关', '🧭 规则路由', { timeOut: 0, extendedTimeOut: 0 });
  try {
    const keep = await callFlashRouter(candidates);
    const r = applyRouting(keep, candidates, byBook, { cached: lastRouteCached, hash: lastRouteHash });
    clearToast(t0);
    const stats = `[规则路由] ${r.statLine}`;
    const msg = lastRouteCached ? `世界书开关使用缓存结果：${stats}（缓存命中）` : stats;
    toast().success(msg, '🧭 规则路由', { timeOut: 4500 });
    console.log(lastRouteCached ? `${msg}` : stats);
  } catch (e) {
    clearToast(t0);
    toast().warning('路由失败，本回合规则照常', '🧭 规则路由', { timeOut: 4000 });
    console.warn('[规则路由] flash 路由失败，本回合不隐藏任何条目:', e);
    hideSet = new Set();
    setRouteVars([], [], []); // 失败 → 无隐藏 → 卡侧显示全部
  }
}

function onEntriesLoaded(payload) {
  if (!hideSet.size) return;
  let hidden = 0;
  for (const list of [payload?.globalLore, payload?.characterLore, payload?.chatLore, payload?.personaLore]) {
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

// ============ UI ============
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function pickJsonFile() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', () => {
      const file = inp.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(reader.result));
        } catch {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
    inp.click();
  });
}

let lastByBook = {};

/** 渲染某条目的关联芯片（可点 × 移除）。linked 存的是条目名称。 */
function renderLinkChips(span, book, name) {
  span.innerHTML = '';
  const linked = getFilter(book, name)?.linked || [];
  if (!linked.length) {
    span.append(el('<span class="crr-hint">（无）</span>'));
    return;
  }
  for (const lname of linked) {
    const chip = el('<span class="crr-chip"></span>');
    chip.append(document.createTextNode(lname));
    const x = el('<i class="fa-solid fa-xmark crr-chip-x" title="移除关联"></i>');
    x.addEventListener('click', () => {
      const f = getFilter(book, name) || {};
      f.linked = (f.linked || []).filter((u) => String(u) !== String(lname));
      setFilter(book, name, f);
      persist();
      renderLinkChips(span, book, name);
    });
    chip.append(x);
    span.append(chip);
  }
}

/** 关联选择器：带搜索的勾选列表（同一世界书其他条目），返回是否有改动 */
async function openLinkPicker(book, srcName, srcComment) {
  const entries = (lastByBook[book] || [])
    .filter((e) => e.comment !== srcName)
    .sort((a, b) => (a.comment || '').localeCompare(b.comment || '', 'zh')); // 按名称排序，[ 开头的聚在一起
  const cur = new Set((getFilter(book, srcName)?.linked || []).map(String)); // linked 存的是名称
  const dlg = el(`
    <div class="crr-link-dlg">
      <div class="crr-head">关联触发条目</div>
      <div class="crr-hint">当「${escapeHtml(srcComment || '')}」被启用时，下列勾选的条目也一并强制启用。</div>
      <input type="search" class="crr-link-search text_pole" placeholder="搜索条目…" />
      <div class="crr-link-list"></div>
    </div>`);
  const listEl = dlg.querySelector('.crr-link-list');
  const search = dlg.querySelector('.crr-link-search');
  const render = (qq = '') => {
    const q = qq.trim().toLowerCase();
    listEl.innerHTML = '';
    entries
      .filter((e) => !q || (e.comment || '').toLowerCase().includes(q))
      .forEach((e) => {
        const r = el('<label class="crr-exp-row"><input type="checkbox" class="crr-link-chk" /> <span></span></label>');
        const c = r.querySelector('input');
        c.dataset.name = String(e.comment);
        c.checked = cur.has(String(e.comment));
        c.addEventListener('change', () => {
          if (c.checked) cur.add(String(e.comment));
          else cur.delete(String(e.comment));
        });
        r.querySelector('span').textContent = e.comment || `#${e.uid}`;
        listEl.append(r);
      });
  };
  search.addEventListener('input', () => render(search.value));
  render();
  const ok = await ctx.callGenericPopup(dlg, ctx.POPUP_TYPE.CONFIRM, '', { okButton: '确定', cancelButton: '取消', wide: true, large: true });
  if (!ok) return false;
  const f = getFilter(book, srcName) || { enabled: true, condition: '', comment: srcComment };
  f.linked = [...cur];
  setFilter(book, srcName, f);
  persist();
  return true;
}

function renderFilterList(container, query = '') {
  const q = query.trim().toLowerCase();
  container.innerHTML = '';
  const books = Object.keys(lastByBook);
  if (!books.length) {
    container.innerHTML = '<div class="crr-hint">未检测到使用中的世界书（请先选中角色卡，再点刷新）。</div>';
    return;
  }
  const rerender = () => renderFilterList(container, query);
  let shown = 0;
  for (const book of books) {
    const entries = lastByBook[book]
      .filter((e) => !q || (e.comment || '').toLowerCase().includes(q))
      .sort((a, b) => (a.comment || '').localeCompare(b.comment || '', 'zh')); // 按名称排序
    if (!entries.length) continue;
    const enabledCount = lastByBook[book].filter((e) => getFilter(book, e.comment)?.enabled).length;
    const group = el(
      `<div class="crr-book"><div class="crr-book-title">📖 ${escapeHtml(book)} <span class="crr-count">${entries.length}/${lastByBook[book].length} · 已过滤 ${enabledCount}</span></div></div>`,
    );
    for (const e of entries) {
      shown++;
      const name = escapeHtml(e.comment || '(无标题 uid ' + e.uid + ')');
      const lamp = e.constant ? '蓝·常驻' : e.disable ? '关' : '绿·关键词';
      const linkedBy = sourceNamesForTarget(book, e.comment); // 被哪些启用源关联（仅信息提示；条目仍可自设条件独立触发）

      const f = getFilter(book, e.comment);
      const on = !!f?.enabled;
      const row = el(`
        <div class="crr-entry${on ? ' crr-on' : ''}">
          <label class="crr-entry-head">
            <input type="checkbox" class="crr-chk"${on ? ' checked' : ''} />
            <span class="crr-entry-name">${name}</span>
            <span class="crr-lamp">${lamp}</span>
          </label>
          <textarea class="crr-cond text_pole" rows="2" placeholder="启用条件（flash 据此判断本条是否打开）：如 进入战斗/交手时"${on ? '' : ' style="display:none"'}></textarea>
          <div class="crr-linkrow"${on ? '' : ' style="display:none"'}>
            <span class="crr-link-label">关联触发：</span>
            <span class="crr-link-chips"></span>
            <div class="menu_button crr-btn crr-link-add"><i class="fa-solid fa-link"></i> 关联</div>
          </div>
          ${linkedBy.length ? `<div class="crr-linked-by"><i class="fa-solid fa-arrow-down-long"></i> 被 ${escapeHtml(linkedBy.join('、'))} 关联触发（被触发时开启；也可勾选上方自设独立条件）</div>` : ''}
        </div>`);
      const chk = row.querySelector('.crr-chk');
      const cond = row.querySelector('.crr-cond');
      const chipsEl = row.querySelector('.crr-link-chips');
      cond.value = f?.condition || '';
      const save = () => {
        const prev = getFilter(book, e.comment) || {};
        setFilter(book, e.comment, { enabled: chk.checked, condition: cond.value, comment: e.comment, linked: prev.linked || [] });
        persist();
      };
      chk.addEventListener('change', () => {
        save();
        rerender(); // 启停可能改变其它条目的被动状态
      });
      cond.addEventListener('input', save);
      renderLinkChips(chipsEl, book, e.comment);
      row.querySelector('.crr-link-add').addEventListener('click', async () => {
        if (await openLinkPicker(book, e.comment, e.comment)) rerender(); // 关联变化 → 整表重渲染（被动状态更新）
      });
      group.append(row);
    }
    container.append(group);
  }
  if (!shown) container.append(el(`<div class="crr-hint">没有匹配「${escapeHtml(query)}」的条目。</div>`));
}

async function refreshList(container, searchInput) {
  container.innerHTML = '<div class="crr-hint">读取使用中的世界书…</div>';
  lastByBook = await inUseEntriesByBook();
  migrateFiltersToNames(lastByBook); // 旧 uid 键配置 → 名称键（幂等）
  renderFilterList(container, searchInput?.value || '');
}

function showPreview(system, user, candCount) {
  const wrap = el(`
    <div class="crr-preview-wrap">
      <div class="crr-head">flash 实际收到的提示词预览</div>
      <div class="crr-pv-label">System（路由提示词 + 候选条目 · 每轮稳定，利于缓存）</div>
      <textarea class="crr-pv text_pole" readonly rows="8"></textarea>
      <div class="crr-pv-label">User（最近剧情 + 本轮玩家输入 · 每轮变化）</div>
      <textarea class="crr-pv text_pole" readonly rows="16"></textarea>
      <div class="crr-hint">「本轮玩家输入」处的 <code>Here_is_Participant_input</code> 为占位符，实际发送时替换为你这一轮的输入。${candCount ? '' : '（当前没有开启文字过滤的条目，候选为空。）'}</div>
    </div>`);
  const tas = wrap.querySelectorAll('.crr-pv');
  tas[0].value = system;
  tas[1].value = user;
  ctx.callGenericPopup(wrap, ctx.POPUP_TYPE.DISPLAY, '', { wide: true, large: true, okButton: '关闭', allowVerticalScrolling: true });
}

// ============ 逐层路由记录 + 楼层查看按钮 ============
/** 新 AI 楼层收到时，把本次路由记录挂到它的 extra 上 */
async function onMessageReceived(mesId) {
  if (!pendingRoute) return;
  const idx = Number(mesId);
  const msg = ctx.chat?.[idx];
  if (!msg || msg.is_user) return; // 只挂到 AI 回复楼层
  msg.extra = msg.extra || {};
  msg.extra.crr_route = pendingRoute;
  pendingRoute = null;
  try {
    await ctx.saveChat();
  } catch (e) {
    /* ignore */
  }
}

function fmtRecord(r) {
  const line = (label, arr) => `${label}：${arr && arr.length ? arr.join('、') : '（无）'}`;
  return [
    `统计：${r.statLine || '（无）'}`,
    line('命中开启', r.kept),
    line('关联开启', r.linked),
    line('隐藏', r.hidden),
    `本次来源：${r.manual ? '手动预览（未调用 flash）' : r.cached ? '缓存复用（未调用 flash）' : 'flash 实时判定'}`,
  ].join('\n');
}

function openFloorPanel(mesid) {
  const idx = Number(mesid);
  const msg = ctx.chat?.[idx];
  const isUser = !!msg?.is_user;
  const wrap = el('<div class="crr-floor-panel"><div class="crr-head"></div><div class="crr-floor-body"></div></div>');
  const head = wrap.querySelector('.crr-head');
  const body = wrap.querySelector('.crr-floor-body');

  if (isUser) {
    head.textContent = `本层路由缓存 · 玩家楼层 #${idx}`;
    const next = ctx.chat?.[idx + 1];
    const rec = next && !next.is_user ? next.extra?.crr_route : null;
    if (!rec) {
      body.innerHTML = '<div class="crr-hint">本层暂无路由记录（尚未生成回复，或该回复无记录）。</div>';
    } else {
      const status = el('<div class="crr-floor-status"></div>');
      const pre = el('<pre class="crr-floor-pre"></pre>');
      pre.textContent = fmtRecord(rec);
      const clearBtn = el('<div class="menu_button crr-btn"><i class="fa-solid fa-trash-can"></i> 清除本层缓存</div>');
      const refresh = () => {
        const has = rec.hash && cacheHasHash(rec.hash);
        status.innerHTML = `缓存状态：${has ? '<b>已缓存</b>（本会话内可复用，避免重复调用 flash）' : '未缓存（已过期 / 已清除 / 重载后丢失）'}`;
        clearBtn.style.display = has ? '' : 'none';
      };
      clearBtn.addEventListener('click', () => {
        cacheDeleteByHash(rec.hash);
        toast().success('已清除本层缓存', '🧭 规则路由', { timeOut: 2500 });
        refresh();
      });
      body.append(status, pre, clearBtn);
      refresh();
    }
  } else {
    head.textContent = `本层路由情况 · AI 回复楼层 #${idx}`;
    const rec = msg?.extra?.crr_route;
    if (!rec) {
      body.innerHTML = '<div class="crr-hint">本层无路由记录（导入的旧楼层，或本轮未运行路由）。</div>';
    } else {
      const pre = el('<pre class="crr-floor-pre"></pre>');
      pre.textContent = fmtRecord(rec);
      body.append(pre);
    }
  }
  ctx.callGenericPopup(wrap, ctx.POPUP_TYPE.DISPLAY, '', { okButton: '关闭', allowVerticalScrolling: true });
}

function addFloorButton(mesEl) {
  if (!mesEl) return;
  const extra = mesEl.querySelector('.extraMesButtons');
  if (!extra || extra.querySelector('.crr_floor_btn')) return;
  const btn = document.createElement('div');
  btn.className = 'mes_button crr_floor_btn fa-solid fa-route interactable';
  btn.title = '规则路由 · 本层路由/缓存';
  btn.tabIndex = 0;
  btn.setAttribute('role', 'button');
  btn.addEventListener('click', () => openFloorPanel(mesEl.getAttribute('mesid')));
  extra.prepend(btn);
}
function addFloorButtonById(mesId) {
  addFloorButton(document.querySelector(`#chat .mes[mesid="${mesId}"]`));
}
function addFloorButtonsToAll() {
  document.querySelectorAll('#chat .mes').forEach(addFloorButton);
}

async function openConfig() {
  const s = settings();
  const root = el(`
    <div class="crr-config">
      <div class="crr-head">
        <span>规则路由 · 配置</span>
        <div class="crr-inline crr-right">
          <div class="menu_button crr-icon crr-import" title="导入配置"><i class="fa-solid fa-file-import"></i></div>
          <div class="menu_button crr-icon crr-export" title="导出配置（不含 API Key）"><i class="fa-solid fa-file-export"></i></div>
          <label class="crr-master" title="关闭后本插件不再路由，所有规则按 ST 原样">
            <input type="checkbox" class="crr-enabled" /> 启用插件
          </label>
        </div>
      </div>

      <div class="crr-section crr-manual-sec">
        <div class="crr-sec-title"><i class="fa-solid fa-flask-vial"></i> <span>手动预览模式</span>
          <label class="crr-master crr-right" title="开启后跳过 flash，用下方名单强制隐藏，供提示词查看器预览">
            <input type="checkbox" class="crr-manual-toggle" /> 启用手动
          </label>
        </div>
        <div class="crr-hint">开启后<b>跳过 flash</b>：下方<b>打勾=激活，不勾=隐藏</b>（所见即所得，<b>无视关联触发</b>）。被隐藏的条目写入 <code>路由隐藏规则</code>。到酒馆助手「提示词查看器」点刷新 <i class="fa-solid fa-rotate-right"></i> 即可看到该状态下的最终提示词。<b>用完请手动关闭</b>（此模式持久生效，会一直跳过 flash）。</div>
        <div class="crr-inline">
          <div class="menu_button crr-btn crr-manual-none" title="全部勾选=全部激活">全部激活</div>
          <div class="menu_button crr-btn crr-manual-all" title="全部取消=全部隐藏">全部隐藏</div>
          <div class="menu_button crr-btn crr-manual-refresh"><i class="fa-solid fa-arrows-rotate"></i> 刷新名单</div>
        </div>
        <div class="crr-manual-list"></div>
      </div>

      <div class="crr-section">
        <div class="crr-sec-title"><i class="fa-solid fa-plug"></i> flash 路由模型</div>
        <div class="crr-grid">
          <label class="crr-lbl">接口地址</label>
          <input type="text" class="crr-url text_pole" placeholder="https://api.deepseek.com/v1" />
          <label class="crr-lbl">API Key</label>
          <input type="password" class="crr-key text_pole" placeholder="sk-..." />
          <label class="crr-lbl">模型</label>
          <div class="crr-inline">
            <select class="crr-model text_pole"></select>
            <div class="menu_button crr-btn crr-fetch"><i class="fa-solid fa-rotate"></i> 获取模型</div>
          </div>
        </div>
        <div class="crr-api-msg crr-hint"></div>
      </div>

      <div class="crr-section">
        <div class="crr-sec-title"><i class="fa-solid fa-pen"></i> <span>路由提示词（给 flash 的 system）</span>
          <div class="crr-inline crr-right">
            <div class="menu_button crr-btn crr-preview-btn"><i class="fa-solid fa-eye"></i> 预览</div>
            <div class="menu_button crr-btn crr-restore" title="恢复默认提示词">恢复默认</div>
          </div>
        </div>
        <textarea class="crr-prompt text_pole" rows="5"></textarea>
        <div class="crr-hint">候选条目（编号 + 启用条件）自动拼在本提示词后构成 system（稳定、利于缓存）；用户消息含最近剧情与本轮输入。模型须输出 <code>{"启用":[编号,...]}</code>。</div>
      </div>

      <div class="crr-section">
        <div class="crr-sec-title"><i class="fa-solid fa-sliders"></i> <span>上下文设置</span></div>
        <div class="crr-grid">
          <label class="crr-lbl">思维链分隔符</label>
          <input type="text" class="crr-cot text_pole" placeholder="&lt;/think&gt;" />
          <div class="crr-hint crr-grid-hint">分隔符之前的内容视作思维链、不送入 flash（默认 <code>&lt;/think&gt;</code>）。</div>

          <label class="crr-lbl">最近 GM 回复条数</label>
          <input type="number" class="crr-histn text_pole" min="1" max="50" />
          <div class="crr-hint crr-grid-hint">仅收录最近 N 条 GM 回复（玩家历史输入不进，只保留本轮输入）；不再截断字数。</div>

          <label class="crr-lbl">标签剔除</label>
          <input type="text" class="crr-striptags text_pole" placeholder="如 think,StatusPlaceHolderImpl（逗号分隔，可留空）" />
          <div class="crr-hint crr-grid-hint">把 GM 回复里 <code>&lt;标签&gt;…&lt;/标签&gt;</code> 整段删除（逗号分隔多个，可留空）。</div>

          <label class="crr-lbl">结果缓存条数</label>
          <div class="crr-inline">
            <input type="number" class="crr-cache text_pole" min="0" max="100" title="0=关闭" />
            <div class="menu_button crr-btn crr-cache-clear"><i class="fa-solid fa-trash-can"></i> 清除缓存</div>
          </div>
          <div class="crr-hint crr-grid-hint">请求提示词逐字节相同（重生成 / swipe / 回退同输入）时复用旧结果、不再调用 flash（0=关闭）。点「清除缓存」立即丢弃当前缓存。</div>
        </div>
      </div>

      <div class="crr-section crr-flex1">
        <div class="crr-sec-title"><i class="fa-solid fa-filter"></i> 规则过滤
          <div class="crr-inline crr-right">
            <input type="search" class="crr-search text_pole" placeholder="搜索条目…" />
            <div class="menu_button crr-btn crr-refresh"><i class="fa-solid fa-arrows-rotate"></i> 刷新</div>
          </div>
        </div>
        <div class="crr-list"></div>
      </div>
    </div>
  `);

  const enabledChk = root.querySelector('.crr-enabled');
  const cotIn = root.querySelector('.crr-cot');
  const histIn = root.querySelector('.crr-histn');
  const tagIn = root.querySelector('.crr-striptags');
  const cacheIn = root.querySelector('.crr-cache');
  const urlIn = root.querySelector('.crr-url');
  const keyIn = root.querySelector('.crr-key');
  const modelSel = root.querySelector('.crr-model');
  const promptIn = root.querySelector('.crr-prompt');
  const apiMsg = root.querySelector('.crr-api-msg');
  const list = root.querySelector('.crr-list');
  const search = root.querySelector('.crr-search');

  enabledChk.checked = s.enabled;
  enabledChk.addEventListener('change', () => {
    s.enabled = enabledChk.checked;
    persist();
    root.classList.toggle('crr-disabled', !s.enabled);
  });
  root.classList.toggle('crr-disabled', !s.enabled);

  // —— 手动预览模式 ——
  const manualToggle = root.querySelector('.crr-manual-toggle');
  const manualList = root.querySelector('.crr-manual-list');
  manualToggle.checked = s.manualMode;
  root.classList.toggle('crr-manual-on', s.manualMode);
  manualToggle.addEventListener('change', () => {
    s.manualMode = manualToggle.checked;
    persist();
    root.classList.toggle('crr-manual-on', s.manualMode);
  });
  async function renderManualList() {
    manualList.innerHTML = '<div class="crr-hint">读取候选条目…</div>';
    const { candidates } = await gatherCandidates();
    // 清理已失效的隐藏键（条目/条件被删后不再是候选）
    const validKeys = new Set(candidates.map((c) => `${c.book}::${c.comment}`));
    const cleaned = (s.manualHidden || []).filter((k) => validKeys.has(k));
    if (cleaned.length !== (s.manualHidden || []).length) {
      s.manualHidden = cleaned;
      persist();
    }
    const hidden = new Set(cleaned);
    manualList.innerHTML = '';
    if (!candidates.length) {
      manualList.innerHTML = '<div class="crr-hint">没有已配置文字过滤的候选条目。请先在下方「规则过滤」里给条目开启过滤并填写启用条件。</div>';
      return;
    }
    candidates
      .slice()
      .sort((a, b) => (a.book || '').localeCompare(b.book || '', 'zh') || (a.comment || '').localeCompare(b.comment || '', 'zh'))
      .forEach((c) => {
        const key = `${c.book}::${c.comment}`;
        const row = el('<label class="crr-exp-row crr-manual-row"><input type="checkbox" class="crr-manual-chk" /> <span class="crr-manual-name"></span> <span class="crr-manual-book crr-hint"></span></label>');
        const chk = row.querySelector('input');
        chk.checked = !hidden.has(key); // 勾选=激活；未勾选=隐藏（在 manualHidden 里）
        chk.addEventListener('change', () => {
          const set = new Set(s.manualHidden || []);
          if (chk.checked) set.delete(key); // 勾上=激活 → 移出隐藏名单
          else set.add(key); // 取消=隐藏 → 加入隐藏名单
          s.manualHidden = [...set];
          persist();
        });
        row.querySelector('.crr-manual-name').textContent = c.comment;
        row.querySelector('.crr-manual-book').textContent = c.book;
        manualList.append(row);
      });
  }
  root.querySelector('.crr-manual-refresh').addEventListener('click', renderManualList);
  root.querySelector('.crr-manual-all').addEventListener('click', async () => {
    const { candidates } = await gatherCandidates();
    s.manualHidden = candidates.map((c) => `${c.book}::${c.comment}`);
    persist();
    renderManualList();
  });
  root.querySelector('.crr-manual-none').addEventListener('click', () => {
    s.manualHidden = [];
    persist();
    renderManualList();
  });
  renderManualList();

  cotIn.value = s.cotSeparator;
  histIn.value = s.historyCount;
  tagIn.value = s.stripTags;
  cotIn.addEventListener('input', () => {
    s.cotSeparator = cotIn.value;
    persist();
  });
  histIn.addEventListener('input', () => {
    const n = parseInt(histIn.value, 10);
    if (n >= 1) {
      s.historyCount = n;
      persist();
    }
  });
  tagIn.addEventListener('input', () => {
    s.stripTags = tagIn.value;
    persist();
  });
  cacheIn.value = s.cacheSize;
  cacheIn.addEventListener('input', () => {
    const n = parseInt(cacheIn.value, 10);
    if (n >= 0) {
      s.cacheSize = n;
      while (routeCache.size > n) routeCache.delete(routeCache.keys().next().value);
      persist();
    }
  });
  root.querySelector('.crr-cache-clear').addEventListener('click', () => {
    routeCache.clear();
    toast().success('已清空 flash 结果缓存', '🧭 规则路由', { timeOut: 2500 });
  });

  urlIn.value = s.api.url || '';
  keyIn.value = s.api.key || '';
  promptIn.value = s.prompt || DEFAULT_PROMPT;
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
  promptIn.addEventListener('input', () => {
    s.prompt = promptIn.value;
    persist();
  });
  root.querySelector('.crr-restore').addEventListener('click', () => {
    promptIn.value = DEFAULT_PROMPT;
    s.prompt = DEFAULT_PROMPT;
    persist();
  });

  root.querySelector('.crr-preview-btn').addEventListener('click', async () => {
    s.prompt = promptIn.value; // 用当前（可能未失焦）的提示词
    const { candidates } = await gatherCandidates();
    const { system, user } = buildRouterMessages(candidates, 'Here_is_Participant_input');
    showPreview(system, user, candidates.length);
  });

  // —— 导出（绝不含 API Key）——
  root.querySelector('.crr-export').addEventListener('click', async () => {
    const books = Object.keys(s.filters || {}).filter((b) => Object.keys(s.filters[b] || {}).length);
    const dlg = el(`
      <div class="crr-export-dlg">
        <div class="crr-head">导出配置</div>
        <label class="crr-exp-row"><input type="checkbox" class="crr-exp-global" checked /> 全局设置（提示词 / 分隔符 / 条数 / 标签剔除 / 接口与模型，<b>不含 API Key</b>）</label>
        <div class="crr-pv-label">世界书过滤配置（多选）</div>
        <div class="crr-exp-books"></div>
      </div>`);
    const booksWrap = dlg.querySelector('.crr-exp-books');
    if (books.length) {
      books.forEach((b) => {
        const r = el('<label class="crr-exp-row"><input type="checkbox" class="crr-exp-book" checked /> <span></span></label>');
        r.querySelector('input').dataset.book = b;
        r.querySelector('span').textContent = `${b}（${Object.keys(s.filters[b]).length} 条）`;
        booksWrap.append(r);
      });
    } else {
      booksWrap.append(el('<div class="crr-hint">（暂无已配置过滤的世界书）</div>'));
    }
    const ok = await ctx.callGenericPopup(dlg, ctx.POPUP_TYPE.CONFIRM, '', { okButton: '导出', cancelButton: '取消' });
    if (!ok) return;
    const out = { __crr_export: true, version: '0.6.0' };
    if (dlg.querySelector('.crr-exp-global').checked) {
      out.global = {
        prompt: s.prompt,
        enabled: s.enabled,
        cotSeparator: s.cotSeparator,
        historyCount: s.historyCount,
        stripTags: s.stripTags,
        api: { url: s.api.url, model: s.api.model }, // 不含 key
      };
    }
    const selBooks = [...dlg.querySelectorAll('.crr-exp-book')].filter((c) => c.checked).map((c) => c.dataset.book);
    if (selBooks.length) {
      out.filters = {};
      selBooks.forEach((b) => (out.filters[b] = s.filters[b]));
    }
    downloadJson(out, 'cultivation-rule-router-config.json');
    toast().success('已导出配置文件（不含 API Key）', '🧭 规则路由', { timeOut: 3500 });
  });

  // —— 导入（保留现有 API Key 不被覆盖）——
  root.querySelector('.crr-import').addEventListener('click', async () => {
    const data = await pickJsonFile();
    if (!data || !data.__crr_export) {
      toast().warning('不是有效的规则路由配置文件', '🧭 规则路由');
      return;
    }
    if (data.global) {
      const g = data.global;
      if (typeof g.prompt === 'string') s.prompt = g.prompt;
      if (typeof g.enabled === 'boolean') s.enabled = g.enabled;
      if (typeof g.cotSeparator === 'string') s.cotSeparator = g.cotSeparator;
      if (typeof g.historyCount === 'number') s.historyCount = g.historyCount;
      if (typeof g.stripTags === 'string') s.stripTags = g.stripTags;
      if (g.api) {
        if (typeof g.api.url === 'string') s.api.url = g.api.url;
        if (typeof g.api.model === 'string') s.api.model = g.api.model;
      } // 不动 s.api.key
    }
    if (data.filters) {
      for (const [b, f] of Object.entries(data.filters)) s.filters[b] = { ...(s.filters[b] || {}), ...f };
    }
    persist();
    // 刷新界面字段
    enabledChk.checked = s.enabled;
    root.classList.toggle('crr-disabled', !s.enabled);
    cotIn.value = s.cotSeparator;
    histIn.value = s.historyCount;
    tagIn.value = s.stripTags;
    urlIn.value = s.api.url || '';
    promptIn.value = s.prompt || DEFAULT_PROMPT;
    if (s.api.model && ![...modelSel.options].some((o) => o.value === s.api.model)) {
      modelSel.append(el(`<option value="${escapeHtml(s.api.model)}" selected>${escapeHtml(s.api.model)}</option>`));
    }
    if (s.api.model) modelSel.value = s.api.model;
    refreshList(list, search);
    toast().success('配置已导入', '🧭 规则路由');
  });

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

  root.querySelector('.crr-refresh').addEventListener('click', () => refreshList(list, search));
  search.addEventListener('input', () => renderFilterList(list, search.value));

  refreshList(list, search); // 打开即刷新

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
      <div id="crr_wand" class="list-group-item flex-container flexGap5 interactable" title="规则路由配置" tabindex="0">
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
  // 逐层路由记录 + 楼层查看按钮
  ctx.eventSource.on(ET.MESSAGE_RECEIVED, onMessageReceived);
  ctx.eventSource.on(ET.USER_MESSAGE_RENDERED, addFloorButtonById);
  ctx.eventSource.on(ET.CHARACTER_MESSAGE_RENDERED, addFloorButtonById);
  ctx.eventSource.on(ET.MESSAGE_UPDATED, addFloorButtonById);
  if (ET.CHAT_CHANGED) ctx.eventSource.on(ET.CHAT_CHANGED, () => setTimeout(addFloorButtonsToAll, 300));
  setTimeout(addFloorButtonsToAll, 1500);
  addWandMenuItem();
  setTimeout(addWandMenuItem, 1500);
  console.log('[规则路由] v0.11.3 已加载 ✓');
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
