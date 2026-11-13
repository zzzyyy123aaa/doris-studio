const minute = 60_000;
const day = 1440 * minute;
export const monitoringRanges = {
  '24h': {label: '24 小时', duration: day, bucket: 5 * minute},
  '7d': {label: '7 天', duration: 7 * day, bucket: 30 * minute},
  '30d': {label: '30 天', duration: 30 * day, bucket: 120 * minute},
};

const number = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
const axisNumber = new Intl.NumberFormat('zh-CN', {notation: 'compact', maximumFractionDigits: 2});
const timeZone = 'Asia/Shanghai';
const sampleDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const axisTime = new Intl.DateTimeFormat('zh-CN', {timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
const axisDate = new Intl.DateTimeFormat('zh-CN', {timeZone, month: '2-digit', day: '2-digit'});

export function isMetric(value) {
  return Number.isFinite(value) && value >= 0;
}

export function formatMetric(value) {
  if (!isMetric(value)) return '—';
  return value > 0 && value < .01 ? value.toPrecision(2) : number.format(value);
}

function formatAxis(value) {
  return value > 0 && value < .01 ? formatMetric(value) : axisNumber.format(value);
}

function axisMaximum(values) {
  const peak = Math.max(0, ...values.filter(isMetric));
  if (!peak) return 1;
  const order = 10 ** Math.floor(Math.log10(peak));
  return [1, 2, 2.5, 5, 10].find(scale => scale * order >= peak) * order;
}

function series(points, key, maximum, maximumGap, x, bottom, height) {
  const sections = [];
  let section;
  let previous;
  for (const point of points) {
    if (!isMetric(point[key])) {
      section = null;
      continue;
    }
    if (!section || point.time - previous > maximumGap) {
      section = [];
      sections.push(section);
    }
    const y = bottom - point[key] / maximum * height;
    section.push([x(point.time).toFixed(1), y.toFixed(1)]);
    previous = point.time;
  }
  const path = sections.filter(items => items.length > 1).map(items => `M${items.map(([left, top]) => `${left},${top}`).join(' L')}`).join(' ');
  const marks = sections.filter(items => items.length === 1).map(([[left, top]]) => `<circle cx="${left}" cy="${top}" r="3" stroke="none"/>`).join('');
  return `<path d="${path}" fill="none" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${marks}`;
}

export function renderMonitoringChart(history, range, sampledAt) {
  const config = monitoringRanges[range];
  const lastBucket = Date.parse(history.at(-1)?.at);
  const sampleTime = typeof sampledAt === 'string' ? Date.parse(sampledAt) : NaN;
  const end = Number.isFinite(lastBucket) ? lastBucket : Number.isFinite(sampleTime) ? sampleTime : Date.now();
  const start = end - config.duration;
  const points = history.filter(point => typeof point?.at === 'string')
    .map(point => ({time: Date.parse(point.at), qps: point.qps, latencyMs: point.latencyMs}))
    .filter(point => point.time >= start && point.time <= end)
    .sort((a, b) => a.time - b.time);
  const available = points.filter(point => isMetric(point.qps) || isMetric(point.latencyMs));
  if (!available.length) return '';

  const frame = {width: 575, height: 215, left: 56, right: 523, top: 24, bottom: 179};
  const plotHeight = frame.bottom - frame.top;
  const plotWidth = frame.right - frame.left;
  const x = time => frame.left + (time - start) / config.duration * plotWidth;
  const qpsValues = available.map(point => point.qps).filter(isMetric);
  const latencyValues = available.map(point => point.latencyMs).filter(isMetric);
  const qpsMax = axisMaximum(qpsValues);
  const latencyMax = axisMaximum(latencyValues);
  const guides = [0, 1, 2, 3, 4].map(index => {
    const level = index / 4;
    const y = frame.bottom - plotHeight * level;
    const left = qpsValues.length ? formatAxis(qpsMax * level) : '';
    const right = latencyValues.length ? formatAxis(latencyMax * level) : '';
    return `<line x1="${frame.left}" x2="${frame.right}" y1="${y}" y2="${y}" stroke="#eae6f3" stroke-dasharray="3 4"/>
      <text x="${frame.left - 8}" y="${y + 3}" text-anchor="end" class="chart-label live-monitor-axis">${left}</text>
      <text x="${frame.right + 8}" y="${y + 3}" class="chart-label live-monitor-axis">${right}</text>`;
  }).join('');
  const timelineFormat = range === '24h' ? axisTime : axisDate;
  const labels = [0, 1, 2, 3, 4].map(index => {
    const time = start + config.duration * index / 4;
    return `<text x="${x(time)}" y="201" text-anchor="middle" class="chart-label live-monitor-axis">${timelineFormat.format(time)}</text>`;
  }).join('');

  const halfBucket = plotWidth * config.bucket / config.duration / 2;
  const samples = points.map((point, index) => {
    const center = x(point.time);
    const midpointLeft = index ? (x(points[index - 1].time) + center) / 2 : frame.left;
    const midpointRight = index < points.length - 1 ? (center + x(points[index + 1].time)) / 2 : frame.right;
    const left = Math.max(midpointLeft, center - halfBucket);
    const right = Math.min(midpointRight, center + halfBucket);
    return `<rect class="chart-hit" x="${left.toFixed(1)}" y="${frame.top}" width="${(right - left).toFixed(1)}" height="${plotHeight}" data-live-point="${index}" data-label="${sampleDate.format(point.time)}" data-qps="${formatMetric(point.qps)}" data-latency="${formatMetric(point.latencyMs)}"/>`;
  }).join('');
  const selected = points.lastIndexOf(available.at(-1));
  const sample = points[selected];
  return `<div class="chart-wrap live-monitor-chart-wrap">
      <svg class="chart-svg live-monitor-chart" viewBox="0 0 ${frame.width} ${frame.height}" preserveAspectRatio="none" role="img" aria-label="最近${config.label} Doris 查询吞吐量与查询耗时估算走势">
        ${guides}${labels}
        <text x="${frame.left}" y="13" class="chart-label live-monitor-axis">QPS</text>
        <text x="${frame.right}" y="13" text-anchor="end" class="chart-label live-monitor-axis">ms</text>
        <g fill="#8f67c9" stroke="#8f67c9">${series(points, 'qps', qpsMax, config.bucket * 1.5, x, frame.bottom, plotHeight)}</g>
        <g fill="#3b9989" stroke="#3b9989">${series(points, 'latencyMs', latencyMax, config.bucket * 1.5, x, frame.bottom, plotHeight)}</g>
        ${samples}
      </svg>
      <div class="chart-tooltip" id="live-chart-tooltip" aria-hidden="true"></div>
    </div>
    <div class="chart-summary live-monitor-sample">
      <label for="live-chart-sample">查看采样点</label>
      <input type="range" id="live-chart-sample" min="0" max="${points.length - 1}" value="${selected}">
      <output id="live-chart-sample-value" for="live-chart-sample" aria-live="polite">${sampleDate.format(sample.time)} · QPS ${formatMetric(sample.qps)} · ${formatMetric(sample.latencyMs)} ms</output>
    </div>`;
}
