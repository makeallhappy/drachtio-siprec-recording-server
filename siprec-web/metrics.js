/**
 * metrics.js —— 宿主机系统指标采集(容器内读 /proc,host 网络与宿主共享内核视图)
 *
 * CPU: /proc/stat 两次采样差分(百分比)
 * 内存: /proc/meminfo (MemTotal / MemAvailable)
 * 磁盘: fs.statfs(REC_ROOT) 底层文件系统
 */
const fs = require('fs');

let lastCpu = null;

function readCpuTimes() {
  const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
  return { idle, total };
}

/** CPU 使用率(%):基于上次采样差分;首次采样时等 200ms */
async function cpuUsage() {
  if (!lastCpu) {
    lastCpu = readCpuTimes();
    await new Promise((r) => setTimeout(r, 200));
  }
  const now = readCpuTimes();
  const dTotal = now.total - lastCpu.total;
  const dIdle = now.idle - lastCpu.idle;
  lastCpu = now;
  if (dTotal <= 0) return 0;
  const usage = (1 - dIdle / dTotal) * 100;
  return Math.round(Math.max(0, Math.min(100, usage)) * 10) / 10;
}

/** 内存(MB / %) */
function memoryUsage() {
  const txt = fs.readFileSync('/proc/meminfo', 'utf8');
  // 逐行解析,避免正则转义问题(值单位 kB)
  const map = {};
  for (const line of txt.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = parseInt(line.slice(i + 1).trim(), 10);
    if (!Number.isNaN(val)) map[key] = val * 1024;
  }
  const total = map.MemTotal || 0;
  const available = map.MemAvailable || 0;
  const used = Math.max(0, total - available);
  return {
    totalBytes: total,
    usedBytes: used,
    availableBytes: available,
    usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
  };
}

/** 磁盘(字节 / %) */
async function diskUsage(root) {
  const st = await fs.promises.statfs(root);
  const total = Number(st.blocks) * Number(st.bsize);
  const free = Number(st.bavail) * Number(st.bsize);
  const used = total - free;
  return {
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
  };
}

/** 负载(1/5/15 分钟) */
function loadAvg() {
  const [l1, l5, l15] = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).map(Number);
  return { load1: l1, load5: l5, load15: l15 };
}

/** CPU 核数 */
function cpuCount() {
  return fs.readFileSync('/proc/cpuinfo', 'utf8').split('\n').filter((l) => /^processor\s*:/.test(l)).length;
}

// ==================== rtpengine 媒体面指标(HTTP /metrics) ====================
// rtpengine 的 --listen-http 只绑回环(127.0.0.1:9909),这里取 Prometheus 文本解析。
// 失败只返回 { ok:false },绝不抛错阻断看板。
const http = require('http');
const RTPENGINE_METRICS_URL = process.env.RTPENGINE_METRICS_URL || 'http://127.0.0.1:9909/metrics';

let lastRtpSample = null; // { ts, packets, bytes }

function fetchText(url, timeoutMs = 900) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; if (buf.length > 2e6) req.destroy(new Error('response too large')); });
      res.on('end', () => resolve(buf));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** 极简 Prometheus 文本解析:name{labels} value */
function parsePrometheus(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[\d.eE+]+)/.exec(line);
    if (!m) continue;
    const labels = {};
    if (m[2]) {
      for (const kv of m[2].slice(1, -1).split(',')) {
        const i = kv.indexOf('=');
        if (i < 0) continue;
        labels[kv.slice(0, i).trim()] = kv.slice(i + 1).trim().replace(/^"|"$/g, '');
      }
    }
    out.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return out;
}

function sumByName(samples, name, pred) {
  let v = 0;
  for (const s of samples) if (s.name === name && (!pred || pred(s.labels))) v += s.value;
  return v;
}

function getByLabels(samples, name, pred) {
  const hit = samples.find((s) => s.name === name && (!pred || pred(s.labels)));
  return hit ? hit.value : null;
}

/** rtpengine 媒体面指标;失败时 { ok:false, error } */
async function rtpengineStats() {
  let text;
  try {
    text = await fetchText(RTPENGINE_METRICS_URL);
  } catch (err) {
    lastRtpSample = null; // 断连后重置速率基线
    return { ok: false, error: String(err.message || err) };
  }

  const s = parsePrometheus(text);
  const now = Date.now();

  // 端口按逻辑接口聚合
  const ifaces = s
    .filter((x) => x.name === 'rtpengine_ports')
    .map((x) => ({
      name: x.labels.name || 'default',
      address: x.labels.address || '',
      total: x.value,
      used: getByLabels(s, 'rtpengine_ports_used', (l) => l.name === x.labels.name && l.address === x.labels.address) || 0,
      free: getByLabels(s, 'rtpengine_ports_free', (l) => l.name === x.labels.name && l.address === x.labels.address) || 0,
    }));

  const packetsUser = sumByName(s, 'rtpengine_packets_total', (l) => l.type === 'userspace');
  const packetsKernel = sumByName(s, 'rtpengine_packets_total', (l) => l.type === 'kernel');
  const bytesUser = sumByName(s, 'rtpengine_bytes_total', (l) => l.type === 'userspace');
  const bytesKernel = sumByName(s, 'rtpengine_bytes_total', (l) => l.type === 'kernel');

  // 速率:与上次采样差分(首次为 null)
  let rates = { pps: null, bps: null };
  const packets = packetsUser + packetsKernel;
  const bytes = bytesUser + bytesKernel;
  if (lastRtpSample && now > lastRtpSample.ts) {
    const dt = (now - lastRtpSample.ts) / 1000;
    rates = {
      pps: Math.max(0, Math.round(((packets - lastRtpSample.packets) / dt) * 10) / 10),
      bps: Math.max(0, Math.round((bytes - lastRtpSample.bytes) / dt)),
    };
  }
  lastRtpSample = { ts: now, packets, bytes };

  const mosSamples = getByLabels(s, 'rtpengine_mos_samples_total') || 0;
  const mosTotal = getByLabels(s, 'rtpengine_mos_total') || 0;

  return {
    ok: true,
    ts: now,
    uptimeSeconds: getByLabels(s, 'rtpengine_uptime_seconds'),
    sessions: {
      own: getByLabels(s, 'rtpengine_sessions', (l) => l.type === 'own') || 0,
      foreign: getByLabels(s, 'rtpengine_sessions', (l) => l.type === 'foreign') || 0,
      total: getByLabels(s, 'rtpengine_sessions_total') || 0,
      streamsUserspace: getByLabels(s, 'rtpengine_mediastreams', (l) => l.type === 'userspace') || 0,
      streamsKernel: getByLabels(s, 'rtpengine_mediastreams', (l) => l.type === 'kernel') || 0,
      streamsMixed: getByLabels(s, 'rtpengine_mediastreams', (l) => l.type === 'mixed') || 0,
    },
    ports: {
      used: ifaces.reduce((a, b) => a + b.used, 0),
      free: ifaces.reduce((a, b) => a + b.free, 0),
      total: ifaces.reduce((a, b) => a + b.total, 0),
      interfaces: ifaces,
    },
    packets: { userspace: packetsUser, kernel: packetsKernel, total: packets },
    bytes: { userspace: bytesUser, kernel: bytesKernel, total: bytes },
    errors: sumByName(s, 'rtpengine_packet_errors_total') + sumByName(s, 'rtpengine_errors_total'),
    quality: {
      packetLoss: getByLabels(s, 'rtpengine_packets_lost') || 0,
      duplicates: getByLabels(s, 'rtpengine_rtp_duplicates') || 0,
      skips: getByLabels(s, 'rtpengine_rtp_skips') || 0,
      reordered: getByLabels(s, 'rtpengine_rtp_reordered') || 0,
      oneWaySessions: getByLabels(s, 'rtpengine_one_way_sessions_total') || 0,
      zeroPacketStreams: getByLabels(s, 'rtpengine_zero_packet_streams_total') || 0,
    },
    mos: {
      samples: mosSamples,
      avg: mosSamples > 0 ? Math.round((mosTotal / mosSamples) * 100) / 100 : null,
    },
    callDurationAvg: getByLabels(s, 'rtpengine_call_duration_avg'),
    rates,
    requests: {
      offer: sumByName(s, 'rtpengine_requests_total', (l) => l.request === 'offer'),
      answer: sumByName(s, 'rtpengine_requests_total', (l) => l.request === 'answer'),
      delete: sumByName(s, 'rtpengine_requests_total', (l) => l.request === 'delete'),
    },
  };
}

module.exports = { cpuUsage, memoryUsage, diskUsage, loadAvg, cpuCount, rtpengineStats };

