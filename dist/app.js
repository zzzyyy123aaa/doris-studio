import {tables,nodes,initialHistory,initialJobs,defaultSql,evaluateSQL} from './data.js';
import {formatMetric,isMetric,monitoringRanges,renderMonitoringChart} from './monitoring-chart.js';
import {alertDelivery,alertFields,readAlertForm,readWebhookForm,webhookDelivery,webhookFields} from './alerts.js';

const paths={grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',code:'m8 5-6 7 6 7 m8-14 6 7-6 7 m-3-16-2 18',database:'M20 6c0 2.2-3.6 4-8 4S4 8.2 4 6s3.6-4 8-4 8 1.8 8 4Z M4 6v6c0 2.2 3.6 4 8 4s8-1.8 8-4V6 M4 12v6c0 2.2 3.6 4 8 4s8-1.8 8-4v-6',history:'M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2',tasks:'M8 4H5v17h14V4h-3 M8 2h8v5H8z M8 12h8 M8 16h5',settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',chevron:'m9 5 7 7-7 7',down:'m7 10 5 5 5-5',search:'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M9 21h6',help:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4 M12 17h.01',external:'M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7',plus:'M12 5v14 M5 12h14',refresh:'M20 7A9 9 0 0 0 4 5L2 8 M2 2v6h6 M4 17a9 9 0 0 0 16 2l2-3 M22 22v-6h-6',arrow:'M5 12h14 m-5-5 5 5-5 5',up:'m7 14 5-5 5 5 M12 9v10',trend:'m3 17 6-6 4 4 8-11 M15 4h6v6',activity:'M2 12h5l3-9 4 18 3-9h5',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l4 2',server:'M3 3h18v7H3z M3 14h18v7H3z M6 6.5h.01 M6 17.5h.01 M10 6.5h8 M10 17.5h8',check:'m5 12 4 4L19 6',shield:'m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z m-4 10 3 3 5-6',info:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 11v6 M12 7h.01',table:'M3 3h18v18H3z M3 9h18 M9 9v12 M3 15h18',play:'m7 3 14 9-14 9V3Z',pause:'M7 4v16 M17 4v16',download:'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',save:'M4 3h13l4 4v14H3V3h1 M7 3v6h9V3 M7 21v-8h10v8',close:'m6 6 12 12 M6 18 18 6',menu:'M4 6h16 M4 12h16 M4 18h16',folder:'M3 5h7l2 3h9v13H3V5Z',key:'M14 9a5 5 0 1 1-10 0 5 5 0 0 1 10 0 M12 13l9 9 M16 17l3-3',file:'M14 2H4v20h16V8l-6-6Z M14 2v6h6 M8 13h8 M8 17h6',copy:'M8 8h13v13H8z M16 8V3H3v13h5',logout:'M9 3H3v18h6 M9 12h12 m-5-5 5 5-5 5',book:'M3 3h8c1 0 1 2 1 2s0-2 1-2h8v17h-8c-1 0-1 2-1 2s0-2-1-2H3V3Z M12 5v17',spark:'m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7',filter:'M3 4h18l-7 8v7l-4 2v-9L3 4Z'};
const icon=(name,cls='')=>`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.grid}"/></svg>`;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem('doris-'+key))??fallback}catch{return fallback}};
const write=(key,value)=>{try{localStorage.setItem('doris-'+key,JSON.stringify(value))}catch{toast('浏览器存储不可用，本次更改仅在当前会话有效。')}};
const state={route:'overview',range:'24h',cluster:read('cluster','production'),sql:read('sql',defaultSql),db:'analytics',table:'analytics.orders',detailTab:'preview',result:null,error:null,running:false,history:read('history',initialHistory),saved:read('saved',[]),jobs:read('jobs',initialJobs),settings:read('settings',{name:'我的工作空间',pageSize:'20',refresh:false,notifications:true}),closed:new Set(),lastUpdate:'刚刚',historyFilter:'all',historySearch:''};
if(!Array.isArray(state.history))state.history=[...initialHistory];
if(!Array.isArray(state.jobs))state.jobs=[...initialJobs];
if(!Array.isArray(state.saved))state.saved=[];
let toastTimer,refreshTimer,modalReturnFocus;
const nav=[['overview','grid','集群概览'],['sql','code','SQL 工作台'],['data','database','数据管理'],['history','history','查询历史'],['tasks','tasks','任务中心'],['alerts','bell','告警配置'],['settings','settings','系统设置']];
const demoDatabases = ['analytics', 'warehouse', 'system'];
const liveSql = 'SELECT 1;';
const live = {
  enabled: false,
  checking: false,
  connected: false,
  checkRequest: null,
  queryRequest: null,
  database: '',
  version: '',
  error: '',
  catalogError: '',
  catalogLoaded: false,
  databases: [],
  tables: [],
  detail: null,
  cluster: null,
  clusterError: '',
  clusterRequest: null,
  monitoring: null,
  monitoringRange: '',
  monitoringRequest: null,
  monitoringError: '',
  connections: [],
  activeConnectionId: '',
  connectionsLoaded: false,
  connectionsError: '',
  storageError: '',
  connectionsRequest: null,
  connectionMutation: false,
};
const connectionWorkspaces = new Map();
const alerts = {data:null, error:'', request:null, operation:null};
const alertWebhook = {data:null, error:'', request:null, operation:null, feedback:'', failed:false};
let sourcesRevision = 0;
let initialized = false;
let tableSearch = '';
let monitoringTimer;
const visibleNav = () => nav.filter(([route]) => route !== (live.enabled ? 'tasks' : 'alerts'));
const currentTables = () => live.enabled ? live.tables : tables;
const currentDatabases = () => live.enabled ? live.databases : demoDatabases;
const tableKey = table => live.enabled ? JSON.stringify([table.db, table.name]) : `${table.db}.${table.name}`;
const selectedTable = () => currentTables().find(table => tableKey(table) === state.table);
const activeConnection = () => live.connections.find(connection => connection.id === live.activeConnectionId);
const clusterName=()=>live.enabled?(activeConnection()?.name || 'Doris 内网连接'):state.cluster==='production'?'Production Cluster':'Development Cluster';
const routeLink=(route,content,cls='')=>`<a href="#/${route}" class="${cls}" aria-label="${esc(content.replace(/<[^>]*>/g,''))}">${content}</a>`;
const button=(action,label,name='',cls='',disabled=false)=>`<button class="button ${cls}" data-action="${action}"${disabled?' disabled':''}>${name?icon(name):''}${label}</button>`;
const tag=(text,color='green')=>`<span class="tag ${color}"><i class="dot"></i>${text}</span>`;

async function fetchApi(path, {body, signal, timeout = 20000, method = body === undefined ? 'GET' : 'POST'} = {}) {
  const deadline = AbortSignal.timeout(timeout);
  const headers = {Accept: 'application/json'};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (path !== 'sources' && !path.startsWith('alerts/webhook') && live.activeConnectionId) headers['X-Doris-Source'] = live.activeConnectionId;
  const response = await fetch(`./api/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
  });
  const isJson = response.headers.get('content-type')?.toLowerCase().includes('application/json');
  if (!isJson) {
    if (path === 'status' && !live.enabled && (response.ok || response.status === 404)) return {mode: 'demo'};
    throw new Error('服务未返回有效数据，请检查内网服务是否已启动。');
  }
  const data = await response.json();
  if (path === 'status' && response.status === 404 && !live.enabled) return {mode: 'demo'};
  if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）。`);
  return data;
}

function describeError(error) {
  if (error.name === 'TimeoutError') return '请求超时，请检查服务和 Doris 连接后重试。';
  if (error instanceof TypeError) return '无法访问内网服务，请确认服务已启动且网络可达。';
  return error.message || '请求失败，请重试。';
}

function enableLive() {
  if (live.enabled) return;
  live.enabled = true;
  state.sql = liveSql;
  state.db = '';
  state.table = '';
  state.history = [];
  state.saved = [];
}

function sourceDescriptor(source) {
  if (typeof source?.id !== 'string' || !source.id || typeof source.name !== 'string') return null;
  return {
    id: source.id,
    name: source.name,
    host: typeof source.host === 'string' ? source.host : '',
    port: Number.isInteger(source.port) ? source.port : null,
    database: typeof source.database === 'string' ? source.database : '',
    managedBy: source.managedBy === 'environment' ? 'environment' : 'studio',
    tls: source.tls === true,
  };
}

function loadConnections() {
  if (live.connectionsRequest) return live.connectionsRequest;
  live.connectionsError = '';
  live.connectionsRequest = refreshConnections();
  renderConnectionViews();
  return live.connectionsRequest;
}

async function refreshConnections() {
  const revision = sourcesRevision;
  try {
    const data = await fetchApi('sources');
    if (revision !== sourcesRevision) return;
    if (!Array.isArray(data?.sources)) throw new Error('服务返回的连接列表格式有误。');
    live.connections = data.sources.map(sourceDescriptor).filter(Boolean);
    live.storageError = typeof data.storageError === 'string' ? data.storageError : '';
    if (!live.connectionsLoaded && !live.activeConnectionId) {
      const preferred = read('live-source-id', '');
      const found = live.connections.find(source => source.id === preferred);
      const defaultSource = live.connections.find(source => source.id === data.defaultId);
      live.activeConnectionId = (found || defaultSource || live.connections[0])?.id || '';
    }
    live.connectionsLoaded = true;
  } catch (error) {
    if (revision === sourcesRevision) live.connectionsError = describeError(error);
  } finally {
    live.connectionsRequest = null;
    renderConnectionViews();
  }
}

function applySource(source) {
  sourcesRevision += 1;
  const index = live.connections.findIndex(item => item.id === source.id);
  if (index === -1) live.connections.push(source);
  else live.connections[index] = source;
  live.connectionsLoaded = true;
  live.connectionsError = '';
  live.storageError = '';
  renderConnectionViews();
}

async function switchConnection(id, {dismiss = true} = {}) {
  const source = live.connections.find(item => item.id === id);
  if (!source || !live.enabled) return;
  if (dismiss) closeModal();
  if (source.id === live.activeConnectionId) return;

  if (live.activeConnectionId) {
    connectionWorkspaces.set(live.activeConnectionId, {
      sql: state.sql, db: state.db, history: state.history, saved: state.saved,
    });
  }
  live.checkRequest?.abort();
  live.checkRequest = null;
  live.queryRequest?.abort();
  live.queryRequest = null;
  resetAlerts();
  live.activeConnectionId = source.id;
  live.connected = false;
  live.database = '';
  live.version = '';
  live.databases = [];
  live.tables = [];
  const workspace = connectionWorkspaces.get(source.id) || {sql:liveSql, db:'', history:[], saved:[]};
  Object.assign(state, workspace, {table:'', detailTab:'preview', result:null, error:null, running:false, historySearch:'', historyFilter:'all'});
  state.closed.clear();
  tableSearch = '';
  write('live-source-id', source.id);
  await checkConnection();
}

async function checkConnection() {
  if (live.checkRequest) return;
  const request = new AbortController();
  live.checkRequest = request;
  live.checking = true;
  live.error = '';
  live.catalogError = '';
  live.catalogLoaded = false;
  live.detail?.controller.abort();
  live.detail = null;
  cancelClusterRequest();
  live.cluster = null;
  live.clusterError = '';
  stopMonitoring();
  live.monitoring = null;
  live.monitoringRange = '';
  live.monitoringError = '';
  if (initialized) layout();

  try {
    const options = {signal: request.signal, timeout: 12000};
    if (live.enabled && !live.connectionsLoaded) await loadConnections();
    if (live.checkRequest !== request) return;
    let status = await fetchApi('status', options);
    if (status?.mode === 'live' && !live.enabled) {
      enableLive();
      await loadConnections();
      if (live.checkRequest !== request) return;
      if (live.activeConnectionId && live.activeConnectionId !== status.sourceId) status = await fetchApi('status', options);
    }
    if (live.checkRequest !== request) return;
    if (status?.mode !== 'live') {
      if (live.enabled) throw new Error('内网服务未返回连接状态，请检查部署配置。');
      return;
    }
    enableLive();
    if (live.activeConnectionId && typeof status.sourceId === 'string' && status.sourceId !== live.activeConnectionId) {
      throw new Error('服务返回了不同的 Doris 连接，请刷新连接列表后重试。');
    }
    if (!live.activeConnectionId && typeof status.sourceId === 'string') live.activeConnectionId = status.sourceId;
    live.connected = status.connected === true;
    live.database = typeof status.database === 'string' ? status.database : '';
    live.version = typeof status.version === 'string' ? status.version : '';
    if (!live.connected) {
      live.error = status.error || 'Doris 连接未建立，请检查服务配置。';
      return;
    }
    initialized = true;
    state.route = routeFromHash();
    layout();
    await loadCatalog(request);
  } catch (error) {
    if (live.checkRequest !== request) return;
    enableLive();
    live.connected = false;
    live.error = describeError(error);
  } finally {
    if (live.checkRequest === request) {
      live.checkRequest = null;
      initialized = true;
      live.checking = false;
      if (live.enabled && !live.connected) {
        live.databases = [];
        live.tables = [];
      }
      state.route = routeFromHash();
      layout();
      resetRefresh();
    }
  }
}

async function loadCatalog(request) {
  try {
    const catalog = await fetchApi('tables', {signal: request.signal});
    if (live.checkRequest !== request) return;
    if (!Array.isArray(catalog?.databases) || !Array.isArray(catalog?.tables)) {
      throw new Error('服务返回的数据库列表格式有误。');
    }
    live.databases = catalog.databases.filter(db => typeof db === 'string' && db);
    live.tables = catalog.tables.filter(table => typeof table?.db === 'string' && typeof table?.name === 'string');
    if (!selectedTable()) state.table = live.tables.length ? tableKey(live.tables[0]) : '';
    live.catalogLoaded = true;
  } catch (error) {
    if (live.checkRequest !== request) return;
    live.databases = [];
    live.tables = [];
    live.catalogError = describeError(error);
  }
}

function routeFromHash() {
  const route = location.hash.replace('#/', '');
  return visibleNav().some(([key]) => key === route) ? route : 'overview';
}

function previewLimit() {
  const limit = Number(state.settings.pageSize);
  return [10, 20, 50].includes(limit) ? limit : 20;
}

function queryForTable(table) {
  if (!live.enabled) return `SELECT *\nFROM ${table.db}.${table.name}\nLIMIT 20;`;
  const quote = name => '`' + name.replace(/`/g, '``') + '`';
  return `SELECT *\nFROM ${quote(table.db)}.${quote(table.name)}\nLIMIT ${previewLimit()};`;
}

function layout(){
const title=nav.find(n=>n[0]===state.route)?.[2]||'集群概览';
const links = visibleNav();
const webhookPanel = state.route === 'alerts' ? document.getElementById('alert-webhook-content') : null;
const webhookFocus = webhookPanel?.contains?.(document.activeElement) ? document.activeElement : null;
document.title=`${title} · Doris Studio`;
document.getElementById('app').innerHTML=`
<aside class="sidebar" id="sidebar">
 <a href="#/overview" class="brand" aria-label="Doris Studio 首页"><img class="brand-mark" src="./favicon.svg" alt=""><div><div class="brand-name">doris<span style="font-weight:500;color:#8e86a0"> studio</span></div><div class="brand-sub">YOUR DATA, IN FOCUS</div></div></a>
 <button class="cluster-switch" data-action="cluster" aria-haspopup="dialog"${live.enabled?' aria-label="切换 Doris 连接"':''}><span class="cluster-symbol">${icon('database')}</span><span class="cluster-switch-copy"><strong id="active-connection-label" title="${esc(clusterName())}">${esc(clusterName())}</strong><small><i class="dot ${live.enabled && !live.connected ? 'red' : 'green'}"></i> ${live.enabled ? connectionLabel() : `${state.cluster==='production'?'生产环境':'开发环境'} · 演示集群`}</small></span>${icon('down')}</button>
 <div class="nav-label">WORKSPACE</div>
 <nav aria-label="工作空间导航">${links.slice(0,4).map(([r,i,t])=>routeLink(r,`${icon(i)}<span>${t}</span>`, `nav-item ${state.route===r?'active':''}`)).join('')}</nav>
 <div class="nav-label second">MANAGEMENT</div>
 <nav aria-label="管理导航">${links.slice(4).map(([r,i,t])=>routeLink(r,`${icon(i)}<span>${t}</span>${r==='tasks'?`<span class="nav-count">${state.jobs.filter(j=>j.status==='RUNNING').length}</span>`:''}`,`nav-item ${state.route===r?'active':''}`)).join('')}</nav>
 <div class="nav-spacer"></div>
 <div class="help-card">${icon('book')}<h4>让数据探索更简单</h4><p>从第一条 SQL 开始，<br>了解 Doris 的更多可能。</p><a href="https://doris.apache.org/zh-CN/docs/gettingStarted/quick-start/" target="_blank" rel="noopener noreferrer">探索 Doris 文档 ${icon('external')}</a></div>
 <a href="#/settings" class="sidebar-user"><div class="avatar">${live.enabled?'DS':'AD'}</div><div><strong>${live.enabled?'Doris Studio':'Admin'}</strong><small>${live.enabled?'内网工作空间':'工作空间管理员 · 演示'}</small></div>${icon('settings')}</a>
</aside><div class="mobile-mask" data-action="mobile-close"></div>
<div class="shell"><header class="topbar"><div class="flex gap8"><button class="icon-button hide-desktop" data-action="mobile" aria-label="打开导航">${icon('menu')}</button><div class="breadcrumb">${icon('grid')}<span>工作空间</span>${icon('chevron')}<span class="current">${title}</span></div></div><div class="top-actions"><button class="global-search" data-action="search">${icon('search')}<span>搜索数据库、表或功能…</span><kbd>⌘ K</kbd></button><span class="divider"></span><span class="demo-label">${live.enabled?'内网模式':'DEMO MODE'}</span><button class="icon-button" data-action="help" aria-label="使用帮助">${icon('help')}</button>${live.enabled?'':`<button class="icon-button" data-action="notifications" aria-label="通知">${icon('bell')}<i class="notification-dot"></i></button>`}<button class="avatar" data-action="profile" aria-label="工作空间设置">${live.enabled?'DS':'AD'}</button></div></header>
<main class="main page-enter" id="main">${renderPage()}</main></div>`;
document.querySelector('.global-search').setAttribute('aria-label','搜索数据库、表或功能');
document.querySelector('.breadcrumb>span').textContent=state.settings.name==='我的工作空间'?'工作空间':state.settings.name;
document.querySelector('.nav-item.active')?.setAttribute('aria-current','page');
if(state.route==='sql') updateLines();
if(state.route==='data') loadLiveDetail();
if(state.route==='overview') loadCluster();
else cancelClusterRequest();
syncMonitoring();
if (state.route === 'alerts') {
  if (webhookPanel) document.getElementById('alert-webhook-content')?.replaceWith?.(webhookPanel);
  webhookFocus?.focus({preventScroll:true});
  loadAlerts();
  loadAlertWebhook();
} else {
  resetAlerts();
  resetAlertWebhook();
}
}
function heading(eyebrow,title,desc,actions=''){return`<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${desc}</p></div><div class="heading-actions">${actions}</div></div>`}
function footer(){return`<footer class="footer"><span><i class="dot"></i>${live.enabled?'内网模式 · Doris 只读工作空间':'所有数据均为演示数据 · 未连接真实 Doris 集群'}</span><span>Doris Studio <span style="padding:0 6px">/</span> Made for data explorers</span></footer>`}
function renderPage(){return({overview:live.enabled?liveOverview:overviewPage,sql:sqlPage,data:live.enabled?liveDataPage:dataPage,history:historyPage,tasks:tasksPage,alerts:alertsPage,settings:live.enabled?liveSettings:settingsPage}[state.route]||overviewPage)()+footer()}

function connectionLabel() {
  if (live.checking) return '正在检查';
  if (live.connectionsLoaded && !live.activeConnectionId) return '未配置连接';
  return live.connected ? '已连接' : '连接失败';
}

function connectionButton() {
  return button('check-connection', live.checking ? '检查中…' : '测试连接', 'refresh', '', live.checking);
}

function liveOverview() {
  return `${heading('DORIS CONNECTION', '集群概览', '检查 Doris 连接、节点状态和可访问的库表。', `${connectionButton()}${routeLink('sql', icon('code')+'<span>SQL 工作台</span>', 'button primary')}`)}
    <section id="live-monitoring" aria-label="集群监控">${renderMonitoring()}</section>
    <div class="settings-grid">
      ${liveConnectionCard()}
      <section class="card"><div class="card-head"><h2>可访问的数据资源</h2>${routeLink('data','浏览库表 '+icon('arrow'),'text-button')}</div>
        <div class="settings-body">
          ${live.catalogError ? `<div class="notice-strip" role="alert">${esc(live.catalogError)}</div>` : ''}
          <div class="settings-row"><strong>数据库</strong><span class="num">${live.catalogLoaded ? live.databases.length : '—'}</span></div>
          <div class="settings-row"><strong>表和视图</strong><span class="num">${live.catalogLoaded ? live.tables.length : '—'}</span></div>
          ${live.catalogLoaded && !live.tables.length ? '<p class="notice-strip">当前账号暂无可浏览的表。可在工作台运行 <code>SELECT 1;</code> 验证查询。</p>' : ''}
        </div>
      </section>
    </div>
    <section class="live-nodes" id="live-nodes" aria-label="集群节点">${renderCluster()}</section>`;
}

function liveConnectionCard() {
  const tone = live.checking ? 'purple' : live.connected ? 'green' : 'red';
  return `<section class="card"><div class="card-head"><h2>当前连接</h2>${tag(connectionLabel(), tone)}</div>
    <div class="settings-body">
      <div class="settings-row"><strong>数据来源</strong><span class="sub connection-current-name" id="current-connection-label">${esc(activeConnection()?.name || (live.activeConnectionId ? 'Doris 内网连接' : '未选择连接'))}</span></div>
      <div class="settings-row"><strong>默认数据库</strong><span class="sub">${esc(live.database || '未指定')}</span></div>
      ${live.version ? `<div class="settings-row"><strong>版本</strong><span class="sub">${esc(live.version)}</span></div>` : ''}
      ${live.error ? `<div class="notice-strip" role="alert">${esc(live.error)}</div>` : ''}
    </div>
  </section>`;
}

function cancelClusterRequest() {
  live.clusterRequest?.abort();
  live.clusterRequest = null;
}

async function loadCluster(force = false) {
  if (!live.enabled || !live.connected || live.checking || state.route !== 'overview' || live.clusterRequest) return;
  if (!force && (live.cluster || live.clusterError)) return;

  const request = new AbortController();
  live.clusterRequest = request;
  live.clusterError = '';
  refreshCluster();
  try {
    const cluster = await fetchApi('cluster', {signal: request.signal});
    const groups = [cluster?.frontends, cluster?.backends];
    const valid = groups.every(group => Array.isArray(group?.nodes) && group.nodes.every(node => node && typeof node === 'object'));
    if (!valid) throw new Error('服务返回的节点状态格式有误。');
    if (live.clusterRequest === request) live.cluster = cluster;
  } catch (error) {
    if (live.clusterRequest !== request) return;
    live.cluster = null;
    live.clusterError = describeError(error);
  } finally {
    if (live.clusterRequest === request) {
      live.clusterRequest = null;
      refreshCluster();
    }
  }
}

function refreshCluster() {
  if (state.route !== 'overview') return;
  const section = document.getElementById('live-nodes');
  if (section) section.innerHTML = renderCluster();
  const card = document.getElementById('live-health-card');
  if (card) card.innerHTML = renderHealthMetric();
}

function renderCluster() {
  const pending = Boolean(live.clusterRequest);
  const refresh = button('refresh-nodes', pending ? '刷新中…' : '刷新节点', 'refresh', 'small', pending || live.checking || !live.connected);
  let body;
  if (live.cluster) {
    body = `${renderNodeGroup('FE', live.cluster.frontends)}${renderNodeGroup('BE', live.cluster.backends)}`;
  } else if (live.clusterError) {
    body = `<div class="error-box" role="alert">${esc(live.clusterError)}</div>`;
  } else {
    const message = live.connected || live.checking ? '正在读取节点状态…' : '连接 Doris 后可查看节点状态。';
    body = `<div class="empty" role="status">${esc(message)}</div>`;
  }
  return `<div class="card-head live-nodes-header"><div><h2>${icon('server')} 集群节点</h2>${renderClusterTimestamp(live.cluster?.sampledAt)}</div>${refresh}</div>
    <div class="live-node-groups" aria-busy="${pending}">${body}</div>`;
}

function renderClusterTimestamp(sampledAt) {
  if (typeof sampledAt !== 'string') return '';
  const sample = new Date(sampledAt);
  if (!Number.isFinite(sample.getTime())) return '';
  const label = sample.toLocaleString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false});
  return `<p class="subtitle">采样于 <time datetime="${esc(sampledAt)}">${esc(label)}</time>（北京时间）</p>`;
}

function nodePermissionLimited(group) {
  return group?.code === 'legacy-permission' || group?.code === 'permission';
}

function validNodeSummary(summary) {
  return Boolean(summary && [summary.online, summary.total, summary.unknown].every(value => Number.isSafeInteger(value) && value >= 0)
    && summary.online + summary.unknown <= summary.total);
}

function isBackendFallback(summary) {
  return ['fe-health', 'fe-metrics'].includes(summary?.source) && validNodeSummary(summary);
}

function isFeRegistration(summary) {
  return summary?.source === 'fe-metrics' && summary.online === null && Number.isSafeInteger(summary.total)
    && summary.total >= 0 && summary.unknown === summary.total;
}

function nodeMetricSource(summary) {
  return summary.source === 'fe-health' ? 'FE 健康接口' : 'FE 指标';
}

function renderNodeGroup(kind, group) {
  const isFrontend = kind === 'FE';
  const title = isFrontend ? '前端节点（FE）' : '后端节点（BE）';
  const online = group.nodes.filter(node => node.alive === true).length;
  const unknown = group.nodes.filter(node => node.alive !== true && node.alive !== false).length;
  const permissionLimited = nodePermissionLimited(group);
  const registration = isFrontend && isFeRegistration(group.summary) ? group.summary : null;
  const healthSummary = !isFrontend && isBackendFallback(group.summary) ? group.summary : null;
  const inferredBackends = !isFrontend && group.nodeSource === 'fe-metrics';
  const summary = group.error ? tag(permissionLimited?'权限受限':'读取失败',permissionLimited?'orange':'red')
    : healthSummary || registration || inferredBackends ? '' : group.nodes.length ? tag(`${online} / ${group.nodes.length} 在线`, online === group.nodes.length ? 'green' : 'purple') : tag('无节点记录','');
  const registrationBadge = registration ? tag(`已登记 ${registration.total} 个`, 'purple') : '';
  const healthBadge = healthSummary ? tag(`${healthSummary.online} / ${healthSummary.total} 在线`, healthSummary.online === healthSummary.total && healthSummary.total ? 'green' : 'purple') : '';
  const uncertain = !group.error && !inferredBackends && unknown ? tag(`${unknown} 个状态未知`, 'orange') : '';
  const columns = [isFrontend ? '节点地址（查询端口）' : '节点地址（心跳端口）', '状态', '角色', '最后心跳（北京时间）', '版本'];
  if (!isFrontend) columns.push('Tablet 数', '磁盘用量');

  let content;
  const provenance = healthSummary ? `<p class="live-node-provenance">在线数量来自${nodeMetricSource(healthSummary)}，仅统计 BE。</p>`
    : registration ? '<p class="live-node-provenance">登记数量来自 FE 指标，FE 在线状态未知。</p>' : '';
  if (group.error && permissionLimited) content = `<div class="notice-strip live-node-permission" role="status"><p>${esc(group.error)}</p>${provenance}</div>`;
  else if (group.error) content = `<div class="error-box" role="alert">${esc(group.error)}${provenance}</div>`;
  else if (registration || (healthSummary && !group.nodes.length)) content = `<div class="notice-strip live-node-permission">${provenance}</div>`;
  else if (inferredBackends) content = '';
  else if (!group.nodes.length) content = '<div class="empty">Doris 未返回此类节点。</div>';
  else {
    content = `<div class="table-scroll"><table class="data-table live-node-table" aria-label="${title}">
      <thead><tr>${columns.map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead>
      <tbody>${group.nodes.map(node=>renderNodeRow(node, isFrontend)).join('')}</tbody>
    </table></div>`;
  }
  const discovered = inferredBackends ? renderInferredBackends(group.nodes) : '';
  return `<section class="card"><div class="card-head"><h2>${title}</h2><div class="flex gap8 live-node-summary">${summary}${registrationBadge}${healthBadge}${uncertain}</div></div>${content}${discovered}</section>`;
}

function nodeEndpoint(node) {
  const host = typeof node.host === 'string' ? node.host : '';
  const hostWithBrackets = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return host && Number.isInteger(node.port) ? `${hostWithBrackets}:${node.port}` : host;
}

function renderInferredBackends(nodes) {
  const discovered = nodes.filter(node => nodeEndpoint(node));
  if (!discovered.length) return '';
  const hasTablets = discovered.some(node => node.tablets != null && node.tablets !== '');
  const rows = discovered.map(node => `<tr><td class="mono">${esc(nodeEndpoint(node))}</td>${hasTablets?`<td class="num">${esc(node.tablets ?? '—')}</td>`:''}<td><span class="tag">未提供</span></td></tr>`);
  return `<div class="table-scroll"><table class="data-table live-node-table" aria-label="从 FE 指标发现的 BE 地址">
      <thead><tr><th scope="col">节点地址（心跳端口）</th>${hasTablets?'<th scope="col">Tablet 数</th>':''}<th scope="col">逐节点心跳与状态</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>
      <p class="table-foot live-node-source-foot">地址来自 FE 指标，接口未提供逐节点心跳与在线状态。</p>`;
}

function renderNodeRow(node, isFrontend) {
  const endpoint = nodeEndpoint(node);
  const status = node.alive === true ? tag('在线') : node.alive === false ? tag('离线','red') : tag('未知','orange');
  const flag = isFrontend ? (node.joined === false ? tag('未加入','orange') : '') : (node.decommissioned === true ? tag('已标记下线','orange') : '');
  const role = node.leader === true && isFrontend ? `<span class="tag purple">主节点</span> ${esc(node.role || '')}` : esc(node.role || '—');
  return `<tr>
    <td><div class="node-name">${icon('server')}<div><strong class="mono">${esc(endpoint || node.id || '—')}</strong>${endpoint && node.id && node.id !== endpoint ? `<small>ID ${esc(node.id)}</small>` : ''}</div></div></td>
    <td><div class="live-node-status">${status}${flag}</div></td><td>${role}</td>
    <td class="mono">${esc(node.lastHeartbeat || '—')}</td>
    <td class="mono live-node-version" title="${esc(node.version || '')}">${esc(node.version || '—')}</td>
    ${isFrontend ? '' : `<td class="num">${esc(node.tablets ?? '—')}</td><td class="num">${renderNodeDisk(node)}</td>`}
  </tr>`;
}

function renderNodeDisk(node) {
  const percent = Number.isFinite(node.diskUsedPercent) ? `${node.diskUsedPercent.toFixed(1)}%` : '';
  const usage = node.diskUsed ? `Doris 数据 ${node.diskUsed}` : '';
  const capacity = [node.diskTotal && `磁盘总容量 ${node.diskTotal}`, percent && `磁盘已用 ${percent}`].filter(Boolean).join(' · ');
  if (!usage) return esc(capacity || '—');
  return `${esc(usage)}${capacity ? `<small class="live-disk-percent">${esc(capacity)}</small>` : ''}`;
}

function stopMonitoring() {
  clearInterval(monitoringTimer);
  monitoringTimer = undefined;
  live.monitoringRequest?.controller.abort();
  live.monitoringRequest = null;
}

function syncMonitoring() {
  if (!live.enabled || !live.connected || live.checking || state.route !== 'overview') {
    stopMonitoring();
    return;
  }
  if (!monitoringTimer) {
    loadMonitoring();
    monitoringTimer = setInterval(() => {
      if (document.visibilityState !== 'hidden') loadMonitoring();
    }, 30_000);
  }
}

async function loadMonitoring() {
  if (!live.enabled || !live.connected || live.checking || state.route !== 'overview') return;
  const range = state.range;
  if (live.monitoringRequest?.range === range) return;
  live.monitoringRequest?.controller.abort();
  const request = {range, controller: new AbortController()};
  live.monitoringRequest = request;
  live.monitoringError = '';
  refreshMonitoring();
  try {
    const data = await fetchApi(`monitoring?range=${range}`, {signal: request.controller.signal});
    if (live.monitoringRequest !== request) return;
    const validStatus = ['ok', 'partial', 'unavailable'].includes(data?.sourceStatus);
    if (!validStatus || !data.current || !Array.isArray(data.history)) throw new Error('服务返回的监控数据格式有误。');
    live.monitoring = data;
    live.monitoringRange = range;
  } catch (error) {
    if (live.monitoringRequest === request) live.monitoringError = describeError(error);
  } finally {
    if (live.monitoringRequest === request) {
      live.monitoringRequest = null;
      refreshMonitoring();
    }
  }
}

function refreshMonitoring() {
  if (state.route !== 'overview') return;
  const section = document.getElementById('live-monitoring');
  if (!section) return;
  const focused = document.activeElement;
  const range = focused?.dataset?.liveRange;
  const sample = focused?.id === 'live-chart-sample' ? focused.value : null;
  section.innerHTML = renderMonitoring();
  if (range && Object.hasOwn(monitoringRanges, range)) section.querySelector(`[data-live-range="${range}"]`)?.focus({preventScroll: true});
  if (sample !== null) {
    const picker = document.getElementById('live-chart-sample');
    if (picker) {
      picker.value = Math.min(Number(sample), Number(picker.max));
      updateLiveSample(picker.value);
      picker.focus({preventScroll: true});
    }
  }
}

function renderMonitoring() {
  const data = live.monitoring;
  const metrics = data?.current || {};
  const feOnly = data?.metricScope === 'connected-fe';
  const beHttp = backendHttpCollection(data);
  const pending = Boolean(live.monitoringRequest) || live.checking;
  const status = monitoringStatus(data, pending);
  const refresh = button('refresh-monitoring', pending?'采集中…':'刷新监控', 'refresh', 'small', pending || !live.connected);
  const storage = formatBytes(metrics.storageBytes);
  const waiting = pending ? '等待采样' : '当前不可用';
  const storageNote = isMetric(metrics.storageBytes) ? (beHttp?'已采集 BE 的 Doris 数据占用':'BE 的 Doris 数据占用')
    : feOnly && !pending ? 'BE 存储暂无采样' : waiting;
  return `<div class="live-monitor-bar">
      <div class="live-monitor-source">${tag(status.label, status.color)}${feOnly?tag('当前 FE','purple'):''}${data ? renderClusterTimestamp(data.sampledAt) : ''}${renderMonitoringCoverage(data?.coverage, beHttp, feOnly)}</div>${refresh}
    </div>
    ${status.message ? `<p class="notice-strip live-monitor-notice" role="status">${esc(status.message)}</p>` : ''}
    <div class="stats-grid">
      ${stat(feOnly?'查询吞吐量（当前 FE）':'查询吞吐量',formatMetric(metrics.qps),'QPS','activity','',`<span>${isMetric(metrics.qps)?'FE 查询速率':waiting}</span>`)}
      ${stat(feOnly?'平均查询耗时（当前 FE）':'平均查询耗时',formatMetric(metrics.latencyMs),'ms','clock','blue',`<span>${isMetric(metrics.latencyMs)?'采样估算':pending?'等待采样':'暂无可计算样本'}</span>`)}
      ${stat('数据存储量',storage.value,storage.unit,'database','orange',`<span>${storageNote}</span>`)}
      <div id="live-health-card" class="live-health-card">${renderHealthMetric()}</div>
    </div>
    <div class="charts-grid live-monitor-charts">${renderLiveTrend(data, pending, feOnly)}${renderLiveResources(metrics, feOnly, beHttp)}</div>`;
}

function monitoringStatus(data, pending) {
  if (live.monitoringError) return {label: '刷新失败', color: 'red', message: live.monitoringError};
  if (!data) return pending ? {label:'等待采样', color:'purple'} : {label:'等待连接', color:''};
  if (data.sourceStatus === 'unavailable') return {label:'监控不可用', color:'red', message:data.message || '当前未采集到 Doris 监控数据。'};
  if (data.sourceStatus === 'partial') return {label:'部分可用', color:'orange', message:data.message || '部分节点或指标暂无采样。'};
  return {label:'监控已采集', color:'green', message:data.message};
}

function backendHttpCollection(data) {
  const diagnostics = data?.beMetrics;
  if (!diagnostics && data?.metricScope !== 'connected-fe') return null;
  const validCounts = (reachable, total) => Number.isSafeInteger(reachable) && Number.isSafeInteger(total) && reachable >= 0 && total >= reachable;
  const counts = validCounts(diagnostics?.reachable, diagnostics?.total) ? diagnostics : {
    reachable: data?.coverage?.be, total: data?.coverage?.beTotal,
  };
  const valid = validCounts(counts.reachable, counts.total);
  return {
    reachable: valid ? counts.reachable : null,
    total: valid ? counts.total : null,
    port: Number.isInteger(diagnostics?.port) && diagnostics.port > 0 && diagnostics.port <= 65535 ? diagnostics.port : null,
    issue: typeof diagnostics?.issue === 'string' ? diagnostics.issue : '',
  };
}

function renderMonitoringCoverage(coverage, beHttp, feOnly) {
  if (beHttp) {
    const parts = [];
    if (!feOnly && isMetric(coverage?.fe) && isMetric(coverage?.feTotal) && coverage.feTotal > 0) parts.push(`FE 指标采集 ${coverage.fe}/${coverage.feTotal}`);
    if (beHttp.total > 0) parts.push(`BE HTTP 采集 ${beHttp.reachable}/${beHttp.total}`);
    return parts.length ? `<span class="live-monitor-coverage">${parts.join(' · ')}</span>` : '';
  }
  if (!coverage || ![coverage.fe, coverage.feTotal, coverage.be, coverage.beTotal].every(isMetric)) return '';
  const groups = [['FE', coverage.fe, coverage.feTotal], ['BE', coverage.be, coverage.beTotal]]
    .filter(([, , total]) => total > 0)
    .map(([kind, count, total]) => `${kind} ${count}/${total}`);
  return groups.length ? `<span class="live-monitor-coverage">指标采集覆盖 ${groups.join(' · ')}</span>` : '';
}

function formatBytes(bytes) {
  if (!isMetric(bytes)) return {value: '—', unit: ''};
  const units = ['B','KiB','MiB','GiB','TiB','PiB'];
  const index = bytes >= 1 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return {value: formatMetric(bytes / 1024 ** index), unit: units[index]};
}

function renderHealthMetric() {
  const cluster = live.cluster;
  const sample = live.monitoring;
  const fromCluster = group => {
    const summary = group?.summary;
    if (isBackendFallback(summary) || isFeRegistration(summary)) return summary;
    if (!group || group.error || group.nodeSource === 'fe-metrics') return null;
    return {
      total: group.nodes.length,
      online: group.nodes.filter(node => node.alive === true).length,
      unknown: group.nodes.filter(node => node.alive !== true && node.alive !== false).length,
    };
  };
  const useSample = sample?.health && (!cluster || Date.parse(sample.sampledAt) >= Date.parse(cluster.sampledAt));
  const groups = useSample ? [sample.health.fe, sample.health.be] : [fromCluster(cluster?.frontends), fromCluster(cluster?.backends)];
  const available = groups.every(validNodeSummary);
  const backendOnly = !available && isBackendFallback(groups[1]);
  const visibleGroups = available ? groups : backendOnly ? [groups[1]] : [];
  const total = visibleGroups.reduce((sum, group) => sum + group.total, 0);
  const online = visibleGroups.reduce((sum, group) => sum + group.online, 0);
  const unknown = groups.filter(validNodeSummary).reduce((sum, group) => sum + group.unknown, 0);
  const value = total || backendOnly ? `${online}<span class="live-health-total"> / ${total}</span>` : '—';
  const clusterNodeGroups = [cluster?.frontends, cluster?.backends];
  const labels = groups.map((group, index) => {
    const name = index === 0 ? 'FE' : 'BE';
    if (!validNodeSummary(group)) {
      const registration = isFeRegistration(group) ? group : cluster?.frontends?.summary;
      if (index === 0 && isFeRegistration(registration)) return `FE 已登记 ${registration.total}（在线未知）`;
      return `${name} ${nodePermissionLimited(clusterNodeGroups[index])?'权限受限':'暂无状态'}`;
    }
    return `${name} ${group.online}/${group.total}${isBackendFallback(group)?`（${nodeMetricSource(group)}）`:''}`;
  });
  const note = cluster || useSample ? `${labels.join(' · ')}${unknown?` · ${unknown} 个未知`:''}` : live.connected ? '等待读取心跳' : '等待连接';
  return stat(backendOnly?'在线节点（仅 BE）':'在线节点',value,'','server','green',`<span>${note}</span>`);
}

function renderLiveTrend(data, pending, feOnly) {
  const controls = Object.entries(monitoringRanges).map(([range, config]) => {
    const active = state.range === range;
    return `<button data-live-range="${range}" aria-pressed="${active}" class="${active?'active':''}">${config.label}</button>`;
  }).join('');
  const history = live.monitoringRange === state.range ? data?.history : null;
  const chart = history ? renderMonitoringChart(history, state.range, data.sampledAt) : '';
  const emptyMessage = pending ? '正在读取所选时段…' : live.monitoringError ? '未能读取所选时段，请重试。' : '此时段暂无有效采样，后台采集后将在此显示。';
  return `<section class="card live-monitor-trend"><div class="card-head"><div><h2>查询性能趋势${feOnly?'（当前 FE）':''}</h2><p class="subtitle">北京时间 · 采样缺口留空</p></div><div class="segmented" aria-label="图表时间范围">${controls}</div></div>
    <div class="chart-legend"><span><i class="legend-dot"></i>查询吞吐量（QPS）</span><span><i class="legend-dot teal"></i>查询耗时（采样估算）</span></div>
    ${chart || `<div class="empty live-monitor-empty" role="status">${icon('activity')}${!live.connected && !pending ? '连接 Doris 后可查看查询趋势。' : emptyMessage}</div>`}</section>`;
}

function renderLiveResources(metrics, feOnly, beHttp) {
  const showStorageDetail = !feOnly || [metrics.storageBytes, metrics.storageTotalBytes].some(isMetric);
  const rate = formatBytes(metrics.networkBytesPerSecond);
  const diagnostics = renderBackendMetricNote(metrics, beHttp);
  return `<section class="card"><div class="card-head"><h2>资源使用情况</h2></div><div class="resource-body live-monitor-resources${showStorageDetail?'':' live-monitor-compact-resources'}">
      ${showStorageDetail ? renderLiveStorage(metrics, beHttp) : '<div class="resource-row"><div class="between"><span>数据存储量（BE）</span><strong>—</strong></div></div>'}
      ${renderResourcePercent('CPU 使用率（BE 主机）',metrics.cpuPercent,'')}
      ${renderResourcePercent(feOnly ? '内存使用率（当前 FE）' : '内存使用率（FE 主机）',metrics.memoryPercent,'green')}
      <div class="resource-row"><div class="between"><span>网络收发（BE 主机）</span><strong>${rate.value}${rate.unit?` ${rate.unit}/s`:''}</strong></div></div>
      ${diagnostics}
    </div></section>`;
}

function renderLiveStorage(metrics, beHttp) {
  const used = formatBytes(metrics.storageBytes);
  const capacity = formatBytes(metrics.storageTotalBytes);
  const utilization = isMetric(metrics.storageBytes) && isMetric(metrics.storageTotalBytes) && metrics.storageTotalBytes > 0
    ? metrics.storageBytes / metrics.storageTotalBytes * 100 : null;
  const ring = isMetric(utilization) && utilization > 0 ? `<circle cx="56" cy="56" r="43" fill="none" stroke="#a88bd6" stroke-width="10" stroke-dasharray="${Math.min(100,utilization)*2.702} 270.2" stroke-linecap="round"/>` : '';
  const capacityLabel = beHttp ? '已采集 BE 的磁盘容量' : 'BE 磁盘总容量';
  return `<div class="resource-total"><div class="donut"><svg viewBox="0 0 112 112" aria-hidden="true"><circle cx="56" cy="56" r="43" fill="none" stroke="#f2edf9" stroke-width="10"/>${ring}</svg><div class="donut-center"><strong>${formatMetric(utilization)}${isMetric(utilization)?'<small>%</small>':''}</strong><span>数据占总容量</span></div></div>
    <div class="resource-info">Doris 数据占用<strong>${used.value} <small>${used.unit}</small></strong><span>${capacityLabel} ${capacity.value} ${capacity.unit}</span></div></div>`;
}

function renderBackendMetricNote(metrics, beHttp) {
  if (!beHttp) return '';
  const hasBeData = [metrics.storageBytes, metrics.storageTotalBytes, metrics.cpuPercent, metrics.networkBytesPerSecond].some(isMetric);
  const portLabel = beHttp.port ? `（${beHttp.port}）` : '';
  let hint = '';
  if (beHttp.total === 0) hint = '尚未发现可采集的 BE 地址。';
  else if (beHttp.reachable === 0) hint = `请检查 Studio 到 BE HTTP 监控端口${portLabel}的连通性。`;
  else if (beHttp.reachable !== null && beHttp.reachable < beHttp.total) hint = 'BE 资源值仅统计已采集的节点。';
  else if (!hasBeData) hint = 'BE 资源暂缺可用样本，CPU 和网络速率需要连续采样。';
  const message = beHttp.issue || hint;
  return message ? `<p class="notice-strip live-be-metrics-note">${esc(message)}</p>` : '';
}

function renderResourcePercent(label, value, color) {
  if (!isMetric(value)) return `<div class="resource-row"><div class="between"><span>${label}</span><strong>—</strong></div></div>`;
  return resource(label,`${formatMetric(value)}%`,Math.min(100,value),color);
}

function updateLiveSample(index) {
  if (!/^\d+$/.test(index)) return;
  const sample = document.querySelector(`[data-live-point="${index}"]`);
  const readout = document.getElementById('live-chart-sample-value');
  if (sample && readout) readout.textContent = liveSampleText(sample);
}

function liveSampleText(sample) {
  const {label, qps, latency} = sample.dataset;
  return `${label} · QPS ${qps} · ${latency === '—' ? '耗时 —' : `${latency} ms`}`;
}
const spark=(color,values)=>`<svg class="stat-spark" viewBox="0 0 60 20" aria-hidden="true"><path d="M0 ${values}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
function stat(title,value,unit,i,cls,bottom,sparkline=''){return`<div class="card stat-card"><div class="stat-top"><span>${title}</span><span class="stat-icon ${cls}">${icon(i)}</span></div><div class="stat-value">${value}<span class="unit">${unit}</span></div><div class="stat-footer">${bottom}${sparkline}</div></div>`}
function overviewPage(){const dev=state.cluster!=='production';return`
${heading('CLUSTER OVERVIEW','集群概览','每一次查询，每一份数据，尽在掌握。',`${button('refresh','刷新','refresh')}${routeLink('sql',icon('plus')+'<span>新建查询</span>','button primary')}`)}
<section class="banner"><div class="flex"><div class="banner-icon">${icon('shield')}</div><div><h2>一切就绪，开始今天的数据探索</h2><p>${clusterName()} 运行平稳，所有节点状态正常。</p></div></div><div class="banner-lines"></div><span class="healthy"><i class="dot"></i>集群健康</span></section>
<section class="stats-grid" aria-label="集群关键指标">
${stat('查询吞吐量',dev?'428':'1,284','QPS','activity','',`<span class="trend">${icon('trend')}12.8%</span><span>较昨日</span>`,spark('#ab90de','16 8 13 14 16 21 10 28 12 35 5 42 8 49 3 60 5'))}
${stat('平均查询耗时',dev?'98':'126','ms','clock','blue',`<span class="trend">↓ 8.2%</span><span>较昨日</span>`,spark('#9db4db','5 8 8 15 4 23 9 30 7 37 13 45 11 52 16 60 14'))}
${stat('数据存储量','128.4','GB','database','orange',`<span class="sub">3 个数据库</span><span style="color:#ddd5e8">·</span><span>6 张演示表</span>`,spark('#d7bb8c','17 9 17 17 13 25 14 33 10 40 10 48 6 60 3'))}
${stat('健康节点','5<span style="color:#b9b3c6;font-size:19px;font-weight:400"> / 5</span>','','server','green',`${tag('全部在线')}<span>2 FE + 3 BE</span>`)}
</section>
<section class="charts-grid"><div class="card"><div class="card-head"><div><h2>查询性能趋势 ${icon('info')}</h2><p class="subtitle">了解集群的查询负载与响应情况</p></div><div class="segmented" aria-label="图表时间范围">${[['24h','24 小时'],['7d','7 天'],['30d','30 天']].map(([v,t])=>`<button data-range="${v}" class="${state.range===v?'active':''}">${t}</button>`).join('')}</div></div><div class="chart-legend"><span><i class="legend-dot"></i>查询吞吐量（QPS）</span><span><i class="legend-dot teal"></i>查询延迟（ms）</span></div>${chart()}<div class="chart-summary"><span>平均 QPS<strong class="num">${state.range==='24h'?'1,126':state.range==='7d'?'1,082':'964'}</strong></span><span>峰值 QPS<strong class="num">1,846</strong></span><span>平均延迟<strong class="num">126 ms</strong></span></div></div>
<div class="card"><div class="card-head"><h2>资源使用情况</h2><span class="tag">集群总览</span></div><div class="resource-body"><div class="resource-total"><div class="donut"><svg viewBox="0 0 112 112" aria-hidden="true"><circle cx="56" cy="56" r="43" fill="none" stroke="#f2edf9" stroke-width="10"/><circle cx="56" cy="56" r="43" fill="none" stroke="#a88bd6" stroke-width="10" stroke-dasharray="173.6 270.2" stroke-linecap="round"/></svg><div class="donut-center"><strong>64.2<small>%</small></strong><span>存储使用率</span></div></div><div class="resource-info">已使用存储<strong>128.4 <small>GB</small></strong><span>总容量 200 GB</span></div></div>${resource('CPU 使用率','32.4%',32.4,'')}${resource('内存使用率','48.6%',48.6,'green')}${resource('网络带宽','24.8 MB/s',24.8,'blue')}<div class="resource-foot">${icon('info')}资源指标为演示快照 · 更新于 <span id="last-updated">${state.lastUpdate}</span></div></div></div></section>
<section class="bottom-grid"><div class="card"><div class="card-head"><h2>节点状态 <span class="tag">5</span></h2><button class="text-button" data-action="nodes">查看详情 ${icon('arrow')}</button></div><div class="table-scroll"><table class="data-table"><thead><tr><th>节点名称 / IP</th><th>角色</th><th>状态</th><th>CPU</th><th>内存</th></tr></thead><tbody>${nodes.map(n=>`<tr><td><div class="node-name">${icon('server')}<span><strong>${n.name}</strong><small class="mono">${n.ip}</small></span></div></td><td><span class="tag ${n.role.includes('Master')?'purple':''}">${n.role}</span></td><td>${tag('正常')}</td><td>${meter(n.cpu)}</td><td>${meter(n.memory)}</td></tr>`).join('')}</tbody></table></div><div class="table-foot"><span>共 5 个节点 · 所有心跳正常</span><span class="green flex gap8"><i class="dot"></i>100% 可用</span></div></div>
<div class="card"><div class="card-head"><h2>最近查询</h2>${routeLink('history','全部记录 '+icon('arrow'),'text-button')}</div><div class="query-list">${state.history.slice(0,4).map(h=>`<button class="query-item" data-query="${h.id}"><span class="query-status" ${h.status==='error'?'style="color:#d18b9e;background:#fff1f5"':''}>${icon(h.status==='error'?'close':'check')}</span><span class="query-text"><code>${esc(h.sql.replace(/\s+/g,' '))}</code><small>${esc(h.db)} <span style="padding:0 5px">·</span> ${esc(h.time.slice(-8))}</small></span><span class="query-time">${h.duration} ms</span></button>`).join('')}</div><div class="table-foot"><span>更高效地探索每一份数据</span>${routeLink('sql',icon('code')+'打开工作台','text-button')}</div></div></section>`}
function resource(name,label,value,color){return`<div class="resource-row"><div class="between"><span>${name}</span><strong>${label}</strong></div><div class="progress ${color}"><i style="width:${value}%"></i></div></div>`}
function meter(value){return`<div class="meter"><span><i style="width:${value}%"></i></span>${value}%</div>`}
function chart(){
 const base=[24,28,25,42,34,52,36,54,50,39,64,45,57,70,61,81,66,73,53,70,83,64,76,71];
 const vals=base.map((v,i)=>state.range==='7d'?Math.max(14,v-9+Math.sin(i*1.5)*16):state.range==='30d'?Math.max(12,v-18+Math.cos(i*1.8)*18):v);
 const coordinates=vals.map((v,i)=>[40+i*22.35,170-v*22.2/2000*152]);
 const line=coordinates.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
 const teal=vals.map((v,i)=>[40+i*22.35,170-(100+v*.37)/2000*152]).map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
 const labels=state.range==='24h'?['00:00','04:00','08:00','12:00','16:00','20:00','23:59']:state.range==='7d'?['10/23','10/24','10/25','10/26','10/27','10/28','10/29']:['09/30','10/05','10/10','10/15','10/20','10/25','10/29'];
 return`<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 575 205" preserveAspectRatio="none" role="img" aria-label="${state.range}查询性能演示折线图，悬停可查看数据"><defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b69be5" stop-opacity=".2"/><stop offset="1" stop-color="#b69be5" stop-opacity="0"/></linearGradient></defs>${[2000,1500,1000,500,0].map((v,i)=>`<line x1="40" y1="${18+i*38}" x2="554" y2="${18+i*38}" stroke="#efedf5" stroke-dasharray="3 4"/><text x="0" y="${21+i*38}" class="chart-label">${v.toLocaleString()}</text>`).join('')}<path d="${line} L554 170 L40 170 Z" fill="url(#chartFill)"/><path d="${line}" fill="none" stroke="#a387d3" stroke-width="2.1" stroke-linejoin="round"/><path d="${teal}" fill="none" stroke="#91c8bd" stroke-width="1.8" stroke-linejoin="round"/>${labels.map((l,i)=>`<text x="${40+i*85.7}" y="194" text-anchor="${i===0?'start':i===6?'end':'middle'}" class="chart-label">${l}</text>`).join('')}${coordinates.map(([x,y],i)=>`<rect class="chart-hit" x="${x-11}" y="10" width="22" height="165" data-chart="${i}" data-qps="${Math.round(vals[i]*22.2)}" data-latency="${Math.round(100+vals[i]*.37)}"/>`).join('')}</svg><div class="chart-tooltip" id="chart-tooltip"></div></div>`;
}
function explorer() {
  const count = currentDatabases().length;
  return `<aside class="card explorer"><div class="explorer-heading between"><span>数据资源</span><span class="tag">${count} DB</span></div>
    <div class="search-box"><input class="input" type="search" id="table-search" placeholder="搜索表名称…" aria-label="搜索表" value="${esc(tableSearch)}"></div>
    <div id="table-tree">${tree(tableSearch)}</div></aside>`;
}

function tree(filter = '') {
  if (live.enabled && !live.catalogLoaded) {
    if (live.error || live.catalogError) {
      return `<div class="empty"><p>${esc(live.error || live.catalogError)}</p>${connectionButton()}</div>`;
    }
    return '<div class="empty" role="status">正在加载库表…</div>';
  }
  if (live.enabled && !live.databases.length) return '<div class="empty">暂无可访问的数据库</div>';

  const term = filter.trim().toLowerCase();
  const groups = currentDatabases().map(db => {
    const matchesDatabase = live.enabled && db.toLowerCase().includes(term);
    const matchesTable = table => `${table.name} ${table.label || ''}`.toLowerCase().includes(term);
    const matchingTables = currentTables().filter(table => table.db === db && (matchesDatabase || matchesTable(table)));
    if (!matchingTables.length && (!live.enabled || !matchesDatabase)) return '';
    const collapsed = state.closed.has(db) && !term;
    const tableLinks = matchingTables.map(table => {
      const key = tableKey(table);
      return `<button class="tree-table ${state.table===key?'active':''}" data-table="${esc(key)}" title="${esc(table.name)}">${icon('table')}<span>${esc(table.name)}</span></button>`;
    });
    return `<button class="tree-db ${collapsed?'closed':''}" data-db="${esc(db)}" aria-expanded="${!collapsed}" title="${esc(db)}">${icon('down','chevron')}${icon('database')}<span>${esc(db)}</span><small class="muted">${matchingTables.length}</small></button>
      ${collapsed ? '' : tableLinks.join('') || '<p class="tree-empty">暂无可浏览的表</p>'}`;
  });
  return groups.join('') || '<div class="empty">没有匹配的数据表</div>';
}

function runButton() {
  return button('run', state.running ? '运行中…' : '运行查询', state.running ? 'refresh' : 'play', 'primary', state.running || (live.enabled && !live.connected));
}

function sqlPage() {
  const databaseNames = currentDatabases();
  const databases = databaseNames.map(db => `<option value="${esc(db)}" ${state.db===db?'selected':''}>${esc(db)}</option>`);
  if (live.enabled) {
    if (state.db && !databaseNames.includes(state.db)) databases.unshift(`<option value="${esc(state.db)}" selected>${esc(state.db)}（未在列表中）</option>`);
    databases.unshift(`<option value="" ${state.db?'':'selected'}>${live.database?'使用服务端默认库':'不指定数据库'}</option>`);
  }
  const connectionNotice = live.enabled && !live.connected ? `<div class="notice-strip" role="alert">${esc(live.error || '正在检查连接。')} ${connectionButton()}</div>` : '';
  const description = live.enabled ? '在 Doris 执行单条只读查询。新集群可运行 SELECT 1; 验证连接。' : '支持 SELECT、WHERE、ORDER BY、LIMIT、COUNT(*)、SHOW 和 DESC。所有查询在浏览器内执行，仅作用于示例数据。';

  return `${heading('SQL WORKSPACE','SQL 工作台','编辑、执行并导出查询结果。',button('saved','已保存查询','folder'))}
    <div class="workspace">${explorer()}<section>
      <div class="card"><div class="editor-head"><div class="editor-tabs"><div class="editor-tab">${icon('code')}查询 01 <span class="dot purple" title="当前查询"></span></div></div><button class="text-button" data-action="new-query">${icon('plus')}新建</button></div>
        <div class="editor-toolbar"><select class="select" id="sql-db" aria-label="查询数据库">${databases.join('')}</select>${runButton()}<span class="muted" style="font-size:9px">Ctrl ↵</span><div style="flex:1"></div>${live.enabled?'':button('format','格式化','code','small quiet')}${button('save-query','保存','save','small quiet')}</div>
        <div class="editor-area"><div class="line-numbers" id="line-numbers" aria-hidden="true"></div><textarea class="sql-textarea" id="sql-editor" aria-label="SQL 编辑器" spellcheck="false" autocapitalize="off">${esc(state.sql)}</textarea></div>
        <div class="editor-status"><span>${icon('database')} <span id="editor-connection-label">${esc(clusterName())}</span> <span style="margin:0 7px">/</span> ${esc(state.db || live.database || '未选数据库')}</span><span>${live.enabled?'只读查询':'演示引擎 · 查询基于有限样本数据'}</span></div>
      </div>
      <div class="card results" id="results" aria-live="polite">${resultPanel()}</div>
      ${connectionNotice}<div class="notice-strip">${icon('info')} ${description}</div>
    </section></div>`;
}

function resultPanel() {
  if (state.running) return `<div class="empty">${icon('refresh','spin')}正在执行${live.enabled?'':'示例'}查询…</div>`;
  if (state.error) return `<div class="result-head"><strong class="red">查询未执行成功</strong></div><div class="error-box">${esc(state.error)}</div>`;
  if (!state.result) return `<div class="result-head"><strong>查询结果</strong></div><div class="empty">${icon('code')}点击「运行查询」或按 Ctrl + Enter</div>`;
  const {columns, rows, duration, truncated} = state.result;
  return `<div class="result-head between"><div><strong>查询结果</strong><small><span class="green">执行成功</span> · ${rows.length} 行 · ${esc(duration)} ms</small></div>${button('export-result','导出 CSV','download','small quiet')}</div>
    ${dataTable(columns, rows)}<div class="table-foot"><span>共 ${rows.length} 行${live.enabled?'':'样本'}结果</span><span>${live.enabled ? (truncated?'达到行数上限，已截断结果':'') : '演示查询不代表真实集群性能'}</span></div>`;
}

function cellText(value) {
  if (value === null && live.enabled) return 'NULL';
  return value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
}

function isTabular(data) {
  return Array.isArray(data?.columns) && data.columns.every(name => typeof name === 'string')
    && Array.isArray(data.rows) && data.rows.every(row => row && typeof row === 'object' && !Array.isArray(row));
}

function dataTable(columns,rows){return`<div class="table-scroll"><table class="data-table"><thead><tr><th>#</th>${columns.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r,i)=>`<tr><td class="muted">${i+1}</td>${columns.map(c=>`<td>${esc(cellText(r[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table>${rows.length?'':'<div class="empty">查询成功，没有匹配的数据。</div>'}</div>`}
function dataPage(){const t=tables.find(t=>`${t.db}.${t.name}`===state.table)||tables[0];return`${heading('DATA EXPLORER','数据管理','从全局到细节，轻松浏览你的数据资产。',`${button('table-sql','查询此表','code','primary')}`)}<div class="workspace">${explorer()}<section class="card"><div class="table-detail-head">${icon('table')}<div><h2>${t.name}</h2><p>${t.db} <span style="padding:0 5px">/</span> ${t.label} <span style="padding:0 5px">·</span> ${t.model}</p></div><span class="tag green" style="margin-left:auto">可用</span></div><div class="detail-stats"><div><span>示例总行数</span><strong class="num">${t.total}</strong></div><div><span>示例存储量</span><strong class="num">${t.size}</strong></div><div><span>字段数量</span><strong class="num">${t.columns.length}</strong></div><div><span>副本数</span><strong class="num">3</strong></div></div><div class="tabs">${[['preview','数据预览'],['schema','表结构'],['ddl','建表语句']].map(([v,l])=>`<button data-detail="${v}" class="${state.detailTab===v?'active':''}">${l}</button>`).join('')}</div>${state.detailTab==='preview'?`<div class="filter-bar"><span class="sub" style="font-size:10px;align-self:center">显示 ${Math.min(Number(state.settings.pageSize),t.rows.length)} 条内置样本</span>${button('export-table','导出样本','download','small')}</div>${dataTable(t.columns.map(c=>c.name),t.rows.slice(0,Number(state.settings.pageSize)))}<div class="table-foot"><span>仅预览内置示例数据，非完整数据集</span></div>`:state.detailTab==='schema'?`<div class="table-scroll"><table class="data-table"><thead><tr><th>字段名称</th><th>类型</th><th>键列</th><th>说明</th></tr></thead><tbody>${t.columns.map(c=>`<tr><td class="mono">${esc(c.name)}</td><td><span class="tag purple">${esc(c.type)}</span></td><td>${c.key?icon('key'):'—'}</td><td>${esc(c.comment)}</td></tr>`).join('')}</tbody></table></div>`:`<div class="between" style="padding:14px 20px 0"><span class="muted" style="font-size:9px">示意 DDL · 请按实际 Doris 版本确认</span>${button('copy-ddl','复制','copy','small quiet')}</div><pre class="ddl">${esc(ddl(t))}</pre>`}</section></div>`}
function liveDataPage() {
  const queryTableButton = selectedTable() && live.catalogLoaded ? button('table-sql', '查询此表', 'code', 'primary') : '';
  return `${heading('DATA EXPLORER','数据管理','浏览当前账号可访问的库表。',queryTableButton)}
    <div class="workspace">${explorer()}<section class="card" id="live-table-detail" aria-live="polite">${renderLiveDetail()}</section></div>`;
}

function detailKey(table) {
  return JSON.stringify([table.db, table.name, state.detailTab, previewLimit()]);
}

function currentDetail() {
  const table = selectedTable();
  return table && live.detail?.key === detailKey(table) ? live.detail : null;
}

function renderLiveDetail() {
  if (live.error || live.catalogError) return `<div class="empty">${icon('database')}请先恢复库表连接。</div>`;
  if (!live.catalogLoaded) return '<div class="empty" role="status">正在加载库表…</div>';
  const table = selectedTable();
  if (!table) return `<div class="empty">${icon('database')}暂无可浏览的表。<br>${routeLink('sql','打开 SQL 工作台验证连接 '+icon('arrow'),'text-button')}</div>`;

  const tabs = [['preview','数据预览'],['schema','表结构'],['ddl','建表语句']];
  const description = [table.db, table.label, table.model].filter(Boolean).map(esc).join(' · ');
  return `<div class="table-detail-head live-detail-title">${icon('table')}<div><h2>${esc(table.name)}</h2><p>${description}</p></div></div>
    <div class="tabs">${tabs.map(([key,label])=>`<button data-detail="${key}" class="${state.detailTab===key?'active':''}" aria-pressed="${state.detailTab===key}">${label}</button>`).join('')}</div>
    ${renderLiveDetailTab()}`;
}

function renderLiveDetailTab() {
  const detail = currentDetail();
  if (!detail || detail.pending) return `<div class="empty" role="status">${icon('refresh','spin')}正在加载…</div>`;
  if (detail.error) return `<div class="error-box" role="alert">${esc(detail.error)} <button class="text-button" data-action="retry-table">重试</button></div>`;

  const data = detail.data;
  if (state.detailTab === 'preview') {
    return `<div class="filter-bar"><span class="sub">显示 ${data.rows.length} 行</span>${button('export-table','导出预览','download','small')}</div>
      ${dataTable(data.columns, data.rows)}`;
  }
  if (state.detailTab === 'schema') {
    const fields = data.columns.map(column => `<tr><td class="mono">${esc(column.name)}</td><td><span class="tag purple">${esc(column.type)}</span></td><td>${column.key?icon('key'):'—'}</td><td>${esc(column.comment)}</td></tr>`);
    return `<div class="table-scroll"><table class="data-table"><thead><tr><th>字段名称</th><th>类型</th><th>键列</th><th>说明</th></tr></thead><tbody>${fields.join('')}</tbody></table></div>`;
  }
  return `<div class="filter-bar"><span class="sub">Doris 返回的建表语句</span>${button('copy-ddl','复制','copy','small quiet')}</div><pre class="ddl">${esc(data.ddl)}</pre>`;
}

async function loadLiveDetail(force = false) {
  if (!live.enabled || !live.catalogLoaded || state.route !== 'data') return;
  const table = selectedTable();
  if (!table || (!force && currentDetail())) return;

  live.detail?.controller.abort();
  const detail = {key: detailKey(table), pending: true, controller: new AbortController()};
  const tab = state.detailTab;
  live.detail = detail;
  const params = new URLSearchParams({db: table.db, name: table.name, tab, limit: String(previewLimit())});
  const refreshDetail = () => {
    const element = document.getElementById('live-table-detail');
    if (element && currentDetail() === detail) element.innerHTML = renderLiveDetail();
  };
  refreshDetail();
  try {
    const data = await fetchApi(`table?${params}`, {signal: detail.controller.signal});
    let valid = typeof data?.ddl === 'string';
    if (tab === 'preview') valid = isTabular(data);
    if (tab === 'schema') valid = Array.isArray(data?.columns) && data.columns.every(column => typeof column?.name === 'string');
    if (!valid) throw new Error('服务返回的表详情格式有误。');
    detail.data = data;
  } catch (error) {
    if (detail.controller.signal.aborted) return;
    detail.error = describeError(error);
  } finally {
    detail.pending = false;
    refreshDetail();
  }
}

function liveSettings() {
  const pageSizes = [10,20,50].map(size=>`<option value="${size}" ${previewLimit()===size?'selected':''}>${size} 行</option>`);
  return `${heading('SETTINGS','系统设置','连接信息和本地工作空间偏好。',button('save-settings','保存设置','save','primary'))}
    <section class="card connection-management"><div class="card-head"><div><h2>数据源管理</h2><p class="subtitle">连接由服务端保存，供此工作空间使用。</p></div><div class="connection-actions">${button('refresh-connections','刷新列表','refresh','small')}${button('add-connection','新增连接','plus','primary small')}</div></div>
      <div id="connection-settings-list">${renderConnectionList(false)}</div>
    </section>
    <div class="settings-grid">
      <section class="card"><div class="card-head"><h2>工作空间偏好</h2></div><div class="settings-body">
        <label class="field"><span>工作空间名称</span><input class="input" id="setting-name" value="${esc(state.settings.name)}" maxlength="40"></label>
        <label class="field"><span>数据预览行数</span><select id="setting-page-size" class="input">${pageSizes.join('')}</select></label>
      </div></section>
      <div>${liveConnectionCard()}<div class="live-connection-actions">${connectionButton()}</div></div>
    </div>`;
}

function alertsPage() {
  const selected = live.activeConnectionId ? `当前数据源：${esc(clusterName())}` : '配置全局通知和各数据源的告警规则。';
  return `${heading('ALERT SETTINGS','告警配置',selected)}<div class="alerts-grid">
    <div id="alerts-content">${renderAlerts()}</div><div id="alert-webhook-content">${renderAlertWebhook()}</div></div>`;
}

function renderAlerts() {
  if (!live.activeConnectionId) {
    return `<section class="card empty">${icon('database')}请先添加或选择 Doris 连接。<br>${routeLink('settings','打开数据源管理 '+icon('arrow'),'text-button')}</section>`;
  }
  if (alerts.error) return `<section class="card"><div class="error-box" role="alert">${esc(alerts.error)} ${button('retry-alerts','重试','refresh','small quiet')}</div></section>`;
  if (!alerts.data) return `<section class="card empty" role="status">${icon('refresh','spin')}正在加载告警配置…</section>`;
  return alertFields(alerts.data.config, alerts.data.status, tag);
}

function refreshAlerts() {
  if (state.route !== 'alerts') return;
  const content = document.getElementById('alerts-content');
  if (content) content.innerHTML = renderAlerts();
}

function refreshAlertDelivery() {
  const delivery = document.getElementById('alerts-delivery');
  if (delivery && alerts.data) delivery.innerHTML = alertDelivery(alerts.data.status, tag);
}

function renderAlertWebhook() {
  if (alertWebhook.error) return `<section class="card"><div class="card-head"><h2>全局飞书机器人</h2></div><div class="error-box" role="alert">${esc(alertWebhook.error)} ${button('retry-alert-webhook','重试','refresh','small quiet')}</div></section>`;
  if (!alertWebhook.data) return `<section class="card empty" role="status">${icon('refresh','spin')}正在加载全局飞书机器人…</section>`;
  const httpWarning = location.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  return webhookFields(alertWebhook.data, {httpWarning, tag, busy:Boolean(alertWebhook.operation), feedback:alertWebhook.feedback, failed:alertWebhook.failed});
}

function refreshAlertWebhook() {
  if (state.route !== 'alerts') return;
  const content = document.getElementById('alert-webhook-content');
  if (content) content.innerHTML = renderAlertWebhook();
  updateWebhookControls();
}

function resetAlertWebhook() {
  alertWebhook.request?.abort();
  alertWebhook.operation?.controller.abort();
  Object.assign(alertWebhook, {data:null, error:'', request:null, operation:null, feedback:'', failed:false});
}

function webhookPayload(data) {
  if (typeof data?.webhookConfigured !== 'boolean' || typeof data?.secretConfigured !== 'boolean') {
    throw new Error('服务返回的全局机器人配置格式有误。');
  }
  return data;
}

async function loadAlertWebhook() {
  if (alertWebhook.data || alertWebhook.request || alertWebhook.error) return;
  const request = new AbortController();
  alertWebhook.request = request;
  try {
    const data = await fetchApi('alerts/webhook', {signal: request.signal});
    if (alertWebhook.request === request) alertWebhook.data = webhookPayload(data);
  } catch (error) {
    if (alertWebhook.request === request) alertWebhook.error = describeError(error);
  } finally {
    if (alertWebhook.request === request) {
      alertWebhook.request = null;
      refreshAlertWebhook();
    }
  }
}

function updateWebhookControls() {
  const form = document.getElementById('alert-webhook-form');
  if (!form) return;
  const save = form.querySelector('button[type="submit"]');
  const test = form.querySelector('[data-action="test-alert-webhook"]');
  if (save) save.disabled = Boolean(alertWebhook.operation);
  if (test) test.disabled = Boolean(alertWebhook.operation) || !alertWebhook.data?.webhookConfigured;
  for (const input of form.querySelectorAll('input')) input.disabled = alertWebhook.operation?.kind === 'save';
  const feedback = document.getElementById('alert-webhook-feedback');
  if (feedback) {
    feedback.textContent = alertWebhook.feedback;
    feedback.classList.toggle('red', alertWebhook.failed);
  }
}

function updateWebhookDelivery() {
  const delivery = document.getElementById('alert-webhook-delivery');
  if (delivery && alertWebhook.data) delivery.innerHTML = webhookDelivery(alertWebhook.data.lastDelivery, tag);
}

async function changeAlertWebhook(kind, form) {
  if (!alertWebhook.data || alertWebhook.operation || state.route !== 'alerts') return;
  const isTest = kind === 'test';
  if (isTest && !alertWebhook.data.webhookConfigured) return;
  const body = isTest ? {} : readWebhookForm(form);
  const operation = {kind, controller:new AbortController()};
  alertWebhook.operation = operation;
  alertWebhook.feedback = isTest ? '正在向飞书群发送测试消息…' : '正在保存全局机器人…';
  alertWebhook.failed = false;
  updateWebhookControls();
  const options = {method:isTest?'POST':'PUT', body, signal:operation.controller.signal};
  try {
    const result = await fetchApi(isTest?'alerts/webhook/test':'alerts/webhook', options);
    if (alertWebhook.operation !== operation) return;
    alertWebhook.data = webhookPayload(result);
    alertWebhook.feedback = isTest ? '测试消息已发送，请在飞书群查看。' : '全局机器人配置已保存。';
    if (isTest) updateWebhookDelivery();
    else refreshAlertWebhook();
  } catch (error) {
    if (alertWebhook.operation !== operation) return;
    alertWebhook.failed = true;
    alertWebhook.feedback = describeError(error);
    if (isTest) {
      try {
        const result = await fetchApi('alerts/webhook', {signal:options.signal});
        if (alertWebhook.operation === operation) {
          alertWebhook.data = webhookPayload(result);
          updateWebhookDelivery();
        }
      } catch {
        // Preserve the test failure message if its delivery record is unavailable.
      }
    }
  } finally {
    if (alertWebhook.operation === operation) {
      alertWebhook.operation = null;
      updateWebhookControls();
    }
  }
}

function resetAlerts() {
  alerts.request?.abort();
  alerts.operation?.abort();
  alerts.request = null;
  alerts.operation = null;
  alerts.error = '';
  alerts.data = null;
}

function alertPayload(data) {
  if (typeof data?.config?.enabled !== 'boolean' || !data.config.thresholds) throw new Error('服务返回的告警配置格式有误。');
  return data;
}

async function loadAlerts() {
  if (!live.activeConnectionId || alerts.request || alerts.data || alerts.error) return;
  const request = new AbortController();
  alerts.request = request;
  try {
    const data = await fetchApi('alerts', {signal: request.signal});
    if (alerts.request === request) alerts.data = alertPayload(data);
  } catch (error) {
    if (alerts.request === request) alerts.error = describeError(error);
  } finally {
    if (alerts.request === request) {
      alerts.request = null;
      refreshAlerts();
    }
  }
}

function alertFeedback(message, failed = false) {
  const feedback = document.getElementById('alerts-feedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle('red', failed);
}

function alertControls(form, busy) {
  const save = form.querySelector('button[type="submit"]');
  if (save) save.disabled = busy;
}

async function saveAlerts(form) {
  if (!alerts.data || alerts.operation || state.route !== 'alerts') return;
  alerts.request?.abort();
  alerts.request = null;
  const operation = new AbortController();
  alerts.operation = operation;
  alertControls(form, true);
  alertFeedback('正在保存配置…');
  try {
    const body = readAlertForm(form);
    for (const field of form.querySelectorAll('input')) field.disabled = true;
    const result = await fetchApi('alerts', {method:'PUT', body, signal:operation.signal});
    if (alerts.operation !== operation) return;
    alerts.data = alertPayload(result);
    refreshAlerts();
    alertFeedback('告警配置已保存。');
  } catch (error) {
    if (alerts.operation === operation) alertFeedback(describeError(error), true);
  } finally {
    if (alerts.operation === operation) {
      alerts.operation = null;
      for (const field of form.querySelectorAll('input')) field.disabled = false;
      alertControls(form, false);
    }
  }
}

async function refreshAlertStatus(buttonElement) {
  if (!alerts.data || alerts.operation || alerts.request || state.route !== 'alerts') return;
  const request = new AbortController();
  alerts.request = request;
  buttonElement.disabled = true;
  try {
    const result = await fetchApi('alerts', {signal:request.signal});
    if (alerts.request !== request) return;
    alerts.data = {...alerts.data, status:alertPayload(result).status};
    refreshAlertDelivery();
  } catch (error) {
    if (alerts.request === request) alertFeedback(describeError(error), true);
  } finally {
    if (alerts.request === request) alerts.request = null;
    buttonElement.disabled = false;
  }
}

function sourceAddress(source) {
  if (!source.host) return '地址未配置';
  const host = source.host.includes(':') && !source.host.startsWith('[') ? `[${source.host}]` : source.host;
  return source.port === null ? host : `${host}:${source.port}`;
}

function sourceSummary(source) {
  return `<span class="connection-row-copy"><strong>${esc(source.name)}</strong><small>${esc(sourceAddress(source))}${source.database?` · ${esc(source.database)}`:''}</small></span>`;
}

function renderConnectionList(picker) {
  const error = live.connectionsError || live.storageError;
  const warning = error ? `<div class="connection-list-notice"><p role="alert">${esc(error)}</p>${live.connectionsError ? button('refresh-connections','重试','refresh','small quiet') : ''}</div>` : '';
  if (!live.connections.length) {
    const hint = live.connectionsRequest ? '正在读取连接列表…' : live.connectionsLoaded ? '暂无 Doris 连接。可以新增一个连接。' : '连接列表尚不可用。';
    return `${warning}<div class="empty connection-list-empty" role="status">${hint}</div>`;
  }
  const items = live.connections.map(source => {
    const selected = source.id === live.activeConnectionId;
    const id = esc(source.id);
    if (picker) {
      return `<li><button class="cluster-choice connection-picker-row ${selected?'selected':''}" data-switch-connection="${id}"${selected?' aria-current="true"':''}>${icon('database')}${sourceSummary(source)}${selected?tag('当前连接','purple'):icon('chevron')}</button></li>`;
    }
    const badges = `${source.managedBy === 'environment' ? tag('部署配置','') : ''}${source.tls ? tag('TLS','') : ''}${selected ? tag('当前连接','purple') : ''}`;
    return `<li class="connection-row"><div class="connection-row-details"><span class="cluster-symbol">${icon('database')}</span>${sourceSummary(source)}<div class="connection-badges">${badges}</div></div>
      <div class="connection-actions">${selected?'':`<button class="button small" data-switch-connection="${id}">切换</button>`}<button class="button small quiet" data-rename-connection="${id}">重命名</button></div></li>`;
  }).join('');
  return `${warning}<ul class="connection-list ${picker?'connection-picker-list':''}">${items}</ul>`;
}

function renderConnectionViews() {
  const settingsList = document.getElementById('connection-settings-list');
  if (settingsList) settingsList.innerHTML = renderConnectionList(false);
  const pickerList = document.getElementById('connection-picker-list');
  if (pickerList) pickerList.innerHTML = renderConnectionList(true);

  const source = activeConnection();
  if (!source) return;
  for (const id of ['active-connection-label', 'current-connection-label', 'editor-connection-label']) {
    const label = document.getElementById(id);
    if (label) { label.textContent = source.name; label.title = source.name; }
  }
}

function openConnectionPicker() {
  const actions = `${button('manage-connections','数据源管理','settings')}${button('add-connection','新增连接','plus','primary')}`;
  modal('切换 Doris 连接', `<div id="connection-picker-list">${renderConnectionList(true)}</div>`, actions, true);
  loadConnections();
}

function openConnectionForm(source) {
  if (!live.enabled || live.connectionMutation) return;
  const isRename = Boolean(source);
  const lanHttp = location.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  const transportNote = lanHttp && !isRename ? '<p class="notice-strip connection-http-note">当前通过 HTTP 访问，密码会经内网明文传输。</p>' : '';
  const fields = isRename ? '' : `<div class="connection-form-grid">
      <label class="field"><span>FE 地址</span><input class="input" name="host" placeholder="doris-fe.intra" maxlength="253" required></label>
      <label class="field"><span>查询端口</span><input class="input" name="port" type="number" min="1" max="65535" value="9030" required></label>
      <label class="field"><span>用户名</span><input class="input" name="username" maxlength="128" required></label>
      <label class="field"><span>密码</span><input class="input" name="password" type="password" autocomplete="new-password" maxlength="1024"></label>
    </div>
    <label class="field"><span>默认数据库（可选）</span><input class="input" name="database" maxlength="128"></label>
    <label class="connection-tls"><input type="checkbox" name="tls"> 启用 Doris SQL TLS</label>`;
  const form = `<form id="connection-form" method="post" autocomplete="off"${isRename?` data-connection-id="${esc(source.id)}"`:''}>
    <label class="field"><span>连接名称</span><input class="input" name="name" maxlength="48" placeholder="例如：分析集群" value="${esc(source?.name || '')}" required></label>
    ${fields}${transportNote}<p class="error-box connection-form-error" role="alert" hidden></p>
  </form>`;
  const actions = `${button('close-modal','取消')}<button type="submit" form="connection-form" class="button primary">${icon('save')}<span>${isRename?'保存名称':'测试并保存'}</span></button>`;
  modal(isRename ? '重命名连接' : '新增 Doris 连接', form, actions, true);
}

async function submitConnection(form) {
  if (!live.enabled || live.connectionMutation) return;
  const fields = new FormData(form);
  const text = field => String(fields.get(field) ?? '').trim();
  const id = form.dataset.connectionId;
  const name = text('name');
  const errorBox = form.querySelector('.connection-form-error');
  if (!name) { errorBox.textContent = '请填写连接名称。'; errorBox.hidden = false; return; }
  const body = id ? {id, name} : {
    name, host:text('host'), port:Number(text('port')), username:text('username'),
    password:String(fields.get('password') ?? ''), database:text('database'), tls:fields.has('tls'),
  };
  const submit = document.querySelector('button[form="connection-form"]');
  const caption = submit?.querySelector('span');
  live.connectionMutation = true;
  errorBox.hidden = true;
  if (submit) submit.disabled = true;
  if (caption) caption.textContent = id ? '正在保存…' : '正在测试连接…';
  try {
    const saved = await fetchApi('sources', {body, method:id?'PATCH':'POST', timeout:30000});
    const source = sourceDescriptor(saved?.source);
    if (!source) throw new Error('服务未返回保存结果，请刷新连接列表确认。');
    applySource(source);
    if (form.isConnected) closeModal();
    toast(id ? '连接名称已更新' : 'Doris 连接已添加');
    if (!live.activeConnectionId) await switchConnection(source.id, {dismiss:false});
  } catch (error) {
    if (form.isConnected) {
      errorBox.textContent = describeError(error);
      errorBox.hidden = false;
    } else {
      toast(describeError(error));
    }
  } finally {
    live.connectionMutation = false;
    if (submit) submit.disabled = false;
    if (caption) caption.textContent = id ? '保存名称' : '测试并保存';
  }
}

function ddl(t){const agg=t.model==='Aggregate Key';return`CREATE TABLE ${t.db}.${t.name} (\n${t.columns.map(c=>`  ${c.name} ${c.type}${agg&&!c.key?' SUM':''} COMMENT '${c.comment}'`).join(',\n')}\n)\n${t.model.toUpperCase()}(${t.columns.filter(c=>c.key).map(c=>c.name).join(', ')})\nDISTRIBUTED BY HASH(${t.columns[0].name}) BUCKETS 10\nPROPERTIES (\n  "replication_num" = "3"\n);`}
function historyPage() {
  const failures = state.history.filter(query => query.status === 'error').length;
  const note = live.enabled ? '当前页面会话中的查询' : '当前浏览器中的演示记录';
  const statuses = [['all','全部状态'],['success','执行成功'],['error','执行失败']];
  return `${heading('QUERY HISTORY','查询历史','查看或重新打开已运行的 SQL。',button('export-history','导出历史','download'))}
    <div class="stats-grid activity-stats">${stat('已执行查询',state.history.length,'次','code','',`<span>${note}</span>`)}${stat('成功查询',state.history.length-failures,'次','check','green','<span>查询已完成</span>')}${stat('未成功查询',failures,'次','info','orange','<span>可查看原因并重新编辑</span>')}</div>
    <section class="card"><div class="filter-bar"><input id="history-search" class="input" placeholder="搜索 SQL 或数据库…" aria-label="搜索历史" value="${esc(state.historySearch)}"><select id="history-filter" class="select" aria-label="查询状态">${statuses.map(([value,label])=>`<option value="${value}" ${state.historyFilter===value?'selected':''}>${label}</option>`).join('')}</select></div><div id="history-table">${historyTable()}</div></section>`;
}

function historyTable() {
  const term = state.historySearch.toLowerCase();
  const rows = state.history.filter(query => {
    const matchesStatus = state.historyFilter === 'all' || query.status === state.historyFilter;
    return matchesStatus && (query.sql.toLowerCase().includes(term) || query.db.toLowerCase().includes(term));
  });
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>SQL 语句</th><th>数据库</th><th>状态</th><th>耗时</th><th>执行时间</th><th></th></tr></thead><tbody>
    ${rows.map(query=>`<tr><td style="max-width:360px;overflow:hidden;text-overflow:ellipsis" title="${esc(query.sql)}"><code>${esc(query.sql.replace(/\s+/g,' '))}</code></td><td>${esc(query.db || '—')}</td><td>${tag(query.status==='success'?'成功':'失败',query.status==='success'?'green':'red')}</td><td class="mono">${esc(query.duration)} ms</td><td class="mono">${esc(query.time)}</td><td><button class="text-button" data-query="${esc(query.id)}">打开 ${icon('arrow')}</button></td></tr>`).join('')}
    </tbody></table></div>${rows.length?'':'<div class="empty">没有找到匹配的查询记录</div>'}<div class="table-foot"><span>共 ${rows.length} 条记录</span><span>${live.enabled?'记录保留在当前页面会话中':'记录保存在当前浏览器'}</span></div>`;
}
function tasksPage(){return`${heading('LOAD JOBS','任务中心','掌握数据流入的每一步。',button('job-info','任务说明','info'))}<div class="stats-grid activity-stats">${stat('运行中',state.jobs.filter(j=>j.status==='RUNNING').length,'个任务','activity','','<span>实时流式导入</span>')}${stat('已完成',state.jobs.filter(j=>j.status==='FINISHED').length,'个任务','check','green','<span>批量导入完成</span>')}${stat('已暂停',state.jobs.filter(j=>j.status==='PAUSED').length,'个任务','pause','orange','<span>等待恢复运行</span>')}</div><div class="card"><div class="card-head"><h2>数据导入任务 <span class="tag">${state.jobs.length}</span></h2><span class="tag purple">演示任务</span></div><div class="table-scroll"><table class="data-table"><thead><tr><th>任务名称</th><th>导入类型</th><th>目标库</th><th>状态</th><th>已导入行数</th><th>操作</th></tr></thead><tbody>${state.jobs.map(j=>`<tr><td><div class="job-name">${icon('tasks')}<div><strong style="font-weight:500">${j.name}</strong><small class="muted" style="display:block;margin-top:5px;font-size:9px">${j.source}</small></div></div></td><td><span class="tag">${j.type}</span></td><td>${j.db}</td><td>${tag({RUNNING:'运行中',FINISHED:'已完成',PAUSED:'已暂停'}[j.status],j.status==='PAUSED'?'orange':'green')}</td><td class="mono">${j.rows}</td><td>${j.status==='FINISHED'?`<button class="text-button" data-job-detail="${j.id}">详情 ${icon('arrow')}</button>`:`<button class="text-button" data-job="${j.id}">${icon(j.status==='RUNNING'?'pause':'play')}${j.status==='RUNNING'?'暂停':'恢复'}</button>`}</td></tr>`).join('')}</tbody></table></div><div class="table-foot"><span>暂停与恢复仅修改本地演示状态</span><span>4 个示例任务</span></div></div>`}
function settingsPage(){return`${heading('SETTINGS','系统设置','让工作空间，适应你的工作方式。',button('save-settings','保存设置','save','primary'))}<div class="settings-grid"><section class="card"><div class="card-head"><h2>工作空间偏好</h2></div><div class="settings-body"><label class="field"><span>工作空间名称</span><input class="input" id="setting-name" value="${esc(state.settings.name)}" maxlength="40"></label><label class="field"><span>数据预览行数</span><select id="setting-page-size" class="input">${['10','20','50'].map(v=>`<option value="${v}" ${state.settings.pageSize===v?'selected':''}>${v} 行</option>`).join('')}</select><small>预览行数不超过表中内置的样本数量。</small></label><div class="settings-row"><div><strong>自动刷新概览</strong><p>每 30 秒重新加载演示指标快照</p></div><button class="toggle ${state.settings.refresh?'on':''}" data-toggle="refresh" role="switch" aria-checked="${state.settings.refresh}" aria-label="自动刷新概览"><i></i></button></div><div class="settings-row"><div><strong>显示演示提醒</strong><p>任务暂停、恢复时显示操作反馈</p></div><button class="toggle ${state.settings.notifications?'on':''}" data-toggle="notifications" role="switch" aria-checked="${state.settings.notifications}" aria-label="显示演示提醒"><i></i></button></div><p class="notice-strip">设置仅保存在当前浏览器，点击「保存设置」后生效。</p></div></section><div><section class="card"><div class="card-head"><h2>当前连接</h2><span class="tag purple">演示模式</span></div><div class="settings-body"><div class="settings-row"><strong>集群</strong><span class="sub">${clusterName()}</span></div><div class="settings-row"><strong>数据来源</strong><span class="sub">浏览器内置示例</span></div><div class="settings-row"><strong>连接状态</strong><span class="tag">未连接真实集群</span></div><div style="margin-top:17px">${button('connection-info','了解真实集群接入','external')}</div></div></section><section class="card" style="margin-top:20px"><div class="about-box"><img src="./favicon.svg" alt=""><div><strong>Doris Studio <span class="tag" style="margin-left:7px">v1.0 Demo</span></strong><p>一个清晰、高效的数据管理工作空间。<br>为 Apache Doris 的数据探索而设计。</p></div></div></section></div></div>`}

function navigate(route){if(location.hash===`#/${route}`){state.route=route;layout()}else location.hash=`/${route}`;}
function refreshMain(){document.getElementById('main').innerHTML=renderPage();if(state.route==='sql')updateLines()}
function updateLines(){const e=document.getElementById('sql-editor'),n=document.getElementById('line-numbers');if(e&&n)n.innerHTML=Array.from({length:Math.max(8,e.value.split('\n').length)},(_,i)=>i+1).join('<br>')}
function toast(message){clearTimeout(toastTimer);document.getElementById('toast-root').innerHTML=`<div class="toast">${icon('check')}${esc(message)}</div>`;toastTimer=setTimeout(()=>document.getElementById('toast-root').replaceChildren(),3500)}
function modal(title,body,foot='',wide=false){modalReturnFocus=document.activeElement;document.getElementById('overlay-root').innerHTML=`<div class="modal-backdrop" data-backdrop><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${body}</div>${foot?`<div class="modal-footer">${foot}</div>`:''}</section></div>`;document.body.style.overflow='hidden';setTimeout(()=>{const root=document.querySelector('.modal');(root?.querySelector('input')||root?.querySelector('button'))?.focus()},0)}
function closeModal(){document.getElementById('overlay-root').replaceChildren();document.body.style.overflow='';if(modalReturnFocus?.isConnected)modalReturnFocus.focus()}
function searchModal(){modal('快速查找',`<input class="input modal-search" id="global-search-input" placeholder="搜索表名、中文说明或页面…" aria-label="全局搜索"><div class="search-results" id="global-results">${searchResults('')}</div>`,'',true)}
function searchResults(query) {
  const term = query.toLowerCase();
  const pages = visibleNav().filter(([, , title]) => title.toLowerCase().includes(term)).map(([route, symbol, title])=>
    `<button class="search-result" data-search-nav="${route}">${icon(symbol)}<span>${title}<small>工作空间页面</small></span>${icon('arrow')}</button>`);
  const matches = (live.enabled && !live.catalogLoaded ? [] : currentTables()).filter(table => `${table.db}.${table.name} ${table.label || ''}`.toLowerCase().includes(term));
  const tableLinks = matches.map(table=>
    `<button class="search-result" data-search-table="${esc(tableKey(table))}">${icon('table')}<span>${esc(table.name)}<small>${esc(table.db)}${table.label?` · ${esc(table.label)}`:''}</small></span>${icon('arrow')}</button>`);
  return pages.concat(tableLinks).join('') || '<div class="empty">没有匹配结果</div>';
}

function refreshQueryUi() {
  const results = document.getElementById('results');
  if (!results) return;
  results.innerHTML = resultPanel();
  document.querySelector('[data-action="run"]').outerHTML = runButton();
}

async function runQuery() {
  if (state.running || (live.enabled && !live.connected)) return;
  const sql = document.getElementById('sql-editor')?.value ?? state.sql;
  const db = state.db;
  const request = live.enabled ? new AbortController() : null;
  state.sql = sql;
  if (!live.enabled) write('sql', sql);
  if (!sql.trim()) {
    state.result = null;
    state.error = '请先输入 SQL。';
    refreshQueryUi();
    return;
  }
  state.running = true;
  live.queryRequest = request;
  state.error = null;
  state.result = null;
  refreshQueryUi();

  if (!live.enabled) await new Promise(resolve=>setTimeout(resolve,350));
  const started = performance.now();
  let result;
  let error;
  try {
    result = request ? await fetchApi('query', {body: {sql, database: db}, signal: request.signal, timeout: 45000}) : evaluateSQL(sql, db);
    if (!isTabular(result)) {
      result = null;
      throw new Error('服务返回的查询结果格式有误。');
    }
  } catch (failure) {
    error = describeError(failure);
  }

  if (live.queryRequest !== request) return;
  live.queryRequest = null;
  const duration = Number.isFinite(result?.duration) ? result.duration : Math.max(1, Math.round(performance.now() - started));
  state.running = false;
  if (state.sql === sql && state.db === db) {
    state.error = error || null;
    state.result = result ? {...result, duration} : null;
  }
  state.history.unshift({id: Date.now(), sql, db: db || live.database, status: error ? 'error' : 'success', duration,
    count: result?.rows.length ?? 0, time: new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}), error});
  state.history = state.history.slice(0,100);
  if (!live.enabled) write('history', state.history);
  if (state.route === 'sql') refreshQueryUi();
  if (state.route === 'history') refreshMain();
}

function loadQuery(sql, db) {
  state.sql = sql;
  state.db = live.enabled ? db || '' : db || 'analytics';
  state.result = null;
  state.error = null;
  if (!live.enabled) write('sql', sql);
  closeModal();
  navigate('sql');
}

function downloadCSV(columns,rows,name){const cell=v=>{let s=cellText(v);if(/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};const csv='\uFEFF'+[columns.map(cell).join(','),...rows.map(r=>columns.map(c=>cell(r[c])).join(','))].join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));const a=document.createElement('a');a.href=url;a.download=name+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('CSV 文件已导出')}
function resetRefresh(){clearInterval(refreshTimer);if(!live.enabled&&state.settings.refresh)refreshTimer=setInterval(()=>{state.lastUpdate=new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});if(state.route==='overview')refreshMain()},30000)}

document.addEventListener('click',async event=>{
 const e=event.target.closest('button,a,[data-backdrop],.mobile-mask');if(!e)return;
 if(e.hasAttribute('data-backdrop')&&event.target===e){closeModal();return}
 if(e.dataset.range){state.range=e.dataset.range;refreshMain();return}
 if(e.dataset.liveRange && Object.hasOwn(monitoringRanges, e.dataset.liveRange)){
   state.range = e.dataset.liveRange;
   if (live.connected && !live.checking) await loadMonitoring();
   else refreshMonitoring();
   return;
 }
 if(e.dataset.db){state.closed.has(e.dataset.db)?state.closed.delete(e.dataset.db):state.closed.add(e.dataset.db);document.getElementById('table-tree').innerHTML=tree(tableSearch);return}
 if(e.dataset.table){
   const table = currentTables().find(candidate => tableKey(candidate) === e.dataset.table);
   if (!table) return;
   state.table = tableKey(table);
   state.db = table.db;
   if (state.route === 'sql') loadQuery(queryForTable(table), table.db);
   else { refreshMain(); loadLiveDetail(); }
   return;
 }
 if(e.dataset.detail){state.detailTab=e.dataset.detail;refreshMain();loadLiveDetail();return}
 if(e.dataset.query){const h=state.history.find(h=>String(h.id)===e.dataset.query);if(h)loadQuery(h.sql,h.db);return}
 if(e.dataset.searchNav){closeModal();navigate(e.dataset.searchNav);return}
 if(e.dataset.searchTable){state.table=e.dataset.searchTable;closeModal();navigate('data');return}
 if(e.dataset.switchConnection){await switchConnection(e.dataset.switchConnection);return}
 if(e.dataset.renameConnection){
   const source = live.connections.find(item => item.id === e.dataset.renameConnection);
   if (source) openConnectionForm(source);
   return;
 }
 if(e.dataset.selectCluster){state.cluster=e.dataset.selectCluster;write('cluster',state.cluster);closeModal();layout();toast(`已切换到${state.cluster==='production'?'生产':'开发'}演示集群`);return}
 if(e.dataset.saved){const s=state.saved.find(q=>String(q.id)===e.dataset.saved);if(s)loadQuery(s.sql,s.db);return}
 if(e.dataset.toggle){const enabled=e.getAttribute('aria-checked')!=='true';e.classList.toggle('on',enabled);e.setAttribute('aria-checked',String(enabled));return}
 if(e.dataset.job){const j=state.jobs.find(j=>j.id===e.dataset.job);j.status=j.status==='RUNNING'?'PAUSED':'RUNNING';write('jobs',state.jobs);layout();if(state.settings.notifications)toast(`${j.name}已${j.status==='RUNNING'?'恢复':'暂停'}（演示）`);return}
 if(e.dataset.jobDetail){const j=state.jobs.find(j=>j.id===e.dataset.jobDetail);modal('导入任务详情',`<p>${j.name} · ${j.id}</p><div class="settings-row"><strong>类型</strong><span>${j.type}</span></div><div class="settings-row"><strong>已导入行数</strong><span>${j.rows}</span></div><div class="settings-row"><strong>开始时间</strong><span>${j.time}</span></div><div class="settings-row"><strong>结果</strong>${tag('演示任务已完成')}</div>`);return}
 const action=e.dataset.action;if(!action)return;
 if(action==='close-modal'){closeModal();return}
 if(action==='mobile'){document.getElementById('sidebar').classList.add('open');return}
 if(action==='mobile-close'){document.getElementById('sidebar').classList.remove('open');return}
 if(action==='search'){searchModal();return}
 if(action==='profile'){navigate('settings');return}
 if(action==='retry-alerts' && state.route==='alerts'){alerts.error='';refreshAlerts();await loadAlerts();return}
 if(action==='retry-alert-webhook' && state.route==='alerts'){alertWebhook.error='';refreshAlertWebhook();await loadAlertWebhook();return}
 if(action==='test-alert-webhook'){await changeAlertWebhook('test');return}
 if(action==='refresh-alert-status'){await refreshAlertStatus(e);return}
 if(action==='add-connection'){openConnectionForm();return}
 if(action==='refresh-connections'){await loadConnections();return}
 if(action==='manage-connections'){closeModal();navigate('settings');await loadConnections();return}
 if(action==='check-connection'){await checkConnection();return}
 if(action==='refresh-nodes'){await loadCluster(true);return}
 if(action==='refresh-monitoring'){await loadMonitoring();return}
 if(action==='retry-table'){await loadLiveDetail(true);return}
 if(action==='refresh'){state.lastUpdate=new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});refreshMain();toast('已重新加载演示指标快照');return}
 if(action==='run'){runQuery();return}
 if(action==='new-query'){loadQuery(live.enabled?liveSql:'SELECT *\nFROM analytics.orders\nLIMIT 10;',live.enabled?state.db:'analytics');document.getElementById('sql-editor')?.focus();return}
 if(action==='format'){state.sql=state.sql.split(/('(?:''|[^'])*')/g).map((part,i)=>i%2?part:part.replace(/\b(select|from|where|order by|group by|limit|asc|desc|show|databases|tables|count|as)\b/gi,m=>m.toUpperCase()).replace(/\s+(FROM|WHERE|ORDER BY|GROUP BY|LIMIT)\b/g,'\n$1')).join('').trim();write('sql',state.sql);refreshMain();toast('SQL 已格式化');return}
 if(action==='table-sql'){
   const table = selectedTable();
   if (table) loadQuery(queryForTable(table), table.db);
   return;
 }
 if(action==='export-result'&&state.result){downloadCSV(state.result.columns,state.result.rows,'doris-query-result');return}
 if(action==='export-table'){
   const table = selectedTable();
   if (!table) return;
   if (live.enabled) {
     const data = currentDetail()?.data;
     if (data?.rows) downloadCSV(data.columns, data.rows, `${table.name}-preview`);
   } else {
     downloadCSV(table.columns.map(column=>column.name),table.rows,`${table.name}-samples`);
   }
   return;
 }
 if(action==='export-history'){downloadCSV(['sql','db','status','duration','count','time'],state.history,'doris-query-history');return}
 if(action==='copy-ddl'){
   const table = selectedTable();
   if (!table) return;
   const statement = live.enabled ? currentDetail()?.data?.ddl : ddl(table);
   if (!statement) return;
   try { await navigator.clipboard.writeText(statement); toast('建表语句已复制'); }
   catch { modal('复制建表语句',`<textarea class="input mono" style="height:260px" readonly>${esc(statement)}</textarea>`); }
   return;
 }
 if(action==='cluster' && live.enabled){openConnectionPicker();return}
 if(action==='cluster'){modal('切换演示集群',`<p>以下集群使用相同的内置样本，监控指标按演示环境展示。</p>${[['production','Production Cluster','生产环境'],['development','Development Cluster','开发环境']].map(([id,title,label])=>`<button class="cluster-choice ${state.cluster===id?'selected':''}" data-select-cluster="${id}">${icon('database')}<span><strong>${title}</strong><small>${label} · 内置演示数据</small></span>${tag(state.cluster===id?'当前集群':'可切换',state.cluster===id?'purple':'green')}</button>`).join('')}`);return}
 if(action==='help' && live.enabled){modal('使用 Doris Studio',`<p>在集群概览测试连接，或在 SQL 工作台运行 <code>SELECT 1;</code> 验证查询。</p><div class="notification">${icon('database')}<div><strong>数据管理</strong><p>浏览当前账号可访问的库表，查看数据预览、表结构与建表语句。</p></div></div><div class="notification">${icon('code')}<div><strong>SQL 工作台</strong><p>点击表名生成只读查询。Ctrl / ⌘ + Enter 运行，结果支持导出 CSV。</p></div></div><div class="notice-strip">Ctrl / ⌘ + K 打开搜索 · Esc 关闭弹窗</div>`);return}
 if(action==='help'){modal('欢迎使用 Doris Studio',`<p>这是可交互的 Doris 管理页面演示。你可以：</p><div class="notification">${icon('grid')}<div><strong>查看集群概览</strong><p>切换图表时间范围、悬停查看指标、检查节点状态。</p></div></div><div class="notification">${icon('code')}<div><strong>探索 SQL 工作台</strong><p>点击左侧表名生成查询，按 Ctrl + Enter 运行，支持保存和导出结果。</p></div></div><div class="notification">${icon('database')}<div><strong>浏览数据资产</strong><p>查看 3 个数据库中的 6 张示例表、字段结构与建表语句。</p></div></div><div class="notice-strip">Ctrl / ⌘ + K 打开搜索 · Esc 关闭弹窗。所有数据为样本，未连接真实集群。</div>`);return}
 if(action==='notifications'){modal('工作空间通知',`<div class="notification">${icon('shield')}<div><strong>集群健康检查通过</strong><p>5 个示例节点全部在线，心跳状态正常。</p><small>演示通知 · 10:58</small></div></div><div class="notification">${icon('check')}<div><strong>每日销售报表导入完成</strong><p>warehouse.daily_sales 已完成 36,500 行示例数据导入。</p><small>演示通知 · 02:31</small></div></div><div class="notification">${icon('info')}<div><strong>欢迎来到 Doris Studio</strong><p>当前为演示模式。运行 SQL、保存查询，开始探索数据。</p><small>系统提示</small></div></div>`);return}
 if(action==='nodes'){modal('集群节点详情',`<p>Production 与 Development 均使用以下示例拓扑。地址仅用于展示。</p><div class="table-scroll"><table class="data-table"><thead><tr><th>节点</th><th>角色</th><th>运行时长</th><th>状态</th></tr></thead><tbody>${nodes.map(n=>`<tr><td class="mono">${n.name}<small style="display:block;margin-top:4px">${n.ip}</small></td><td>${n.role}</td><td>${n.uptime}</td><td>${tag('正常')}</td></tr>`).join('')}</tbody></table></div>`,'',true);return}
 if(action==='save-query'){modal('保存查询',`<label class="field"><span>查询名称</span><input class="input" id="query-name" maxlength="60" placeholder="例如：数据检查" value="查询 ${state.saved.length+1}"></label><p>${live.enabled?'保存的查询可在当前页面会话中再次打开。':'SQL 及所选数据库会保存在当前浏览器中。'}</p>`,`${button('close-modal','取消')}${button('confirm-save','保存查询','save','primary')}`);return}
 if(action==='confirm-save'){const name=document.getElementById('query-name').value.trim();if(!name){document.getElementById('query-name').focus();return}state.saved.unshift({id:Date.now(),name,sql:state.sql,db:state.db});if(!live.enabled)write('saved',state.saved);closeModal();toast('查询已保存');return}
 if(action==='saved'){modal('已保存查询',state.saved.length?state.saved.map(q=>`<button class="search-result" data-saved="${q.id}">${icon('file')}<span>${esc(q.name)}<small>${esc(q.db)} · ${esc(q.sql.replace(/\s+/g,' ').slice(0,70))}</small></span>${icon('arrow')}</button>`).join(''):`<div class="empty">${icon('folder')}还没有保存的查询<br>在 SQL 编辑器中点击「保存」即可添加。</div>`,'',true);return}
 if(action==='save-settings'){
   const input = document.getElementById('setting-name');
   const name = input.value.trim();
   if (!name) { input.focus(); toast('请填写工作空间名称'); return; }
   const pageSize = document.getElementById('setting-page-size').value;
   state.settings = {...state.settings, name, pageSize};
   if (!live.enabled) {
     state.settings.refresh = document.querySelector('[data-toggle="refresh"]').getAttribute('aria-checked') === 'true';
     state.settings.notifications = document.querySelector('[data-toggle="notifications"]').getAttribute('aria-checked') === 'true';
   }
   write('settings', state.settings);
   resetRefresh();
   layout();
   toast('设置已保存');
   return;
 }
 if(action==='connection-info'){modal('接入内网 Doris',`<p>当前页面使用内置演示数据。请在可访问 Doris FE 的内网机器上运行 Doris Studio 服务。</p><div class="notification">${icon('server')}<div><strong>配置连接</strong><p>在服务端配置 FE 地址、查询端口和只读账号，打开内网页面后点击「测试连接」。</p></div></div><div class="notice-strip">新集群可以在 SQL 工作台运行 <code>SELECT 1;</code> 验证查询。</div>`);return}
 if(action==='job-info'){modal('导入任务说明',`<p>任务中心展示 4 个模拟导入任务，包括持续导入和已完成的批量任务。</p><div class="notification">${icon('activity')}<div><strong>Routine Load</strong><p>演示 Kafka 持续导入；点击暂停或恢复，更新本地任务状态。</p></div></div><div class="notification">${icon('file')}<div><strong>Broker Load / Stream Load</strong><p>展示已完成的批量任务，点击详情查看任务信息。</p></div></div><div class="notice-strip">此页面不执行真实导入，也不会创建或更改 Doris 任务。</div>`);return}
});

document.addEventListener('submit', event => {
  const form = event.target;
  if (form.id === 'alert-webhook-form') {
    event.preventDefault();
    changeAlertWebhook('save', form);
    return;
  }
  if (form.id === 'alerts-form') {
    event.preventDefault();
    saveAlerts(form);
    return;
  }
  if (form.id !== 'connection-form') return;
  event.preventDefault();
  submitConnection(form);
});

document.addEventListener('input',e=>{
 if(e.target.id==='sql-editor'){state.sql=e.target.value;if(!live.enabled)write('sql',state.sql);updateLines()}
 if(e.target.id==='table-search'){tableSearch=e.target.value;document.getElementById('table-tree').innerHTML=tree(tableSearch)}
 if(e.target.id==='global-search-input')document.getElementById('global-results').innerHTML=searchResults(e.target.value.trim());
 if(e.target.id==='history-search'){state.historySearch=e.target.value;document.getElementById('history-table').innerHTML=historyTable()}
 if(e.target.id==='live-chart-sample')updateLiveSample(e.target.value);
});
document.addEventListener('change',e=>{
 if(e.target.id==='sql-db'){state.db=e.target.value;state.result=null;state.error=null;refreshMain()}
 if(e.target.id==='history-filter'){state.historyFilter=e.target.value;document.getElementById('history-table').innerHTML=historyTable()}
});
document.addEventListener('pointermove',e=>{const hit=e.target.closest('[data-chart]');const tip=document.getElementById('chart-tooltip');if(!tip)return;if(!hit){tip.style.display='none';return}const rect=hit.closest('.chart-wrap').getBoundingClientRect();tip.style.display='block';tip.style.left=Math.min(e.clientX-rect.left+12,rect.width-150)+'px';tip.style.top='12px';tip.innerHTML=`演示采样点 ${Number(hit.dataset.chart)+1}<br>QPS <strong>${hit.dataset.qps}</strong> · 延迟 ${hit.dataset.latency} ms`;});
document.addEventListener('pointermove', event => {
  const tip = document.getElementById('live-chart-tooltip');
  if (!tip) return;
  const sample = event.target.closest('[data-live-point]');
  if (!sample) { tip.style.display = 'none'; return; }
  tip.textContent = liveSampleText(sample);
  tip.style.display = 'block';
  const bounds = sample.closest('.chart-wrap').getBoundingClientRect();
  const maxLeft = bounds.width - tip.offsetWidth - 8;
  tip.style.left = `${Math.max(8,Math.min(event.clientX - bounds.left + 12,maxLeft))}px`;
  tip.style.top = '14px';
});
document.addEventListener('keydown',e=>{
 if(!initialized)return;
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();searchModal()}
 if(e.key==='Escape'){closeModal();document.getElementById('sidebar')?.classList.remove('open')}
 const dialog=document.querySelector('.modal');
 if(dialog&&e.key==='Tab'){const focusables=[...dialog.querySelectorAll('button,input,textarea,select,a[href]')].filter(el=>!el.disabled);const first=focusables[0],last=focusables.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}
 if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&state.route==='sql'&&!dialog){e.preventDefault();runQuery()}
 if(e.key==='Tab'&&e.target.id==='sql-editor'){e.preventDefault();const input=e.target;input.setRangeText('  ',input.selectionStart,input.selectionEnd,'end');state.sql=input.value;if(!live.enabled)write('sql',state.sql);updateLines()}
});
window.addEventListener('hashchange',()=>{if(!initialized)return;state.route=routeFromHash();layout();window.scrollTo(0,0)});

if (document.querySelector('meta[name="doris-mode"][content="live"]')) enableLive();
document.getElementById('app').innerHTML = '<main class="empty" role="status">正在检查 Doris 连接…</main>';
await checkConnection();
if (!live.enabled) {
  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&family=Noto+Sans+SC:wght@400;500;600;700&display=swap';
  document.head.append(fonts);
}
