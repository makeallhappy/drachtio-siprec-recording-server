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
  format: { type: String, default: '' }, // 音频格式提示: 'wav' | 'flac' | 'mp3'(blob URL 无后缀时用)
})

const waveformEl = ref(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const channelMode = ref('both') // both | left | right

let ws = null
let audioCtx = null
let splitter = null
let gainL = null
let gainR = null
let merger = null
let sourceNode = null

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
    // 音频加载完成后初始化声道控制
    setupChannelControl()
  })
  ws.on('audioprocess', (t) => { currentTime.value = t })
  ws.on('play', () => { playing.value = true })
  ws.on('pause', () => { playing.value = false })
  ws.on('finish', () => { playing.value = false })

  if (props.url) {
    loadUrl(props.url)
  }
}

function loadUrl(url) {
  if (ws && url) {
    ws.load(url)
  }
}

/** 初始化 Web Audio 声道分离:audio element → ChannelSplitter → GainL/GainR → ChannelMerger → destination */
function setupChannelControl() {
  if (audioCtx) return // 已初始化
  const audio = ws?.getMediaElement?.()
  if (!audio) return

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    sourceNode = audioCtx.createMediaElementSource(audio)
    splitter = audioCtx.createChannelSplitter(2)
    gainL = audioCtx.createGain()
    gainR = audioCtx.createGain()
    merger = audioCtx.createChannelMerger(2)

    sourceNode.connect(splitter)
    splitter.connect(gainL, 0) // 左声道 → gainL
    splitter.connect(gainR, 1) // 右声道 → gainR
    gainL.connect(merger, 0, 0) // gainL → 合并器左
    gainR.connect(merger, 0, 1) // gainR → 合并器右
    merger.connect(audioCtx.destination)

    // 应用当前声道模式
    applyChannelMode()
  } catch (e) {
    console.warn('[WavePlayer] Web Audio 声道控制初始化失败:', e)
  }
}

/** 应用声道模式到 gain 节点 */
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

function togglePlay() {
  if (ws) ws.playPause()
}

function stopAll() {
  if (ws) ws.stop()
}

function setChannel(mode) {
  channelMode.value = mode
  // 如果 Web Audio 还没初始化(可能音频还没 ready),先初始化
  if (!audioCtx) {
    setupChannelControl()
  } else {
    applyChannelMode()
  }
}

watch(() => props.url, (newUrl) => {
  if (newUrl) loadUrl(newUrl)
})

onMounted(() => {
  initWaveSurfer()
})

onBeforeUnmount(() => {
  if (audioCtx) {
    try { audioCtx.close() } catch {}
    audioCtx = null
    splitter = null
    gainL = null
    gainR = null
    merger = null
    sourceNode = null
  }
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
