const express = require('express');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/favicon.ico', (req, res) => res.status(204).end());

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const FOLDER_ID = process.env.DRIVE_FOLDER_ID;

let fileCache = { data: null, timestamp: 0 };
let contentCache = {};
const CACHE_TTL = 30 * 1000;

async function getSavedFolderOrder() {
    try {
        const res = await drive.files.list({
            q: `'${FOLDER_ID}' in parents and name='_order_manifest.json' and trashed=false`,
            fields: 'files(id, name)',
        });
        if (res.data.files && res.data.files.length > 0) {
            const fileId = res.data.files[0].id;
            const contentRes = await drive.files.get({ fileId, alt: 'media' });
            return { fileId, order: contentRes.data.order || [] };
        }
    } catch (e) { console.error("Error reading order manifest:", e.message); }
    return { fileId: null, order: [] };
}

// ================= API BACKEND =================
app.get('/api/pages', async (req, res) => {
    try {
        if (!FOLDER_ID) throw new Error("DRIVE_FOLDER_ID belum diatur di file .env");
        const now = Date.now();
        if (fileCache.data && (now - fileCache.timestamp < CACHE_TTL)) {
            return res.json(fileCache.data);
        }
        
        const response = await drive.files.list({
            q: `'${FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`,
            fields: 'files(id, name, createdTime)',
            orderBy: 'name',
        });
        
        const rawFiles = (response.data.files || []).filter(f => !f.name.startsWith('_'));
        const { order } = await getSavedFolderOrder();
        
        if (order && order.length > 0) {
            rawFiles.sort((a, b) => {
                const idxA = order.indexOf(a.id);
                const idxB = order.indexOf(b.id);
                if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                if (idxA !== -1) return -1;
                if (idxB !== -1) return 1;
                return a.name.localeCompare(b.name);
            });
        }

        fileCache = { data: rawFiles, timestamp: now };
        res.json(rawFiles);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/pages/:id', async (req, res) => {
    try {
        if (contentCache[req.params.id]) {
            return res.json(contentCache[req.params.id]);
        }
        const response = await drive.files.get({ fileId: req.params.id, alt: 'media' });
        contentCache[req.params.id] = response.data;
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/folders/reorder', async (req, res) => {
    try {
        const { order } = req.body;
        if (!Array.isArray(order)) throw new Error("Format order tidak valid");
        
        const { fileId } = await getSavedFolderOrder();
        const payload = { order, updated_at: new Date().toISOString() };
        const media = {
            mimeType: 'application/json',
            body: JSON.stringify(payload, null, 2),
        };

        if (fileId) {
            await drive.files.update({ fileId, media });
        } else {
            await drive.files.create({
                resource: { name: '_order_manifest.json', mimeType: 'application/json', parents: [FOLDER_ID] },
                media
            });
        }
        fileCache.timestamp = 0;
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/search', async (req, res) => {
    try {
        const query = (req.query.q || '').trim().toLowerCase();
        if (!query) return res.json([]);

        const now = Date.now();
        if (!fileCache.data || (now - fileCache.timestamp >= CACHE_TTL)) {
            const response = await drive.files.list({
                q: `'${FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`,
                fields: 'files(id, name, createdTime)',
                orderBy: 'name',
            });
            fileCache = { data: (response.data.files || []).filter(f => !f.name.startsWith('_')), timestamp: now };
        }
        const files = fileCache.data || [];
        const results = [];

        await Promise.all(files.map(async (file) => {
            const cleanFolderName = file.name.replace('.json', '').replace(/-/g, ' ');

            if (cleanFolderName.toLowerCase().includes(query)) {
                results.push({
                    type: 'folder',
                    folderId: file.id,
                    folderName: cleanFolderName,
                    title: cleanFolderName,
                    subtext: 'Modul Folder Utama',
                    pageIndex: 0
                });
            }

            let data = contentCache[file.id];
            if (!data) {
                try {
                    const resFile = await drive.files.get({ fileId: file.id, alt: 'media' });
                    data = resFile.data;
                    contentCache[file.id] = data;
                } catch (e) { return; }
            }

            const pages = data.pages || [];
            pages.forEach((p, pIdx) => {
                const pageTitle = p.title || `Halaman ${pIdx + 1}`;

                if (pageTitle.toLowerCase().includes(query)) {
                    results.push({
                        type: 'page',
                        folderId: file.id,
                        folderName: cleanFolderName,
                        title: pageTitle,
                        subtext: `Folder: ${cleanFolderName} • Halaman ${pIdx + 1}`,
                        pageIndex: pIdx
                    });
                }

                const blocks = p.blocks || [];
                blocks.forEach((b, bIdx) => {
                    const isHeading = ['h1', 'h2', 'h3', 'header'].includes(b.type);
                    if (b.content && b.content.toLowerCase().includes(query)) {
                        if (isHeading) {
                            results.push({
                                type: 'heading',
                                folderId: file.id,
                                folderName: cleanFolderName,
                                title: b.content,
                                subtext: `${cleanFolderName} ➔ ${pageTitle}`,
                                pageIndex: pIdx,
                                blockIndex: bIdx
                            });
                        }
                    }
                });
            });
        }));

        res.json(results.slice(0, 20));
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/pages', async (req, res) => {
    try {
        const { id, title, pages } = req.body;
        
        let targetFileName;
        if (id) {
            const currentFile = await drive.files.get({ fileId: id, fields: 'name' });
            targetFileName = currentFile.data.name;
        } else {
            const cleanTitle = title ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'untitled-folder';
            targetFileName = `${cleanTitle}.json`;
        }

        const fileMetadata = { name: targetFileName, mimeType: 'application/json' };
        const payloadData = { title, pages, updated_at: new Date().toISOString() };
        const media = {
            mimeType: 'application/json',
            body: JSON.stringify(payloadData, null, 2),
        };

        let result;
        if (id) {
            result = await drive.files.update({ fileId: id, media: media });
            contentCache[id] = payloadData;
        } else {
            fileMetadata.parents = [FOLDER_ID];
            result = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id, name' });
            contentCache[result.data.id] = payloadData;
        }
        fileCache.timestamp = 0; 
        res.json({ success: true, file: result.data });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/pages/:id/rename', async (req, res) => {
    try {
        const { title } = req.body;
        const cleanTitle = title ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'untitled-folder';
        const fileName = `${cleanTitle}.json`;
        
        const file = await drive.files.get({ fileId: req.params.id, alt: 'media' });
        let content = file.data;
        content.title = title;

        await drive.files.update({ 
            fileId: req.params.id, 
            requestBody: { name: fileName },
            media: { mimeType: 'application/json', body: JSON.stringify(content, null, 2) }
        });
        
        contentCache[req.params.id] = content;
        fileCache.timestamp = 0;
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/pages/:id', async (req, res) => {
    try {
        await drive.files.update({ fileId: req.params.id, requestBody: { trashed: true } });
        delete contentCache[req.params.id];
        fileCache.timestamp = 0;
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/verify-password', (req, res) => {
    const { password } = req.body;
    if (password === (process.env.ADMIN_PASSWORD || 'admin123')) res.json({ success: true });
    else res.status(401).json({ success: false });
});

// ================= FRONTEND UI =================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="id" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Shanz Workspace</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    fontFamily: { 
                        sans: ['"Plus Jakarta Sans"', 'Inter', 'sans-serif'],
                        mono: ['"JetBrains Mono"', 'monospace']
                    },
                    colors: { 
                        brand: { 50: '#eff6ff', 100: '#dbeafe', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
                        slate: { 
                            750: '#1b2438',
                            850: '#111726', 
                            900: '#0c111d', 
                            950: '#060a12' 
                        }
                    }
                }
            }
        }
    </script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js"></script>
    <style>
        html { scroll-behavior: smooth; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(59, 130, 246, 0.2); border-radius: 5px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(59, 130, 246, 0.4); }
        textarea { overflow: hidden; }
        .highlight-pulse {
            animation: pulseBlock 2s cubic-bezier(0.4, 0, 0.6, 1);
        }
        @keyframes pulseBlock {
            0%, 100% { background-color: transparent; }
            50% { background-color: rgba(59, 130, 246, 0.15); border-radius: 0.75rem; }
        }
        .notion-block:hover .block-actions {
            opacity: 1;
            pointer-events: auto;
        }
        .folder-drag-ghost {
            opacity: 0.3;
            background-color: rgba(59, 130, 246, 0.2) !important;
            border: 1px dashed rgba(59, 130, 246, 0.6) !important;
        }
        .folder-drag-chosen {
            background-color: rgba(17, 23, 38, 0.95) !important;
            border: 1px solid rgba(59, 130, 246, 0.5) !important;
        }
    </style>
</head>
<body class="bg-slate-950 text-slate-200 font-sans h-screen flex flex-col overflow-hidden selection:bg-brand-500/30 selection:text-blue-200">

    <!-- TOP NAVBAR -->
    <header class="h-14 border-b border-slate-850/90 px-4 sm:px-6 flex justify-between items-center bg-slate-900/90 backdrop-blur-xl z-30 shrink-0">
        <div class="flex items-center gap-3 w-1/4">
            <button onclick="toggleSidebar()" class="p-2 rounded-xl bg-slate-850 hover:bg-slate-800 text-slate-300 hover:text-white transition flex items-center gap-2 border border-slate-700/60 shadow-sm">
                <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
                <span class="text-xs font-semibold tracking-wide hidden sm:inline text-slate-200">Menu</span>
            </button>
        </div>
        
        <!-- DEEP SEARCH BAR -->
        <div class="flex-1 max-w-xl mx-3 relative">
            <div class="relative group">
                <div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-blue-400 transition">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                </div>
                <input type="text" id="global-search" oninput="handleDeepSearch(this.value)" placeholder="Cari materi, halaman, atau sub-bab..." class="w-full bg-slate-850/90 text-xs sm:text-sm pl-10 pr-16 py-1.5 rounded-xl outline-none border border-slate-700/60 focus:border-blue-500/80 focus:ring-2 focus:ring-blue-500/20 text-slate-100 placeholder-slate-400 shadow-inner transition">
                <div class="absolute inset-y-0 right-0 pr-2.5 flex items-center pointer-events-none">
                    <kbd class="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 bg-slate-800 border border-slate-700 rounded-md">Ctrl K</kbd>
                </div>
            </div>

            <!-- SEARCH RESULTS DROPDOWN -->
            <div id="search-results" class="absolute top-full left-0 right-0 mt-2 bg-slate-900/95 backdrop-blur-2xl border border-slate-700/80 rounded-2xl shadow-2xl max-h-96 overflow-y-auto hidden z-40 p-2 divide-y divide-slate-800/60"></div>
        </div>

        <div class="flex items-center justify-end gap-2 w-1/4">
            <button id="admin-auth-btn" onclick="handleAdminToggle()" class="text-xs px-3.5 py-1.5 rounded-xl font-semibold transition bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/30">Sign In</button>
        </div>
    </header>

    <!-- LAYOUT UTAMA -->
    <div class="flex-1 flex overflow-hidden relative">
        <div id="sidebar-overlay" onclick="toggleSidebar()" class="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 hidden transition-opacity"></div>

        <!-- SIDEBAR -->
        <aside id="sidebar" class="fixed inset-y-0 left-0 z-50 w-72 bg-slate-900 border-r border-slate-850 flex flex-col transform -translate-x-full transition-transform duration-300 h-full shadow-2xl">
            <div class="p-4 border-b border-slate-850 flex justify-between items-center bg-slate-900/80">
                <div class="flex items-center gap-2.5">
                    <div class="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center font-bold text-blue-400 text-xs shadow-inner">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>
                    </div>
                    <span class="text-xs font-bold text-slate-200 uppercase tracking-wider">Folder</span>
                </div>
                <div class="flex items-center gap-1">
                    <button id="new-folder-btn" onclick="createNewFolder()" class="text-[11px] bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1 rounded-lg transition font-medium hidden flex items-center gap-1 shadow-sm">+ Folder</button>
                    <button onclick="toggleSidebar()" class="p-1 rounded-lg text-slate-400 hover:text-white text-xs hover:bg-slate-800 transition">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </button>
                </div>
            </div>

            <!-- FOLDER LIST -->
            <div id="folder-list" class="flex-1 overflow-y-auto p-3 space-y-1">
                <p class="text-xs text-slate-500 p-4 text-center animate-pulse">Memuat workspace...</p>
            </div>
            
            <div class="p-3 border-t border-slate-850 bg-slate-950/60 text-[11px] text-slate-400 flex items-center justify-between">
                <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span> Cloud Sync</span>
                <span class="font-mono text-[10px] text-slate-500">Shanz Engine</span>
            </div>
        </aside>

        <!-- MAIN WORKSPACE / EDITOR -->
        <main id="main-scroll" class="flex-1 overflow-y-auto bg-slate-950 relative">
            <div id="main-content-container" class="max-w-4xl mx-auto w-full px-5 sm:px-12 py-8 pb-44">
                
                <!-- TOP PAGE NAVIGATION -->
                <div id="top-nav-container" class="hidden justify-between items-center mb-6 pb-4 border-b border-slate-850">
                    <button id="top-btn-prev" onclick="goToPrevPage()" class="invisible bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 hover:text-white px-3.5 py-1.5 text-xs rounded-xl transition font-medium flex items-center gap-1.5">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg> Sebelumnya
                    </button>
                    
                    <div id="page-indicator" class="text-xs font-semibold px-3 py-1 bg-blue-500/10 text-blue-400 rounded-full border border-blue-500/20 font-mono">
                        Hal 0 / 0
                    </div>

                    <button id="top-btn-next" onclick="goToNextPage()" class="invisible bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-1.5 text-xs rounded-xl transition font-medium shadow-sm flex items-center gap-1.5">
                        Selanjutnya <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>
                    </button>
                </div>

                <!-- JUDUL HALAMAN UTAMA -->
                <div id="title-wrapper" class="hidden mb-6 relative group">
                    <textarea id="page-title" rows="1" oninput="autoResize(this); updateCurrentPageTitle(this.value)" placeholder="Judul Halaman..." readonly class="text-3xl sm:text-4xl font-extrabold bg-transparent outline-none w-full text-white resize-none tracking-tight placeholder-slate-750 whitespace-pre-wrap leading-tight"></textarea>
                    <div class="h-px w-full bg-slate-850 mt-4"></div>
                </div>
                
                <!-- BLOK KONTEN WORKSPACE -->
                <div id="editor-container" class="space-y-3"></div>
                
                <!-- BOTTOM PAGE NAVIGATION -->
                <div id="bot-nav-container" class="hidden justify-between items-center mt-12 pt-6 border-t border-slate-850">
                    <button id="bot-btn-prev" onclick="goToPrevPage()" class="invisible bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 hover:text-white px-4 py-2 text-xs rounded-xl transition font-medium">❮ Halaman Sebelumnya</button>
                    <button id="bot-btn-next" onclick="goToNextPage()" class="invisible bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-xs rounded-xl transition font-medium shadow-sm">Halaman Selanjutnya ❯</button>
                </div>
            </div>
        </main>
    </div>

    <!-- SAVE FAB (POJOK KIRI BAWAH) -->
    <div id="save-fab-container" class="fixed bottom-6 left-6 z-30 hidden">
        <button type="button" id="save-fab-btn" onclick="saveCurrentFolder()" title="Simpan Semua Perubahan (Ctrl + S)" class="w-13 h-13 sm:w-14 sm:h-14 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-2xl shadow-blue-950 flex items-center justify-center p-3.5 transition-all duration-200 active:scale-90 focus:outline-none border border-blue-400/30 cursor-pointer select-none group">
            <svg class="w-6 h-6 group-hover:scale-110 transition-transform" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>
        </button>
    </div>

    <!-- NOTION BLOCK FAB (POJOK KANAN BAWAH) -->
    <div id="fab-container" class="fixed bottom-6 right-6 z-30 flex flex-col items-end gap-2.5 hidden" onclick="event.stopPropagation()">
        <div id="fab-menu" class="hidden flex-col gap-2 mb-1 bg-slate-900/95 backdrop-blur-2xl p-4 rounded-2xl shadow-2xl border border-slate-800 min-w-[270px] max-h-[75vh] overflow-y-auto">
            <div class="flex items-center justify-between pb-2 border-b border-slate-800">
                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Aksi Halaman</span>
                <span class="text-[10px] text-blue-400 font-mono font-semibold" id="fab-page-badge">Hal 1</span>
            </div>
            
            <div class="grid grid-cols-2 gap-1.5 pt-1">
                <button type="button" onclick="addNewPage()" class="text-left text-xs p-2 rounded-xl bg-slate-850 hover:bg-slate-800 text-slate-200 font-medium flex items-center gap-1.5 transition">
                    <svg class="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"/></svg> Hal Baru
                </button>
                <button type="button" onclick="deleteCurrentPage()" class="text-left text-xs p-2 rounded-xl bg-red-950/30 hover:bg-red-950/60 text-red-400 font-medium flex items-center gap-1.5 transition">
                    <svg class="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg> Hapus Hal
                </button>
            </div>
            
            <div class="h-px bg-slate-800 my-1"></div>
            <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">Tambah Blok</span>
            
            <div class="space-y-1">
                <button type="button" onclick="addBlock('paragraph')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <span class="w-5 text-center font-bold text-blue-400">T</span> Teks Paragraf
                </button>
                <button type="button" onclick="addBlock('h1')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <span class="w-5 text-center font-extrabold text-blue-400">H1</span> Heading 1
                </button>
                <button type="button" onclick="addBlock('h2')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <span class="w-5 text-center font-bold text-blue-400">H2</span> Heading 2
                </button>
                <button type="button" onclick="addBlock('h3')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <span class="w-5 text-center font-semibold text-blue-400">H3</span> Heading 3
                </button>
                <button type="button" onclick="addBlock('bullet')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg> Bulleted List
                </button>
                <button type="button" onclick="addBlock('numbered')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <span class="w-5 text-center font-mono font-bold text-blue-400">1.</span> Numbered List
                </button>
                <button type="button" onclick="addBlock('todo')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/></svg> To-Do Checkbox
                </button>
                <button type="button" onclick="addBlock('callout')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg> Callout Box
                </button>
                <button type="button" onclick="addBlock('quote')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/></svg> Quote Catatan
                </button>
                <button type="button" onclick="addBlock('code')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Snippet Kode
                </button>
                <button type="button" onclick="addBlock('divider')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">
                    <svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="5" x2="19" y1="12" y2="12"/></svg> Garis Pembatas
                </button>
            </div>
        </div>

        <button type="button" id="fab-main-btn" onclick="toggleFab(event)" class="w-13 h-13 sm:w-14 sm:h-14 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-2xl shadow-blue-950 flex items-center justify-center p-3.5 transition-all duration-200 active:scale-90 focus:outline-none border border-blue-400/30 cursor-pointer select-none">
            <svg id="fab-icon" class="w-6 h-6 transition-transform duration-200 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                <path d="M5 12h14M12 5v14"/>
            </svg>
        </button>
    </div>

    <!-- TOAST NOTIFICATION -->
    <div id="toast" class="fixed top-18 right-6 bg-slate-900 border border-slate-750 text-white text-xs px-4 py-3 rounded-xl shadow-2xl transform translate-x-full opacity-0 transition-all duration-300 z-50 font-medium"></div>

    <!-- CUSTOM CENTER POPUP MODAL UI (PENGGANTI PROMPT & CONFIRM BROWSER) -->
    <div id="custom-modal" class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm hidden opacity-0 transition-opacity duration-200">
        <div id="custom-modal-card" class="bg-slate-900 border border-slate-800 w-full max-w-sm sm:max-w-md rounded-2xl p-5 sm:p-6 shadow-2xl transform scale-95 transition-transform duration-200">
            <div class="flex items-center gap-3 mb-4">
                <div id="modal-icon-container" class="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                </div>
                <div>
                    <h3 id="modal-title" class="text-sm sm:text-base font-bold text-white">Judul Modal</h3>
                    <p id="modal-desc" class="text-xs text-slate-400 mt-0.5"></p>
                </div>
            </div>

            <div id="modal-input-wrapper" class="mb-5">
                <input type="text" id="modal-input" class="w-full bg-slate-950 text-xs sm:text-sm px-3.5 py-2.5 rounded-xl outline-none border border-slate-800 focus:border-blue-500/80 focus:ring-2 focus:ring-blue-500/20 text-slate-100 placeholder-slate-500 transition font-sans">
            </div>

            <div class="flex items-center justify-end gap-2 pt-1">
                <button type="button" id="modal-btn-cancel" class="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white bg-slate-850 hover:bg-slate-800 border border-slate-750 transition">Batal</button>
                <button type="button" id="modal-btn-confirm" class="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 transition shadow-lg shadow-blue-950 border border-blue-400/30 flex items-center gap-1.5">Lanjut</button>
            </div>
        </div>
    </div>

    <script>
        let folders = [];
        let currentFolderId = null;
        let currentFolderData = { title: '', pages: [] };
        let currentPageIndex = 0;
        let isAdmin = localStorage.getItem('isAdmin') === 'true';
        let isFabOpen = false;
        let searchDebounceTimer = null;
        let folderSortableInstance = null;

        window.onload = async () => {
            updateAdminUI();
            await loadFolders();
            renderWelcomeView();
        };

        window.addEventListener('keydown', (e) => { 
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { 
                e.preventDefault(); 
                if(isAdmin) saveCurrentFolder(); 
            } 
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                document.getElementById('global-search').focus();
            }
        });

        // ================= CUSTOM POPUP MODAL ENGINE =================
        function showCustomDialog({ title, desc = '', placeholder = '', defaultValue = '', isPrompt = true, isPassword = false, isDanger = false, confirmText = 'Simpan' }) {
            return new Promise((resolve) => {
                const modal = document.getElementById('custom-modal');
                const card = document.getElementById('custom-modal-card');
                const titleEl = document.getElementById('modal-title');
                const descEl = document.getElementById('modal-desc');
                const inputWrap = document.getElementById('modal-input-wrapper');
                const inputEl = document.getElementById('modal-input');
                const iconBox = document.getElementById('modal-icon-container');
                const btnCancel = document.getElementById('modal-btn-cancel');
                const btnConfirm = document.getElementById('modal-btn-confirm');

                titleEl.innerText = title;
                descEl.innerText = desc;
                if (!desc) descEl.classList.add('hidden'); else descEl.classList.remove('hidden');

                if (isDanger) {
                    iconBox.className = "w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 shrink-0";
                    iconBox.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
                    btnConfirm.className = "px-4 py-2 rounded-xl text-xs font-semibold text-white bg-red-600 hover:bg-red-500 transition shadow-lg shadow-red-950 border border-red-400/30";
                } else if (isPassword) {
                    iconBox.className = "w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0";
                    iconBox.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>';
                    btnConfirm.className = "px-4 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 transition shadow-lg shadow-blue-950 border border-blue-400/30";
                } else {
                    iconBox.className = "w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0";
                    iconBox.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
                    btnConfirm.className = "px-4 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 transition shadow-lg shadow-blue-950 border border-blue-400/30";
                }

                btnConfirm.innerText = confirmText;

                if (isPrompt) {
                    inputWrap.classList.remove('hidden');
                    inputEl.type = isPassword ? 'password' : 'text';
                    inputEl.placeholder = placeholder;
                    inputEl.value = defaultValue;
                } else {
                    inputWrap.classList.add('hidden');
                }

                // Show Animation
                modal.classList.remove('hidden');
                setTimeout(() => {
                    modal.classList.remove('opacity-0');
                    card.classList.remove('scale-95');
                    card.classList.add('scale-100');
                    if (isPrompt) {
                        inputEl.focus();
                        if (defaultValue) inputEl.select();
                    }
                }, 20);

                function cleanup() {
                    modal.classList.add('opacity-0');
                    card.classList.remove('scale-100');
                    card.classList.add('scale-95');
                    setTimeout(() => modal.classList.add('hidden'), 200);
                    btnConfirm.onclick = null;
                    btnCancel.onclick = null;
                    modal.onclick = null;
                    inputEl.onkeydown = null;
                    window.removeEventListener('keydown', handleEsc);
                }

                function submit() {
                    const val = isPrompt ? inputEl.value.trim() : true;
                    cleanup();
                    resolve(val);
                }

                function cancel() {
                    cleanup();
                    resolve(null);
                }

                function handleEsc(e) {
                    if (e.key === 'Escape') cancel();
                }

                btnConfirm.onclick = submit;
                btnCancel.onclick = cancel;
                modal.onclick = (e) => { if (e.target === modal) cancel(); };
                inputEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
                window.addEventListener('keydown', handleEsc);
            });
        }

        function autoResize(el) { 
            if(!el) return;
            el.style.height = 'auto'; 
            el.style.height = el.scrollHeight + 'px'; 
        }

        function showToast(msg, isError = false) {
            const toast = document.getElementById('toast');
            toast.innerText = msg;
            toast.className = \`fixed top-18 right-6 \${isError ? 'bg-red-950/90 border-red-800 text-red-200' : 'bg-slate-900 border-slate-700 text-blue-400'} border text-xs px-4 py-3 rounded-xl shadow-2xl transform transition-all duration-300 z-50 font-medium\`;
            toast.classList.remove('translate-x-full', 'opacity-0');
            setTimeout(() => toast.classList.add('translate-x-full', 'opacity-0'), 3000);
        }

        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.toggle('hidden');
        }

        function toggleFab(e, forceState) {
            if (e && e.stopPropagation) e.stopPropagation();
            const menu = document.getElementById('fab-menu');
            const icon = document.getElementById('fab-icon');
            const badge = document.getElementById('fab-page-badge');
            if(!menu || !icon) return;

            if (badge) badge.innerText = \`Hal \${currentPageIndex + 1}\`;
            isFabOpen = (typeof forceState === 'boolean') ? forceState : !isFabOpen;

            if (isFabOpen) {
                menu.classList.remove('hidden');
                menu.classList.add('flex');
                icon.classList.add('rotate-45');
            } else {
                menu.classList.remove('flex');
                menu.classList.add('hidden');
                icon.classList.remove('rotate-45');
            }
        }

        function formatMarkdown(text) {
            if (!text) return '';
            let s = escapeHtml(text);
            s = s.replace(/\\*\\*(.*?)\\*\\*/g, '<strong class="font-bold text-white">$1</strong>');
            s = s.replace(/\\*(.*?)\\*/g, '<em class="italic text-slate-200">$1</em>');
            s = s.replace(new RegExp('\\\\x60([^\\\\x60]+)\\\\x60', 'g'), '<code class="px-1.5 py-0.5 rounded bg-slate-900 text-blue-300 font-mono text-xs border border-slate-800">$1</code>');
            return s;
        }

        function syncDomToBlocks() {
            if (!currentFolderData.pages || !currentFolderData.pages[currentPageIndex]) return;
            const blocks = currentFolderData.pages[currentPageIndex].blocks || [];
            const container = document.getElementById('editor-container');
            if (!container) return;
            
            const blockEls = container.children;
            for (let i = 0; i < blockEls.length; i++) {
                if (!blocks[i]) continue;
                const bType = blocks[i].type;
                
                if (['paragraph', 'h1', 'h2', 'h3', 'header', 'bullet', 'numbered', 'quote', 'callout'].includes(bType)) {
                    const input = blockEls[i].querySelector('textarea, input[type="text"]');
                    if (input) blocks[i].content = input.value;
                } else if (bType === 'todo') {
                    const input = blockEls[i].querySelector('textarea, input[type="text"]');
                    const checkbox = blockEls[i].querySelector('input[type="checkbox"]');
                    if (input) blocks[i].content = input.value;
                    if (checkbox) blocks[i].checked = checkbox.checked;
                } else if (bType === 'code') {
                    const langInput = blockEls[i].querySelector('input[type="text"]');
                    const codeTextarea = blockEls[i].querySelector('textarea');
                    if (langInput) blocks[i].language = langInput.value;
                    if (codeTextarea) blocks[i].content = codeTextarea.value;
                }
            }
        }

        function updateAdminUI() {
            const btn = document.getElementById('admin-auth-btn');
            const newFolderBtn = document.getElementById('new-folder-btn');
            const fab = document.getElementById('fab-container');
            const saveFab = document.getElementById('save-fab-container');
            const titleInput = document.getElementById('page-title');

            if(isAdmin) {
                btn.innerText = 'Sign Out';
                btn.className = 'text-xs px-3.5 py-1.5 rounded-xl font-semibold transition bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30';
                newFolderBtn.classList.remove('hidden');
                fab.classList.remove('hidden');
                saveFab.classList.remove('hidden');
                titleInput.removeAttribute('readonly');
            } else {
                btn.innerText = 'Sign In';
                btn.className = 'text-xs px-3.5 py-1.5 rounded-xl font-semibold transition bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/30';
                newFolderBtn.classList.add('hidden');
                fab.classList.add('hidden');
                saveFab.classList.add('hidden');
                titleInput.setAttribute('readonly', true);
            }
            initFolderSortable();
        }

        async function handleAdminToggle() {
            if(isAdmin) {
                isAdmin = false; localStorage.setItem('isAdmin', 'false');
                updateAdminUI(); showToast('Signed out.'); 
                if (currentFolderId) renderCurrentPage();
            } else {
                const pwd = await showCustomDialog({
                    title: 'Sign In Admin',
                    desc: 'Masukkan password admin untuk mengaktifkan mode editor workspace.',
                    placeholder: 'Password admin...',
                    isPrompt: true,
                    isPassword: true,
                    confirmText: 'Masuk'
                });
                if(!pwd) return;
                try {
                    const res = await fetch('/api/verify-password', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ password: pwd }) });
                    if((await res.json()).success) {
                        isAdmin = true; localStorage.setItem('isAdmin', 'true');
                        updateAdminUI(); showToast('Akses Admin Aktif'); 
                        if (currentFolderId) renderCurrentPage();
                    } else showToast('Password salah', true);
                } catch(e) { showToast('Gagal terhubung', true); }
            }
        }

        async function loadFolders() {
            try {
                const res = await fetch('/api/pages');
                const data = await res.json();
                folders = Array.isArray(data) ? data : [];
                renderFolderList();
            } catch(e) { document.getElementById('folder-list').innerHTML = '<p class="text-xs text-red-400 p-4">Gagal memuat workspace.</p>'; }
        }

        function renderWelcomeView() {
            currentFolderId = null;
            document.getElementById('top-nav-container').classList.replace('flex', 'hidden');
            document.getElementById('bot-nav-container').classList.replace('flex', 'hidden');
            document.getElementById('title-wrapper').classList.add('hidden');

            const container = document.getElementById('editor-container');
            container.innerHTML = \`
                <div class="flex flex-col items-center justify-center text-center py-20 px-4">
                    <div class="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-blue-400 mb-4 shadow-xl">
                        <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>
                    </div>
                    <button onclick="toggleSidebar()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold transition shadow-lg shadow-blue-950 flex items-center gap-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
                        Buka Sidebar
                    </button>
                </div>
            \`;
        }

        async function createNewFolder() {
            const title = await showCustomDialog({
                title: 'Buat Modul Folder Baru',
                desc: 'Masukkan nama folder materi baru yang ingin ditambahkan.',
                placeholder: 'e.g. Routing Static, VLAN, Firewall...',
                isPrompt: true,
                confirmText: 'Buat Modul'
            });
            if(!title || title.trim() === '') return;
            
            showToast('Membuat modul folder...');
            try {
                const folderName = title.trim();
                const payload = { 
                    title: folderName, 
                    pages: [{ title: '', blocks: [] }] 
                };
                const res = await fetch('/api/pages', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                const result = await res.json();
                if(result.success) {
                    showToast('Folder dibuat!');
                    await loadFolders(); 
                    loadFolderContent(result.file.id, 0);
                } else showToast('Gagal membuat modul', true);
            } catch(e) { showToast('Kesalahan jaringan', true); }
        }

        async function renameFolder(id, oldName) {
            const newTitle = await showCustomDialog({
                title: 'Ubah Nama Modul',
                desc: 'Perbarui nama modul folder materi ini.',
                placeholder: 'Nama modul...',
                defaultValue: oldName,
                isPrompt: true,
                confirmText: 'Simpan Nama'
            });
            if(!newTitle || newTitle === oldName) return;
            
            showToast('Mengubah nama...');
            try {
                const res = await fetch(\`/api/pages/\${id}/rename\`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ title: newTitle }) });
                if(res.ok) {
                    showToast('Nama modul diubah!');
                    await loadFolders();
                } else showToast('Gagal mengubah nama', true);
            } catch(e) { showToast('Kesalahan jaringan', true); }
        }

        async function deleteFolder(id, name) {
            const confirmed = await showCustomDialog({
                title: 'Hapus Modul Folder',
                desc: \`Yakin ingin menghapus modul "\${name}" beserta seluruh isinya?\`,
                isPrompt: false,
                isDanger: true,
                confirmText: 'Hapus Modul'
            });
            if(!confirmed) return;
            
            showToast('Menghapus...');
            try {
                const res = await fetch(\`/api/pages/\${id}\`, { method: 'DELETE' });
                if(res.ok) {
                    showToast('Modul dihapus!');
                    await loadFolders();
                    renderWelcomeView();
                } else showToast('Gagal menghapus', true);
            } catch(e) { showToast('Kesalahan jaringan', true); }
        }

        function initFolderSortable() {
            const listEl = document.getElementById('folder-list');
            if (!listEl) return;
            
            if (folderSortableInstance) {
                folderSortableInstance.destroy();
                folderSortableInstance = null;
            }

            folderSortableInstance = new Sortable(listEl, {
                animation: 200,
                ghostClass: 'folder-drag-ghost',
                chosenClass: 'folder-drag-chosen',
                delay: 200,
                delayOnTouchOnly: true,
                touchStartThreshold: 5,
                disabled: !isAdmin,
                onEnd: async function(evt) {
                    const items = document.querySelectorAll('#folder-list > div[data-id]');
                    const newOrder = Array.from(items).map(el => el.getAttribute('data-id'));
                    
                    folders.sort((a, b) => newOrder.indexOf(a.id) - newOrder.indexOf(b.id));

                    if (isAdmin) {
                        try {
                            const res = await fetch('/api/folders/reorder', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({ order: newOrder })
                            });
                            if ((await res.json()).success) {
                                showToast('Urutan posisi folder tersimpan!');
                            }
                        } catch(e) { showToast('Gagal menyimpan urutan folder', true); }
                    }
                }
            });
        }

        function renderFolderList() {
            const listEl = document.getElementById('folder-list');
            listEl.innerHTML = '';
            if(folders.length === 0) { listEl.innerHTML = '<p class="text-xs text-slate-500 p-4 text-center">Belum ada modul materi.</p>'; return; }
            
            folders.forEach((file) => {
                const cleanName = file.name.replace('.json', '').replace(/-/g, ' ');
                const isActive = currentFolderId === file.id;
                
                const div = document.createElement('div');
                div.setAttribute('data-id', file.id);
                div.className = \`group relative flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer select-none \${
                    isActive 
                    ? 'bg-blue-600/15 text-blue-400 border border-blue-500/30 font-semibold' 
                    : 'text-slate-300 hover:bg-slate-850 hover:text-white border border-transparent'
                }\`;
                
                const btnContent = document.createElement('button');
                btnContent.className = "flex-1 text-left truncate flex items-center gap-2.5 outline-none";
                btnContent.innerHTML = \`
                    <svg class="w-4 h-4 shrink-0 pointer-events-none \${isActive ? 'text-blue-400' : 'text-slate-400'}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
                    <span class="truncate capitalize text-slate-200 group-hover:text-white pointer-events-none">\${cleanName}</span>
                \`;
                btnContent.onclick = () => { 
                    loadFolderContent(file.id, 0); 
                    toggleSidebar();
                };
                div.appendChild(btnContent);

                if(isAdmin) {
                    const actions = document.createElement('div');
                    actions.className = "hidden group-hover:flex items-center gap-1 shrink-0 ml-2";
                    
                    const btnRename = document.createElement('button');
                    btnRename.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
                    btnRename.className = "p-1 rounded hover:bg-slate-750 text-slate-400 hover:text-slate-200 transition";
                    btnRename.onclick = (e) => { e.stopPropagation(); renameFolder(file.id, cleanName); };
                    
                    const btnDelete = document.createElement('button');
                    btnDelete.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
                    btnDelete.className = "p-1 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition";
                    btnDelete.onclick = (e) => { e.stopPropagation(); deleteFolder(file.id, cleanName); };
                    
                    actions.appendChild(btnRename);
                    actions.appendChild(btnDelete);
                    div.appendChild(actions);
                }
                listEl.appendChild(div);
            });

            initFolderSortable();
        }

        async function loadFolderContent(id, targetPageIndex = 0, targetBlockIndex = null) {
            try {
                const res = await fetch(\`/api/pages/\${id}\`);
                const data = await res.json();
                currentFolderId = id;
                
                if(!data.pages || !Array.isArray(data.pages)) {
                    currentFolderData = {
                        title: data.title || 'Untitled Folder',
                        pages: [{ title: '', blocks: data.blocks || [] }]
                    };
                } else {
                    currentFolderData = data;
                }

                currentPageIndex = targetPageIndex || 0;
                renderFolderList();
                renderCurrentPage();

                if (targetBlockIndex !== null && typeof targetBlockIndex !== 'undefined') {
                    setTimeout(() => {
                        const targetBlock = document.getElementById(\`block-\${targetBlockIndex}\`);
                        if (targetBlock) {
                            targetBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            targetBlock.classList.add('highlight-pulse');
                            setTimeout(() => targetBlock.classList.remove('highlight-pulse'), 2000);
                        }
                    }, 120);
                } else {
                    document.getElementById('main-scroll').scrollTo({top: 0, behavior: 'smooth'});
                }
            } catch(e) { showToast('Gagal memuat modul', true); }
        }

        function renderCurrentPage() {
            const pages = currentFolderData.pages || [];
            
            document.getElementById('top-nav-container').classList.replace('hidden', 'flex');
            document.getElementById('bot-nav-container').classList.replace('hidden', 'flex');
            document.getElementById('title-wrapper').classList.remove('hidden');

            if(currentPageIndex >= pages.length) currentPageIndex = pages.length - 1;
            if(currentPageIndex < 0) currentPageIndex = 0;

            const page = pages[currentPageIndex] || { title: '', blocks: [] };
            const titleEl = document.getElementById('page-title');
            titleEl.value = page.title || '';
            setTimeout(() => autoResize(titleEl), 50);

            const container = document.getElementById('editor-container');
            container.innerHTML = '';
            
            const blocks = page.blocks || [];
            if(blocks.length === 0) {
                updateNavigationUI(currentPageIndex + 1, pages.length);
                return;
            }

            blocks.forEach((block, index) => {
                const wrapper = document.createElement('div');
                wrapper.id = \`block-\${index}\`;
                wrapper.className = "notion-block group relative w-full mb-2 transition-all duration-200 rounded-xl";
                
                const moveControls = isAdmin ? \`
                    <div class="block-actions opacity-0 group-hover:opacity-100 flex items-center gap-1 absolute right-2 top-2 transition-opacity bg-slate-900 border border-slate-700/80 px-1.5 py-0.5 rounded-lg shadow-xl z-10">
                        <button type="button" onclick="moveBlock(\${index}, -1)" title="Pindah ke Atas" class="p-1 hover:text-blue-400 text-slate-400 text-xs">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>
                        </button>
                        <button type="button" onclick="moveBlock(\${index}, 1)" title="Pindah ke Bawah" class="p-1 hover:text-blue-400 text-slate-400 text-xs">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
                        </button>
                        <button type="button" onclick="removeBlock(\${index})" title="Hapus Blok" class="p-1 hover:text-red-400 text-slate-400 text-xs">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
                        </button>
                    </div>
                \` : '';

                let bType = block.type;
                if (bType === 'header') bType = 'h2';

                if (isAdmin) {
                    let inner = '';
                    if (bType === 'paragraph') {
                        inner = \`<textarea rows="1" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="Ketik teks normal... (bisa **bold**, *italic*)" class="w-full bg-transparent text-slate-200 text-sm leading-relaxed outline-none resize-none px-3 py-1.5 rounded-lg hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition font-sans whitespace-pre-wrap">\${block.content || ''}</textarea>\`;
                    } else if (bType === 'h1') {
                        inner = \`<textarea rows="1" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="Heading 1..." class="w-full bg-transparent text-2xl sm:text-3xl font-extrabold text-white outline-none resize-none px-3 py-1 rounded-lg hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition tracking-tight whitespace-pre-wrap">\${block.content || ''}</textarea>\`;
                    } else if (bType === 'h2') {
                        inner = \`<textarea rows="1" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="Heading 2..." class="w-full bg-transparent text-xl sm:text-2xl font-bold text-slate-100 outline-none resize-none px-3 py-1 rounded-lg hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition tracking-tight whitespace-pre-wrap">\${block.content || ''}</textarea>\`;
                    } else if (bType === 'h3') {
                        inner = \`<textarea rows="1" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="Heading 3..." class="w-full bg-transparent text-lg font-semibold text-slate-200 outline-none resize-none px-3 py-1 rounded-lg hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition whitespace-pre-wrap">\${block.content || ''}</textarea>\`;
                    } else if (bType === 'bullet') {
                        inner = \`<div class="flex items-start gap-2.5 px-3 py-1"><span class="text-blue-400 font-bold mt-1 text-base leading-none">•</span><textarea rows="1" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="List item..." class="w-full bg-transparent text-slate-200 text-sm outline-none resize-none hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 rounded-lg p-1 transition whitespace-pre-wrap">\${block.content || ''}</textarea></div>\`;
                    } else if (bType === 'numbered') {
                        inner = \`<div class="flex items-start gap-2.5 px-3 py-1"><span class="font-mono text-blue-400 text-xs font-bold mt-1.5">\${index + 1}.</span><textarea rows="1" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="Numbered list..." class="w-full bg-transparent text-slate-200 text-sm outline-none resize-none hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 rounded-lg p-1 transition whitespace-pre-wrap">\${block.content || ''}</textarea></div>\`;
                    } else if (bType === 'todo') {
                        inner = \`<div class="flex items-start gap-2.5 px-3 py-1"><input type="checkbox" onchange="updateBlockChecked(\${index}, this.checked)" \${block.checked ? 'checked' : ''} class="mt-1.5 w-4 h-4 rounded border-slate-700 text-blue-600 focus:ring-blue-500 bg-slate-850 cursor-pointer"><textarea rows="1" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="To-do task..." class="w-full bg-transparent text-slate-200 text-sm outline-none resize-none hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 rounded-lg p-1 transition whitespace-pre-wrap \${block.checked ? 'line-through text-slate-500' : ''}">\${block.content || ''}</textarea></div>\`;
                    } else if (bType === 'callout') {
                        inner = \`<div class="bg-blue-950/20 border border-blue-500/30 rounded-2xl p-3.5 flex items-start gap-3 shadow-inner"><svg class="w-5 h-5 text-blue-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg><textarea rows="2" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="Tulis catatan penting..." class="w-full bg-transparent text-slate-200 text-xs sm:text-sm outline-none resize-none font-medium whitespace-pre-wrap">\${block.content || ''}</textarea></div>\`;
                    } else if (bType === 'quote') {
                        inner = \`<div class="border-l-2 border-blue-500 pl-3.5 py-1"><textarea rows="2" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="Kutipan..." class="w-full bg-transparent text-slate-300 italic text-sm outline-none resize-none whitespace-pre-wrap font-serif">\${block.content || ''}</textarea></div>\`;
                    } else if (bType === 'divider') {
                        inner = \`<div class="py-2"><div class="h-px bg-slate-800/80 w-full"></div></div>\`;
                    } else if (bType === 'code') {
                        inner = \`<div class="bg-slate-900 text-slate-200 p-4 rounded-2xl font-mono text-xs border border-slate-800 shadow-inner"><input type="text" value="\${block.language || 'javascript'}" oninput="updateBlockLang(\${index}, this.value)" placeholder="Bahasa (e.g. bash, javascript, html, python)" class="bg-transparent text-[11px] text-blue-400 font-bold pb-2 outline-none w-full border-b border-slate-800 block"/><textarea rows="4" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" class="w-full bg-transparent outline-none resize-none text-slate-100 mt-2 font-mono whitespace-pre" placeholder="Paste kode program...">\${block.content || ''}</textarea></div>\`;
                    }
                    wrapper.innerHTML = \`<div class="relative w-full">\${moveControls}\${inner}</div>\`;
                } else {
                    if (bType === 'paragraph') {
                        wrapper.innerHTML = \`<p class="text-slate-300 leading-relaxed text-sm my-2 whitespace-pre-wrap font-sans">\${formatMarkdown(block.content)}</p>\`;
                    } else if (bType === 'h1') {
                        wrapper.innerHTML = \`<h1 class="text-2xl sm:text-3xl font-extrabold text-white mt-7 mb-2 tracking-tight whitespace-pre-wrap">\${escapeHtml(block.content)}</h1>\`;
                    } else if (bType === 'h2') {
                        wrapper.innerHTML = \`<h2 class="text-xl sm:text-2xl font-bold text-slate-100 mt-5 mb-2 tracking-tight whitespace-pre-wrap">\${escapeHtml(block.content)}</h2><div class="h-px w-full bg-slate-850 mb-3"></div>\`;
                    } else if (bType === 'h3') {
                        wrapper.innerHTML = \`<h3 class="text-lg font-bold text-slate-200 mt-4 mb-1 tracking-tight whitespace-pre-wrap">\${escapeHtml(block.content)}</h3>\`;
                    } else if (bType === 'bullet') {
                        wrapper.innerHTML = \`<div class="flex items-start gap-2.5 my-1.5"><span class="text-blue-400 text-base leading-none mt-1 font-bold">•</span><p class="text-slate-300 text-sm whitespace-pre-wrap flex-1 font-sans">\${formatMarkdown(block.content)}</p></div>\`;
                    } else if (bType === 'numbered') {
                        wrapper.innerHTML = \`<div class="flex items-start gap-2.5 my-1.5"><span class="font-mono text-blue-400 text-xs font-bold mt-1">\${index + 1}.</span><p class="text-slate-300 text-sm whitespace-pre-wrap flex-1 font-sans">\${formatMarkdown(block.content)}</p></div>\`;
                    } else if (bType === 'todo') {
                        wrapper.innerHTML = \`<div class="flex items-start gap-2.5 my-1.5"><input type="checkbox" \${block.checked ? 'checked' : ''} disabled class="mt-1 w-4 h-4 rounded border-slate-700 text-blue-600 bg-slate-850"><p class="text-slate-300 text-sm whitespace-pre-wrap flex-1 font-sans \${block.checked ? 'line-through text-slate-500' : ''}">\${formatMarkdown(block.content)}</p></div>\`;
                    } else if (bType === 'callout') {
                        wrapper.innerHTML = \`<div class="bg-blue-950/20 border border-blue-500/30 rounded-2xl p-4 flex items-start gap-3 my-3 shadow-inner"><svg class="w-5 h-5 text-blue-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg><div class="text-slate-200 text-xs sm:text-sm font-medium leading-relaxed whitespace-pre-wrap flex-1">\${formatMarkdown(block.content)}</div></div>\`;
                    } else if (bType === 'quote') {
                        wrapper.innerHTML = \`<blockquote class="border-l-2 border-blue-500 pl-4 py-1.5 my-3 text-slate-300 italic text-sm font-serif leading-relaxed whitespace-pre-wrap">\${formatMarkdown(block.content)}</blockquote>\`;
                    } else if (bType === 'divider') {
                        wrapper.innerHTML = \`<div class="py-3"><div class="h-px bg-slate-800/80 w-full"></div></div>\`;
                    } else if (bType === 'code') {
                        wrapper.innerHTML = \`<div class="relative group/code bg-slate-900 border border-slate-800 p-4 rounded-2xl my-3"><div class="flex justify-between items-center pb-2 mb-2 border-b border-slate-800 text-[11px] font-mono text-blue-400"><span>\${escapeHtml(block.language || 'code')}</span><button type="button" onclick="copyCode(this)" class="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-2 py-0.5 rounded-md transition shadow border border-slate-700">Salin</button></div><pre class="font-mono text-xs overflow-x-auto"><code class="language-\${block.language || 'javascript'}">\${escapeHtml(block.content)}</code></pre></div>\`;
                    }
                }
                container.appendChild(wrapper);
            });

            if(isAdmin) document.querySelectorAll('#editor-container textarea, #page-title').forEach(el => autoResize(el));
            else hljs.highlightAll();

            updateNavigationUI(currentPageIndex + 1, pages.length);
        }

        function updateNavigationUI(current, total) {
            document.getElementById('page-indicator').innerText = total > 0 ? \`Hal \${current} / \${total}\` : 'Hal 0 / 0';
            
            const hasPrev = current > 1;
            const hasNext = current < total;

            const topPrev = document.getElementById('top-btn-prev');
            const botPrev = document.getElementById('bot-btn-prev');
            const topNext = document.getElementById('top-btn-next');
            const botNext = document.getElementById('bot-btn-next');

            if (hasPrev) {
                topPrev.classList.remove('invisible');
                botPrev.classList.remove('invisible');
            } else {
                topPrev.classList.add('invisible');
                botPrev.classList.add('invisible');
            }

            if (hasNext) {
                topNext.classList.remove('invisible');
                botNext.classList.remove('invisible');
            } else {
                topNext.classList.add('invisible');
                botNext.classList.add('invisible');
            }
        }

        function goToPrevPage() {
            if(currentPageIndex > 0) {
                syncDomToBlocks();
                currentPageIndex--;
                renderCurrentPage();
                document.getElementById('main-scroll').scrollTo({top: 0, behavior: 'smooth'});
            }
        }

        function goToNextPage() {
            if(currentPageIndex < currentFolderData.pages.length - 1) {
                syncDomToBlocks();
                currentPageIndex++;
                renderCurrentPage();
                document.getElementById('main-scroll').scrollTo({top: 0, behavior: 'smooth'});
            }
        }

        function addNewPage() {
            if (!currentFolderId) {
                showToast('Pilih folder terlebih dahulu di sidebar!', true);
                toggleFab(null, false);
                return;
            }
            syncDomToBlocks();
            if(!currentFolderData.pages) currentFolderData.pages = [];
            currentFolderData.pages.push({
                title: '',
                blocks: []
            });
            currentPageIndex = currentFolderData.pages.length - 1;
            toggleFab(null, false);
            renderCurrentPage();
            document.getElementById('main-scroll').scrollTo({top: 0, behavior: 'smooth'});
            showToast('Halaman baru dibuat.');
        }

        async function deleteCurrentPage() {
            if (!currentFolderId) {
                showToast('Belum ada folder yang dipilih!', true);
                toggleFab(null, false);
                return;
            }
            if(!currentFolderData.pages || currentFolderData.pages.length <= 1) {
                showToast('Folder minimal harus memiliki 1 halaman!', true);
                toggleFab(null, false);
                return;
            }
            const confirmed = await showCustomDialog({
                title: 'Hapus Halaman Ini',
                desc: 'Halaman ini dan seluruh blok isinya akan dihapus.',
                isPrompt: false,
                isDanger: true,
                confirmText: 'Hapus Halaman'
            });
            if(!confirmed) return;
            
            syncDomToBlocks();
            currentFolderData.pages.splice(currentPageIndex, 1);
            if(currentPageIndex >= currentFolderData.pages.length) {
                currentPageIndex = currentFolderData.pages.length - 1;
            }
            toggleFab(null, false);
            renderCurrentPage();
            showToast('Halaman dihapus.');
        }

        function updateCurrentPageTitle(val) {
            if(currentFolderData.pages && currentFolderData.pages[currentPageIndex]) {
                currentFolderData.pages[currentPageIndex].title = val;
            }
        }

        function updateBlockContent(i, val) { 
            if(currentFolderData.pages[currentPageIndex] && currentFolderData.pages[currentPageIndex].blocks[i]) {
                currentFolderData.pages[currentPageIndex].blocks[i].content = val; 
            }
        }
        function updateBlockLang(i, val) { 
            if(currentFolderData.pages[currentPageIndex] && currentFolderData.pages[currentPageIndex].blocks[i]) {
                currentFolderData.pages[currentPageIndex].blocks[i].language = val; 
            }
        }
        function updateBlockChecked(i, val) { 
            if(currentFolderData.pages[currentPageIndex] && currentFolderData.pages[currentPageIndex].blocks[i]) {
                currentFolderData.pages[currentPageIndex].blocks[i].checked = val; 
                renderCurrentPage();
            }
        }
        function moveBlock(i, dir) {
            syncDomToBlocks();
            const blocks = currentFolderData.pages[currentPageIndex].blocks;
            const target = i + dir;
            if (target < 0 || target >= blocks.length) return;
            const temp = blocks[i];
            blocks[i] = blocks[target];
            blocks[target] = temp;
            renderCurrentPage();
        }
        function removeBlock(i) { 
            syncDomToBlocks();
            if(currentFolderData.pages[currentPageIndex] && currentFolderData.pages[currentPageIndex].blocks) {
                currentFolderData.pages[currentPageIndex].blocks.splice(i, 1); 
                renderCurrentPage(); 
            }
        }

        function addBlock(type) { 
            if (!currentFolderId || !currentFolderData.pages || currentFolderData.pages.length === 0) {
                showToast('Pilih folder terlebih dahulu di sidebar!', true);
                toggleFab(null, false);
                return;
            }
            if (!currentFolderData.pages[currentPageIndex]) currentPageIndex = 0;
            if (!currentFolderData.pages[currentPageIndex].blocks) currentFolderData.pages[currentPageIndex].blocks = [];

            syncDomToBlocks();

            currentFolderData.pages[currentPageIndex].blocks.push({ 
                type, 
                content: '', 
                checked: type === 'todo' ? false : undefined,
                language: type === 'code' ? 'javascript' : undefined 
            }); 
            
            toggleFab(null, false);
            renderCurrentPage();

            setTimeout(() => {
                const container = document.getElementById('editor-container');
                const lastBlock = container.lastElementChild;
                if(lastBlock) {
                    const inputEl = lastBlock.querySelector('textarea, input[type="text"]');
                    if(inputEl) inputEl.focus();
                    lastBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 80);
        }

        async function saveCurrentFolder() {
            if(!currentFolderId) {
                showToast('Tidak ada folder aktif untuk disimpan!', true);
                return;
            }
            syncDomToBlocks();
            showToast('Menyimpan ke Google Drive...');
            try {
                const res = await fetch('/api/pages', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ 
                        id: currentFolderId, 
                        title: currentFolderData.title, 
                        pages: currentFolderData.pages 
                    }) 
                });
                if((await res.json()).success) { 
                    showToast('Semua halaman tersimpan!'); 
                    toggleFab(null, false);
                    await loadFolders(); 
                } else showToast('Gagal menyimpan', true);
            } catch(e) { showToast('Error jaringan', true); }
        }

        function copyCode(btn) {
            navigator.clipboard.writeText(btn.closest('.group\\/code').querySelector('code').innerText);
            btn.innerText = 'Tersalin!'; btn.classList.add('text-blue-400');
            setTimeout(() => { btn.innerText = 'Salin'; btn.classList.remove('text-blue-400'); }, 2000);
        }

        function escapeHtml(t) { return (t || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

        function handleDeepSearch(query) {
            clearTimeout(searchDebounceTimer);
            const resBox = document.getElementById('search-results');
            if(!query.trim()) { resBox.classList.add('hidden'); return; }

            searchDebounceTimer = setTimeout(async () => {
                try {
                    const res = await fetch(\`/api/search?q=\${encodeURIComponent(query.trim())}\`);
                    const data = await res.json();
                    
                    resBox.innerHTML = '';
                    if(!data || data.length === 0) { 
                        resBox.innerHTML = \`
                            <div class="p-4 text-center text-xs text-slate-500">
                                Tidak ada hasil untuk "<span class="text-slate-300">\${escapeHtml(query)}</span>"
                            </div>
                        \`; 
                    } else {
                        data.forEach(item => {
                            const div = document.createElement('div');
                            div.className = 'flex items-center justify-between p-3 hover:bg-slate-850 rounded-xl cursor-pointer transition group gap-3';
                            
                            let badgeHtml = '';
                            let iconSvg = '';

                            if (item.type === 'folder') {
                                badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">Folder</span>';
                                iconSvg = '<svg class="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
                            } else if (item.type === 'page') {
                                badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">Halaman</span>';
                                iconSvg = '<svg class="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
                            } else if (item.type === 'heading') {
                                badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-purple-500/10 text-purple-400 border border-purple-500/20 shrink-0">Sub Bab</span>';
                                iconSvg = '<svg class="w-4 h-4 text-purple-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>';
                            }

                            div.innerHTML = \`
                                <div class="flex items-center gap-3 truncate">
                                    \${iconSvg}
                                    <div class="truncate">
                                        <div class="text-xs text-slate-200 group-hover:text-white font-semibold truncate capitalize">\${escapeHtml(item.title)}</div>
                                        <div class="text-[11px] text-slate-500 group-hover:text-slate-400 truncate mt-0.5">\${escapeHtml(item.subtext)}</div>
                                    </div>
                                </div>
                                <div class="flex items-center gap-2 shrink-0">
                                    \${badgeHtml}
                                    <span class="text-[11px] text-slate-500 group-hover:text-slate-300 font-mono hidden sm:inline">Buka →</span>
                                </div>
                            \`;

                            div.onclick = () => { 
                                loadFolderContent(item.folderId, item.pageIndex, item.blockIndex); 
                                resBox.classList.add('hidden'); 
                                document.getElementById('global-search').value = ''; 
                            };
                            resBox.appendChild(div);
                        });
                    }
                    resBox.classList.remove('hidden');
                } catch (e) { console.error(e); }
            }, 250);
        }

        document.addEventListener('click', (e) => {
            if (isFabOpen) {
                const fabContainer = document.getElementById('fab-container');
                if (fabContainer && !fabContainer.contains(e.target)) {
                    toggleFab(null, false);
                }
            }
            const searchInput = document.getElementById('global-search');
            const resBox = document.getElementById('search-results');
            if (searchInput && resBox && !searchInput.contains(e.target) && !resBox.contains(e.target)) {
                resBox.classList.add('hidden');
            }
        });
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));
}
module.exports = app;
