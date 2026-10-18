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

module.exports = { cpuUsage, memoryUsage, diskUsage, loadAvg, cpuCount };

