#!/usr/bin/env node
// pcap2audio.js —— 把 rtpengine 录的 pcap(RTP/PCMA)转成 WAV(可选经 docker ffmpeg 转 MP3/FLAC)
// 零依赖,纯 Node 标准库。
//
// 用法:
//   node pcap2audio.js in.pcap                 # 生成同名 .wav(立体声:左=腿1,右=腿2)
//   node pcap2audio.js in.pcap --mix           # 单声道混音
//   node pcap2audio.js in.pcap --mp3|--flac    # 先出 wav 再调 docker ffmpeg 转码
//   node pcap2audio.js recordings/pcaps/ --all # 批量转目录下所有 pcap
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------- G.711 A-law 解码 ----------
const ALAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let a = 0; a < 256; a++) {
    const v = a ^ 0x55;
    const seg = (v & 0x70) >> 4;
    let pcm = (v & 0x0f) << 4;
    if (seg === 0) pcm += 8;
    else if (seg === 1) pcm += 0x108;
    else { pcm += 0x108; pcm <<= (seg - 1); }
    t[a] = (v & 0x80) ? pcm : -pcm;
  }
  return t;
})();

function alawDecode(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ALAW_TABLE[buf[i]];
  return out;
}

// ---------- G.711 μ-law 解码(PT=0) ----------
const ULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let u = 0; u < 256; u++) {
    const v = u ^ 0xff;
    let pcm = 0;
    if ((v & 0x80) !== 0) pcm = (v & 0x0f) << 3 | 0x84;
    else pcm = (v & 0x0f) << 3 | 0x04;
    const exp = (v >> 4) & 0x07;
    pcm = exp === 0 ? pcm : pcm << exp;
    t[u] = (v & 0x80) ? pcm : -pcm;
  }
  return t;
})();

function ulawDecode(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ULAW_TABLE[buf[i]];
  return out;
}

// ---------- pcap / RTP 解析 ----------
// 注意：rtpengine 的 pcap 默认写 LINKTYPE_RAW(101)，即每个包直接从 IPv4 头开始，
// 没有 Ethernet 头。旧实现固定从 14 字节 Ethernet 头解析，导致所有包被丢弃、
// 报 “pcap 里没有 G.711 的 RTP 包”，播放接口 500。这里按 pcap 全局头的 linktype 分派。
function ipOffsetForLinktype(pkt, linktype) {
  switch (linktype) {
    case 101: // LINKTYPE_RAW：直接 IPv4/IPv6
    case 12:  // LINKTYPE_RAW_ALT
      return 0;
    case 113: // Linux SLL
      return 16;
    case 276: // Linux SLL2
      return 20;
    case 0:   // BSD loopback
      return 4;
    case 1: { // Ethernet(含 802.1Q/802.1ad)
      if (pkt.length < 14) return -1;
      let off = 14;
      let etype = pkt.readUInt16BE(12);
      while (etype === 0x8100 || etype === 0x88a8) {
        if (pkt.length < off + 4) return -1;
        etype = pkt.readUInt16BE(off + 2);
        off += 4;
      }
      return etype === 0x0800 ? off : -1;
    }
    default:
      return -1;
  }
}

/** 从帧里取出 RTP 负载；无法识别时返回 null */
function rtpFromFrame(pkt, linktype) {
  let off = ipOffsetForLinktype(pkt, linktype);
  // 未知 linktype 时容错尝试常见偏移（raw IP / Ethernet）
  if (off < 0 && linktype !== 1) {
    for (const cand of [0, 14, 16, 20]) {
      if (pkt.length > cand && (pkt[cand] >> 4) === 4) { off = cand; break; }
    }
  }
  if (off < 0 || pkt.length < off + 20) return null;

  const ip = pkt.subarray(off);
  const ver = ip[0] >> 4;
  if (ver === 4) {
    const ihl = (ip[0] & 0x0f) * 4;
    if (ip[9] !== 17 || ip.length < ihl + 8) return null;
    return ip.subarray(ihl + 8);
  }
  if (ver === 6) {
    // 仅处理无扩展头的 UDP
    if (ip[6] !== 17 || ip.length < 48) return null;
    return ip.subarray(48);
  }
  return null;
}

function parsePcapRtp(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24) return new Map();
  const magic = buf.readUInt32BE(0);
  const be = magic === 0xa1b2c3d4;
  if (!be && magic !== 0xd4c3b2a1) throw new Error(`${file}: 不是标准 pcap 文件`);
  const linktype = be ? buf.readUInt32BE(20) : buf.readUInt32LE(20);

  const legs = new Map(); // ssrc -> [{seq, payload}]
  let off = 24;
  while (off + 16 <= buf.length) {
    const incl = be ? buf.readUInt32BE(off + 8) : buf.readUInt32LE(off + 8);
    off += 16;
    const pkt = buf.subarray(off, off + incl);
    off += incl;
    if (pkt.length < 12) continue;

    const rtp = rtpFromFrame(pkt, linktype);
    if (!rtp || rtp.length < 12) continue;
    // RTP: v2, PT=0 (PCMU) 或 PT=8 (PCMA)
    if ((rtp[0] >> 6) !== 2) continue;
    const pt = rtp[1] & 0x7f;
    if (pt !== 0 && pt !== 8) continue;
    let hdr = 12 + (rtp[0] & 0x0f) * 4;
    if (rtp[0] & 0x10) { // header extension
      if (rtp.length < hdr + 4) continue;
      hdr += 4 + rtp.readUInt16BE(hdr + 2) * 4;
    }
    if (rtp.length <= hdr) continue;
    const seq = rtp.readUInt16BE(2);
    const ssrc = rtp.readUInt32BE(8);
    if (!legs.has(ssrc)) legs.set(ssrc, []);
    legs.get(ssrc).push({ seq, pt, payload: rtp.subarray(hdr) });
  }
  return legs;
}

// ---------- 合成 WAV ----------
function writeWav(outPath, legs, mix) {
  if (legs.size === 0) throw new Error('pcap 里没有 G.711(PCMU PT=0 / PCMA PT=8)的 RTP 包');
  const decoded = [];
  for (const ssrc of [...legs.keys()].sort((a, b) => a - b)) {
    const pkts = legs.get(ssrc).sort((a, b) => a.seq - b.seq);
    const pcm = [];
    for (const p of pkts) {
      // PT=0 -> μ-law, PT=8 -> A-law
      pcm.push(...(p.pt === 0 ? ulawDecode(p.payload) : alawDecode(p.payload)));
    }
    decoded.push(pcm);
  }
  if (decoded.length === 1) decoded.push([]); // 单路时右路补静音
  const n = Math.max(decoded[0].length, decoded[1].length);
  const L = decoded[0], R = decoded[1];

  const channels = mix ? 1 : 2;
  const dataSize = n * 2 * channels;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataSize, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000 * channels * 2, 28); header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(dataSize, 40);

  const frames = Buffer.alloc(dataSize);
  for (let i = 0; i < n; i++) {
    const l = L[i] || 0, r = R[i] || 0;
    if (mix) {
      let m = Math.round((l + r) / 2);
      m = Math.max(-32768, Math.min(32767, m));
      frames.writeInt16LE(m, i * 2);
    } else {
      frames.writeInt16LE(l, i * 4);
      frames.writeInt16LE(r, i * 4 + 2);
    }
  }
  fs.writeFileSync(outPath, Buffer.concat([header, frames]));
  return n;
}

// ---------- ffmpeg 转 mp3/flac ----------
const FFMPEG_IMG = 'jrottenberg/ffmpeg:4.4-alpine';

function hasLocalFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe' });
  return !r.error && r.status === 0;
}

function transcode(wavPath, fmt) {
  const dir = path.dirname(path.resolve(wavPath));
  const base = path.basename(wavPath);
  const out = base.replace(/\.wav$/, '.' + fmt);
  const codec = fmt === 'mp3' ? ['-codec:a', 'libmp3lame', '-q:a', '4'] : ['-codec:a', 'flac'];
  if (hasLocalFfmpeg()) {
    // 容器/装了 ffmpeg 的宿主机:直接本地转码
    execFileSync('ffmpeg', ['-y', '-i', wavPath, ...codec, path.join(dir, out)], { stdio: 'pipe' });
  } else {
    // 无本地 ffmpeg:回退 docker 镜像转码
    execFileSync('docker', ['run', '--rm', '-v', `${dir}:/work`, '-w', '/work',
      FFMPEG_IMG, '-y', '-i', base, ...codec, out], { stdio: 'pipe' });
  }
  return path.join(dir, out);
}

// ---------- main ----------
function convert(pcap, mix, fmt) {
  const wavPath = pcap.replace(/\.pcap$/, '') + '.wav';
  const legs = parsePcapRtp(pcap);
  const samples = writeWav(wavPath, legs, mix);
  console.log(`${pcap} -> ${wavPath}  (${legs.size} 路 RTP, ${(samples / 8000).toFixed(1)} 秒)`);
  if (fmt) console.log(`       -> ${transcode(wavPath, fmt)}`);
}

const argv = process.argv.slice(2);
const files = argv.filter(a => !a.startsWith('--'));
const mix = argv.includes('--mix');
const fmt = argv.includes('--mp3') ? 'mp3' : (argv.includes('--flac') ? 'flac' : null);
if (files.length === 0) { console.log('用法: node pcap2audio.js <in.pcap|目录> [--mix] [--mp3|--flac] [--all]'); process.exit(1); }

const target = files[0];
if (argv.includes('--all') || fs.statSync(target).isDirectory()) {
  for (const name of fs.readdirSync(target).sort()) {
    if (name.endsWith('.pcap')) {
      const p = path.join(target, name);
      if (fs.statSync(p).size > 24) convert(p, mix, fmt);
    }
  }
} else {
  convert(target, mix, fmt);
}
