require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
let CACHED_ROOT_ID = (process.env.DRIVE_FOLDER_ID || '').trim();

// Middleware (Mendukung upload payload lab)
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
// Tangani Favicon agar tidak membebani pemanggilan fungsi serverless & 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Inisialisasi Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
  (process.env.DRIVE_CLIENT_ID || '').trim(),
  (process.env.DRIVE_CLIENT_SECRET || '').trim(),
  'https://developers.google.com/oauthplayground'
);

if (process.env.DRIVE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.DRIVE_REFRESH_TOKEN.trim(),
  });
}

const drive = google.drive({ version: 'v3', auth: oauth2Client });

function isLocalhost(req) {
  const host = req.headers.host || '';
  return host.includes('localhost') || host.includes('127.0.0.1') || host.includes('::1');
}

// SATU-SATUNYA GUARD: Cek Localhost ATAU Password Admin dari Header
function adminAuthGuard(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || '';
  const secretPass = (process.env.ADMIN_PASSWORD || 'shanz123').trim();

  // Izinkan jika akses dari Localhost ATAU jika password admin cocok
  if (isLocalhost(req) || (adminKey && adminKey.trim() === secretPass)) {
    return next();
  }
  return res.status(401).json({ error: 'Akses Ditolak: Password Admin belum diisi atau salah!' });
}

// In-Memory Cache Hemat Kuota Vercel
let memoryCache = {
  folders: null,
  foldersLastFetch: 0,
};

// Auto-Detect Folder NOTION
async function getRootFolderId() {
  if (CACHED_ROOT_ID) {
    try {
      const res = await drive.files.get({
        fileId: CACHED_ROOT_ID,
        fields: 'id, name, trashed',
        supportsAllDrives: true,
      });
      if (!res.data.trashed) return res.data.id;
    } catch (e) {}
  }

  try {
    const searchRes = await drive.files.list({
      q: "name = 'NOTION' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    if (searchRes.data.files && searchRes.data.files.length > 0) {
      CACHED_ROOT_ID = searchRes.data.files[0].id;
      return CACHED_ROOT_ID;
    }
  } catch (searchErr) {
    console.error('[ERROR] Gagal auto-detect folder NOTION:', searchErr.message);
  }

  return CACHED_ROOT_ID;
}

// Auto-Detect Bucket Khusus (Images & File)
async function getSpecialBucketId(rootId, folderName) {
  const res = await drive.files.list({
    q: `'${rootId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (res.data.files.length > 0) return res.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [rootId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  return created.data.id;
}

// ================= API ENDPOINTS =================

// 1. Endpoint Verifikasi Password Admin
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const secretPass = (process.env.ADMIN_PASSWORD || 'shanz123').trim();

  if (password && password.trim() === secretPass) {
    return res.json({ success: true, key: secretPass });
  }
  return res.status(401).json({ success: false, error: 'Password salah!' });
});

// 2. Status Mode & Auth
app.get('/api/mode', (req, res) => {
  const adminKey = req.headers['x-admin-key'] || '';
  const secretPass = (process.env.ADMIN_PASSWORD || 'shanz123').trim();
  const isLocal = isLocalhost(req);
  const isAuthenticated = isLocal || (adminKey && adminKey.trim() === secretPass);

  res.json({ isLocal, isAuthenticated });
});

// 3. Ambil Folder (Hide folder internal 'Images' & 'File')
app.get('/api/folders', async (req, res) => {
  try {
    const now = Date.now();
    // Cache 30 detik untuk menghemat kuota Vercel
    if (memoryCache.folders && now - memoryCache.foldersLastFetch < 30000) {
      return res.json(memoryCache.folders);
    }

    const rootId = await getRootFolderId();
    const driveRes = await drive.files.list({
      q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name, createdTime, description)',
      orderBy: 'name',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const folders = driveRes.data.files
      .filter((f) => {
        const lower = f.name.toLowerCase();
        return lower !== 'images' && lower !== 'image' && lower !== 'file' && lower !== 'files';
      })
      .map((f) => ({
        id: f.id,
        name: f.name,
        icon: f.description || '',
      }));

    memoryCache.folders = folders;
    memoryCache.foldersLastFetch = now;
    return res.json(folders);
  } catch (err) {
    console.error('Error fetching folders:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. Update Icon Folder (Admin Protected)
app.put('/api/folders/:folderId', adminAuthGuard, async (req, res) => {
  try {
    const { folderId } = req.params;
    const { icon } = req.body;

    await drive.files.update({
      fileId: folderId,
      requestBody: { description: icon || '' },
      supportsAllDrives: true,
    });

    memoryCache = { folders: null, foldersLastFetch: 0 };
    res.json({ success: true, icon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Ambil Berkas di Suatu Folder
app.get('/api/folders/:folderId/files', async (req, res) => {
  try {
    const { folderId } = req.params;
    const driveRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/json' and trashed = false`,
      fields: 'files(id, name, modifiedTime, description)',
      orderBy: 'modifiedTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = driveRes.data.files.map((file) => ({
      id: file.id,
      name: file.name.replace(/\.json$/i, ''),
      modifiedTime: file.modifiedTime,
      icon: file.description || 'file-text',
    }));

    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Baca Isi Dokumen Catatan
app.get('/api/docs/:docId', async (req, res) => {
  try {
    const { docId } = req.params;
    const driveRes = await drive.files.get({
      fileId: docId,
      alt: 'media',
      supportsAllDrives: true,
    });
    res.json(driveRes.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Buat Dokumen Baru (Admin Protected)
app.post('/api/docs', adminAuthGuard, async (req, res) => {
  try {
    const { title, folderId, icon } = req.body;
    const safeTitle = (title || 'Untitled').trim();
    const docData = {
      id: 'doc_' + Date.now(),
      title: safeTitle,
      icon: icon || 'file-text',
      folderId: folderId,
      cover: null,
      updatedAt: new Date().toISOString(),
      blocks: [{ id: 'b_init_1', type: 'paragraph', content: '' }],
    };

    const driveRes = await drive.files.create({
      requestBody: {
        name: `${safeTitle}.json`,
        parents: [folderId],
        description: icon || 'file-text',
      },
      media: {
        mimeType: 'application/json',
        body: JSON.stringify(docData, null, 2),
      },
      fields: 'id, name',
      supportsAllDrives: true,
    });

    docData.driveFileId = driveRes.data.id;
    res.status(201).json(docData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Simpan Dokumen (Admin Protected)
app.put('/api/docs/:docId', adminAuthGuard, async (req, res) => {
  try {
    const { docId } = req.params;
    const docPayload = req.body;
    docPayload.updatedAt = new Date().toISOString();

    await drive.files.update({
      fileId: docId,
      requestBody: {
        name: `${docPayload.title || 'Untitled'}.json`,
        description: docPayload.icon || 'file-text',
      },
      media: {
        mimeType: 'application/json',
        body: JSON.stringify(docPayload, null, 2),
      },
      supportsAllDrives: true,
    });

    res.json({ success: true, updatedAt: docPayload.updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Pindah Folder Dokumen (Admin Protected)
app.put('/api/docs/:docId/move', adminAuthGuard, async (req, res) => {
  try {
    const { docId } = req.params;
    const { currentFolderId, newFolderId } = req.body;

    await drive.files.update({
      fileId: docId,
      addParents: newFolderId,
      removeParents: currentFolderId,
      fields: 'id, parents',
      supportsAllDrives: true,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Hapus Dokumen (Admin Protected)
app.delete('/api/docs/:docId', adminAuthGuard, async (req, res) => {
  try {
    const { docId } = req.params;
    await drive.files.update({
      fileId: docId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Upload Screenshot ke Folder "Images" (Admin Protected)
app.post('/api/upload', adminAuthGuard, async (req, res) => {
  try {
    const { fileName, mimeType, base64 } = req.body;
    const rootId = await getRootFolderId();
    const imagesFolderId = await getSpecialBucketId(rootId, 'Images');

    const cleanBase64 = base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    const safeName = `img_${Date.now()}_${fileName || 'screenshot.webp'}`;
    const driveRes = await drive.files.create({
      requestBody: {
        name: safeName,
        parents: [imagesFolderId],
      },
      media: { mimeType, body: stream },
      fields: 'id',
      supportsAllDrives: true,
    });

    const fileId = driveRes.data.id;
    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });

    res.json({ url: `https://lh3.googleusercontent.com/d/${fileId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Upload Berkas Praktikum ke Folder "File" (Admin Protected)
app.post('/api/upload-file', adminAuthGuard, async (req, res) => {
  try {
    const { fileName, mimeType, base64 } = req.body;
    const rootId = await getRootFolderId();
    const labFolderId = await getSpecialBucketId(rootId, 'File');

    const cleanBase64 = base64.split(',')[1] || base64;
    const buffer = Buffer.from(cleanBase64, 'base64');
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);

    const safeName = fileName || `lab_file_${Date.now()}`;
    const driveRes = await drive.files.create({
      requestBody: {
        name: safeName,
        parents: [labFolderId],
      },
      media: { mimeType: mimeType || 'application/octet-stream', body: stream },
      fields: 'id, name',
      supportsAllDrives: true,
    });

    const fileId = driveRes.data.id;
    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });

    res.json({ fileId: fileId, fileName: safeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Direct Streaming Download di Tempat (Public Access)
app.get('/api/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const customName = req.query.name || '';

    const meta = await drive.files.get({
      fileId,
      fields: 'name, mimeType',
      supportsAllDrives: true,
    });

    const downloadFileName = (customName || meta.data.name || 'downloaded_file').trim();

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadFileName)}"`);
    res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream');

    const driveStream = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );

    driveStream.data.pipe(res);
  } catch (err) {
    res.status(500).send('Gagal mengunduh berkas: ' + err.message);
  }
});

// Fallback SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server (Tunggal & Bersih)
const server = app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` [NOTION CLONE - TKJ WORKSPACE ENGINE]`);
  console.log(` Running Localhost: http://localhost:${PORT}`);
  console.log(` Password Admin   : ${process.env.ADMIN_PASSWORD ? 'Terkonfigurasi' : 'Default (shanz123)'}`);
  console.log(`===================================================`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[PORT CONFLICT] Port ${PORT} bentrok. Jalankan: fuser -k ${PORT}/tcp`);
  } else {
    console.error('[SERVER ERROR]:', err.message);
  }
});

module.exports = app;
