// netlify/functions/api.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json());

// Onde os downloads serão salvos
const DOWNLOAD_ROOT = path.join(__dirname, '../../downloads');
if (!fs.existsSync(DOWNLOAD_ROOT)) {
  fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });
}

// Armazena status de cada download
const downloadStatus = {};

/**
 * Inicia um download (vídeo ou áudio) de forma assíncrona
 */
function downloadVideo(url, type, quality, folder, id) {
  const outDir = path.join(DOWNLOAD_ROOT, folder);
  fs.mkdirSync(outDir, { recursive: true });

  downloadStatus[id] = {
    status: 'starting',
    message: 'Iniciando download...',
    timestamp: new Date().toISOString(),
  };

  if (type === 'audio') {
    try {
      // LOG: Exibe todas as faixas de áudio disponíveis para depuração
      ytdl.getInfo(url).then(info => {
        const audioFormats = info.formats.filter(f => f.hasAudio && !f.hasVideo);
        console.log('Faixas de áudio disponíveis:');
        audioFormats.forEach(f => {
          console.log({
            itag: f.itag,
            mimeType: f.mimeType,
            audioBitrate: f.audioBitrate,
            language: f.language || f.languageCode || 'desconhecido',
            approxDurationMs: f.approxDurationMs
          });
        });
      });
      // fluxo de áudio: ytdl → ffmpeg → .mp3
      const stream = ytdl(url, { quality: 'highestaudio' });
      const output = path.join(outDir, `${id}.mp3`);

      ffmpeg(stream)
        .audioBitrate(
          quality !== 'best' && quality !== 'worst' ? quality : 192
        )
        .save(output)
        .on('progress', (p) => {
          downloadStatus[id] = {
            status: 'downloading',
            message: `Processando: ${p.targetSize}kb baixados`,
            timestamp: new Date().toISOString(),
          };
        })
        .on('end', () => {
          downloadStatus[id] = {
            status: 'completed',
            message: 'Download concluído com sucesso!',
            timestamp: new Date().toISOString(),
            file: path.basename(output),
          };
        })
        .on('error', (err) => {
          downloadStatus[id] = {
            status: 'error',
            message: err.message,
            timestamp: new Date().toISOString(),
          };
        });
    } catch (err) {
      downloadStatus[id] = {
        status: 'error',
        message: err.message,
        timestamp: new Date().toISOString(),
      };
      return;
    }
  } else {
    // fluxo de vídeo: ytdl → .mp4
    try {
      const stream = ytdl(url, {
        quality:
          quality === 'best'
            ? 'highestvideo'
            : quality === 'worst'
            ? 'lowestvideo'
            : `highest[height<=${quality}]`,
      });
      const output = path.join(outDir, `${id}.mp4`);
      const fileStream = fs.createWriteStream(output);

      stream.pipe(fileStream);
      stream
        .on('progress', (_, downloaded, total) => {
          const pct = ((downloaded / total) * 100).toFixed(2);
          downloadStatus[id] = {
            status: 'downloading',
            message: `${pct}%`,
            timestamp: new Date().toISOString(),
          };
        })
        .on('end', () => {
          downloadStatus[id] = {
            status: 'completed',
            message: 'Download concluído com sucesso!',
            timestamp: new Date().toISOString(),
            file: path.basename(output),
          };
        })
        .on('error', (err) => {
          downloadStatus[id] = {
            status: 'error',
            message: err.message,
            timestamp: new Date().toISOString(),
          };
        });
    } catch (err) {
      downloadStatus[id] = {
        status: 'error',
        message: err.message,
        timestamp: new Date().toISOString(),
      };
      return;
    }
  }
}

// Endpoint para iniciar download
app.post('/api/download', (req, res) => {
  const { url, type = 'video', quality = 'best', folder = '' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  const downloadId = uuidv4();
  downloadVideo(url, type, quality, folder, downloadId);

  res.json({
    download_id: downloadId,
    message: 'Download iniciado com sucesso',
  });
});

// Endpoint para checar status
app.get('/api/status/:id', (req, res) => {
  const info = downloadStatus[req.params.id];
  if (!info) {
    return res.json({
      status: 'not_found',
      message: 'Download não encontrado',
    });
  }
  res.json(info);
});

// Endpoint para obter informações do vídeo
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });
  try {
    const info = await ytdl.getInfo(url);
    const v = info.videoDetails;
    res.json({
      title: v.title,
      duration: Number(v.lengthSeconds),
      uploader: v.author.name,
      view_count: Number(v.viewCount),
      description:
        (v.description || '').substring(0, 200) + (v.description ? '...' : ''),
    });
  } catch (e) {
    console.error('Erro ao obter info:', e);
    return res.status(500).json({ error: 'Não foi possível obter informações do vídeo.' });
  }
});

// Lista de arquivos já baixados
app.get('/api/downloads', (req, res) => {
  if (!fs.existsSync(DOWNLOAD_ROOT)) return res.json([]);
  const files = fs
    .readdirSync(DOWNLOAD_ROOT)
    .filter((f) => fs.statSync(path.join(DOWNLOAD_ROOT, f)).isFile())
    .map((name) => {
      const stats = fs.statSync(path.join(DOWNLOAD_ROOT, name));
      return {
        name,
        size: stats.size,
        modified: stats.mtime.toISOString(),
      };
    });
  res.json(files);
});

// Baixar arquivo específico
app.get('/api/download-file/:filename', (req, res) => {
  const filePath = path.join(DOWNLOAD_ROOT, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Arquivo não encontrado' });
  }
  res.download(filePath);
});

module.exports.handler = serverless(app);
