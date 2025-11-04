// server.js - Real Grok AI + Video Generator
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
app.use(express.static('.')); // Serve index.html

// === CONFIG ===
const XAI_API_KEY = process.env.XAI_API_KEY;
if (!XAI_API_KEY) {
  console.error('ERROR: Add XAI_API_KEY to .env file!');
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

const TEMP_DIR = path.join(__dirname, 'temp');
fs.ensureDirSync(TEMP_DIR);

// === HELPERS ===
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function formatTime(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${h}:${m}:${s},000`;
}

function generateSRT(script, duration) {
  const lines = script.split('\n').map(l => l.trim()).filter(Boolean);
  const perLine = Math.max(2, Math.floor(duration / lines.length));
  let srt = '';
  lines.forEach((line, i) => {
    const start = i * perLine;
    const end = Math.min(start + perLine, duration);
    srt += `${i + 1}\n${formatTime(start)} --> ${formatTime(end)}\n${line}\n\n`;
  });
  return srt;
}

async function fetchPexelsVideo(query) {
  try {
    const res = await axios.get('https://api.pexels.com/videos/search', {
      params: { query, per_page: 1, orientation: 'landscape' },
      headers: { Authorization: '563492ad6f91700001000001e5a4d7b7e4a04b0b8b4e4e4e4e4e4e4e' }
    });
    return res.data.videos[0]?.video_files[0]?.link || null;
  } catch {
    return 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
  }
}

function generateTTS(text, voice, outputPath) {
  return new Promise((resolve, reject) => {
    // Simple fallback: use macOS 'say' command or skip
    const cmd = process.platform === 'darwin'
      ? `say -v ${voice.includes('Female') ? 'Samantha' : 'Alex'} "${text.replace(/"/g, '\\"')}" -o "${outputPath}"`
      : `echo "TTS not supported on this OS" > "${outputPath}"`;

    require('child_process').exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// === ROUTES ===

// 1. Generate Script with Grok
app.post('/api/generate-script', async (req, res) => {
  const { topic, duration = 60, style, voice, unlimited } = req.body;
  const model = unlimited ? 'grok-4' : 'grok-3-mini';

  const prompt = `Write a ${duration}-second video script about "${topic}". 
Style: ${style}. Voice: ${voice}. 
Keep each line short for subtitles. 
Return only the script, one sentence per line.`;

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 500
    });

    const script = completion.choices[0].message.content.trim();
    const srt = generateSRT(script, duration);

    res.json({ script, srt });
  } catch (e) {
    log('Script error: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});

// 2. Generate Full Video
app.post('/api/generate-video', async (req, res) => {
  const { script, srt, music, voice, duration = 60 } = req.body;
  const jobId = uuidv4();
  const dir = path.join(TEMP_DIR, jobId);
  fs.ensureDirSync(dir);

  const files = {
    bg: path.join(dir, 'bg.mp4'),
    audio: path.join(dir, 'voice.aiff'),
    srt: path.join(dir, 'subs.srt'),
    temp: path.join(dir, 'temp.mp4'),
    final: path.join(dir, 'final.mp4')
  };

  try {
    log(`Starting video job ${jobId}`);

    // Step 1: Save SRT
    await fs.writeFile(files.srt, srt);

    // Step 2: Download Background Video
    const bgUrl = await fetchPexelsVideo(style);
    const bgRes = await axios({ url: bgUrl, responseType: 'stream' });
    await new Promise((resolve, reject) => {
      bgRes.data.pipe(fs.createWriteStream(files.bg))
        .on('finish', resolve)
        .on('error', reject);
    });

    // Step 3: Trim BG to Duration
    await new Promise((resolve, reject) => {
      ffmpeg(files.bg)
        .setDuration(duration)
        .outputOptions('-c copy')
        .save(files.temp)
        .on('end', resolve)
        .on('error', reject);
    });

    // Step 4: Generate Voice (TTS)
    await generateTTS(script, voice, files.audio);

    // Step 5: Overlay Audio
    await new Promise((resolve, reject) => {
      ffmpeg(files.temp)
        .input(files.audio)
        .outputOptions('-c:v copy', '-c:a aac', '-shortest')
        .save(files.temp)
        .on('end', resolve)
        .on('error', reject);
    });

    // Step 6: Burn Subtitles
    await new Promise((resolve, reject) => {
      ffmpeg(files.temp)
        .videoFilters(`subtitles=${files.srt.replace(/:/g, '\\:')}:force_style='Fontsize=24,PrimaryColour=&Hffffff&,OutlineColour=&H0&,BackColour=&H80000000&,Bold=1'`)
        .outputOptions('-c:v libx264', '-pix_fmt yuv420p')
        .save(files.final)
        .on('end', resolve)
        .on('error', reject);
    });

    // Step 7: Stream Video
    res.set('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(files.final);
    stream.pipe(res);

    stream.on('end', () => {
      setTimeout(() => fs.remove(dir), 5000);
      log(`Video sent: ${jobId}`);
    });

  } catch (e) {
    log(`Video failed: ${e.message}`);
    await fs.remove(dir);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// === START SERVER ===
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\nServer running at http://localhost:${PORT}`);
  console.log(`Open index.html in browser`);
  console.log(`Make sure you have:\n   → .env with XAI_API_KEY\n   → FFmpeg installed\n`);
});
