const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl      = require('@distube/ytdl-core');
const ffmpeg    = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const DOWNLOAD_ROOT = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_ROOT)) fs.mkdirSync(DOWNLOAD_ROOT);

const downloadStatus = {};
const sanitize = s => s.replace(/[<>:"\/\\|?*\u0000-\u001F]/g,'').trim().substring(0,200);

async function downloadVideo(url, type, quality, folder, id, title) {
  const outDir = folder
    ? path.join(DOWNLOAD_ROOT, folder)
    : DOWNLOAD_ROOT;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  downloadStatus[id] = { status:'starting', message:'Iniciando download…', timestamp: new Date().toISOString() };

  // ────── ÁUDIO ────────────────────────────────────────────────────────────
  if (type === 'audio') {
    try {
      // mantém seu bloco de áudio com ytdl + ffmpeg…
      const audioQuality = quality === 'best'
        ? 'highestaudio'
        : quality === 'worst'
          ? 'lowestaudio'
          : `highestaudio[audioBitrate<=${quality}]`;

      const stream = ytdl(url, { quality: audioQuality });
      const filename = `${title}.mp3`;
      const output = path.join(outDir, filename);

      ffmpeg(stream)
        .audioBitrate(quality!=='best'&&quality!=='worst'? parseInt(quality) : 192)
        .save(output)
        .on('progress', p => {
          downloadStatus[id] = {
            status:'downloading',
            message:`Processando: ${p.targetSize}kb`,
            timestamp: new Date().toISOString()
          };
        })
        .on('end', () => {
          downloadStatus[id] = {
            status:'completed',
            message:'Download concluído!',
            timestamp: new Date().toISOString(),
            file: filename
          };
        })
        .on('error', err => {
          downloadStatus[id] = { status:'error', message: err.message, timestamp: new Date().toISOString() };
        });

    } catch (err) {
      downloadStatus[id] = { status:'error', message: err.message, timestamp: new Date().toISOString() };
    }

    return;
  }

  // ────── VÍDEO ────────────────────────────────────────────────────────────
  try {
    const info = await ytdl.getInfo(url);
    const format = info.formats.find(f => String(f.itag) === quality);
    if (!format) throw new Error(`Formato ${quality} não encontrado`);

    const filename = `${title}.mp4`;
    const output   = path.join(outDir, filename);

    if (format.hasVideo && format.hasAudio) {
      // progressivo: áudio+vídeo juntos
      const videoStream = ytdl(url, { filter: f => f.itag == format.itag });
      const fileOut     = fs.createWriteStream(output);

      videoStream.pipe(fileOut);
      videoStream.on('progress', (_chunk, dl, total) => {
        const pct = ((dl/total)*100).toFixed(1);
        downloadStatus[id] = {
          status:'downloading',
          message:`${pct}%`,
          timestamp: new Date().toISOString()
        };
      });
      fileOut.on('finish', () => {
        downloadStatus[id] = {
          status:'completed',
          message:'Download concluído!',
          timestamp: new Date().toISOString(),
          file: filename
        };
      });
      videoStream.on('error', err => {
        downloadStatus[id] = { status:'error', message: err.message, timestamp: new Date().toISOString() };
      });

    } else if (format.hasVideo && !format.hasAudio) {
      // 1) encontra o melhor áudio-only
      const audioFmt = info.formats
        .filter(f => f.hasAudio && !f.hasVideo)
        .sort((a, b) => (b.audioBitrate||0)-(a.audioBitrate||0))[0];
    
      const videoTemp = path.join(outDir, `${id}_video.mp4`);
      const audioTemp = path.join(outDir, `${id}_audio.m4a`);
    
      // 2) baixa vídeo-only
      await new Promise((res, rej) => {
        ytdl(url, { filter: f => f.itag == format.itag })
          .pipe(fs.createWriteStream(videoTemp))
          .on('finish', res)
          .on('error', rej);
      });
    
      // 3) baixa áudio-only
      await new Promise((res, rej) => {
        ytdl(url, { filter: f => f.itag == audioFmt.itag })
          .pipe(fs.createWriteStream(audioTemp))
          .on('finish', res)
          .on('error', rej);
      });
    
      // 4) mescla: vídeo em copy + áudio transcodificado para AAC
      await new Promise((res, rej) => {
        ffmpeg()
          .input(videoTemp)
          .input(audioTemp)
          .videoCodec('copy')
          .audioCodec('aac')
          .audioBitrate('192k')
          .on('progress', p => {
            const pct = p.percent ? p.percent.toFixed(1) : 0;
            downloadStatus[id] = {
              status: 'downloading',
              message: `Mesclando e transcodificando áudio: ${pct}%`,
              timestamp: new Date().toISOString()
            };
          })
          .on('end', () => res())
          .on('error', (err, stdout, stderr) => {
            console.error('FFmpeg erro:', stderr || err.message);
            rej(err);
          })
          .save(output);
      });
    
      // 5) remove temporários
      fs.unlinkSync(videoTemp);
      fs.unlinkSync(audioTemp);
    
      downloadStatus[id] = {
        status:  'completed',
        message: 'Download concluído!',
        timestamp: new Date().toISOString(),
        file:     filename
      };
    

    } else {
      throw new Error('Formato selecionado inválido para vídeo');
    }

  } catch (err) {
    downloadStatus[id] = { status:'error', message: err.message, timestamp: new Date().toISOString() };
  }
}

// ─────────── rotas ─────────────────────────────────────────────────────────

app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error:'URL é obrigatória' });
  try {
    const info = await ytdl.getInfo(url);
    const v = info.videoDetails;
    res.json({
      title:       v.title,
      duration:    Number(v.lengthSeconds),
      uploader:    v.author.name,
      view_count:  Number(v.viewCount),
      description: (v.description||'').slice(0,200)+'…',
      formats: info.formats.map(f => ({
        itag:         f.itag,
        qualityLabel: f.qualityLabel,
        audioBitrate: f.audioBitrate,
        hasVideo:     f.hasVideo,
        hasAudio:     f.hasAudio,
        height:       f.height
      }))
    });
  } catch (e) {
    res.status(500).json({ error:'Falha ao obter informações do vídeo.' });
  }
});

app.post('/api/download', async (req, res) => {
  const { url, type='video', quality='best', folder='' } = req.body;
  if (!url) return res.status(400).json({ error:'URL é obrigatória' });

  let title;
  try {
    const info = await ytdl.getInfo(url);
    title = sanitize(info.videoDetails.title);
  } catch {
    title = uuidv4();
  }

  const downloadId = uuidv4();
  downloadVideo(url, type, quality, folder, downloadId, title);
  res.json({ download_id: downloadId, message:'Download iniciado!' });
});

app.get('/api/status/:id', (req, res) => {
  const st = downloadStatus[req.params.id];
  if (!st) return res.json({ status:'not_found', message:'Não existe' });
  res.json(st);
});

function listAllFiles(dir) {
  let out = [];
  fs.readdirSync(dir).forEach(name => {
    const full = path.join(dir,name), st = fs.statSync(full);
    if (st.isDirectory()) out = out.concat(listAllFiles(full));
    else out.push({ name, size: st.size, modified: st.mtime.toISOString() });
  });
  return out;
}

app.get('/api/downloads', (req, res) => {
  if (!fs.existsSync(DOWNLOAD_ROOT)) return res.json([]);
  res.json(listAllFiles(DOWNLOAD_ROOT));
});

app.get('/api/download-file/:filename', (req, res) => {
  const fn = req.params.filename;
  const nested = path.join(DOWNLOAD_ROOT,'downloads',fn);
  const filePath = fs.existsSync(nested) ? nested : path.join(DOWNLOAD_ROOT,fn);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error:'Arquivo não encontrado' });
  res.download(filePath);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
