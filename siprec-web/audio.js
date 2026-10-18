/**
 * audio.js —— 录音音频服务
 *
 * 按元数据的 original_call_id 在 recordings/pcaps/ 找对应 pcap(<callid>-<random>.pcap),
 * 用 tools/pcap2audio.js 转成 wav/mp3,缓存到 recordings/cache/,再带 HTTP Range 流式返回。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// 容器里挂 /recordings(见 docker run -v);宿主机开发默认项目根下 recordings
const REC_ROOT = process.env.RECORDING_ROOT || (fs.existsSync('/recordings') ? '/recordings' : path.join(__dirname, '..', 'recordings'));
const PCAP_DIR = process.env.RECORDING_PCAP_DIR || path.join(REC_ROOT, 'pcaps');
const FLAC_DIR = process.env.RECORDING_FLAC_DIR || path.join(REC_ROOT, 'flac'); // 冷热分层归档(archive-recordings.sh 产出)
const CACHE_DIR = process.env.RECORDING_CACHE_DIR || path.join(REC_ROOT, 'cache');
// 容器里转换器在 /app/tools/(与 server.js 同级,见 Dockerfile);宿主机开发在项目根 tools/
const CONVERTER = [path.join(__dirname, 'tools', 'pcap2audio.js'),
                   path.join(__dirname, '..', 'tools', 'pcap2audio.js')]
  .find((p) => fs.existsSync(p));
const ALLOWED_FMT = new Set(['wav', 'mp3', 'flac']);

fs.mkdirSync(CACHE_DIR, { recursive: true });

// RTP engine 写 pcap 需要时间;短呼可能等一会儿才出现
const PCAP_WAIT_MS = Number(process.env.RECORDING_PCAP_WAIT_MS || 0);

/** call-id 里的 @ 在 pcap 文件名里被 URL 编码为 %40 */
function encodeCallId(callid) {
  return callid.replace(/@/g, '%40');
}

/**
 * 按 original_call_id 找 pcap 文件。
 * rtpengine 命名:<callid>-<random>.pcap,callid 中 @ 编码为 %40。
 * 取该 call-id 前缀下最新的一个。
 */
function findPcap(callid) {
  if (!callid) return null;
  const prefix = encodeCallId(callid) + '-';
  let best = null;
  let bestMtime = 0;
  let names = [];
  try { names = fs.readdirSync(PCAP_DIR); } catch { return null; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.pcap')) continue;
    const p = path.join(PCAP_DIR, name);
    const st = fs.statSync(p);
    if (st.size <= 24) continue; // 空 pcap(只有头部)
    if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p; }
  }
  return best;
}

/**
 * 按 original_call_id 找归档 FLAC(冷热分层后 pcap 已删,FLAC 在 recordings/flac/)。
 * 命名与 pcap 相同,只是后缀 .flac。
 */
function findArchivedFlac(callid) {
  if (!callid) return null;
  const prefix = encodeCallId(callid) + '-';
  let best = null;
  let bestMtime = 0;
  let names = [];
  try { names = fs.readdirSync(FLAC_DIR); } catch { return null; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.flac')) continue;
    const p = path.join(FLAC_DIR, name);
    const st = fs.statSync(p);
    if (st.size <= 4) continue;
    if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p; }
  }
  return best;
}

/** 确保 pcap 已转成目标格式,返回音频文件路径;失败抛错 */
function ensureAudio(pcapPath, fmt) {
  return new Promise((resolve, reject) => {
    const base = path.basename(pcapPath).replace(/\.pcap$/, '');
    const target = path.join(CACHE_DIR, `${base}.${fmt}`);
    if (fs.existsSync(target) && fs.statSync(target).size > 44) {
      return resolve(target); // 已缓存
    }
    const args = [CONVERTER, pcapPath];
    if (fmt !== 'wav') args.push(`--${fmt}`);
    // 转换产物默认落在 pcap 同目录;转到后再挪到缓存目录
    execFile(process.execPath, args, { timeout: 60000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`convert failed: ${stderr || err.message}`));
      const produced = pcapPath.replace(/\.pcap$/, `.${fmt}`);
      if (!fs.existsSync(produced)) return reject(new Error(`converter did not produce ${produced}`));
      try {
        fs.renameSync(produced, target);
      } catch (e) {
        try { fs.copyFileSync(produced, target); fs.unlinkSync(produced); }
        catch (e2) { return reject(e2); }
      }
      resolve(target);
    });
  });
}

/**
 * 归档 FLAC → 目标格式。
 * fmt=flac 直接复用(拷入缓存);wav/mp3 用容器内 ffmpeg 转码。
 */
function ensureAudioFromFlac(flacPath, fmt) {
  return new Promise((resolve, reject) => {
    const base = path.basename(flacPath).replace(/\.flac$/, '');
    const target = path.join(CACHE_DIR, `${base}.${fmt}`);
    if (fs.existsSync(target) && fs.statSync(target).size > 4) {
      return resolve(target); // 已缓存
    }
    if (fmt === 'flac') {
      try { fs.copyFileSync(flacPath, target); return resolve(target); }
      catch (e) { return reject(e); }
    }
    // flac → wav/mp3(容器里有 ffmpeg)
    const codecArgs = fmt === 'mp3'
      ? ['-codec:a', 'libmp3lame', '-q:a', '4']
      : ['-codec:a', 'pcm_s16le'];
    execFile('ffmpeg', ['-y', '-i', flacPath, ...codecArgs, target], { timeout: 60000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg flac->${fmt} failed: ${stderr || err.message}`));
      if (!fs.existsSync(target)) return reject(new Error('ffmpeg did not produce output'));
      resolve(target);
    });
  });
}

const MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac' };

/**
 * 按 call-id 解析出可流式返回的音频文件路径(优先 pcap,其次归档 flac)
 * @returns {Promise<string|null>}
 */
async function resolveAudioPath(callid, fmt) {
  if (!callid) return null;
  let pcap = findPcap(callid);
  if (!pcap && PCAP_WAIT_MS > 0) {
    await new Promise((r) => setTimeout(r, PCAP_WAIT_MS));
    pcap = findPcap(callid);
  }
  if (pcap) return ensureAudio(pcap, fmt);
  const archived = findArchivedFlac(callid);
  if (!archived) return null;
  return ensureAudioFromFlac(archived, fmt);
}

/** 带 HTTP Range 的文件流式响应 */
function streamFile(audioPath, fmt, req, res, opts = {}) {
  const stat = fs.statSync(audioPath);
  const mime = MIME[fmt] || 'application/octet-stream';
  const filename = path.basename(audioPath);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (opts.download) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) { res.status(416).end(); return; }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(audioPath, { start, end }).pipe(res);
      return;
    }
  }
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(audioPath).pipe(res);
}

/** 按 call-id 直接流式输出音频(供 /api/v1 复用) */
async function streamForCallId(callid, fmt, req, res, opts = {}) {
  const f = ALLOWED_FMT.has(fmt) ? fmt : 'wav';
  const audioPath = await resolveAudioPath(callid, f);
  if (!audioPath) {
    if (opts.onNotFound) return opts.onNotFound();
    return res.status(404).json({ error: 'no audio' });
  }
  streamFile(audioPath, f, req, res, opts);
}

/**
 * Express 处理器:GET /api/recordings/:table/:id/audio?fmt=wav|mp3|flac[&download=1]
 * 依赖一个查库函数 getCallId(table, id) -> Promise<original_call_id|null>
 */
function audioHandler(getCallId) {
  return async (req, res) => {
    try {
      const fmt = ALLOWED_FMT.has(req.query.fmt) ? req.query.fmt : 'wav';
      const { table, id } = req.params;
      const callid = await getCallId(table, Number(id));
      if (!callid) return res.status(404).json({ error: 'recording not found (no call-id)' });

      let pcap = findPcap(callid);
      if (!pcap && PCAP_WAIT_MS > 0) {
        await new Promise((r) => setTimeout(r, PCAP_WAIT_MS));
        pcap = findPcap(callid);
      }

      let audioPath;
      if (pcap) {
        audioPath = await ensureAudio(pcap, fmt);
      } else {
        // pcap 已被冷热分层归档删除 → 回落到归档 FLAC
        const archived = findArchivedFlac(callid);
        if (!archived) return res.status(404).json({ error: `no pcap or archived flac for call-id ${callid}` });
        audioPath = await ensureAudioFromFlac(archived, fmt);
      }
      const stat = fs.statSync(audioPath);
      const mime = MIME[fmt] || 'application/octet-stream';
      const download = req.query.download === '1';
      const filename = path.basename(audioPath);

      // HTTP Range(拖动进度)
      const range = req.headers.range;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', mime);
      if (download) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          let start = m[1] ? parseInt(m[1], 10) : 0;
          let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (isNaN(start)) start = 0;
          if (isNaN(end) || end >= stat.size) end = stat.size - 1;
          if (start > end) return res.status(416).end();
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
          res.setHeader('Content-Length', end - start + 1);
          return fs.createReadStream(audioPath, { start, end }).pipe(res);
        }
      }
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(audioPath).pipe(res);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  };
}

module.exports = { audioHandler, findPcap, findArchivedFlac, ensureAudio, ensureAudioFromFlac, resolveAudioPath, streamFile, streamForCallId };
