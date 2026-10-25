<template>
  <div class="dashboard">
    <!-- 顶部指标卡 -->
    <div class="stat-row">
      <el-card class="stat-card active-card" shadow="hover">
        <div class="stat-label">正在录音</div>
        <div class="stat-value">
          <span class="num">{{ activeRecordings }}</span>
          <span class="unit">路</span>
        </div>
        <div class="stat-sub">
          <span class="dot" :class="{ live: activeRecordings > 0 }"></span>
          {{ activeRecordings > 0 ? '录音进行中' : '当前空闲' }}
        </div>
      </el-card>

      <el-card class="stat-card" shadow="hover">
        <div class="stat-label">CPU 使用率</div>
        <div class="stat-value"><span class="num">{{ cpu.usagePercent ?? '--' }}</span><span class="unit">%</span></div>
        <div class="stat-sub">{{ cpu.cores }} 核 · 负载 {{ cpu.load1 ?? '-' }}</div>
      </el-card>

      <el-card class="stat-card" shadow="hover">
        <div class="stat-label">内存使用率</div>
        <div class="stat-value"><span class="num">{{ memory.usedPercent ?? '--' }}</span><span class="unit">%</span></div>
        <div class="stat-sub">{{ fmtBytes(memory.usedBytes) }} / {{ fmtBytes(memory.totalBytes) }}</div>
      </el-card>

      <el-card class="stat-card" shadow="hover">
        <div class="stat-label">磁盘使用率</div>
        <div class="stat-value"><span class="num">{{ disk.usedPercent ?? '--' }}</span><span class="unit">%</span></div>
        <div class="stat-sub">可用 {{ fmtBytes(disk.freeBytes) }} / {{ fmtBytes(disk.totalBytes) }}</div>
      </el-card>
    </div>

    <!-- rtpengine 媒体面（数据来自 rtpengine /metrics） -->
    <div class="stat-row">
      <el-card class="stat-card media-card" shadow="hover">
        <div class="stat-label">媒体会话 · rtpengine</div>
        <div class="stat-value">
          <span class="num">{{ rtp.ok ? (rtp.sessions?.own ?? 0) : '--' }}</span><span class="unit">路</span>
        </div>
        <div class="stat-sub">{{ rtpSub }}</div>
      </el-card>

      <el-card class="stat-card" shadow="hover">
        <div class="stat-label">媒体端口占用</div>
        <div class="stat-value"><span class="num">{{ rtp.ok ? rtp.ports?.used : '--' }}</span><span class="unit">个</span></div>
        <div class="stat-sub">{{ portSub }}</div>
      </el-card>

      <el-card class="stat-card" shadow="hover">
        <div class="stat-label">媒体包速率</div>
        <div class="stat-value"><span class="num">{{ rtp.rates?.pps ?? '--' }}</span><span class="unit">pps</span></div>
        <div class="stat-sub">{{ rateSub }}</div>
      </el-card>

      <el-card class="stat-card" shadow="hover">
        <div class="stat-label">媒体异常</div>
        <div class="stat-value"><span class="num">{{ rtp.ok ? (rtp.errors ?? 0) : '--' }}</span><span class="unit">次</span></div>
        <div class="stat-sub">{{ qualitySub }}</div>
      </el-card>
    </div>

    <!-- 图表区 -->
    <div class="chart-row">
      <el-card class="chart-card" shadow="never">
        <template #header>
          <div class="chart-head"><span>CPU 使用率</span><span class="chart-sub">最近 3 分钟</span></div>
        </template>
        <div ref="cpuEl" class="chart"></div>
      </el-card>

      <el-card class="chart-card" shadow="never">
        <template #header>
          <div class="chart-head"><span>内存使用率</span><span class="chart-sub">最近 3 分钟</span></div>
        </template>
        <div ref="memEl" class="chart"></div>
      </el-card>
    </div>

    <div class="chart-row">
      <el-card class="chart-card" shadow="never">
        <template #header>
          <div class="chart-head"><span>磁盘容量</span><span class="chart-sub">宿主机</span></div>
        </template>
        <div ref="diskEl" class="chart chart-disk"></div>
      </el-card>

      <el-card class="chart-card" shadow="never">
        <template #header>
          <div class="chart-head"><span>并发录音数</span><span class="chart-sub">最近 3 分钟</span></div>
        </template>
        <div ref="activeEl" class="chart"></div>
      </el-card>
    </div>

    <div class="foot">
      每 3 秒刷新 · 最后更新 {{ lastUpdate || '—' }}
      <span v-if="error" class="err">· {{ error }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import * as echarts from 'echarts'
import api from '@/api'

const MAX_POINTS = 60
const POLL_MS = 3000

const activeRecordings = ref(0)
const cpu = ref({ usagePercent: null, cores: null, load1: null })
const memory = ref({ usedPercent: null, usedBytes: null, totalBytes: null })
const disk = ref({ usedPercent: null, freeBytes: null, totalBytes: null })
const rtp = ref({ ok: false, rates: {}, sessions: {}, ports: {}, quality: {} })

const rtpSub = computed(() => {
  if (!rtp.value.ok) return 'rtpengine 未连接（9909 不可达）'
  const s = rtp.value.sessions || {}
  return `用户态流 ${s.streamsUserspace ?? 0} · 外来 ${s.foreign ?? 0} · 累计 ${s.total ?? 0} 通`
})

const portSub = computed(() => {
  if (!rtp.value.ok) return '—'
  const p = rtp.value.ports || {}
  return `空闲 ${p.free ?? 0} / 共 ${p.total ?? 0}`
})

const rateSub = computed(() => {
  if (!rtp.value.ok) return '—'
  const r = rtp.value.rates || {}
  return `媒体验码率 ${fmtBitrate(r.bps)}`
})

const qualitySub = computed(() => {
  if (!rtp.value.ok) return '—'
  const q = rtp.value.quality || {}
  return `丢包 ${q.packetLoss ?? 0} · 乱序 ${q.reordered ?? 0} · 单向 ${q.oneWaySessions ?? 0}`
})
const lastUpdate = ref('')
const error = ref('')

const cpuEl = ref(null)
const memEl = ref(null)
const diskEl = ref(null)
const activeEl = ref(null)

let cpuChart = null
let memChart = null
let diskChart = null
let activeChart = null
let timer = null

const times = []
const cpuSeries = []
const memSeries = []
const activeSeries = []

function fmtBytes(b) {
  if (b == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Number(b)
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

function fmtBitrate(bps) {
  if (bps == null) return '—'
  if (bps < 1000) return `${bps} bps`
  if (bps < 1e6) return `${(bps / 1000).toFixed(1)} Kbps`
  return `${(bps / 1e6).toFixed(2)} Mbps`
}

function nowLabel() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function lineOption(color, data, max = 100) {
  return {
    grid: { left: 44, right: 16, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `${v}%` },
    xAxis: {
      type: 'category',
      data: times,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#dcdfe6' } },
      axisLabel: { color: '#909399', fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max,
      axisLabel: { color: '#909399', fontSize: 10, formatter: '{value}%' },
      splitLine: { lineStyle: { color: '#f0f2f5' } },
    },
    series: [{
      type: 'line',
      smooth: true,
      symbol: 'none',
      data,
      lineStyle: { width: 2, color },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: color + '66' },
          { offset: 1, color: color + '05' },
        ]),
      },
    }],
    animationDuration: 300,
  }
}

function activeOption() {
  return {
    grid: { left: 44, right: 16, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis', valueFormatter: (v) => `${v} 路` },
    xAxis: {
      type: 'category', data: times, boundaryGap: false,
      axisLine: { lineStyle: { color: '#dcdfe6' } },
      axisLabel: { color: '#909399', fontSize: 10 },
    },
    yAxis: {
      type: 'value', minInterval: 1,
      axisLabel: { color: '#909399', fontSize: 10 },
      splitLine: { lineStyle: { color: '#f0f2f5' } },
    },
    series: [{
      type: 'line', smooth: true, symbol: 'none', data: activeSeries,
      lineStyle: { width: 2, color: '#67c23a' },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: '#67c23a66' },
          { offset: 1, color: '#67c23a05' },
        ]),
      },
    }],
    animationDuration: 300,
  }
}

function diskOption() {
  const used = disk.value.usedPercent ?? 0
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} GB ({d}%)' },
    legend: { bottom: 0, icon: 'circle', textStyle: { color: '#606266', fontSize: 12 } },
    series: [{
      type: 'pie',
      radius: ['58%', '78%'],
      center: ['50%', '46%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      label: {
        show: true,
        position: 'center',
        formatter: `{a| ${used}%}\n{b|已用}`,
        rich: {
          a: { fontSize: 24, fontWeight: 600, color: '#303133', lineHeight: 30 },
          b: { fontSize: 12, color: '#909399' },
        },
      },
      emphasis: { label: { show: true } },
      labelLine: { show: false },
      data: [
        { value: +(Number(disk.value.totalBytes - (disk.value.freeBytes ?? 0)) / 1024 / 1024 / 1024).toFixed(2), name: '已用', itemStyle: { color: '#409eff' } },
        { value: +(Number(disk.value.freeBytes ?? 0) / 1024 / 1024 / 1024).toFixed(2), name: '可用', itemStyle: { color: '#e4e7ed' } },
      ],
    }],
  }
}

async function poll() {
  try {
    const { data } = await api.get('/api/system/metrics')
    activeRecordings.value = data.activeRecordings
    cpu.value = data.cpu
    memory.value = data.memory
    disk.value = data.disk
    rtp.value = data.rtpengine || { ok: false, rates: {}, sessions: {}, ports: {}, quality: {} }
    lastUpdate.value = new Date(data.ts).toLocaleTimeString()
    error.value = ''

    const label = nowLabel()
    times.push(label)
    cpuSeries.push(data.cpu.usagePercent)
    memSeries.push(data.memory.usedPercent)
    activeSeries.push(data.activeRecordings)
    if (times.length > MAX_POINTS) {
      times.shift(); cpuSeries.shift(); memSeries.shift(); activeSeries.shift()
    }

    cpuChart?.setOption({ xAxis: { data: times }, series: [{ data: cpuSeries }] })
    memChart?.setOption({ xAxis: { data: times }, series: [{ data: memSeries }] })
    activeChart?.setOption({ xAxis: { data: times }, series: [{ data: activeSeries }] })
    diskChart?.setOption(diskOption())
  } catch (e) {
    error.value = '数据获取失败: ' + (e.response?.data?.error || e.message)
  }
}

function resizeAll() {
  cpuChart?.resize(); memChart?.resize(); diskChart?.resize(); activeChart?.resize()
}

onMounted(() => {
  cpuChart = echarts.init(cpuEl.value)
  memChart = echarts.init(memEl.value)
  diskChart = echarts.init(diskEl.value)
  activeChart = echarts.init(activeEl.value)

  cpuChart.setOption(lineOption('#409eff', cpuSeries))
  memChart.setOption(lineOption('#e6a23c', memSeries))
  activeChart.setOption(activeOption())
  diskChart.setOption(diskOption())

  poll()
  timer = setInterval(poll, POLL_MS)
  window.addEventListener('resize', resizeAll)
})

onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('resize', resizeAll)
  cpuChart?.dispose(); memChart?.dispose(); diskChart?.dispose(); activeChart?.dispose()
})
</script>

<style scoped>
.dashboard { display: flex; flex-direction: column; gap: 16px; }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.stat-card { border-radius: 10px; }
.active-card {
  background: linear-gradient(135deg, #ecf5ff 0%, #d9ecff 100%);
  border-color: #b3d8ff;
}
.stat-label { font-size: 13px; color: #606266; margin-bottom: 10px; }
.stat-value { display: flex; align-items: baseline; gap: 4px; }
.stat-value .num { font-size: 32px; font-weight: 700; color: #303133; line-height: 1; }
.active-card .stat-value .num { color: #0960bd; }
.stat-value .unit { font-size: 14px; color: #909399; }
.stat-sub { margin-top: 10px; font-size: 12px; color: #909399; display: flex; align-items: center; gap: 6px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #c0c4cc; display: inline-block; }
.dot.live { background: #67c23a; box-shadow: 0 0 0 3px #67c23a33; animation: pulse 1.6s infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 #67c23a55; } 70% { box-shadow: 0 0 0 6px #67c23a00; } 100% { box-shadow: 0 0 0 0 #67c23a00; } }

.chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.chart-card { border-radius: 10px; }
.chart-head { display: flex; justify-content: space-between; align-items: center; font-size: 14px; font-weight: 600; color: #303133; }
.chart-sub { font-size: 12px; color: #909399; font-weight: 400; }
.chart { height: 150px; width: 100%; }
.chart-disk { height: 150px; }
.foot { font-size: 12px; color: #909399; text-align: right; }
.err { color: #f56c6c; }

@media (max-width: 1100px) {
  .stat-row { grid-template-columns: repeat(2, 1fr); }
  .chart-row { grid-template-columns: 1fr; }
}
</style>

