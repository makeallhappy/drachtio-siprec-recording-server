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
    ws.load(props.url)
  }
}

function loadUrl(url) {
  if (ws && url) {
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
