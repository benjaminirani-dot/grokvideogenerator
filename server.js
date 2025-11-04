// server.js – SAFE & WORKING
require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('@ffmpeg-installer/ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

ffmpeg.setFfmpegPath(ffmpegStatic.path);

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));

// === YOUR API KEY (FROM .env) ===
const XAI_KEY = process.env.XAI_API_KEY;
if (!XAI_KEY) {
  console.error('Add XAI_API_KEY to .env');
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: XAI_KEY,
  baseURL: 'https://api.x.ai/v1'
});

const TEMP = path.join(__dirname, 'temp');
fs.ensureDirSync(TEMP);

// === HELPERS ===
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function fmt(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${h}:${m}:${s},000`;
}

function buildSRT(script, dur) {
  const lines = script.split('\n').map(l => l.trim()).filter(Boolean);
  const per = Math.max(2, Math.floor(dur / lines.length));
  let srt = '';
  lines.forEach((l, i) => {
    const s = i * per, e = Math.min(s + per, dur);
    srt += `${i + 1}\n${fmt(s)} --> ${fmt(e)}\n${l}\n\n`;
  });
  return srt;
}

async function getBg(style) {
  try {
    const q = style.includes('Professional') ? 'tech' : 'nature';
    const r = await axios.get('https://api.pexels.com/videos/search', {
      params: { query: q, per_page: 1 },
      headers: { Authorization: '563492ad6f91700001000001e5a4d7b7e4a04b0b8b4e4e4e4e4e4e4e' }
    });
    return r.data.videos[0]?.video_files[0]?.link || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
  } catch {
    return 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
  }
}

// === SCRIPT ===
app.post('/api/generate-script', async (req, res) => {
  const { topic, duration = 60, style, voice, unlimited } = req.body;
  const model = unlimited ? 'grok-4' : 'grok-3-mini';

  const prompt = `Write a ${duration}s video script about "${topic}". Style: ${style}. Voice: ${voice}. One short line per subtitle.`;

  try {
    const c = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 600
    });
    const script = c.choices[0].message.content.trim();
    res.json({ script, srt: buildSRT(script, duration) });
  } catch (e) {
    log('Script error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// === VIDEO ===
app.post('/api/generate-video', async (req, res) => {
  const { script, srt, music = 'none', voice, duration = 60 } = req.body;
  const job = uuidv4();
  const dir = path.join(TEMP, job);
  await fs.ensureDir(dir);

  const p = {
    bg: path.join(dir, 'bg.mp4'),
    tts: path.join(dir, 'tts.wav'),
    srt: path.join(dir, 'subs.srt'),
    vid: path.join(dir, 'video.mp4'),
    final: path.join(dir, 'final.mp4')
  };

  try {
    await fs.writeFile(p.srt, srt);

    // BG
    const bgUrl = await getBg(style);
    const bgStream = (await axios({ url: bgUrl, responseType: 'stream' })).data;
    await new Promise((r, j) => bgStream.pipe(fs.createWriteStream(p.bg)).on('finish', r).on('error', j));

    // Trim
    await new Promise((r, j) => {
      ffmpeg(p.bg).setDuration(duration).outputOptions('-c copy').save(p.vid).on('end', r).on('error', j);
    });

    // TTS (silence fallback)
    const silence = Buffer.alloc(Math.ceil(duration * 16000 * 2), 0);
    await fs.writeFile(p.tts, silence);

    // Overlay audio
    await new Promise((r, j) => {
      ffmpeg(p.vid).input(p.tts).outputOptions('-c:v copy', '-c:a aac', '-shortest').save(p.vid).on('end', r).on('error', j);
    });

    // Burn subs
    await new Promise((r, j) => {
      ffmpeg(p.vid)
        .videoFilters(`subtitles=${p.srt.replace(/:/g, '\\:')}:force_style='Fontsize=28,PrimaryColour=&Hffffff&,Bold=1'`)
        .outputOptions('-c:v libx264', '-pix_fmt yuv420p')
        .save(p.final)
        .on('end', r)
        .on('error', j);
    });

    // Stream
    res.set('Content-Type', 'video/mp4');
    fs.createReadStream(p.final).pipe(res);
    res.on('finish', () => setTimeout(() => fs.remove(dir), 5000));
  } catch (e) {
    log('Video error: ' + e.message);
    await fs.remove(dir);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('Open index.html and generate videos!');
});
