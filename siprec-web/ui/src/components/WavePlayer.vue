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
import { canNativeDecodeFlac, decodeAudioSmart } from '@/utils/flac-decode'

const props = defineProps({
  url: { type: String, default: '' }, // 音频 URL(blob 或 http)
  format: { type: String, default: '' }, // 音频格式提示: 'wav' | 'flac' | 'mp3'(blob URL 无后缀时用)
})

const waveformEl = ref(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const channelMode = ref('both') // both | left | right

let ws = null

function fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function initWaveSurfer() {
  if (!waveformEl.value) return
  ws = WaveSurfer.create({
    container: waveformEl.value,
    waveColor: '#409eff',
    progressColor: '#0960bd',
    cursorColor: '#f56c6c',
    cursorWidth: 2,
    height: 80,
    splitChannels: true, // 关键:双轨分别显示
    splitChannelsOptions: {
      overlay: false, // 上下排列,不叠加
      channelColors: {
        0: { waveColor: '#67c23a', progressColor: '#529b2e' }, // 左=主叫,绿色
        1: { waveColor: '#e6a23c', progressColor: '#b88230' }, // 右=被叫,橙色
      },
    },
    backend: 'WebAudio',
    interact: true, // 点击波形跳转
  })

  ws.on('ready', () => {
    duration.value = ws.getDuration()
  })
  ws.on('audioprocess', (t) => { currentTime.value = t })
  ws.on('play', () => { playing.value = true })
  ws.on('pause', () => { playing.value = false })
  ws.on('finish', () => { playing.value = false })

  if (props.url) {
    loadUrl(props.url)
  }
}

/** 判断是否为 FLAC(显式 format 优先,其次 URL 后缀) */
function isFlac(url) {
  if (props.format) return props.format.toLowerCase() === 'flac'
  return /\.flac(\?|$)/i.test(url)
}

/**
 * 加载音频:WAV 直接 load;FLAC 检测原生支持,iOS 不支持则用 libflacjs 解码成 AudioBuffer 再 loadDecodedBuffer
 */
async function loadUrl(url) {
  if (!ws || !url) return

  // WAV / MP3 等浏览器普遍支持的格式,直接 load
  if (!isFlac(url)) {
    ws.load(url)
    return
  }

  // FLAC:先检测原生支持
  const nativeOk = await canNativeDecodeFlac()
  if (nativeOk) {
    ws.load(url)
    return
  }

  // iOS Safari 等:用 libflacjs 解码成 AudioBuffer
  try {
    const resp = await fetch(url)
    const blob = await resp.blob()
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    const audioBuffer = await decodeAudioSmart(blob, audioCtx)
    // wavesurfer 支持直接加载解码后的 AudioBuffer
    ws.loadDecodedBuffer(audioBuffer)
  } catch (e) {
    console.error('[WavePlayer] libflacjs decode failed:', e)
    // 最后兜底:还是尝试直接 load(让 wavesurfer 自己处理,可能会失败)
    ws.load(url)
  }
}

function togglePlay() {
  if (ws) ws.playPause()
}

function stopAll() {
  if (ws) ws.stop()
}

function setChannel(mode) {
  channelMode.value = mode
  if (!ws) return
  // wavesurfer v7 的 setMuted 是全局的;要实现单轨听,得用 Web Audio API 的 ChannelSplitter
  // 这里用简单方案:调整左右声道音量(通过 backend 的 gainNode)
  const backend = ws.getBackend?.()
  if (backend && backend.gainNode) {
    // 简化:通过 setVolume 做不到分左右,先标记模式(后续可扩展)
  }
}

watch(() => props.url, (newUrl) => {
  if (newUrl) loadUrl(newUrl)
})

onMounted(() => {
  initWaveSurfer()
})

onBeforeUnmount(() => {
  if (ws) {
    try { ws.destroy() } catch {}
    ws = null
  }
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
