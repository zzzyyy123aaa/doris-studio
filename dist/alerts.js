const rules = [
  {key: 'feOffline', label: 'FE 离线节点数', unit: '台', min: 1, step: '1', hint: '需要可确认的 FE 在线状态'},
  {key: 'beOffline', label: 'BE 离线节点数', unit: '台', min: 1, step: '1', hint: '按可确认的 BE 在线状态计算'},
  {key: 'cpuPercent', label: 'CPU 使用率', unit: '%', min: 0, max: 100, step: 'any', hint: 'BE 主机'},
  {key: 'memoryPercent', label: '内存使用率', unit: '%', min: 0, max: 100, step: 'any', hint: 'FE 主机，可能仅为当前 FE'},
  {key: 'diskPercent', label: 'BE 数据盘最高使用率', unit: '%', min: 0, max: 100, step: 'any', hint: '采样到的数据盘中最高的文件系统使用率'},
  {key: 'qps', label: '查询吞吐量', unit: 'QPS', min: 0, step: 'any', hint: '可能仅为当前 FE'},
  {key: 'latencyMs', label: '平均查询耗时', unit: 'ms', min: 0, step: 'any', hint: '采样估算，可能仅为当前 FE'},
];
const deliveryLabels = {alert: '告警', recovery: '恢复通知', test: '测试消息'};
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character]);

function formatTime(value) {
  const date = new Date(value);
  return typeof value === 'string' && Number.isFinite(date.getTime()) ? `${dateFormat.format(date)}（北京时间）` : '';
}

function fieldValue(value) {
  return Number.isFinite(value) ? value : '';
}

export function alertFields(config, status, tag) {
  const thresholds = rules.map(rule => `<label class="alert-rule">
    <span class="alert-rule-copy"><strong>${rule.label}</strong><small>${rule.hint}</small></span>
    <span class="alert-value"><input class="input" type="number" name="${rule.key}" min="${rule.min}"${rule.max?` max="${rule.max}"`:''} step="${rule.step}" value="${fieldValue(config.thresholds?.[rule.key])}" placeholder="关闭" aria-label="${rule.label}阈值（${rule.unit}）"><span>${rule.unit}</span></span>
  </label>`).join('');
  return `<div class="alerts-delivery-column">
    <form id="alerts-form" method="post" autocomplete="off" class="card alerts-rules">
      <div class="card-head"><div><h2>当前数据源的告警规则</h2><p class="subtitle">指标达到阈值时触发，留空关闭该项。</p></div><label class="alert-switch"><input type="checkbox" name="enabled"${config.enabled?' checked':''}> 启用告警</label></div>
        <div class="alerts-card-body">
          <div class="alert-rule-list">${thresholds}</div>
          <div class="alert-timing">
            <label class="field"><span>连续达标采样次数</span><input class="input" type="number" name="consecutiveSamples" min="1" max="20" step="1" value="${fieldValue(config.consecutiveSamples)}" required><small>连续达到阈值后发送。</small></label>
            <label class="field"><span>告警冷却（分钟）</span><input class="input" type="number" name="cooldownMinutes" min="1" max="1440" step="1" value="${fieldValue(config.cooldownMinutes)}" required><small>同一规则再次触发时，两次告警的最短间隔。</small></label>
          </div>
          <label class="alert-switch"><input type="checkbox" name="notifyRecovery"${config.notifyRecovery?' checked':''}> 恢复后发送通知</label>
          <p class="notice-strip alert-note">只有可用于判断的采样才更新状态。指标缺失或覆盖不完整时，既有告警不会因此恢复。</p>
          <div class="alert-form-footer"><p class="alert-feedback" id="alerts-feedback" role="status"></p><button class="button primary" type="submit">保存告警规则</button></div>
        </div>
    </form>
    <section class="card" id="alerts-delivery">${alertDelivery(status, tag)}</section>
  </div>`;
}

export function webhookFields(config, {httpWarning, tag, busy = false, feedback = '', failed = false}) {
  const webhookBadge = config.webhookConfigured ? (config.globalConfigured ? tag('已配置','green') : tag('可沿用','purple')) : tag('未配置','');
  const secretBadge = config.secretConfigured ? tag('已配置','green') : tag('未配置','');
  const migration = config.legacyConflict ? '无法自动沿用旧机器人。请输入要供所有数据源使用的 Webhook 地址。'
    : config.legacyConfigured && config.webhookConfigured ? '可沿用已保存的机器人，点「保存全局机器人」后应用到所有数据源。'
    : config.legacyConfigured ? '已有数据源保存了机器人。保存全局机器人后，所有数据源将使用该机器人。'
    : config.globalConfigured && !config.webhookConfigured ? '飞书通知已暂停。保存 Webhook 后恢复发送。' : '';
  const testTarget = config.legacyConfigured && config.webhookConfigured && !config.globalConfigured ? '可沿用的已保存机器人' : '已保存的全局机器人';
  return `<form class="card" id="alert-webhook-form" method="post" autocomplete="off">
    <div class="card-head"><div><h2>全局飞书机器人</h2><p class="subtitle">配置一次，供所有数据源发送告警。</p></div>${webhookBadge}</div>
    <div class="alerts-card-body">
      ${migration?`<p class="notice-strip alert-migration-note">${migration}</p>`:''}
      <label class="field"><span>Webhook 地址</span><input class="input" name="webhook" type="password" autocomplete="new-password" maxlength="2048" placeholder="${config.webhookConfigured?'留空保留已保存地址':'https://open.feishu.cn/open-apis/bot/v2/hook/…'}"${config.legacyConflict?' required':''} spellcheck="false"></label>
      <label class="alert-switch alert-clear"${config.webhookConfigured?'':' hidden'}><input type="checkbox" name="clearWebhook"> 清除全局地址和签名密钥</label>
      <label class="field alert-secret"><span>签名密钥（可选） ${secretBadge}</span><input class="input" name="secret" type="password" autocomplete="new-password" maxlength="256" placeholder="${config.secretConfigured?'留空保留已保存密钥':'机器人启用签名校验时填写'}" spellcheck="false"></label>
      <label class="alert-switch alert-clear"${config.secretConfigured?'':' hidden'}><input type="checkbox" name="clearSecret"> 清除全局签名密钥</label>
      ${httpWarning?'<p class="notice-strip alert-http-note">当前通过 HTTP 访问，填写的 Webhook 和签名密钥会经内网明文传输。</p>':''}
      <div class="alert-webhook-actions"><button class="button primary" type="submit"${busy?' disabled':''}>保存全局机器人</button><button class="button" type="button" data-action="test-alert-webhook"${config.webhookConfigured&&!busy?'':' disabled'}>发送测试消息</button></div>
      <p class="alert-detail">测试消息会发送到${testTarget}所在飞书群。</p>
      <p class="alert-feedback${failed?' red':''}" id="alert-webhook-feedback" role="status">${escape(feedback)}</p>
      <div id="alert-webhook-delivery" class="alert-webhook-delivery">${webhookDelivery(config.lastDelivery, tag)}</div>
    </div>
  </form>`;
}

function deliveryResult(last, tag, empty) {
  const date = formatTime(last?.at);
  return last ? `<div class="alert-delivery-row"><strong>${escape(Object.hasOwn(deliveryLabels, last.kind) ? deliveryLabels[last.kind] : '通知')}</strong>${last.ok===true?tag('发送成功','green'):tag('发送失败','red')}</div>
    ${date?`<small class="alert-detail">${date}</small>`:''}${last.message?`<p class="alert-detail">${escape(last.message)}</p>`:''}` : `<p class="alert-detail">${empty}</p>`;
}

export function webhookDelivery(last, tag) {
  return `<h3 class="alert-section-title">最近一次测试</h3>${deliveryResult(last, tag, '暂无测试记录。')}`;
}

export function alertDelivery(status, tag) {
  const active = Array.isArray(status?.active) ? status.active : [];
  const last = status?.lastDelivery?.kind === 'test' ? null : status?.lastDelivery;
  const delivery = deliveryResult(last, tag, '暂无发送记录。');
  const activeRules = active.length ? `<ul class="alert-active-list">${active.map(item => {
    const rule = rules.find(candidate => candidate.key === item?.key);
    const since = formatTime(item?.since);
    return `<li><div class="alert-delivery-row"><strong>${escape(rule?.label || item?.key || '告警')}</strong>${item?.notified?tag('已通知','orange'):tag('待通知','')}</div>${since?`<small class="alert-detail">${since}触发</small>`:''}</li>`;
  }).join('')}</ul>` : '<p class="alert-detail">当前无触发中的规则。</p>';
  return `<div class="card-head"><h2>通知与告警状态</h2><button class="button small quiet" type="button" data-action="refresh-alert-status">刷新状态</button></div><div class="alerts-card-body">
    <h3 class="alert-section-title">最近一次发送</h3>${delivery}
    <h3 class="alert-section-title alert-active-heading">当前告警</h3>${activeRules}
  </div>`;
}

export function readAlertForm(form) {
  const fields = new FormData(form);
  const thresholds = Object.fromEntries(rules.map(rule => {
    const value = fields.get(rule.key);
    if (value === '' || value === null) return [rule.key, null];
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || (rule.max && number > rule.max) || (rule.step === '1' && !Number.isSafeInteger(number))) {
      throw new Error(`${rule.label}阈值无效。填写有效的正数，或留空关闭。`);
    }
    return [rule.key, number];
  }));
  return {
    enabled: fields.has('enabled'),
    notifyRecovery: fields.has('notifyRecovery'),
    consecutiveSamples: Number(fields.get('consecutiveSamples')),
    cooldownMinutes: Number(fields.get('cooldownMinutes')),
    thresholds,
  };
}

export function readWebhookForm(form) {
  const fields = new FormData(form);
  const config = {};
  if (fields.has('clearWebhook')) config.webhook = null;
  else {
    const webhook = fields.get('webhook')?.trim();
    if (webhook) config.webhook = webhook;
    if (fields.has('clearSecret')) config.secret = null;
    else {
      const secret = fields.get('secret');
      if (secret) config.secret = secret;
    }
  }
  return config;
}
