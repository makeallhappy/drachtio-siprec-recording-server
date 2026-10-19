<template>
  <div class="wave-player">
    <div class="wave-toolbar">
      <el-button-group>
        <el-button size="small" :icon="VideoPlay" @click="togglePlay">{{ playing ? '暂停' : '播放' }}</el-button>
        <el-button size="small" @click="stopAll">停止</el-button>
      </el-button-group>
      <span class="time">{{ fmtTime(currentTime) }} / {{ fmtTime(duration) }}</span>
      <div class="channel-btns">
        <el-button size="small" :type="channelMode === 'both' ? 'primary' : ''" @click="setChannel('both')">双轨</el-button>
        <el-button size="small" :type="channelMode === 'left' ? 'primary' : ''" @click="setChannel('left')">主叫</el-button>
        <el-button size="small" :type="channelMode === 'right' ? 'primary' : ''" @click="setChannel('right')">被叫</el-button>
      </div>
    </div>
    <div ref="waveformEl" class="waveform"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import WaveSurfer from 'wavesurfer.js'
import { VideoPlay } from '@element-plus/icons-vue'

const props = defineProps({
  url: { type: String, default: '' }, // 音频 URL(blob 或 http)
  format: { type: String, default: '' },
})

const waveformEl = ref(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const channelMode = ref('both') // both | left | right

let ws = null

// ---- 方案B:我们自己的播放图(BufferSource),与 wavesurfer 波形图完全独立 ----
let audioCtx = null
let sourceNode = null      // BufferSource(播放解码后的 AudioBuffer)
let splitter = null
let gainL = null
let gainR = null
let merger = null
let audioBuffer = null     // 解码后的双声道 AudioBuffer
let startTime = 0          // source 开始播放的 ctx.currentTime
let startOffset = 0        // 已播放位置(秒),用于暂停/恢复/seek
let playingToken = 0       // 用于取消异步 seek 后的陈旧回调

function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// ---------- 初始化 wavesurfer(只管波形显示,静音) ----------
function initWaveSurfer() {
  if (!waveformEl.value) return
  ws = WaveSurfer.create({
    container: waveformEl.value,
    waveColor: '#409eff',
    progressColor: '#0960bd',
    cursorColor: '#f56c6c',
    cursorWidth: 2,
    height: 80,
    splitChannels: true,
    splitChannelsOptions: {
      overlay: false,
      channelColors: {
        0: { waveColor: '#67c23a', progressColor: '#529b2e' }, // 左=主叫
        1: { waveColor: '#e6a23c', progressColor: '#b88230' }, // 右=被叫
      },
    },
    backend: 'WebAudio',
    interact: true,
    // 让 wavesurfer 不实际出声(由我们的 BufferSource 出声)
    volume: 0,
  })

  ws.on('decode', () => {
    // 解码完成:取回 AudioBuffer 建立我们的播放图
    audioBuffer = ws.getDecodedData()
    if (audioBuffer) setupPlaybackGraph()
  })
  ws.on('interaction', () => {
    // 点击波形跳转 -> 同步我们的播放位置
    const t = ws.getCurrentTime()
    seekTo(t)
  })
  ws.on('destroy', () => {})

  if (props.url) {
    loadUrl(props.url)
  }
}

// ---------- 加载:fetch blob -> decodeAudioData -> wavesurfer 显示波形 ----------
async function loadUrl(url) {
  if (!ws || !url) return
  stopAll()
  try {
    // 把 URL(blob)抓下来自己解码(得到 AudioBuffer,用于声道控制)
    const resp = await fetch(url)
    const blob = await resp.blob()
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    audioBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer())
    // 让 wavesurfer 也加载同一份 blob,渲染波形(volume=0 静音)
    await ws.loadBlob(blob)
  } catch (e) {
    console.error('[WavePlayer] load failed:', e)
  }
}

// ---------- 建立播放图:BufferSource -> splitter -> gainL/gainR -> merger -> destination ----------
function setupPlaybackGraph() {
  if (!audioCtx || !audioBuffer) return
  // 清理旧的
  teardownSource()
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})

  splitter = audioCtx.createChannelSplitter(2)
  gainL = audioCtx.createGain()
  gainR = audioCtx.createGain()
  merger = audioCtx.createChannelMerger(2)

  splitter.connect(gainL, 0)
  splitter.connect(gainR, 1)
  gainL.connect(merger, 0, 0)
  gainR.connect(merger, 0, 1)
  merger.connect(audioCtx.destination)

  // 从 buffer 创建源
  sourceNode = audioCtx.createBufferSource()
  sourceNode.buffer = audioBuffer
  sourceNode.connect(splitter)
  sourceNode.onended = () => { playing.value = false }

  applyChannelMode()
}

function teardownSource() {
  if (sourceNode) {
    try { sourceNode.onended = null; sourceNode.stop() } catch {}
    sourceNode.disconnect()
    sourceNode = null
  }
  if (splitter) { try { splitter.disconnect() } catch {} splitter = null }
  if (gainL) { try { gainL.disconnect() } catch {} gainL = null }
  if (gainR) { try { gainR.disconnect() } catch {} gainR = null }
  if (merger) { try { merger.disconnect() } catch {} merger = null }
}

// ---------- 播放控制 ----------
function startPlayback(offsetSec) {
  if (!audioCtx || !audioBuffer || !sourceNode) return
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  teardownSource()
  setupPlaybackGraph()
  sourceNode = audioCtx.createBufferSource()
  sourceNode.buffer = audioBuffer
  sourceNode.connect(splitter)
  startOffset = offsetSec || 0
  startTime = audioCtx.currentTime
  sourceNode.start(0, startOffset)
  sourceNode.onended = () => { playing.value = false }
  playing.value = true
}

function stopAll() {
  playingToken++
  teardownSource()
  startOffset = 0
  startTime = 0
  playing.value = false
  if (ws) {
    try { ws.setTime(0) } catch {}
  }
  currentTime.value = 0
}

function togglePlay() {
  if (!audioBuffer || !audioCtx) return
  if (playing.value) {
    // 暂停:记录当前位置
    const pos = audioCtx.currentTime - startTime + startOffset
    teardownSource()
    startOffset = pos
    playing.value = false
  } else {
    startPlayback(startOffset)
    // 同步波形到当前位置
    if (ws) { try { ws.setTime(startOffset) } catch {} }
  }
}

function seekTo(t) {
  if (!audioBuffer || !audioCtx) return
  const wasPlaying = playing.value
  const token = ++playingToken
  teardownSource()
  startOffset = Math.max(0, Math.min(t, audioBuffer.duration))
  if (wasPlaying) {
    startPlayback(startOffset)
    setTimeout(() => { if (token === playingToken) { /* 防抖 */ } }, 0)
  } else {
    currentTime.value = startOffset
  }
}

// 进度刷新(wavesurfer audioprocess 不适合我们独立的 source,用 rAF 算)
let rafId = null
function tick() {
  if (playing.value && audioCtx && sourceNode) {
    const pos = audioCtx.currentTime - startTime + startOffset
    if (pos >= (audioBuffer ? audioBuffer.duration : 0) - 0.02) {
      currentTime.value = audioBuffer ? audioBuffer.duration : 0
      playing.value = false
    } else {
      currentTime.value = pos
      // 同步波形进度
      if (ws) { try { ws.setTime(pos) } catch {} }
    }
  }
  rafId = requestAnimationFrame(tick)
}

// ---------- 声道切换 ----------
function applyChannelMode() {
  if (!gainL || !gainR) return
  if (channelMode.value === 'both') {
    gainL.gain.value = 1
    gainR.gain.value = 1
  } else if (channelMode.value === 'left') {
    gainL.gain.value = 1
    gainR.gain.value = 0
  } else if (channelMode.value === 'right') {
    gainL.gain.value = 0
    gainR.gain.value = 1
  }
}

function setChannel(mode) {
  channelMode.value = mode
  applyChannelMode()
}

watch(() => props.url, (newUrl) => {
  if (newUrl) loadUrl(newUrl)
})

onMounted(() => {
  initWaveSurfer()
  rafId = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  playingToken++
  teardownSource()
  if (audioCtx) { try { audioCtx.close() } catch {} audioCtx = null }
  if (ws) { try { ws.destroy() } catch {} ws = null }
})
</script>

<style scoped>
.wave-player {
  width: 100%;
}
.wave-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.time {
  font-size: 12px;
  color: #606266;
  font-family: monospace;
}
.channel-btns {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.waveform {
  width: 100%;
  min-height: 80px;
  background: #fff;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
}
</style>
