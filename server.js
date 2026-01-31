// server.js
// Aplikasi Node.js + Express untuk temporary file hosting video
// dengan fitur upload, streaming, auto cleanup, rate-limit, dan API key auth.

require('dotenv').config(); // Load konfigurasi dari file .env

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// Konfigurasi dasar dari environment
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const DEFAULT_EXPIRY_MINUTES = Number(process.env.DEFAULT_EXPIRY_MINUTES || '180');
const CLEANUP_INTERVAL_SECONDS = Number(process.env.CLEANUP_INTERVAL_SECONDS || '60');

// Direktori untuk menyimpan file upload
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const METADATA_PATH = path.join(UPLOAD_DIR, 'metadata.json');

let fileRecords = [];

function loadMetadata() {
  try {
    const raw = fs.readFileSync(METADATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      fileRecords = parsed;
    } else {
      fileRecords = [];
    }
  } catch (err) {
    fileRecords = [];
  }
}

function saveMetadata() {
  fs.writeFile(METADATA_PATH, JSON.stringify(fileRecords, null, 2), (err) => {
    if (err) {
      console.error(
        `[META] ${new Date().toISOString()} | Gagal menyimpan metadata:`,
        err.message
      );
    }
  });
}

function addFileRecord(file, expiryMinutes, extraMeta) {
  const now = Date.now();
  const minutesNumber = Number(expiryMinutes);
  const minutes =
    Number.isFinite(minutesNumber) && minutesNumber > 0 ? minutesNumber : DEFAULT_EXPIRY_MINUTES;
  const record = {
    id: file.filename,
    filename: file.filename,
    originalName: file.originalname,
    size: file.size,
    mimeType: file.mimetype,
    createdAt: new Date(now).toISOString(),
    expiryMinutes: minutes,
    expiresAt: new Date(now + minutes * 60 * 1000).toISOString(),
    metadata: extraMeta || {},
    deleted: false,
  };
  fileRecords.push(record);
  saveMetadata();
  return record;
}

function getFileRecord(id) {
  return fileRecords.find((f) => f.id === id);
}

function authenticateApiKey(req, res, next) {
  const clientKey = req.header('x-api-key');
  if (!API_KEY || !clientKey || clientKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      message: 'API key tidak valid',
    });
  }
  next();
}

// Buat folder uploads jika belum ada
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Percayai header X-Forwarded-For (penting jika di balik reverse proxy / cPanel)
// agar logging IP bekerja dengan benar
app.set('trust proxy', 1);

// Aktifkan CORS untuk semua origin
app.use(cors());

// Parser JSON untuk endpoint yang butuh body JSON (opsional, tapi aman diaktifkan)
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

// Konfigurasi Multer untuk upload file
const allowedExtensions = ['.mp4', '.mov', '.avi'];

// Storage menggunakan diskStorage dengan nama file random dari crypto.randomBytes
const storage = multer.diskStorage({
  // Lokasi penyimpanan file
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    crypto.randomBytes(6, (err, buffer) => {
      if (err) {
        return cb(err);
      }

      const ext = path.extname(file.originalname).toLowerCase();
      const randomName = buffer.toString('hex') + ext;
      cb(null, randomName);
    });
  },
});

// Filter untuk validasi tipe file (hanya video mp4, mov, avi)
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();

  // Pastikan ekstensi sesuai whitelist
  if (!allowedExtensions.includes(ext)) {
    const error = new Error(
      'Tipe file tidak diizinkan. Hanya .mp4, .mov, .avi yang diperbolehkan.'
    );
    error.code = 'INVALID_FILE_TYPE';
    return cb(error);
  }

  // Opsional: cek mimetype juga, harus video/*
  if (!file.mimetype.startsWith('video/')) {
    const error = new Error('File bukan video yang valid.');
    error.code = 'INVALID_FILE_TYPE';
    return cb(error);
  }

  cb(null, true);
}

// Inisialisasi Multer dengan limit ukuran file dan filter tipe file
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
  },
  fileFilter,
});

// Middleware Multer untuk field "file"
const uploadSingleFile = upload.single('file');

// Endpoint health check
// GET /health -> { status: "ok", timestamp: "..." }
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Endpoint upload file publik sederhana (digunakan oleh UI)
app.post('/upload', (req, res, next) => {
  uploadSingleFile(req, res, function (err) {
    if (err) {
      return next(err);
    }

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'File tidak ditemukan di field "file"',
        });
      }

      const record = addFileRecord(req.file);
      const fileUrl = `${req.protocol}://${req.get('host')}/files/${encodeURIComponent(
        req.file.filename
      )}`;

      console.log(
        `[UPLOAD] ${new Date().toISOString()} | ip=${req.ip} | filename=${
          req.file.filename
        } | size=${req.file.size} bytes`
      );

      return res.json({
        success: true,
        url: fileUrl,
        filename: req.file.filename,
        size: req.file.size,
        expiresAt: record.expiresAt,
        expiryMinutes: record.expiryMinutes,
      });
    } catch (error) {
      next(error);
    }
  });
});

// API upload untuk integrasi n8n (dengan API key dan expiry_minutes)
app.post('/api/files', authenticateApiKey, (req, res, next) => {
  uploadSingleFile(req, res, function (err) {
    if (err) {
      return next(err);
    }

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'File tidak ditemukan di field "file"',
        });
      }

      const expiryFromBody = req.body && req.body.expiry_minutes;
      let metadata = {};
      if (req.body && req.body.meta) {
        try {
          metadata = JSON.parse(req.body.meta);
        } catch (e) {
          return res.status(400).json({
            success: false,
            message: 'Field meta harus berupa JSON yang valid',
          });
        }
      }

      const record = addFileRecord(req.file, expiryFromBody, metadata);
      const fileUrl = `${req.protocol}://${req.get('host')}/files/${encodeURIComponent(
        req.file.filename
      )}`;

      return res.json({
        success: true,
        file: {
          id: record.id,
          url: fileUrl,
          filename: record.filename,
          originalName: record.originalName,
          size: record.size,
          mimeType: record.mimeType,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          expiryMinutes: record.expiryMinutes,
          metadata: record.metadata,
        },
      });
    } catch (error) {
      next(error);
    }
  });
});

// List file untuk integrasi n8n
app.get('/api/files', authenticateApiKey, (req, res) => {
  const status = req.query.status;
  const now = Date.now();
  let list = fileRecords;

  if (status === 'active') {
    list = list.filter((f) => !f.deleted && new Date(f.expiresAt).getTime() > now);
  } else if (status === 'expired') {
    list = list.filter((f) => f.deleted || new Date(f.expiresAt).getTime() <= now);
  }

  return res.json({
    success: true,
    files: list,
  });
});

// Detail metadata file
app.get('/api/files/:id', authenticateApiKey, (req, res) => {
  const record = getFileRecord(req.params.id);
  if (!record) {
    return res.status(404).json({
      success: false,
      message: 'File tidak ditemukan',
    });
  }

  return res.json({
    success: true,
    file: record,
  });
});

// Update metadata / expiry file
app.patch('/api/files/:id', authenticateApiKey, (req, res) => {
  const record = getFileRecord(req.params.id);
  if (!record) {
    return res.status(404).json({
      success: false,
      message: 'File tidak ditemukan',
    });
  }

  const now = Date.now();
  const updates = req.body || {};

  if (typeof updates.expiry_minutes !== 'undefined') {
    const minutesNumber = Number(updates.expiry_minutes);
    if (!Number.isFinite(minutesNumber) || minutesNumber <= 0) {
      return res.status(400).json({
        success: false,
        message: 'expiry_minutes harus angka > 0',
      });
    }
    record.expiryMinutes = minutesNumber;
    record.expiresAt = new Date(now + minutesNumber * 60 * 1000).toISOString();
  }

  if (typeof updates.metadata === 'object' && updates.metadata !== null) {
    record.metadata = updates.metadata;
  }

  saveMetadata();

  return res.json({
    success: true,
    file: record,
  });
});

// Hapus file manual
app.delete('/api/files/:id', authenticateApiKey, (req, res) => {
  const record = getFileRecord(req.params.id);
  if (!record) {
    return res.status(404).json({
      success: false,
      message: 'File tidak ditemukan',
    });
  }

  const filePath = path.join(UPLOAD_DIR, record.filename);

  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error(
        `[DELETE] ${new Date().toISOString()} | Gagal menghapus file ${record.filename}:`,
        err.message
      );
      return res.status(500).json({
        success: false,
        message: 'Gagal menghapus file di server',
      });
    }

    record.deleted = true;
    record.deletedAt = new Date().toISOString();
    saveMetadata();

    return res.json({
      success: true,
      message: 'File berhasil dihapus',
    });
  });
});

// Endpoint download / streaming file
// GET /files/:filename
// - Jika file ada: stream langsung (mendukung Range header untuk video streaming)
// - Jika tidak ada: 404 JSON
app.get('/files/:filename', (req, res, next) => {
  try {
    // Sanitasi nama file untuk mencegah path traversal
    const safeFilename = path.basename(req.params.filename);
    const filePath = path.join(UPLOAD_DIR, safeFilename);

    // Cek apakah file ada
    fs.stat(filePath, (err, stat) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return res.status(404).json({
            success: false,
            message: 'File tidak ditemukan',
          });
        }
        return next(err);
      }

      const fileSize = stat.size;
      const range = req.headers.range;

      // Set content-type berdasarkan ekstensi file
      const ext = path.extname(safeFilename).toLowerCase();
      let contentType = 'application/octet-stream';

      if (ext === '.mp4') {
        contentType = 'video/mp4';
      } else if (ext === '.mov') {
        contentType = 'video/quicktime';
      } else if (ext === '.avi') {
        contentType = 'video/x-msvideo';
      }

      // Jika ada header Range, kirim partial content (206)
      // untuk mendukung video streaming (misal dari Instagram API)
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        // Validasi range
        if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize) {
          res
            .status(416)
            .set('Content-Range', `bytes */${fileSize}`)
            .end();
          return;
        }

        const chunkSize = end - start + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
        });

        fileStream.pipe(res);
      } else {
        // Tanpa Range, kirim seluruh file
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': contentType,
        });

        fs.createReadStream(filePath).pipe(res);
      }
    });
  } catch (err) {
    next(err);
  }
});

// ---- AUTO CLEANUP BERDASARKAN expiryMinutes ----

function normalizeRecordsAfterLoad() {
  const now = Date.now();
  fileRecords.forEach((record) => {
    const minutesNumber = Number(record.expiryMinutes);
    const minutes =
      Number.isFinite(minutesNumber) && minutesNumber > 0
        ? minutesNumber
        : DEFAULT_EXPIRY_MINUTES;
    record.expiryMinutes = minutes;
    if (!record.createdAt) {
      record.createdAt = new Date(now).toISOString();
    }
    if (!record.expiresAt) {
      const createdTime = new Date(record.createdAt).getTime() || now;
      record.expiresAt = new Date(createdTime + minutes * 60 * 1000).toISOString();
    }
    if (typeof record.deleted !== 'boolean') {
      record.deleted = false;
    }
  });
}

function cleanupExpiredFiles() {
  const now = Date.now();

  fileRecords.forEach((record) => {
    if (record.deleted) {
      return;
    }

    const expiryTime = new Date(record.expiresAt).getTime();
    if (!Number.isFinite(expiryTime) || expiryTime > now) {
      return;
    }

    const filePath = path.join(UPLOAD_DIR, record.filename);

    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error(
          `[CLEANUP] ${new Date().toISOString()} | Gagal menghapus file ${record.filename}:`,
          err.message
        );
        return;
      }

      record.deleted = true;
      record.deletedAt = new Date().toISOString();
      console.log(
        `[CLEANUP] ${new Date().toISOString()} | File dihapus: ${record.filename} | expiresAt=${record.expiresAt}`
      );
      saveMetadata();
    });
  });
}

// ---- GLOBAL ERROR HANDLER ----

// Middleware penanganan error terpusat
app.use((err, req, res, next) => {
  console.error('[ERROR]', new Date().toISOString(), err);

  // Error ukuran file terlalu besar
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      message: 'Ukuran file melebihi batas 100MB',
    });
  }

  // Error tipe file tidak valid
  if (err.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({
      success: false,
      message: 'Tipe file tidak diizinkan. Hanya mp4, mov, avi yang diperbolehkan.',
    });
  }

  // Error Multer lainnya
  if (err.name === 'MulterError') {
    return res.status(400).json({
      success: false,
      message: `Kesalahan upload file: ${err.message}`,
    });
  }

  // Fallback error internal server
  return res.status(500).json({
    success: false,
    message: 'Terjadi kesalahan pada server',
  });
});

loadMetadata();
normalizeRecordsAfterLoad();
cleanupExpiredFiles();
setInterval(cleanupExpiredFiles, CLEANUP_INTERVAL_SECONDS * 1000);

app.listen(PORT, () => {
  console.log(`Server file hosting berjalan pada port ${PORT}`);
});
