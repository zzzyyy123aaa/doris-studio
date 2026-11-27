import {formatMetric,isMetric,monitoringRanges} from './monitoring-chart.js';

const zone = 'Asia/Shanghai';
const sampleFormat = new Intl.DateTimeFormat('zh-CN', {timeZone:zone, month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
const timeFormat = new Intl.DateTimeFormat('zh-CN', {timeZone:zone, hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
const dateFormat = new Intl.DateTimeFormat('zh-CN', {timeZone:zone, month:'2-digit', day:'2-digit'});
const compactFormat = new Intl.NumberFormat('zh-CN', {notation:'compact', maximumFractionDigits:2});

export function renderMysqlChart(history, range, sampledAt) {
  const config = monitoringRanges[range];
  const latest = Date.parse(history.at(-1)?.at);
  const sampleTime = Date.parse(sampledAt);
  const end = Number.isFinite(latest) ? latest : Number.isFinite(sampleTime) ? sampleTime : Date.now();
  const start = end - config.duration;
  const points = history.filter(point => typeof point?.at === 'string')
    .map(point => ({time:Date.parse(point.at), qps:point.qps}))
    .filter(point => point.time >= start && point.time <= end).sort((a,b) => a.time-b.time);
  const available = points.filter(point => isMetric(point.qps));
  if (!available.length) return '';
  const peak = Math.max(...available.map(point => point.qps));
  const order = peak ? 10 ** Math.floor(Math.log10(peak)) : 1;
  const maximum = peak ? [1,2,2.5,5,10].find(scale => scale * order >= peak) * order : 1;
  const frame = {left:56, right:550, top:24, bottom:179};
  const width = frame.right - frame.left;
  const height = frame.bottom - frame.top;
  const x = time => frame.left + (time-start) / config.duration * width;
  const y = qps => frame.bottom - qps / maximum * height;
  const sections = [];
  let segment;
  let previous;
  for (const point of points) {
    if (!isMetric(point.qps)) { segment = null; continue; }
    if (!segment || point.time-previous > config.bucket * 1.5) { segment=[]; sections.push(segment); }
    segment.push(`${x(point.time).toFixed(1)},${y(point.qps).toFixed(1)}`);
    previous = point.time;
  }
  const lines = sections.filter(section => section.length > 1).map(section => `<path d="M${section.join(' L')}" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join('');
  const singles = sections.filter(section => section.length === 1).map(([position]) => {
    const [cx,cy] = position.split(',');
    return `<circle cx="${cx}" cy="${cy}" r="3" stroke="none"/>`;
  }).join('');
  const guides = [0,1,2,3,4].map(index => {
    const value = maximum * index / 4;
    const label = value > 0 && value < .01 ? formatMetric(value) : compactFormat.format(value);
    return `<line x1="${frame.left}" x2="${frame.right}" y1="${y(value)}" y2="${y(value)}" stroke="#eae6f3" stroke-dasharray="3 4"/><text x="${frame.left-8}" y="${y(value)+3}" text-anchor="end" class="chart-label live-monitor-axis">${label}</text>`;
  }).join('');
  const timelineFormat = range === '24h' ? timeFormat : dateFormat;
  const labels = [0,1,2,3,4].map(index => {
    const time = start + config.duration * index / 4;
    return `<text x="${x(time)}" y="201" text-anchor="${index===4?'end':'middle'}" class="chart-label live-monitor-axis">${timelineFormat.format(time)}</text>`;
  }).join('');
  const halfBucket = width * config.bucket / config.duration / 2;
  const samples = points.map((point,index) => {
    const center = x(point.time);
    const left = Math.max(frame.left, center-halfBucket);
    const right = Math.min(frame.right, center+halfBucket);
    return `<rect class="chart-hit" x="${left.toFixed(1)}" y="${frame.top}" width="${(right-left).toFixed(1)}" height="${height}" data-live-point="${index}" data-label="${sampleFormat.format(point.time)}" data-qps="${formatMetric(point.qps)}" data-metric="mysql"/>`;
  }).join('');
  const selected = points.lastIndexOf(available.at(-1));
  const sample = points[selected];
  return `<div class="chart-wrap live-monitor-chart-wrap"><svg class="chart-svg live-monitor-chart" viewBox="0 0 575 215" preserveAspectRatio="none" role="img" aria-label="最近${config.label} MySQL SQL 请求速率走势">
      ${guides}${labels}<text x="${frame.left}" y="13" class="chart-label live-monitor-axis">QPS</text><g fill="#8f67c9" stroke="#8f67c9">${lines}${singles}</g>${samples}
    </svg><div class="chart-tooltip" id="live-chart-tooltip" aria-hidden="true"></div></div>
    <div class="chart-summary live-monitor-sample"><label for="live-chart-sample">查看采样点</label><input type="range" id="live-chart-sample" min="0" max="${points.length-1}" value="${selected}"><output id="live-chart-sample-value" for="live-chart-sample" aria-live="polite">${sampleFormat.format(sample.time)} · SQL 请求 ${formatMetric(sample.qps)} QPS</output></div>`;
}
