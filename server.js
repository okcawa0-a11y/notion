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
            q: "'" + FOLDER_ID + "' in parents and name='_order_manifest.json' and trashed=false",
            fields: 'files(id, name)',
        });
        if (res.data.files && res.data.files.length > 0) {
            const fileId = res.data.files[0].id;
            const contentRes = await drive.files.get({ fileId, alt: 'media' });
            return { fileId, order: contentRes.data.order || [] };
        }
    } catch (e) { console.error("Error order:", e.message); }
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
            q: "'" + FOLDER_ID + "' in parents and mimeType='application/json' and trashed=false",
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
                q: "'" + FOLDER_ID + "' in parents and mimeType='application/json' and trashed=false",
                fields: 'files(id, name, createdTime)',
                orderBy: 'name',
            });
            fileCache = { data: (response.data.files || []).filter(f => !f.name.startsWith('_')), timestamp: now };
        }
        const files = fileCache.data || [];
        const results = [];

        await Promise.all(files.map(async (file) => {
            const cleanFolderName = file.name.replace(/\.json$/i, '');

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
                const pageTitle = p.title || ('Halaman ' + (pIdx + 1));

                if (pageTitle.toLowerCase().includes(query)) {
                    results.push({
                        type: 'page',
                        folderId: file.id,
                        folderName: cleanFolderName,
                        title: pageTitle,
                        subtext: 'Folder: ' + cleanFolderName + ' • Halaman ' + (pIdx + 1),
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
                                subtext: cleanFolderName + ' ➔ ' + pageTitle,
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
            const safeTitle = (title || 'Untitled Folder').trim().replace(/[\/\\]/g, '／');
            targetFileName = safeTitle + '.json';
        }

        const fileMetadata = { name: targetFileName, mimeType: 'application/json' };
        const payloadData = { title: (title || 'Untitled Folder').trim(), pages, updated_at: new Date().toISOString() };
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
        const safeTitle = (title || 'Untitled Folder').trim().replace(/[\/\\]/g, '／');
        const fileName = safeTitle + '.json';
        
        const file = await drive.files.get({ fileId: req.params.id, alt: 'media' });
        let content = file.data;
        content.title = (title || 'Untitled Folder').trim();

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
    res.send('<!DOCTYPE html>\n' +
'<html lang="id" class="dark">\n' +
'<head>\n' +
'    <meta charset="UTF-8">\n' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'    <title>Shanz Workspace</title>\n' +
'    <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
'    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
'    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">\n' +
'    <script src="https://cdn.tailwindcss.com"></script>\n' +
'    <script>\n' +
'        tailwind.config = {\n' +
'            darkMode: \'class\',\n' +
'            theme: {\n' +
'                extend: {\n' +
'                    fontFamily: { \n' +
'                        sans: [\'"Plus Jakarta Sans"\', \'Inter\', \'sans-serif\'],\n' +
'                        mono: [\'"JetBrains Mono"\', \'monospace\']\n' +
'                    },\n' +
'                    colors: { \n' +
'                        brand: { 50: \'#eff6ff\', 100: \'#dbeafe\', 400: \'#60a5fa\', 500: \'#3b82f6\', 600: \'#2563eb\', 700: \'#1d4ed8\' },\n' +
'                        slate: { \n' +
'                            750: \'#1b2438\',\n' +
'                            850: \'#111726\', \n' +
'                            900: \'#0c111d\', \n' +
'                            950: \'#060a12\' \n' +
'                        }\n' +
'                    }\n' +
'                }\n' +
'            }\n' +
'        }\n' +
'    </script>\n' +
'    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">\n' +
'    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>\n' +
'    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js"></script>\n' +
'    <style>\n' +
'        html { scroll-behavior: smooth; }\n' +
'        ::-webkit-scrollbar { width: 5px; height: 5px; }\n' +
'        ::-webkit-scrollbar-track { background: transparent; }\n' +
'        ::-webkit-scrollbar-thumb { background: rgba(59, 130, 246, 0.2); border-radius: 5px; }\n' +
'        ::-webkit-scrollbar-thumb:hover { background: rgba(59, 130, 246, 0.4); }\n' +
'        textarea { overflow: hidden; }\n' +
'        .highlight-pulse {\n' +
'            animation: pulseBlock 2s cubic-bezier(0.4, 0, 0.6, 1);\n' +
'        }\n' +
'        @keyframes pulseBlock {\n' +
'            0%, 100% { background-color: transparent; }\n' +
'            50% { background-color: rgba(59, 130, 246, 0.15); border-radius: 0.75rem; }\n' +
'        }\n' +
'        .notion-block:hover .block-actions {\n' +
'            opacity: 1;\n' +
'            pointer-events: auto;\n' +
'        }\n' +
'        .folder-drag-ghost {\n' +
'            opacity: 0.3;\n' +
'            background-color: rgba(59, 130, 246, 0.2) !important;\n' +
'            border: 1px dashed rgba(59, 130, 246, 0.6) !important;\n' +
'        }\n' +
'        .folder-drag-chosen {\n' +
'            background-color: rgba(17, 23, 38, 0.95) !important;\n' +
'            border: 1px solid rgba(59, 130, 246, 0.5) !important;\n' +
'        }\n' +
'    </style>\n' +
'</head>\n' +
'<body class="bg-slate-950 text-slate-200 font-sans h-screen flex flex-col overflow-hidden selection:bg-brand-500/30 selection:text-blue-200">\n' +
'\n' +
'    <!-- TOP NAVBAR -->\n' +
'    <header class="h-14 border-b border-slate-850/90 px-4 sm:px-6 flex justify-between items-center bg-slate-900/90 backdrop-blur-xl z-30 shrink-0">\n' +
'        <div class="flex items-center gap-3 w-1/4">\n' +
'            <button onclick="toggleSidebar()" class="p-2 rounded-xl bg-slate-850 hover:bg-slate-800 text-slate-300 hover:text-white transition flex items-center gap-2 border border-slate-700/60 shadow-sm">\n' +
'                <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>\n' +
'                <span class="text-xs font-semibold tracking-wide hidden sm:inline text-slate-200">Menu</span>\n' +
'            </button>\n' +
'        </div>\n' +
'        \n' +
'        <!-- DEEP SEARCH BAR -->\n' +
'        <div class="flex-1 max-w-xl mx-3 relative">\n' +
'            <div class="relative group">\n' +
'                <div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-blue-400 transition">\n' +
'                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>\n' +
'                </div>\n' +
'                <input type="text" id="global-search" oninput="handleDeepSearch(this.value)" placeholder="Cari materi, halaman, atau sub-bab..." class="w-full bg-slate-850/90 text-xs sm:text-sm pl-10 pr-16 py-1.5 rounded-xl outline-none border border-slate-700/60 focus:border-blue-500/80 focus:ring-2 focus:ring-blue-500/20 text-slate-100 placeholder-slate-400 shadow-inner transition">\n' +
'                <div class="absolute inset-y-0 right-0 pr-2.5 flex items-center pointer-events-none">\n' +
'                    <kbd class="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 bg-slate-800 border border-slate-700 rounded-md">Ctrl K</kbd>\n' +
'                </div>\n' +
'            </div>\n' +
'\n' +
'            <!-- SEARCH RESULTS DROPDOWN -->\n' +
'            <div id="search-results" class="absolute top-full left-0 right-0 mt-2 bg-slate-900/95 backdrop-blur-2xl border border-slate-700/80 rounded-2xl shadow-2xl max-h-96 overflow-y-auto hidden z-40 p-2 divide-y divide-slate-800/60"></div>\n' +
'        </div>\n' +
'\n' +
'        <div class="flex items-center justify-end gap-2 w-1/4">\n' +
'            <button id="admin-auth-btn" onclick="handleAdminToggle()" class="text-xs px-3.5 py-1.5 rounded-xl font-semibold transition bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/30">Sign In</button>\n' +
'        </div>\n' +
'    </header>\n' +
'\n' +
'    <!-- LAYOUT UTAMA -->\n' +
'    <div class="flex-1 flex overflow-hidden relative">\n' +
'        <div id="sidebar-overlay" onclick="toggleSidebar()" class="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 hidden transition-opacity"></div>\n' +
'\n' +
'        <!-- SIDEBAR -->\n' +
'        <aside id="sidebar" class="fixed inset-y-0 left-0 z-50 w-72 bg-slate-900 border-r border-slate-850 flex flex-col transform -translate-x-full transition-transform duration-300 h-full shadow-2xl">\n' +
'            <div class="p-4 border-b border-slate-850 flex justify-between items-center bg-slate-900/80">\n' +
'                <div class="flex items-center gap-2.5">\n' +
'                    <div class="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center font-bold text-blue-400 text-xs shadow-inner">\n' +
'                        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>\n' +
'                    </div>\n' +
'                    <span class="text-xs font-bold text-slate-200 uppercase tracking-wider">Materi Folder</span>\n' +
'                </div>\n' +
'                <div class="flex items-center gap-1">\n' +
'                    <button id="new-folder-btn" onclick="createNewFolder()" class="text-[11px] bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1 rounded-lg transition font-medium hidden flex items-center gap-1 shadow-sm">+ Folder</button>\n' +
'                    <button onclick="toggleSidebar()" class="p-1 rounded-lg text-slate-400 hover:text-white text-xs hover:bg-slate-800 transition">\n' +
'                        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>\n' +
'                    </button>\n' +
'                </div>\n' +
'            </div>\n' +
'\n' +
'            <!-- FOLDER LIST -->\n' +
'            <div id="folder-list" class="flex-1 overflow-y-auto p-3 space-y-1">\n' +
'                <p class="text-xs text-slate-500 p-4 text-center animate-pulse">Memuat workspace...</p>\n' +
'            </div>\n' +
'            \n' +
'            <div class="p-3 border-t border-slate-850 bg-slate-950/60 text-[11px] text-slate-400 flex items-center justify-between">\n' +
'                <span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span> Cloud Sync</span>\n' +
'                <span class="font-mono text-[10px] text-slate-500">Shanz Engine</span>\n' +
'            </div>\n' +
'        </aside>\n' +
'\n' +
'        <!-- MAIN WORKSPACE / EDITOR -->\n' +
'        <main id="main-scroll" class="flex-1 overflow-y-auto bg-slate-950 relative">\n' +
'            <div id="main-content-container" class="max-w-4xl mx-auto w-full px-5 sm:px-12 py-8 pb-44">\n' +
'                \n' +
'                <!-- TOP PAGE NAVIGATION & ACTIONS -->\n' +
'                <div id="top-nav-container" class="hidden justify-between items-center mb-6 pb-4 border-b border-slate-850">\n' +
'                    <button id="top-btn-prev" onclick="goToPrevPage()" class="invisible bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 hover:text-white px-3.5 py-1.5 text-xs rounded-xl transition font-medium flex items-center gap-1.5">\n' +
'                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg> Sebelumnya\n' +
'                    </button>\n' +
'                    \n' +
'                    <div class="flex items-center gap-2">\n' +
'                        <div id="page-indicator" class="text-xs font-semibold px-3 py-1 bg-blue-500/10 text-blue-400 rounded-full border border-blue-500/20 font-mono">\n' +
'                            Hal 0 / 0\n' +
'                        </div>\n' +
'                        <button type="button" onclick="exportCurrentFolderMarkdown()" title="Export Modul ke Markdown (.md)" class="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-850 text-slate-400 hover:text-white border border-slate-800 transition">\n' +
'                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>\n' +
'                        </button>\n' +
'                    </div>\n' +
'\n' +
'                    <button id="top-btn-next" onclick="goToNextPage()" class="invisible bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-1.5 text-xs rounded-xl transition font-medium shadow-sm flex items-center gap-1.5">\n' +
'                        Selanjutnya <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>\n' +
'                    </button>\n' +
'                </div>\n' +
'\n' +
'                <!-- JUDUL HALAMAN UTAMA -->\n' +
'                <div id="title-wrapper" class="hidden mb-6 relative group">\n' +
'                    <textarea id="page-title" rows="1" oninput="autoResize(this); updateCurrentPageTitle(this.value)" placeholder="Judul Halaman..." readonly class="text-3xl sm:text-4xl font-extrabold bg-transparent outline-none w-full text-white resize-none tracking-tight placeholder-slate-750 whitespace-pre-wrap leading-tight"></textarea>\n' +
'                    <div class="h-px w-full bg-slate-850 mt-4"></div>\n' +
'                </div>\n' +
'                \n' +
'                <!-- BLOK KONTEN WORKSPACE -->\n' +
'                <div id="editor-container" class="space-y-3"></div>\n' +
'                \n' +
'                <!-- BOTTOM PAGE NAVIGATION -->\n' +
'                <div id="bot-nav-container" class="hidden justify-between items-center mt-12 pt-6 border-t border-slate-850">\n' +
'                    <button id="bot-btn-prev" onclick="goToPrevPage()" class="invisible bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 hover:text-white px-4 py-2 text-xs rounded-xl transition font-medium">❮ Halaman Sebelumnya</button>\n' +
'                    <button id="bot-btn-next" onclick="goToNextPage()" class="invisible bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-xs rounded-xl transition font-medium shadow-sm">Halaman Selanjutnya ❯</button>\n' +
'                </div>\n' +
'            </div>\n' +
'        </main>\n' +
'    </div>\n' +
'\n' +
'    <!-- SAVE FAB (POJOK KIRI BAWAH) -->\n' +
'    <div id="save-fab-container" class="fixed bottom-6 left-6 z-30 hidden">\n' +
'        <button type="button" id="save-fab-btn" onclick="saveCurrentFolder()" title="Simpan Semua Perubahan (Ctrl + S)" class="w-13 h-13 sm:w-14 sm:h-14 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-2xl shadow-blue-950 flex items-center justify-center p-3.5 transition-all duration-200 active:scale-90 focus:outline-none border border-blue-400/30 cursor-pointer select-none group">\n' +
'            <svg class="w-6 h-6 group-hover:scale-110 transition-transform" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>\n' +
'        </button>\n' +
'    </div>\n' +
'\n' +
'    <!-- NOTION BLOCK FAB (POJOK KANAN BAWAH) -->\n' +
'    <div id="fab-container" class="fixed bottom-6 right-6 z-30 flex flex-col items-end gap-2.5 hidden" onclick="event.stopPropagation()">\n' +
'        <div id="fab-menu" class="hidden flex-col gap-2 mb-1 bg-slate-900/95 backdrop-blur-2xl p-4 rounded-2xl shadow-2xl border border-slate-800 min-w-[270px] max-h-[75vh] overflow-y-auto">\n' +
'            <div class="flex items-center justify-between pb-2 border-b border-slate-800">\n' +
'                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Aksi Halaman</span>\n' +
'                <span class="text-[10px] text-blue-400 font-mono font-semibold" id="fab-page-badge">Hal 1</span>\n' +
'            </div>\n' +
'            \n' +
'            <div class="grid grid-cols-2 gap-1.5 pt-1">\n' +
'                <button type="button" onclick="addNewPage()" class="text-left text-xs p-2 rounded-xl bg-slate-850 hover:bg-slate-800 text-slate-200 font-medium flex items-center gap-1.5 transition">\n' +
'                    <svg class="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"/></svg> Hal Baru\n' +
'                </button>\n' +
'                <button type="button" onclick="deleteCurrentPage()" class="text-left text-xs p-2 rounded-xl bg-red-950/30 hover:bg-red-950/60 text-red-400 font-medium flex items-center gap-1.5 transition">\n' +
'                    <svg class="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg> Hapus Hal\n' +
'                </button>\n' +
'            </div>\n' +
'            <button type="button" onclick="openImportModal(); toggleFab(null, false);" class="w-full text-left text-xs p-2 rounded-xl bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 font-medium flex items-center gap-1.5 transition border border-blue-500/20">\n' +
'                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg> Import Catatan AI (Paste)\n' +
'            </button>\n' +
'            \n' +
'            <div class="h-px bg-slate-800 my-1"></div>\n' +
'            <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">Tambah Blok Notion</span>\n' +
'            \n' +
'            <div class="space-y-1">\n' +
'                <button type="button" onclick="addBlock(\'paragraph\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <span class="w-5 text-center font-bold text-blue-400">T</span> Teks Paragraf\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'h1\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <span class="w-5 text-center font-extrabold text-blue-400">H1</span> Heading 1\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'h2\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <span class="w-5 text-center font-bold text-blue-400">H2</span> Heading 2\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'h3\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <span class="w-5 text-center font-semibold text-blue-400">H3</span> Heading 3\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'bullet\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg> Bulleted List\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'numbered\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <span class="w-5 text-center font-mono font-bold text-blue-400">1.</span> Numbered List\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'todo\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/></svg> To-Do Checkbox\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'callout\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg> Callout Box\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'quote\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/></svg> Quote Catatan\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'code\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Snippet Kode\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'table\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-blue-600/20 text-blue-300 font-semibold transition flex items-center gap-2.5 border border-blue-500/30">\n' +
'                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></svg> Blok Tabel Kustom\n' +
'                </button>\n' +
'                <button type="button" onclick="addBlock(\'divider\')" class="w-full text-left text-xs px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2.5">\n' +
'                    <svg class="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="5" x2="19" y1="12" y2="12"/></svg> Garis Pembatas\n' +
'                </button>\n' +
'            </div>\n' +
'        </div>\n' +
'\n' +
'        <button type="button" id="fab-main-btn" onclick="toggleFab(event)" class="w-13 h-13 sm:w-14 sm:h-14 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-2xl shadow-blue-950 flex items-center justify-center p-3.5 transition-all duration-200 active:scale-90 focus:outline-none border border-blue-400/30 cursor-pointer select-none">\n' +
'            <svg id="fab-icon" class="w-6 h-6 transition-transform duration-200 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">\n' +
'                <path d="M5 12h14M12 5v14"/>\n' +
'            </svg>\n' +
'        </button>\n' +
'    </div>\n' +
'\n' +
'    <!-- TOAST NOTIFICATION -->\n' +
'    <div id="toast" class="fixed top-18 right-6 bg-slate-900 border border-slate-750 text-white text-xs px-4 py-3 rounded-xl shadow-2xl transform translate-x-full opacity-0 transition-all duration-300 z-50 font-medium"></div>\n' +
'\n' +
'    <!-- CUSTOM CENTER POPUP MODAL UI -->\n' +
'    <div id="custom-modal" class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm hidden opacity-0 transition-opacity duration-200">\n' +
'        <div id="custom-modal-card" class="bg-slate-900 border border-slate-800 w-full max-w-sm sm:max-w-md rounded-2xl p-5 sm:p-6 shadow-2xl transform scale-95 transition-transform duration-200">\n' +
'            <div class="flex items-center gap-3 mb-4">\n' +
'                <div id="modal-icon-container" class="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">\n' +
'                    <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>\n' +
'                </div>\n' +
'                <div>\n' +
'                    <h3 id="modal-title" class="text-sm sm:text-base font-bold text-white">Judul Modal</h3>\n' +
'                    <p id="modal-desc" class="text-xs text-slate-400 mt-0.5"></p>\n' +
'                </div>\n' +
'            </div>\n' +
'\n' +
'            <div id="modal-input-wrapper" class="mb-5">\n' +
'                <input type="text" id="modal-input" class="w-full bg-slate-950 text-xs sm:text-sm px-3.5 py-2.5 rounded-xl outline-none border border-slate-800 focus:border-blue-500/80 focus:ring-2 focus:ring-blue-500/20 text-slate-100 placeholder-slate-500 transition font-sans">\n' +
'            </div>\n' +
'\n' +
'            <div class="flex items-center justify-end gap-2 pt-1">\n' +
'                <button type="button" id="modal-btn-cancel" class="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white bg-slate-850 hover:bg-slate-800 border border-slate-750 transition">Batal</button>\n' +
'                <button type="button" id="modal-btn-confirm" class="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 transition shadow-lg shadow-blue-950 border border-blue-400/30 flex items-center gap-1.5">Lanjut</button>\n' +
'            </div>\n' +
'        </div>\n' +
'    </div>\n' +
'\n' +
'    <!-- CUSTOM IMPORT MODAL UI -->\n' +
'    <div id="import-modal" class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md hidden opacity-0 transition-opacity duration-200">\n' +
'        <div id="import-modal-card" class="bg-slate-900 border border-slate-800 w-full max-w-2xl rounded-2xl p-5 sm:p-6 shadow-2xl transform scale-95 transition-transform duration-200 flex flex-col max-h-[90vh]">\n' +
'            <div class="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">\n' +
'                <div class="flex items-center gap-2.5">\n' +
'                    <div class="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">\n' +
'                        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>\n' +
'                    </div>\n' +
'                    <div>\n' +
'                        <h3 class="text-sm sm:text-base font-bold text-white">Import Catatan / Modul AI</h3>\n' +
'                        <p class="text-[11px] text-slate-400">Paste catatan teks AI lo di sini. Sistem akan otomatis membagi halaman dan menyusun blok Notion.</p>\n' +
'                    </div>\n' +
'                </div>\n' +
'                <button type="button" onclick="closeImportModal()" class="p-1 rounded-lg text-slate-400 hover:text-white text-xs hover:bg-slate-800 transition">\n' +
'                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>\n' +
'                </button>\n' +
'            </div>\n' +
'\n' +
'            <div class="flex-1 my-2 min-h-[260px] flex flex-col">\n' +
'                <textarea id="import-raw-input" placeholder="Paste teks materi markdown/catatan dari AI di sini...&#10;&#10;Contoh:&#10;# Judul Halaman 1&#10;## A. Pengantar Materi&#10;Penjelasan materi...&#10;&#10;### Step Membuat Kode:&#10;[kode snippet terminal]" class="w-full flex-1 bg-slate-950 text-xs sm:text-sm p-4 rounded-xl outline-none border border-slate-800 focus:border-blue-500/80 focus:ring-2 focus:ring-blue-500/20 text-slate-100 placeholder-slate-600 resize-none font-mono leading-relaxed"></textarea>\n' +
'            </div>\n' +
'\n' +
'            <div class="flex items-center justify-between pt-3 border-t border-slate-800 text-[11px] text-slate-400">\n' +
'                <span class="hidden sm:inline">H1 (#) = Halaman Baru | H2 (##) = Sub Bab | H3 (###) = Judul Step</span>\n' +
'                <div class="flex items-center gap-2 ml-auto">\n' +
'                    <button type="button" onclick="closeImportModal()" class="px-4 py-2 rounded-xl font-semibold text-slate-300 hover:text-white bg-slate-850 hover:bg-slate-800 border border-slate-750 transition">Batal</button>\n' +
'                    <button type="button" onclick="processImportContent()" class="px-4 py-2 rounded-xl font-semibold text-white bg-blue-600 hover:bg-blue-500 transition shadow-lg shadow-blue-950 border border-blue-400/30 flex items-center gap-1.5">\n' +
'                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>\n' +
'                        Proses & Simpan Modul\n' +
'                    </button>\n' +
'                </div>\n' +
'            </div>\n' +
'        </div>\n' +
'    </div>\n' +
'\n' +
'    <script>\n' +
'        let folders = [];\n' +
'        let currentFolderId = null;\n' +
'        let currentFolderData = { title: \'\', pages: [] };\n' +
'        let currentPageIndex = 0;\n' +
'        let isAdmin = localStorage.getItem(\'isAdmin\') === \'true\';\n' +
'        let isFabOpen = false;\n' +
'        let searchDebounceTimer = null;\n' +
'        let folderSortableInstance = null;\n' +
'\n' +
'        window.onload = async () => {\n' +
'            updateAdminUI();\n' +
'            await loadFolders();\n' +
'            renderWelcomeView();\n' +
'        };\n' +
'\n' +
'        window.addEventListener(\'keydown\', (e) => { \n' +
'            if ((e.ctrlKey || e.metaKey) && e.key === \'s\') { \n' +
'                e.preventDefault(); \n' +
'                if(isAdmin) saveCurrentFolder(); \n' +
'            } \n' +
'            if ((e.ctrlKey || e.metaKey) && e.key === \'k\') {\n' +
'                e.preventDefault();\n' +
'                document.getElementById(\'global-search\').focus();\n' +
'            }\n' +
'        });\n' +
'\n' +
'        function showCustomDialog(options) {\n' +
'            return new Promise((resolve) => {\n' +
'                const title = options.title || \'\';\n' +
'                const desc = options.desc || \'\';\n' +
'                const placeholder = options.placeholder || \'\';\n' +
'                const defaultValue = options.defaultValue || \'\';\n' +
'                const isPrompt = (options.isPrompt !== undefined) ? options.isPrompt : true;\n' +
'                const isPassword = !!options.isPassword;\n' +
'                const isDanger = !!options.isDanger;\n' +
'                const confirmText = options.confirmText || \'Simpan\';\n' +
'\n' +
'                const modal = document.getElementById(\'custom-modal\');\n' +
'                const card = document.getElementById(\'custom-modal-card\');\n' +
'                const titleEl = document.getElementById(\'modal-title\');\n' +
'                const descEl = document.getElementById(\'modal-desc\');\n' +
'                const inputWrap = document.getElementById(\'modal-input-wrapper\');\n' +
'                const inputEl = document.getElementById(\'modal-input\');\n' +
'                const iconBox = document.getElementById(\'modal-icon-container\');\n' +
'                const btnCancel = document.getElementById(\'modal-btn-cancel\');\n' +
'                const btnConfirm = document.getElementById(\'modal-btn-confirm\');\n' +
'\n' +
'                titleEl.innerText = title;\n' +
'                descEl.innerText = desc;\n' +
'                if (!desc) descEl.classList.add(\'hidden\'); else descEl.classList.remove(\'hidden\');\n' +
'\n' +
'                if (isDanger) {\n' +
'                    iconBox.className = "w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 shrink-0";\n' +
'                    iconBox.innerHTML = \'<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>\';\n' +
'                    btnConfirm.className = "px-4 py-2 rounded-xl text-xs font-semibold text-white bg-red-600 hover:bg-red-500 transition shadow-lg shadow-red-950 border border-red-400/30";\n' +
'                } else if (isPassword) {\n' +
'                    iconBox.className = "w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0";\n' +
'                    iconBox.innerHTML = \'<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>\';\n' +
'                    btnConfirm.className = "px-4 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 transition shadow-lg shadow-blue-950 border border-blue-400/30";\n' +
'                } else {\n' +
'                    iconBox.className = "w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0";\n' +
'                    iconBox.innerHTML = \'<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>\';\n' +
'                    btnConfirm.className = "px-4 py-2 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 transition shadow-lg shadow-blue-950 border border-blue-400/30";\n' +
'                }\n' +
'\n' +
'                btnConfirm.innerText = confirmText;\n' +
'\n' +
'                if (isPrompt) {\n' +
'                    inputWrap.classList.remove(\'hidden\');\n' +
'                    inputEl.type = isPassword ? \'password\' : \'text\';\n' +
'                    inputEl.placeholder = placeholder;\n' +
'                    inputEl.value = defaultValue;\n' +
'                } else {\n' +
'                    inputWrap.classList.add(\'hidden\');\n' +
'                }\n' +
'\n' +
'                modal.classList.remove(\'hidden\');\n' +
'                setTimeout(() => {\n' +
'                    modal.classList.remove(\'opacity-0\');\n' +
'                    card.classList.remove(\'scale-95\');\n' +
'                    card.classList.add(\'scale-100\');\n' +
'                    if (isPrompt) {\n' +
'                        inputEl.focus();\n' +
'                        if (defaultValue) inputEl.select();\n' +
'                    }\n' +
'                }, 20);\n' +
'\n' +
'                function cleanup() {\n' +
'                    modal.classList.add(\'opacity-0\');\n' +
'                    card.classList.remove(\'scale-100\');\n' +
'                    card.classList.add(\'scale-95\');\n' +
'                    setTimeout(() => modal.classList.add(\'hidden\'), 200);\n' +
'                    btnConfirm.onclick = null;\n' +
'                    btnCancel.onclick = null;\n' +
'                    modal.onclick = null;\n' +
'                    inputEl.onkeydown = null;\n' +
'                    window.removeEventListener(\'keydown\', handleEsc);\n' +
'                }\n' +
'\n' +
'                function submit() {\n' +
'                    const val = isPrompt ? inputEl.value.trim() : true;\n' +
'                    cleanup();\n' +
'                    resolve(val);\n' +
'                }\n' +
'\n' +
'                function cancel() {\n' +
'                    cleanup();\n' +
'                    resolve(null);\n' +
'                }\n' +
'\n' +
'                function handleEsc(e) {\n' +
'                    if (e.key === \'Escape\') cancel();\n' +
'                }\n' +
'\n' +
'                btnConfirm.onclick = submit;\n' +
'                btnCancel.onclick = cancel;\n' +
'                modal.onclick = (e) => { if (e.target === modal) cancel(); };\n' +
'                inputEl.onkeydown = (e) => { if (e.key === \'Enter\') { e.preventDefault(); submit(); } };\n' +
'                window.addEventListener(\'keydown\', handleEsc);\n' +
'            });\n' +
'        }\n' +
'\n' +
'        // ================= IMPORT MODAL CONTROLLERS =================\n' +
'        function openImportModal() {\n' +
'            const modal = document.getElementById(\'import-modal\');\n' +
'            const card = document.getElementById(\'import-modal-card\');\n' +
'            const textarea = document.getElementById(\'import-raw-input\');\n' +
'            textarea.value = \'\';\n' +
'            modal.classList.remove(\'hidden\');\n' +
'            setTimeout(() => {\n' +
'                modal.classList.remove(\'opacity-0\');\n' +
'                card.classList.remove(\'scale-95\');\n' +
'                card.classList.add(\'scale-100\');\n' +
'                textarea.focus();\n' +
'            }, 20);\n' +
'        }\n' +
'\n' +
'        function closeImportModal() {\n' +
'            const modal = document.getElementById(\'import-modal\');\n' +
'            const card = document.getElementById(\'import-modal-card\');\n' +
'            modal.classList.add(\'opacity-0\');\n' +
'            card.classList.remove(\'scale-100\');\n' +
'            card.classList.add(\'scale-95\');\n' +
'            setTimeout(() => modal.classList.add(\'hidden\'), 200);\n' +
'        }\n' +
'\n' +
'        // SMART MULTI-PAGE & NOTION BLOCK PARSER ENGINE\n' +
'        function parseRawToPages(rawText) {\n' +
'            const lines = rawText.split(new RegExp(\'\\\\r?\\\\n\'));\n' +
'            const parsedPages = [];\n' +
'            let currentPage = null;\n' +
'            let inCodeBlock = false;\n' +
'            let codeLang = \'bash\';\n' +
'            let codeBuffer = [];\n' +
'            let inTable = false;\n' +
'            let tableHeaders = [];\n' +
'            let tableRows = [];\n' +
'            const tripleTicks = String.fromCharCode(96, 96, 96);\n' +
'\n' +
'            for (let i = 0; i < lines.length; i++) {\n' +
'                const line = lines[i];\n' +
'                const trimmed = line.trim();\n' +
'\n' +
'                if (trimmed.indexOf(tripleTicks) === 0) {\n' +
'                    if (inCodeBlock) {\n' +
'                        if (!currentPage) currentPage = { title: \'\', blocks: [] };\n' +
'                        currentPage.blocks.push({\n' +
'                            type: \'code\',\n' +
'                            language: codeLang || \'bash\',\n' +
'                            content: codeBuffer.join(\'\\\\n\')\n' +
'                        });\n' +
'                        inCodeBlock = false;\n' +
'                        codeBuffer = [];\n' +
'                    } else {\n' +
'                        inCodeBlock = true;\n' +
'                        codeLang = trimmed.replace(new RegExp(tripleTicks, \'g\'), \'\').trim() || \'bash\';\n' +
'                        codeBuffer = [];\n' +
'                    }\n' +
'                    continue;\n' +
'                }\n' +
'\n' +
'                if (inCodeBlock) {\n' +
'                    codeBuffer.push(line);\n' +
'                    continue;\n' +
'                }\n' +
'\n' +
'                // Deteksi Tabel Markdown\n' +
'                if (trimmed.startsWith(\'|\') && trimmed.endsWith(\'|\')) {\n' +
'                    const cols = trimmed.split(\'|\').slice(1, -1).map(c => c.trim());\n' +
'                    if (cols.every(c => c.replace(/[:\\-]/g, \'\') === \'\')) continue;\n' +
'                    if (!inTable) {\n' +
'                        inTable = true;\n' +
'                        tableHeaders = cols;\n' +
'                        tableRows = [];\n' +
'                    } else {\n' +
'                        tableRows.push(cols);\n' +
'                    }\n' +
'                    continue;\n' +
'                } else if (inTable) {\n' +
'                    if (!currentPage) currentPage = { title: \'\', blocks: [] };\n' +
'                    currentPage.blocks.push({ type: \'table\', headers: tableHeaders, rows: tableRows });\n' +
'                    inTable = false; tableHeaders = []; tableRows = [];\n' +
'                }\n' +
'\n' +
'                if (!trimmed) continue;\n' +
'\n' +
'                if (trimmed.indexOf(\'# \') === 0 && trimmed.indexOf(\'## \') !== 0 && trimmed.indexOf(\'### \') !== 0) {\n' +
'                    if (currentPage) parsedPages.push(currentPage);\n' +
'                    const pageTitle = trimmed.replace(new RegExp(\'^#\\\\s+\'), \'\').trim();\n' +
'                    currentPage = { title: pageTitle, blocks: [] };\n' +
'                    continue;\n' +
'                }\n' +
'\n' +
'                if (!currentPage) currentPage = { title: \'\', blocks: [] };\n' +
'\n' +
'                if (trimmed.indexOf(\'## \') === 0 && trimmed.indexOf(\'### \') !== 0) {\n' +
'                    currentPage.blocks.push({\n' +
'                        type: \'h2\',\n' +
'                        content: trimmed.replace(new RegExp(\'^##\\\\s+\'), \'\').trim()\n' +
'                    });\n' +
'                } else if (trimmed.indexOf(\'### \') === 0) {\n' +
'                    currentPage.blocks.push({\n' +
'                        type: \'h3\',\n' +
'                        content: trimmed.replace(new RegExp(\'^###\\\\s+\'), \'\').trim()\n' +
'                    });\n' +
'                } else if (trimmed === \'---\' || trimmed === \'***\' || trimmed === \'___\') {\n' +
'                    currentPage.blocks.push({ type: \'divider\', content: \'\' });\n' +
'                } else if (new RegExp(\'^(NOTE|INFO|PENTING|TIP|WARNING|CATATAN|PERHATIAN):\', \'i\').test(trimmed)) {\n' +
'                    currentPage.blocks.push({\n' +
'                        type: \'callout\',\n' +
'                        content: trimmed\n' +
'                    });\n' +
'                } else if (trimmed.indexOf(\'> \') === 0) {\n' +
'                    currentPage.blocks.push({\n' +
'                        type: \'quote\',\n' +
'                        content: trimmed.replace(new RegExp(\'^>\\\\s*\'), \'\').trim()\n' +
'                    });\n' +
'                } else if (new RegExp(\'^\\[([ xX])\\]\\\\s+\').test(trimmed)) {\n' +
'                    const isChecked = new RegExp(\'^\\[[xX]\\]\').test(trimmed);\n' +
'                    const taskContent = trimmed.replace(new RegExp(\'^\\[([ xX])\\]\\\\s+\'), \'\').trim();\n' +
'                    currentPage.blocks.push({\n' +
'                        type: \'todo\',\n' +
'                        checked: isChecked,\n' +
'                        content: taskContent\n' +
'                    });\n' +
'                } else if (new RegExp(\'^\\\\d+[\\\\.\\\\)]\\\\s+\').test(trimmed)) {\n' +
'                    const numContent = trimmed.replace(new RegExp(\'^\\\\d+[\\\\.\\\\)]\\\\s+\'), \'\').trim();\n' +
'                    currentPage.blocks.push({\n' +
'                        type: \'numbered\',\n' +
'                        content: numContent\n' +
'                    });\n' +
'                } else if (new RegExp(\'^[-*•]\\\\s+\').test(trimmed)) {\n' +
'                    const bulletContent = trimmed.replace(new RegExp(\'^[-*•]\\\\s+\'), \'\').trim();\n' +
'                    currentPage.blocks.push({\n' +
'                        type: \'bullet\',\n' +
'                        content: bulletContent\n' +
'                    });\n' +
'                } else {\n' +
'                    currentPage.blocks.push({\n' +
'                        type: \'paragraph\',\n' +
'                        content: trimmed\n' +
'                    });\n' +
'                }\n' +
'            }\n' +
'\n' +
'            if (inTable) {\n' +
'                if (!currentPage) currentPage = { title: \'\', blocks: [] };\n' +
'                currentPage.blocks.push({ type: \'table\', headers: tableHeaders, rows: tableRows });\n' +
'            }\n' +
'\n' +
'            if (inCodeBlock && codeBuffer.length > 0) {\n' +
'                if (!currentPage) currentPage = { title: \'\', blocks: [] };\n' +
'                currentPage.blocks.push({\n' +
'                    type: \'code\',\n' +
'                    language: codeLang || \'bash\',\n' +
'                    content: codeBuffer.join(\'\\\\n\')\n' +
'                });\n' +
'            }\n' +
'\n' +
'            if (currentPage) parsedPages.push(currentPage);\n' +
'            return parsedPages;\n' +
'        }\n' +
'\n' +
'        async function processImportContent() {\n' +
'            const raw = document.getElementById(\'import-raw-input\').value;\n' +
'            if (!raw || !raw.trim()) {\n' +
'                showToast(\'Area teks masih kosong!\', true);\n' +
'                return;\n' +
'            }\n' +
'\n' +
'            const parsedPages = parseRawToPages(raw);\n' +
'            if (!parsedPages || parsedPages.length === 0) {\n' +
'                showToast(\'Format catatan tidak valid atau kosong!\', true);\n' +
'                return;\n' +
'            }\n' +
'\n' +
'            closeImportModal();\n' +
'\n' +
'            const folderName = await showCustomDialog({\n' +
'                title: \'Judul Modul Folder Baru\',\n' +
'                desc: \'Sistem mendeteksi \' + parsedPages.length + \' halaman otomatis. Masukkan judul untuk modul folder ini:\',\n' +
'                placeholder: \'e.g. 1) STRUKTUR 7 LAYER OSI & TCP/UDP...\',\n' +
'                isPrompt: true,\n' +
'                confirmText: \'Simpan & Buka Modul\'\n' +
'            });\n' +
'\n' +
'            if (!folderName || !folderName.trim()) {\n' +
'                showToast(\'Import dibatalkan (nama folder kosong).\');\n' +
'                return;\n' +
'            }\n' +
'\n' +
'            showToast(\'Menyimpan seluruh modul ke Google Drive...\');\n' +
'            try {\n' +
'                const payload = {\n' +
'                    title: folderName.trim(),\n' +
'                    pages: parsedPages\n' +
'                };\n' +
'                const res = await fetch(\'/api/pages\', {\n' +
'                    method: \'POST\',\n' +
'                    headers: { \'Content-Type\': \'application/json\' },\n' +
'                    body: JSON.stringify(payload)\n' +
'                });\n' +
'                const result = await res.json();\n' +
'                if (result.success) {\n' +
'                    showToast(\'Modul "\' + folderName + \'" berhasil diimport (\' + parsedPages.length + \' Halaman)!\');\n' +
'                    await loadFolders();\n' +
'                    loadFolderContent(result.file.id, 0);\n' +
'                } else {\n' +
'                    showToast(\'Gagal menyimpan hasil import\', true);\n' +
'                }\n' +
'            } catch(e) {\n' +
'                showToast(\'Kesalahan jaringan saat mengimport modul\', true);\n' +
'            }\n' +
'        }\n' +
'\n' +
'        function exportCurrentFolderMarkdown() {\n' +
'            if (!currentFolderId || !currentFolderData) {\n' +
'                showToast(\'Pilih modul folder terlebih dahulu!\', true);\n' +
'                return;\n' +
'            }\n' +
'            syncDomToBlocks();\n' +
'            const title = currentFolderData.title || \'Untitled\';\n' +
'            const tripleTicks = String.fromCharCode(96, 96, 96);\n' +
'            let mdContent = \'# \' + title + \'\\\\n\\\\n\';\n' +
'            const pages = currentFolderData.pages || [];\n' +
'            for (let p = 0; p < pages.length; p++) {\n' +
'                const page = pages[p];\n' +
'                if (page.title) mdContent += \'# \' + page.title + \'\\\\n\\\\n\';\n' +
'                const blocks = page.blocks || [];\n' +
'                for (let b = 0; b < blocks.length; b++) {\n' +
'                    const blk = blocks[b];\n' +
'                    if (blk.type === \'h2\') mdContent += \'## \' + blk.content + \'\\\\n\\\\n\';\n' +
'                    else if (blk.type === \'h3\') mdContent += \'### \' + blk.content + \'\\\\n\\\\n\';\n' +
'                    else if (blk.type === \'bullet\') mdContent += \'- \' + blk.content + \'\\\\n\';\n' +
'                    else if (blk.type === \'numbered\') mdContent += (b + 1) + \'. \' + blk.content + \'\\\\n\';\n' +
'                    else if (blk.type === \'todo\') mdContent += \'[\' + (blk.checked ? \'x\' : \' \') + \'] \' + blk.content + \'\\\\n\';\n' +
'                    else if (blk.type === \'callout\') mdContent += \'NOTE: \' + blk.content + \'\\\\n\\\\n\';\n' +
'                    else if (blk.type === \'quote\') mdContent += \'> \' + blk.content + \'\\\\n\\\\n\';\n' +
'                    else if (blk.type === \'divider\') mdContent += \'---\\\\n\\\\n\';\n' +
'                    else if (blk.type === \'code\') mdContent += tripleTicks + (blk.language || \'bash\') + \'\\\\n\' + blk.content + \'\\\\n\' + tripleTicks + \'\\\\n\\\\n\';\n' +
'                    else if (blk.type === \'table\') {\n' +
'                        mdContent += \'| \' + blk.headers.join(\' | \') + \' |\\\\n\';\n' +
'                        mdContent += \'| \' + blk.headers.map(() => \'---\').join(\' | \') + \' |\\\\n\';\n' +
'                        for (let r = 0; r < blk.rows.length; r++) {\n' +
'                            mdContent += \'| \' + blk.rows[r].join(\' | \') + \' |\\\\n\';\n' +
'                        }\n' +
'                        mdContent += \'\\\\n\';\n' +
'                    }\n' +
'                    else mdContent += blk.content + \'\\\\n\\\\n\';\n' +
'                }\n' +
'                mdContent += \'\\\\n\';\n' +
'            }\n' +
'\n' +
'            const blob = new Blob([mdContent], { type: \'text/markdown;charset=utf-8;\' });\n' +
'            const link = document.createElement(\'a\');\n' +
'            link.href = URL.createObjectURL(blob);\n' +
'            link.download = (title.replace(new RegExp(\'[^a-zA-Z0-9_-]\', \'g\'), \'_\')) + \'.md\';\n' +
'            link.click();\n' +
'            showToast(\'Modul berhasil diexport ke Markdown!\');\n' +
'        }\n' +
'\n' +
'        function autoResize(el) { \n' +
'            if(!el) return;\n' +
'            el.style.height = \'auto\'; \n' +
'            el.style.height = el.scrollHeight + \'px\'; \n' +
'        }\n' +
'\n' +
'        function showToast(msg, isError = false) {\n' +
'            const toast = document.getElementById(\'toast\');\n' +
'            toast.innerText = msg;\n' +
'            toast.className = \'fixed top-18 right-6 \' + (isError ? \'bg-red-950/90 border-red-800 text-red-200\' : \'bg-slate-900 border-slate-700 text-blue-400\') + \' border text-xs px-4 py-3 rounded-xl shadow-2xl transform transition-all duration-300 z-50 font-medium\';\n' +
'            toast.classList.remove(\'translate-x-full\', \'opacity-0\');\n' +
'            setTimeout(() => toast.classList.add(\'translate-x-full\', \'opacity-0\'), 3000);\n' +
'        }\n' +
'\n' +
'        function toggleSidebar() {\n' +
'            document.getElementById(\'sidebar\').classList.toggle(\'-translate-x-full\');\n' +
'            document.getElementById(\'sidebar-overlay\').classList.toggle(\'hidden\');\n' +
'        }\n' +
'\n' +
'        function toggleFab(e, forceState) {\n' +
'            if (e && e.stopPropagation) e.stopPropagation();\n' +
'            const menu = document.getElementById(\'fab-menu\');\n' +
'            const icon = document.getElementById(\'fab-icon\');\n' +
'            const badge = document.getElementById(\'fab-page-badge\');\n' +
'            if(!menu || !icon) return;\n' +
'\n' +
'            if (badge) badge.innerText = \'Hal \' + (currentPageIndex + 1);\n' +
'            isFabOpen = (typeof forceState === \'boolean\') ? forceState : !isFabOpen;\n' +
'\n' +
'            if (isFabOpen) {\n' +
'                menu.classList.remove(\'hidden\');\n' +
'                menu.classList.add(\'flex\');\n' +
'                icon.classList.add(\'rotate-45\');\n' +
'            } else {\n' +
'                menu.classList.remove(\'flex\');\n' +
'                menu.classList.add(\'hidden\');\n' +
'                icon.classList.remove(\'rotate-45\');\n' +
'            }\n' +
'        }\n' +
'\n' +
'        function formatMarkdown(text) {\n' +
'            if (!text) return \'\';\n' +
'            let s = escapeHtml(text);\n' +
'            const tick = String.fromCharCode(96);\n' +
'            s = s.replace(new RegExp(\'\\\\*\\\\*(.*?)\\\\*\\\\*\', \'g\'), \'<strong class="font-bold text-white">$1</strong>\');\n' +
'            s = s.replace(new RegExp(\'\\\\*(.*?)\\\\*\', \'g\'), \'<em class="italic text-slate-200">$1</em>\');\n' +
'            s = s.replace(new RegExp(tick + \'([^\' + tick + \']+)\' + tick, \'g\'), \'<code class="px-1.5 py-0.5 rounded bg-slate-900 text-blue-300 font-mono text-xs border border-slate-800">$1</code>\');\n' +
'            return s;\n' +
'        }\n' +
'\n' +
'        function syncDomToBlocks() {\n' +
'            if (!currentFolderData.pages || !currentFolderData.pages[currentPageIndex]) return;\n' +
'            const blocks = currentFolderData.pages[currentPageIndex].blocks || [];\n' +
'            const container = document.getElementById(\'editor-container\');\n' +
'            if (!container) return;\n' +
'            \n' +
'            const blockEls = container.children;\n' +
'            for (let i = 0; i < blockEls.length; i++) {\n' +
'                if (!blocks[i]) continue;\n' +
'                const bType = blocks[i].type;\n' +
'                \n' +
'                if ([\'paragraph\', \'h1\', \'h2\', \'h3\', \'header\', \'bullet\', \'numbered\', \'quote\', \'callout\'].includes(bType)) {\n' +
'                    const input = blockEls[i].querySelector(\'textarea, input[type="text"]\');\n' +
'                    if (input) blocks[i].content = input.value;\n' +
'                } else if (bType === \'todo\') {\n' +
'                    const input = blockEls[i].querySelector(\'textarea, input[type="text"]\');\n' +
'                    const checkbox = blockEls[i].querySelector(\'input[type="checkbox"]\');\n' +
'                    if (input) blocks[i].content = input.value;\n' +
'                    if (checkbox) blocks[i].checked = checkbox.checked;\n' +
'                } else if (bType === \'code\') {\n' +
'                    const langInput = blockEls[i].querySelector(\'input[type="text"]\');\n' +
'                    const codeTextarea = blockEls[i].querySelector(\'textarea\');\n' +
'                    if (langInput) blocks[i].language = langInput.value;\n' +
'                    if (codeTextarea) blocks[i].content = codeTextarea.value;\n' +
'                } else if (bType === \'table\') {\n' +
'                    const rows = [];\n' +
'                    const trs = blockEls[i].querySelectorAll(\'tbody tr\');\n' +
'                    trs.forEach(tr => {\n' +
'                        const rowData = [];\n' +
'                        tr.querySelectorAll(\'input\').forEach(inp => rowData.push(inp.value));\n' +
'                        rows.push(rowData);\n' +
'                    });\n' +
'                    blocks[i].rows = rows;\n' +
'                }\n' +
'            }\n' +
'        }\n' +
'\n' +
'        function updateAdminUI() {\n' +
'            const btn = document.getElementById(\'admin-auth-btn\');\n' +
'            const newFolderBtn = document.getElementById(\'new-folder-btn\');\n' +
'            const fab = document.getElementById(\'fab-container\');\n' +
'            const saveFab = document.getElementById(\'save-fab-container\');\n' +
'            const titleInput = document.getElementById(\'page-title\');\n' +
'\n' +
'            if(isAdmin) {\n' +
'                btn.innerText = \'Sign Out\';\n' +
'                btn.className = \'text-xs px-3.5 py-1.5 rounded-xl font-semibold transition bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30\';\n' +
'                newFolderBtn.classList.remove(\'hidden\');\n' +
'                fab.classList.remove(\'hidden\');\n' +
'                saveFab.classList.remove(\'hidden\');\n' +
'                titleInput.removeAttribute(\'readonly\');\n' +
'            } else {\n' +
'                btn.innerText = \'Sign In\';\n' +
'                btn.className = \'text-xs px-3.5 py-1.5 rounded-xl font-semibold transition bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/30\';\n' +
'                newFolderBtn.classList.add(\'hidden\');\n' +
'                fab.classList.add(\'hidden\');\n' +
'                saveFab.classList.add(\'hidden\');\n' +
'                titleInput.setAttribute(\'readonly\', true);\n' +
'            }\n' +
'            initFolderSortable();\n' +
'        }\n' +
'\n' +
'        async function handleAdminToggle() {\n' +
'            if(isAdmin) {\n' +
'                isAdmin = false; localStorage.setItem(\'isAdmin\', \'false\');\n' +
'                updateAdminUI(); showToast(\'Signed out.\'); \n' +
'                if (currentFolderId) renderCurrentPage();\n' +
'            } else {\n' +
'                const pwd = await showCustomDialog({\n' +
'                    title: \'Sign In Admin\',\n' +
'                    desc: \'Masukkan password admin untuk mengaktifkan mode editor workspace.\',\n' +
'                    placeholder: \'Password admin...\',\n' +
'                    isPrompt: true,\n' +
'                    isPassword: true,\n' +
'                    confirmText: \'Masuk\'\n' +
'                });\n' +
'                if(!pwd) return;\n' +
'                try {\n' +
'                    const res = await fetch(\'/api/verify-password\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ password: pwd }) });\n' +
'                    if((await res.json()).success) {\n' +
'                        isAdmin = true; localStorage.setItem(\'isAdmin\', \'true\');\n' +
'                        updateAdminUI(); showToast(\'Akses Admin Aktif\'); \n' +
'                        if (currentFolderId) renderCurrentPage();\n' +
'                    } else showToast(\'Password salah\', true);\n' +
'                } catch(e) { showToast(\'Gagal terhubung\', true); }\n' +
'            }\n' +
'        }\n' +
'\n' +
'        async function loadFolders() {\n' +
'            try {\n' +
'                const res = await fetch(\'/api/pages\');\n' +
'                const data = await res.json();\n' +
'                folders = Array.isArray(data) ? data : [];\n' +
'                renderFolderList();\n' +
'            } catch(e) { document.getElementById(\'folder-list\').innerHTML = \'<p class="text-xs text-red-400 p-4">Gagal memuat workspace.</p>\'; }\n' +
'        }\n' +
'\n' +
'        function renderWelcomeView() {\n' +
'            currentFolderId = null;\n' +
'            document.getElementById(\'top-nav-container\').classList.replace(\'flex\', \'hidden\');\n' +
'            document.getElementById(\'bot-nav-container\').classList.replace(\'flex\', \'hidden\');\n' +
'            document.getElementById(\'title-wrapper\').classList.add(\'hidden\');\n' +
'\n' +
'            const container = document.getElementById(\'editor-container\');\n' +
'            container.innerHTML = \'<div class="flex flex-col items-center justify-center text-center py-20 px-4">\' +\n' +
'                \'<div class="w-14 h-14 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-blue-400 mb-4 shadow-xl">\' +\n' +
'                    \'<svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>\' +\n' +
'                \'</div>\' +\n' +
'                \'<h2 class="text-lg sm:text-xl font-bold mb-2 text-white">Dokumentasi & Catatan Materi</h2>\' +\n' +
'                \'<p class="text-slate-400 max-w-sm text-xs mb-6 leading-relaxed">Buka menu sidebar untuk memilih bab materi atau gunakan tombol Ctrl + K untuk mencari topik cepat.</p>\' +\n' +
'                \'<button onclick="toggleSidebar()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold transition shadow-lg shadow-blue-950 flex items-center gap-2">\' +\n' +
'                    \'<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>\' +\n' +
'                    \'Buka Sidebar\' +\n' +
'                \'</button>\' +\n' +
'            \'</div>\';\n' +
'        }\n' +
'\n' +
'        async function createNewFolder() {\n' +
'            const title = await showCustomDialog({\n' +
'                title: \'Buat Modul Folder Baru\',\n' +
'                desc: \'Masukkan nama folder materi baru (Mendukung CAPSLOCK, angka, simbol & slash).\',\n' +
'                placeholder: \'e.g. 1) STRUKTUR 7 LAYER OSI / TCP-UDP...\',\n' +
'                isPrompt: true,\n' +
'                confirmText: \'Buat Modul\'\n' +
'            });\n' +
'            if(!title || title.trim() === \'\') return;\n' +
'            \n' +
'            showToast(\'Membuat modul folder...\');\n' +
'            try {\n' +
'                const folderName = title.trim();\n' +
'                const payload = { \n' +
'                    title: folderName, \n' +
'                    pages: [{ title: \'\', blocks: [] }] \n' +
'                };\n' +
'                const res = await fetch(\'/api/pages\', { method: \'POST\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify(payload) });\n' +
'                const result = await res.json();\n' +
'                if(result.success) {\n' +
'                    showToast(\'Folder dibuat!\');\n' +
'                    await loadFolders(); \n' +
'                    loadFolderContent(result.file.id, 0);\n' +
'                } else showToast(\'Gagal membuat modul\', true);\n' +
'            } catch(e) { showToast(\'Kesalahan jaringan\', true); }\n' +
'        }\n' +
'\n' +
'        async function renameFolder(id, oldName) {\n' +
'            const newTitle = await showCustomDialog({\n' +
'                title: \'Ubah Nama Modul\',\n' +
'                desc: \'Perbarui nama modul folder materi ini.\',\n' +
'                placeholder: \'Nama modul...\',\n' +
'                defaultValue: oldName,\n' +
'                isPrompt: true,\n' +
'                confirmText: \'Simpan Nama\'\n' +
'            });\n' +
'            if(!newTitle || newTitle === oldName) return;\n' +
'            \n' +
'            showToast(\'Mengubah nama...\');\n' +
'            try {\n' +
'                const res = await fetch(\'/api/pages/\' + id + \'/rename\', { method: \'PUT\', headers: {\'Content-Type\': \'application/json\'}, body: JSON.stringify({ title: newTitle }) });\n' +
'                if(res.ok) {\n' +
'                    showToast(\'Nama modul diubah!\');\n' +
'                    await loadFolders();\n' +
'                } else showToast(\'Gagal mengubah nama\', true);\n' +
'            } catch(e) { showToast(\'Kesalahan jaringan\', true); }\n' +
'        }\n' +
'\n' +
'        async function deleteFolder(id, name) {\n' +
'            const confirmed = await showCustomDialog({\n' +
'                title: \'Hapus Modul Folder\',\n' +
'                desc: \'Yakin ingin menghapus modul "\' + name + \'" beserta seluruh isinya?\',\n' +
'                isPrompt: false,\n' +
'                isDanger: true,\n' +
'                confirmText: \'Hapus Modul\'\n' +
'            });\n' +
'            if(!confirmed) return;\n' +
'            \n' +
'            showToast(\'Menghapus...\');\n' +
'            try {\n' +
'                const res = await fetch(\'/api/pages/\' + id, { method: \'DELETE\' });\n' +
'                if(res.ok) {\n' +
'                    showToast(\'Modul dihapus!\');\n' +
'                    await loadFolders();\n' +
'                    renderWelcomeView();\n' +
'                } else showToast(\'Gagal menghapus\', true);\n' +
'            } catch(e) { showToast(\'Kesalahan jaringan\', true); }\n' +
'        }\n' +
'\n' +
'        function initFolderSortable() {\n' +
'            const listEl = document.getElementById(\'folder-list\');\n' +
'            if (!listEl) return;\n' +
'            \n' +
'            if (folderSortableInstance) {\n' +
'                folderSortableInstance.destroy();\n' +
'                folderSortableInstance = null;\n' +
'            }\n' +
'\n' +
'            folderSortableInstance = new Sortable(listEl, {\n' +
'                animation: 200,\n' +
'                ghostClass: \'folder-drag-ghost\',\n' +
'                chosenClass: \'folder-drag-chosen\',\n' +
'                delay: 200,\n' +
'                delayOnTouchOnly: true,\n' +
'                touchStartThreshold: 5,\n' +
'                disabled: !isAdmin,\n' +
'                onEnd: async function(evt) {\n' +
'                    const items = document.querySelectorAll(\'#folder-list > div[data-id]\');\n' +
'                    const newOrder = Array.from(items).map(el => el.getAttribute(\'data-id\'));\n' +
'                    \n' +
'                    folders.sort((a, b) => newOrder.indexOf(a.id) - newOrder.indexOf(b.id));\n' +
'\n' +
'                    if (isAdmin) {\n' +
'                        try {\n' +
'                            const res = await fetch(\'/api/folders/reorder\', {\n' +
'                                method: \'POST\',\n' +
'                                headers: {\'Content-Type\': \'application/json\'},\n' +
'                                body: JSON.stringify({ order: newOrder })\n' +
'                            });\n' +
'                            if ((await res.json()).success) {\n' +
'                                showToast(\'Urutan posisi folder tersimpan!\');\n' +
'                            }\n' +
'                        } catch(e) { showToast(\'Gagal menyimpan urutan folder\', true); }\n' +
'                    }\n' +
'                }\n' +
'            });\n' +
'        }\n' +
'\n' +
'        function renderFolderList() {\n' +
'            const listEl = document.getElementById(\'folder-list\');\n' +
'            listEl.innerHTML = \'\';\n' +
'            if(folders.length === 0) { listEl.innerHTML = \'<p class="text-xs text-slate-500 p-4 text-center">Belum ada modul materi.</p>\'; return; }\n' +
'            \n' +
'            folders.forEach((file) => {\n' +
'                const cleanName = file.name.replace(new RegExp(\'\\\\.json$\', \'i\'), \'\');\n' +
'                const isActive = currentFolderId === file.id;\n' +
'                \n' +
'                const div = document.createElement(\'div\');\n' +
'                div.setAttribute(\'data-id\', file.id);\n' +
'                div.className = \'group relative flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer select-none \' + \n' +
'                    (isActive ? \'bg-blue-600/15 text-blue-400 border border-blue-500/30 font-semibold\' : \'text-slate-300 hover:bg-slate-850 hover:text-white border border-transparent\');\n' +
'                \n' +
'                const btnContent = document.createElement(\'button\');\n' +
'                btnContent.className = "flex-1 text-left truncate flex items-center gap-2.5 outline-none";\n' +
'                btnContent.innerHTML = \'<svg class="w-4 h-4 shrink-0 pointer-events-none \' + (isActive ? \'text-blue-400\' : \'text-slate-400\') + \'" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>\' +\n' +
'                    \'<span class="truncate text-slate-200 group-hover:text-white pointer-events-none">\' + escapeHtml(cleanName) + \'</span>\';\n' +
'                btnContent.onclick = () => { \n' +
'                    loadFolderContent(file.id, 0); \n' +
'                    toggleSidebar();\n' +
'                };\n' +
'                div.appendChild(btnContent);\n' +
'\n' +
'                if(isAdmin) {\n' +
'                    const actions = document.createElement(\'div\');\n' +
'                    actions.className = "hidden group-hover:flex items-center gap-1 shrink-0 ml-2";\n' +
'                    \n' +
'                    const btnRename = document.createElement(\'button\');\n' +
'                    btnRename.innerHTML = \'<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>\';\n' +
'                    btnRename.className = "p-1 rounded hover:bg-slate-750 text-slate-400 hover:text-slate-200 transition";\n' +
'                    btnRename.onclick = (e) => { e.stopPropagation(); renameFolder(file.id, cleanName); };\n' +
'                    \n' +
'                    const btnDelete = document.createElement(\'button\');\n' +
'                    btnDelete.innerHTML = \'<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>\';\n' +
'                    btnDelete.className = "p-1 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition";\n' +
'                    btnDelete.onclick = (e) => { e.stopPropagation(); deleteFolder(file.id, cleanName); };\n' +
'                    \n' +
'                    actions.appendChild(btnRename);\n' +
'                    actions.appendChild(btnDelete);\n' +
'                    div.appendChild(actions);\n' +
'                }\n' +
'                listEl.appendChild(div);\n' +
'            });\n' +
'\n' +
'            initFolderSortable();\n' +
'        }\n' +
'\n' +
'        async function loadFolderContent(id, targetPageIndex = 0, targetBlockIndex = null) {\n' +
'            try {\n' +
'                const res = await fetch(\'/api/pages/\' + id);\n' +
'                const data = await res.json();\n' +
'                currentFolderId = id;\n' +
'                \n' +
'                if(!data.pages || !Array.isArray(data.pages)) {\n' +
'                    currentFolderData = {\n' +
'                        title: data.title || \'Untitled Folder\',\n' +
'                        pages: [{ title: \'\', blocks: data.blocks || [] }]\n' +
'                    };\n' +
'                } else {\n' +
'                    currentFolderData = data;\n' +
'                }\n' +
'\n' +
'                currentPageIndex = targetPageIndex || 0;\n' +
'                renderFolderList();\n' +
'                renderCurrentPage();\n' +
'\n' +
'                if (targetBlockIndex !== null && typeof targetBlockIndex !== \'undefined\') {\n' +
'                    setTimeout(() => {\n' +
'                        const targetBlock = document.getElementById(\'block-\' + targetBlockIndex);\n' +
'                        if (targetBlock) {\n' +
'                            targetBlock.scrollIntoView({ behavior: \'smooth\', block: \'center\' });\n' +
'                            targetBlock.classList.add(\'highlight-pulse\');\n' +
'                            setTimeout(() => targetBlock.classList.remove(\'highlight-pulse\'), 2000);\n' +
'                        }\n' +
'                    }, 120);\n' +
'                } else {\n' +
'                    document.getElementById(\'main-scroll\').scrollTo({top: 0, behavior: \'smooth\'});\n' +
'                }\n' +
'            } catch(e) { showToast(\'Gagal memuat modul\', true); }\n' +
'        }\n' +
'\n' +
'        function renderCurrentPage() {\n' +
'            const pages = currentFolderData.pages || [];\n' +
'            \n' +
'            document.getElementById(\'top-nav-container\').classList.replace(\'hidden\', \'flex\');\n' +
'            document.getElementById(\'bot-nav-container\').classList.replace(\'hidden\', \'flex\');\n' +
'            document.getElementById(\'title-wrapper\').classList.remove(\'hidden\');\n' +
'\n' +
'            if(currentPageIndex >= pages.length) currentPageIndex = pages.length - 1;\n' +
'            if(currentPageIndex < 0) currentPageIndex = 0;\n' +
'\n' +
'            const page = pages[currentPageIndex] || { title: \'\', blocks: [] };\n' +
'            const titleEl = document.getElementById(\'page-title\');\n' +
'            titleEl.value = page.title || \'\';\n' +
'            setTimeout(() => autoResize(titleEl), 50);\n' +
'\n' +
'            const container = document.getElementById(\'editor-container\');\n' +
'            container.innerHTML = \'\';\n' +
'            \n' +
'            const blocks = page.blocks || [];\n' +
'            if(blocks.length === 0) {\n' +
'                updateNavigationUI(currentPageIndex + 1, pages.length);\n' +
'                return;\n' +
'            }\n' +
'\n' +
'            blocks.forEach((block, index) => {\n' +
'                const wrapper = document.createElement(\'div\');\n' +
'                wrapper.id = \'block-\' + index;\n' +
'                wrapper.className = "notion-block group relative w-full mb-2 transition-all duration-200 rounded-xl";\n' +
'                \n' +
'                const moveControls = isAdmin ? (\'<div class="block-actions opacity-0 group-hover:opacity-100 flex items-center gap-1 absolute right-2 top-2 transition-opacity bg-slate-900 border border-slate-700/80 px-1.5 py-0.5 rounded-lg shadow-xl z-10">\' +\n' +
'                    \'<button type="button" onclick="moveBlock(\' + index + \', -1)" title="Pindah ke Atas" class="p-1 hover:text-blue-400 text-slate-400 text-xs">\' +\n' +
'                        \'<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>\' +\n' +
'                    \'</button>\' +\n' +
'                    \'<button type="button" onclick="moveBlock(\' + index + \', 1)" title="Pindah ke Bawah" class="p-1 hover:text-blue-400 text-slate-400 text-xs">\' +\n' +
'                        \'<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>\' +\n' +
'                    \'</button>\' +\n' +
'                    \'<button type="button" onclick="removeBlock(\' + index + \')" title="Hapus Blok" class="p-1 hover:text-red-400 text-slate-400 text-xs">\' +\n' +
'                        \'<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>\' +\n' +
'                    \'</button>\' +\n' +
'                \'</div>\') : \'\';\n' +
'\n' +
'                let bType = block.type;\n' +
'                if (bType === \'header\') bType = \'h2\';\n' +
'\n' +
'                if (isAdmin) {\n' +
'                    let inner = \'\';\n' +
'                    if (bType === \'paragraph\') {\n' +
'                        inner = \'<textarea rows="1" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" placeholder="Ketik teks normal... (bisa **bold**, *italic*)" class="w-full bg-transparent text-slate-200 text-sm leading-relaxed outline-none resize-none px-3 py-1.5 rounded-lg hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition font-sans whitespace-pre-wrap">\' + escapeHtml(block.content || \'\') + \'</textarea>\';\n' +
'                    } else if (bType === \'h1\') {\n' +
'                        inner = \'<textarea rows="1" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" placeholder="Heading 1..." class="w-full bg-transparent text-2xl sm:text-3xl font-extrabold text-white outline-none resize-none px-3 py-1 rounded-lg hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition tracking-tight whitespace-pre-wrap">\' + escapeHtml(block.content || \'\') + \'</textarea>\';\n' +
'                    } else if (bType === \'h2\') {\n' +
'                        inner = \'<textarea rows="1" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" placeholder="Heading 2..." class="w-full bg-transparent text-xl sm:text-2xl font-bold text-slate-100 outline-none resize-none px-3 py-1 rounded-lg hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition tracking-tight whitespace-pre-wrap">\' + escapeHtml(block.content || \'\') + \'</textarea>\';\n' +
'                    } else if (bType === \'h3\') {\n' +
'                        inner = \'<textarea rows="1" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" placeholder="Heading 3..." class="w-full bg-transparent text-lg font-semibold text-slate-200 outline-none resize-none px-3 py-1 rounded-lg hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition whitespace-pre-wrap">\' + escapeHtml(block.content || \'\') + \'</textarea>\';\n' +
'                    } else if (bType === \'bullet\') {\n' +
'                        inner = \'<div class="flex items-start gap-2.5 px-3 py-1"><span class="text-blue-400 font-bold mt-1 text-base leading-none">•</span><textarea rows="1" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" placeholder="List item..." class="w-full bg-transparent text-slate-200 text-sm outline-none resize-none hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 rounded-lg p-1 transition whitespace-pre-wrap">\' + escapeHtml(block.content || \'\') + \'</textarea></div>\';\n' +
'                    } else if (bType === \'numbered\') {\n' +
'                        inner = \'<div class="flex items-start gap-2.5 px-3 py-1"><span class="font-mono text-blue-400 text-xs font-bold mt-1.5">\' + (index + 1) + \'.</span><textarea rows="1" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" placeholder="Numbered list..." class="w-full bg-transparent text-slate-200 text-sm outline-none resize-none hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 rounded-lg p-1 transition whitespace-pre-wrap">\' + escapeHtml(block.content || \'\') + \'</textarea></div>\';\n' +
'                    } else if (bType === \'todo\') {\n' +
'                        inner = \'<div class="flex items-start gap-2.5 px-3 py-1"><input type="checkbox" onchange="updateBlockChecked(\' + index + \', this.checked)" \' + (block.checked ? \'checked\' : \'\') + \' class="mt-1.5 w-4 h-4 rounded border-slate-700 text-blue-600 focus:ring-blue-500 bg-slate-850 cursor-pointer"><textarea rows="1" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" placeholder="To-do task..." class="w-full bg-transparent text-slate-200 text-sm outline-none resize-none hover:bg-slate-900/60 focus:bg-slate-900 border border-transparent focus:border-slate-800 rounded-lg p-1 transition whitespace-pre-wrap \' + (block.checked ? \'line-through text-slate-500\' : \'\') + \'">\' + escapeHtml(block.content || \'\') + \'</textarea></div>\';\n' +
'                    } else if (bType === \'callout\') {\n' +
'                        inner = \'<div class="bg-blue-950/20 border border-blue-500/30 rounded-2xl p-3.5 flex items-start gap-3 shadow-inner"><svg class="w-5 h-5 text-blue-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg><textarea rows="2" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" placeholder="Tulis catatan penting..." class="w-full bg-transparent text-slate-200 text-xs sm:text-sm outline-none resize-none font-medium whitespace-pre-wrap">\' + escapeHtml(block.content || \'\') + \'</textarea></div>\';\n' +
'                    } else if (bType === \'quote\') {\n' +
'                        inner = \'<div class="border-l-2 border-blue-500 pl-3.5 py-1"><textarea rows="2" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" placeholder="Kutipan..." class="w-full bg-transparent text-slate-300 italic text-sm outline-none resize-none whitespace-pre-wrap font-serif">\' + escapeHtml(block.content || \'\') + \'</textarea></div>\';\n' +
'                    } else if (bType === \'divider\') {\n' +
'                        inner = \'<div class="py-2"><div class="h-px bg-slate-800/80 w-full"></div></div>\';\n' +
'                    } else if (bType === \'code\') {\n' +
'                        inner = \'<div class="bg-slate-900 text-slate-200 p-4 rounded-2xl font-mono text-xs border border-slate-800 shadow-inner"><input type="text" value="\' + escapeHtml(block.language || \'javascript\') + \'" oninput="updateBlockLang(\' + index + \', this.value)" placeholder="Bahasa (e.g. bash, javascript, html, python)" class="bg-transparent text-[11px] text-blue-400 font-bold pb-2 outline-none w-full border-b border-slate-800 block"/><textarea rows="4" oninput="autoResize(this); updateBlockContent(\' + index + \', this.value)" class="w-full bg-transparent outline-none resize-none text-slate-100 mt-2 font-mono whitespace-pre" placeholder="Paste kode program...">\' + escapeHtml(block.content || \'\') + \'</textarea></div>\';\n' +
'                    } else if (bType === \'table\') {\n' +
'                        let tbl = \'<div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 overflow-x-auto shadow-inner"><table class="w-full text-xs text-left text-slate-300 min-w-[450px]"><thead><tr class="border-b border-slate-800">\';\n' +
'                        (block.headers || [\'Singkatan\', \'Kepanjangan / Arti\']).forEach((h, hIdx) => {\n' +
'                            tbl += \'<th class="p-2"><div class="flex items-center gap-1.5"><input type="text" value="\' + escapeHtml(h) + \'" oninput="updateTableHeader(\' + index + \', \' + hIdx + \', this.value)" class="bg-slate-950 px-2.5 py-1.5 rounded-lg w-full font-bold text-blue-400 border border-slate-800 outline-none focus:border-blue-500"/><button type="button" onclick="deleteTableColumn(\' + index + \', \' + hIdx + \')" class="p-1 rounded text-slate-500 hover:text-red-400 transition" title="Hapus Kolom">✕</button></div></th>\';\n' +
'                        });\n' +
'                        tbl += \'<th class="w-12 text-center">Aksi</th></tr></thead><tbody>\';\n' +
'                        (block.rows || []).forEach((r, rIdx) => {\n' +
'                            tbl += \'<tr class="border-b border-slate-800/50 hover:bg-slate-850/50 transition">\';\n' +
'                            r.forEach((cell) => {\n' +
'                                tbl += \'<td class="p-2"><input type="text" value="\' + escapeHtml(cell) + \'" class="bg-slate-950 px-2.5 py-1.5 rounded-lg w-full text-slate-200 border border-slate-800 outline-none focus:border-blue-500"/></td>\';\n' +
'                            });\n' +
'                            tbl += \'<td class="p-2 text-center"><button type="button" onclick="deleteTableRow(\' + index + \', \' + rIdx + \')" class="p-1 rounded-lg hover:bg-red-500/20 text-red-400 transition" title="Hapus Baris">✕</button></td></tr>\';\n' +
'                        });\n' +
'                        tbl += \'</tbody></table><div class="mt-3 flex items-center justify-between flex-wrap gap-2"><div class="flex items-center gap-2"><button type="button" onclick="addTableRow(\' + index + \')" class="px-3.5 py-1.5 bg-blue-600/15 hover:bg-blue-600/25 text-blue-400 rounded-xl text-xs font-semibold border border-blue-500/30 transition">+ Tambah Baris</button><button type="button" onclick="addTableColumn(\' + index + \')" class="px-3.5 py-1.5 bg-purple-600/15 hover:bg-purple-600/25 text-purple-400 rounded-xl text-xs font-semibold border border-purple-500/30 transition">+ Tambah Kolom</button></div><span class="text-[10px] text-slate-500 font-mono">Tabel Responsif</span></div></div>\';\n' +
'                        inner = tbl;\n' +
'                    }\n' +
'                    wrapper.innerHTML = \'<div class="relative w-full">\' + moveControls + inner + \'</div>\';\n' +
'                } else {\n' +
'                    if (bType === \'paragraph\') {\n' +
'                        wrapper.innerHTML = \'<p class="text-slate-300 leading-relaxed text-sm my-2 whitespace-pre-wrap font-sans">\' + formatMarkdown(block.content) + \'</p>\';\n' +
'                    } else if (bType === \'h1\') {\n' +
'                        wrapper.innerHTML = \'<h1 class="text-2xl sm:text-3xl font-extrabold text-white mt-7 mb-2 tracking-tight whitespace-pre-wrap">\' + escapeHtml(block.content) + \'</h1>\';\n' +
'                    } else if (bType === \'h2\') {\n' +
'                        wrapper.innerHTML = \'<h2 class="text-xl sm:text-2xl font-bold text-slate-100 mt-5 mb-2 tracking-tight whitespace-pre-wrap">\' + escapeHtml(block.content) + \'</h2><div class="h-px w-full bg-slate-850 mb-3"></div>\';\n' +
'                    } else if (bType === \'h3\') {\n' +
'                        wrapper.innerHTML = \'<h3 class="text-lg font-bold text-slate-200 mt-4 mb-1 tracking-tight whitespace-pre-wrap">\' + escapeHtml(block.content) + \'</h3>\';\n' +
'                    } else if (bType === \'bullet\') {\n' +
'                        wrapper.innerHTML = \'<div class="flex items-start gap-2.5 my-1.5"><span class="text-blue-400 text-base leading-none mt-1 font-bold">•</span><p class="text-slate-300 text-sm whitespace-pre-wrap flex-1 font-sans">\' + formatMarkdown(block.content) + \'</p></div>\';\n' +
'                    } else if (bType === \'numbered\') {\n' +
'                        wrapper.innerHTML = \'<div class="flex items-start gap-2.5 my-1.5"><span class="font-mono text-blue-400 text-xs font-bold mt-1">\'+ (index + 1) +\'.</span><p class="text-slate-300 text-sm whitespace-pre-wrap flex-1 font-sans">\' + formatMarkdown(block.content) + \'</p></div>\';\n' +
'                    } else if (bType === \'todo\') {\n' +
'                        wrapper.innerHTML = \'<div class="flex items-start gap-2.5 my-1.5"><input type="checkbox" \' + (block.checked ? \'checked\' : \'\') + \' disabled class="mt-1 w-4 h-4 rounded border-slate-700 text-blue-600 bg-slate-850"><p class="text-slate-300 text-sm whitespace-pre-wrap flex-1 font-sans \' + (block.checked ? \'line-through text-slate-500\' : \'\') + \'">\' + formatMarkdown(block.content) + \'</p></div>\';\n' +
'                    } else if (bType === \'callout\') {\n' +
'                        wrapper.innerHTML = \'<div class="bg-blue-950/20 border border-blue-500/30 rounded-2xl p-4 flex items-start gap-3 my-3 shadow-inner"><svg class="w-5 h-5 text-blue-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg><div class="text-slate-200 text-xs sm:text-sm font-medium leading-relaxed whitespace-pre-wrap flex-1">\' + formatMarkdown(block.content) + \'</div></div>\';\n' +
'                    } else if (bType === \'quote\') {\n' +
'                        wrapper.innerHTML = \'<blockquote class="border-l-2 border-blue-500 pl-4 py-1.5 my-3 text-slate-300 italic text-sm font-serif leading-relaxed whitespace-pre-wrap">\' + formatMarkdown(block.content) + \'</blockquote>\';\n' +
'                    } else if (bType === \'divider\') {\n' +
'                        wrapper.innerHTML = \'<div class="py-3"><div class="h-px bg-slate-800/80 w-full"></div></div>\';\n' +
'                    } else if (bType === \'code\') {\n' +
'                        wrapper.innerHTML = \'<div class="relative group/code bg-slate-900 border border-slate-800 p-4 rounded-2xl my-3"><div class="flex justify-between items-center pb-2 mb-2 border-b border-slate-800 text-[11px] font-mono text-blue-400"><span>\' + escapeHtml(block.language || \'code\') + \'</span><button type="button" onclick="copyCode(this)" class="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white px-2 py-0.5 rounded-md transition shadow border border-slate-700">Salin</button></div><pre class="font-mono text-xs overflow-x-auto"><code class="language-\' + (block.language || \'javascript\') + \'">\' + escapeHtml(block.content) + \'</code></pre></div>\';\n' +
'                    } else if (bType === \'table\') {\n' +
'                        let tbl = \'<div class="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-x-auto my-3 shadow-inner"><table class="w-full text-xs text-left text-slate-300 min-w-[450px]"><thead class="bg-slate-900 border-b border-slate-800"><tr>\';\n' +
'                        (block.headers || []).forEach(h => { tbl += \'<th class="p-3 font-bold text-blue-400">\' + escapeHtml(h) + \'</th>\'; });\n' +
'                        tbl += \'</tr></thead><tbody>\';\n' +
'                        (block.rows || []).forEach(r => {\n' +
'                            tbl += \'<tr class="border-b border-slate-800/40 hover:bg-slate-850/40 transition">\';\n' +
'                            r.forEach(c => { tbl += \'<td class="p-3">\' + escapeHtml(c) + \'</td>\'; });\n' +
'                            tbl += \'</tr>\';\n' +
'                        });\n' +
'                        tbl += \'</tbody></table></div>\';\n' +
'                        wrapper.innerHTML = tbl;\n' +
'                    }\n' +
'                }\n' +
'                container.appendChild(wrapper);\n' +
'            });\n' +
'\n' +
'            if(isAdmin) document.querySelectorAll(\'#editor-container textarea, #page-title\').forEach(el => autoResize(el));\n' +
'            else hljs.highlightAll();\n' +
'\n' +
'            updateNavigationUI(currentPageIndex + 1, pages.length);\n' +
'        }\n' +
'\n' +
'        // KONTROL TABEL MANUAL\n' +
'        function addTableRow(bIdx) {\n' +
'            syncDomToBlocks();\n' +
'            const page = currentFolderData.pages[currentPageIndex];\n' +
'            const colsCount = page.blocks[bIdx].headers.length;\n' +
'            page.blocks[bIdx].rows.push(Array(colsCount).fill(\'Baru\'));\n' +
'            renderCurrentPage();\n' +
'        }\n' +
'        function deleteTableRow(bIdx, rIdx) {\n' +
'            syncDomToBlocks();\n' +
'            const page = currentFolderData.pages[currentPageIndex];\n' +
'            page.blocks[bIdx].rows.splice(rIdx, 1);\n' +
'            renderCurrentPage();\n' +
'        }\n' +
'        function addTableColumn(bIdx) {\n' +
'            syncDomToBlocks();\n' +
'            const page = currentFolderData.pages[currentPageIndex];\n' +
'            page.blocks[bIdx].headers.push(\'Kolom Baru\');\n' +
'            page.blocks[bIdx].rows.forEach(r => r.push(\'-\'));\n' +
'            renderCurrentPage();\n' +
'        }\n' +
'        function deleteTableColumn(bIdx, hIdx) {\n' +
'            syncDomToBlocks();\n' +
'            const page = currentFolderData.pages[currentPageIndex];\n' +
'            if (page.blocks[bIdx].headers.length <= 1) {\n' +
'                showToast(\'Tabel minimal harus memiliki 1 kolom!\', true);\n' +
'                return;\n' +
'            }\n' +
'            page.blocks[bIdx].headers.splice(hIdx, 1);\n' +
'            page.blocks[bIdx].rows.forEach(r => r.splice(hIdx, 1));\n' +
'            renderCurrentPage();\n' +
'        }\n' +
'        function updateTableHeader(bIdx, hIdx, val) {\n' +
'            const page = currentFolderData.pages[currentPageIndex];\n' +
'            page.blocks[bIdx].headers[hIdx] = val;\n' +
'        }\n' +
'\n' +
'        function updateNavigationUI(current, total) {\n' +
'            document.getElementById(\'page-indicator\').innerText = total > 0 ? \`Hal \${current} / \${total}\` : \'Hal 0 / 0\';\n' +
'            \n' +
'            const hasPrev = current > 1;\n' +
'            const hasNext = current < total;\n' +
'\n' +
'            const topPrev = document.getElementById(\'top-btn-prev\');\n' +
'            const botPrev = document.getElementById(\'bot-btn-prev\');\n' +
'            const topNext = document.getElementById(\'top-btn-next\');\n' +
'            const botNext = document.getElementById(\'bot-btn-next\');\n' +
'\n' +
'            if (hasPrev) {\n' +
'                topPrev.classList.remove(\'invisible\');\n' +
'                botPrev.classList.remove(\'invisible\');\n' +
'            } else {\n' +
'                topPrev.classList.add(\'invisible\');\n' +
'                botPrev.classList.add(\'invisible\');\n' +
'            }\n' +
'\n' +
'            if (hasNext) {\n' +
'                topNext.classList.remove(\'invisible\');\n' +
'                botNext.classList.remove(\'invisible\');\n' +
'            } else {\n' +
'                topNext.classList.add(\'invisible\');\n' +
'                botNext.classList.add(\'invisible\');\n' +
'            }\n' +
'        }\n' +
'\n' +
'        function goToPrevPage() {\n' +
'            if(currentPageIndex > 0) {\n' +
'                syncDomToBlocks();\n' +
'                currentPageIndex--;\n' +
'                renderCurrentPage();\n' +
'                document.getElementById(\'main-scroll\').scrollTo({top: 0, behavior: \'smooth\'});\n' +
'            }\n' +
'        }\n' +
'\n' +
'        function goToNextPage() {\n' +
'            if(currentPageIndex < currentFolderData.pages.length - 1) {\n' +
'                syncDomToBlocks();\n' +
'                currentPageIndex++;\n' +
'                renderCurrentPage();\n' +
'                document.getElementById(\'main-scroll\').scrollTo({top: 0, behavior: \'smooth\'});\n' +
'            }\n' +
'        }\n' +
'\n' +
'        function addNewPage() {\n' +
'            if (!currentFolderId) {\n' +
'                showToast(\'Pilih folder terlebih dahulu di sidebar!\', true);\n' +
'                toggleFab(null, false);\n' +
'                return;\n' +
'            }\n' +
'            syncDomToBlocks();\n' +
'            if(!currentFolderData.pages) currentFolderData.pages = [];\n' +
'            currentFolderData.pages.push({\n' +
'                title: \'\',\n' +
'                blocks: []\n' +
'            });\n' +
'            currentPageIndex = currentFolderData.pages.length - 1;\n' +
'            toggleFab(null, false);\n' +
'            renderCurrentPage();\n' +
'            document.getElementById(\'main-scroll\').scrollTo({top: 0, behavior: \'smooth\'});\n' +
'            showToast(\'Halaman baru dibuat.\');\n' +
'        }\n' +
'\n' +
'        async function deleteCurrentPage() {\n' +
'            if (!currentFolderId) {\n' +
'                showToast(\'Belum ada folder yang dipilih!\', true);\n' +
'                toggleFab(null, false);\n' +
'                return;\n' +
'            }\n' +
'            if(!currentFolderData.pages || currentFolderData.pages.length <= 1) {\n' +
'                showToast(\'Folder minimal harus memiliki 1 halaman!\', true);\n' +
'                toggleFab(null, false);\n' +
'                return;\n' +
'            }\n' +
'            const confirmed = await showCustomDialog({\n' +
'                title: \'Hapus Halaman Ini\',\n' +
'                desc: \'Halaman ini dan seluruh blok isinya akan dihapus.\',\n' +
'                isPrompt: false,\n' +
'                isDanger: true,\n' +
'                confirmText: \'Hapus Halaman\'\n' +
'            });\n' +
'            if(!confirmed) return;\n' +
'            \n' +
'            syncDomToBlocks();\n' +
'            currentFolderData.pages.splice(currentPageIndex, 1);\n' +
'            if(currentPageIndex >= currentFolderData.pages.length) {\n' +
'                currentPageIndex = currentFolderData.pages.length - 1;\n' +
'            }\n' +
'            toggleFab(null, false);\n' +
'            renderCurrentPage();\n' +
'            showToast(\'Halaman dihapus.\');\n' +
'        }\n' +
'\n' +
'        function updateCurrentPageTitle(val) {\n' +
'            if(currentFolderData.pages && currentFolderData.pages[currentPageIndex]) {\n' +
'                currentFolderData.pages[currentPageIndex].title = val;\n' +
'            }\n' +
'        }\n' +
'\n' +
'        function updateBlockContent(i, val) { \n' +
'            if(currentFolderData.pages[currentPageIndex] && currentFolderData.pages[currentPageIndex].blocks[i]) {\n' +
'                currentFolderData.pages[currentPageIndex].blocks[i].content = val; \n' +
'            }\n' +
'        }\n' +
'        function updateBlockLang(i, val) { \n' +
'            if(currentFolderData.pages[currentPageIndex] && currentFolderData.pages[currentPageIndex].blocks[i]) {\n' +
'                currentFolderData.pages[currentPageIndex].blocks[i].language = val; \n' +
'            }\n' +
'        }\n' +
'        function updateBlockChecked(i, val) { \n' +
'            if(currentFolderData.pages[currentPageIndex] && currentFolderData.pages[currentPageIndex].blocks[i]) {\n' +
'                currentFolderData.pages[currentPageIndex].blocks[i].checked = val; \n' +
'                renderCurrentPage();\n' +
'            }\n' +
'        }\n' +
'        function moveBlock(i, dir) {\n' +
'            syncDomToBlocks();\n' +
'            const blocks = currentFolderData.pages[currentPageIndex].blocks;\n' +
'            const target = i + dir;\n' +
'            if (target < 0 || target >= blocks.length) return;\n' +
'            const temp = blocks[i];\n' +
'            blocks[i] = blocks[target];\n' +
'            blocks[target] = temp;\n' +
'            renderCurrentPage();\n' +
'        }\n' +
'        function removeBlock(i) { \n' +
'            syncDomToBlocks();\n' +
'            if(currentFolderData.pages[currentPageIndex] && currentFolderData.pages[currentPageIndex].blocks) {\n' +
'                currentFolderData.pages[currentPageIndex].blocks.splice(i, 1); \n' +
'                renderCurrentPage(); \n' +
'            }\n' +
'        }\n' +
'\n' +
'        function addBlock(type) { \n' +
'            if (!currentFolderId || !currentFolderData.pages || currentFolderData.pages.length === 0) {\n' +
'                showToast(\'Pilih folder terlebih dahulu di sidebar!\', true);\n' +
'                toggleFab(null, false);\n' +
'                return;\n' +
'            }\n' +
'            if (!currentFolderData.pages[currentPageIndex]) currentPageIndex = 0;\n' +
'            if (!currentFolderData.pages[currentPageIndex].blocks) currentFolderData.pages[currentPageIndex].blocks = [];\n' +
'\n' +
'            syncDomToBlocks();\n' +
'\n' +
'            const newBlock = type === \'table\' ? {\n' +
'                type: \'table\',\n' +
'                headers: [\'Singkatan\', \'Kepanjangan / Arti\'],\n' +
'                rows: [\n' +
'                    [\'TCP\', \'Transmission Control Protocol\'],\n' +
'                    [\'UDP\', \'User Datagram Protocol\'],\n' +
'                    [\'IP\', \'Internet Protocol\'],\n' +
'                    [\'DNS\', \'Domain Name System\'],\n' +
'                    [\'DHCP\', \'Dynamic Host Configuration Protocol\']\n' +
'                ]\n' +
'            } : {\n' +
'                type, \n' +
'                content: \'\', \n' +
'                checked: type === \'todo\' ? false : undefined,\n' +
'                language: type === \'code\' ? \'javascript\' : undefined \n' +
'            };\n' +
'\n' +
'            currentFolderData.pages[currentPageIndex].blocks.push(newBlock); \n' +
'            \n' +
'            toggleFab(null, false);\n' +
'            renderCurrentPage();\n' +
'\n' +
'            setTimeout(() => {\n' +
'                const container = document.getElementById(\'editor-container\');\n' +
'                const lastBlock = container.lastElementChild;\n' +
'                if(lastBlock) {\n' +
'                    const inputEl = lastBlock.querySelector(\'textarea, input[type="text"]\');\n' +
'                    if(inputEl) inputEl.focus();\n' +
'                    lastBlock.scrollIntoView({ behavior: \'smooth\', block: \'center\' });\n' +
'                }\n' +
'            }, 80);\n' +
'        }\n' +
'\n' +
'        async function saveCurrentFolder() {\n' +
'            if(!currentFolderId) {\n' +
'                showToast(\'Tidak ada folder aktif untuk disimpan!\', true);\n' +
'                return;\n' +
'            }\n' +
'            syncDomToBlocks();\n' +
'            showToast(\'Menyimpan ke Google Drive...\');\n' +
'            try {\n' +
'                const res = await fetch(\'/api/pages\', { \n' +
'                    method: \'POST\', \n' +
'                    headers: {\'Content-Type\': \'application/json\'}, \n' +
'                    body: JSON.stringify({ \n' +
'                        id: currentFolderId, \n' +
'                        title: currentFolderData.title, \n' +
'                        pages: currentFolderData.pages \n' +
'                    }) \n' +
'                });\n' +
'                if((await res.json()).success) { \n' +
'                    showToast(\'Semua halaman tersimpan!\'); \n' +
'                    toggleFab(null, false);\n' +
'                    await loadFolders(); \n' +
'                } else showToast(\'Gagal menyimpan\', true);\n' +
'            } catch(e) { showToast(\'Error jaringan\', true); }\n' +
'        }\n' +
'\n' +
'        function copyCode(btn) {\n' +
'            navigator.clipboard.writeText(btn.closest(\'.group\\\\/code\').querySelector(\'code\').innerText);\n' +
'            btn.innerText = \'Tersalin!\'; btn.classList.add(\'text-blue-400\');\n' +
'            setTimeout(() => { btn.innerText = \'Salin\'; btn.classList.remove(\'text-blue-400\'); }, 2000);\n' +
'        }\n' +
'\n' +
'        function escapeHtml(t) { return (t || \'\').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }\n' +
'\n' +
'        function handleDeepSearch(query) {\n' +
'            clearTimeout(searchDebounceTimer);\n' +
'            const resBox = document.getElementById(\'search-results\');\n' +
'            if(!query.trim()) { resBox.classList.add(\'hidden\'); return; }\n' +
'\n' +
'            searchDebounceTimer = setTimeout(async () => {\n' +
'                try {\n' +
'                    const res = await fetch(\'/api/search?q=\' + encodeURIComponent(query.trim()));\n' +
'                    const data = await res.json();\n' +
'                    \n' +
'                    resBox.innerHTML = \'\';\n' +
'                    if(!data || data.length === 0) { \n' +
'                        resBox.innerHTML = \'<div class="p-4 text-center text-xs text-slate-500">Tidak ada hasil untuk "<span class="text-slate-300">\' + escapeHtml(query) + \'</span>"</div>\'; \n' +
'                    } else {\n' +
'                        data.forEach(item => {\n' +
'                            const div = document.createElement(\'div\');\n' +
'                            div.className = \'flex items-center justify-between p-3 hover:bg-slate-850 rounded-xl cursor-pointer transition group gap-3\';\n' +
'                            \n' +
'                            let badgeHtml = \'\';\n' +
'                            let iconSvg = \'\';\n' +
'\n' +
'                            if (item.type === \'folder\') {\n' +
'                                badgeHtml = \'<span class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">Folder</span>\';\n' +
'                                iconSvg = \'<svg class="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>\';\n' +
'                            } else if (item.type === \'page\') {\n' +
'                                badgeHtml = \'<span class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">Halaman</span>\';\n' +
'                                iconSvg = \'<svg class="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>\';\n' +
'                            } else if (item.type === \'heading\') {\n' +
'                                badgeHtml = \'<span class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-purple-500/10 text-purple-400 border border-purple-500/20 shrink-0">Sub Bab</span>\';\n' +
'                                iconSvg = \'<svg class="w-4 h-4 text-purple-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>\';\n' +
'                            }\n' +
'\n' +
'                            div.innerHTML = \'<div class="flex items-center gap-3 truncate">\' +\n' +
'                                iconSvg +\n' +
'                                \'<div class="truncate">\' +\n' +
'                                    \'<div class="text-xs text-slate-200 group-hover:text-white font-semibold truncate">\' + escapeHtml(item.title) + \'</div>\' +\n' +
'                                    \'<div class="text-[11px] text-slate-500 group-hover:text-slate-400 truncate mt-0.5">\' + escapeHtml(item.subtext) + \'</div>\' +\n' +
'                                \'</div>\' +\n' +
'                            \'</div>\' +\n' +
'                            \'<div class="flex items-center gap-2 shrink-0">\' +\n' +
'                                badgeHtml +\n' +
'                                \'<span class="text-[11px] text-slate-500 group-hover:text-slate-300 font-mono hidden sm:inline">Buka →</span>\' +\n' +
'                            \'</div>\';\n' +
'\n' +
'                            div.onclick = () => { \n' +
'                                loadFolderContent(item.folderId, item.pageIndex, item.blockIndex); \n' +
'                                resBox.classList.add(\'hidden\'); \n' +
'                                document.getElementById(\'global-search\').value = \'\'; \n' +
'                            };\n' +
'                            resBox.appendChild(div);\n' +
'                        });\n' +
'                    }\n' +
'                    resBox.classList.remove(\'hidden\');\n' +
'                } catch (e) { console.error(e); }\n' +
'            }, 250);\n' +
'        }\n' +
'\n' +
'        document.addEventListener(\'click\', (e) => {\n' +
'            if (isFabOpen) {\n' +
'                const fabContainer = document.getElementById(\'fab-container\');\n' +
'                if (fabContainer && !fabContainer.contains(e.target)) {\n' +
'                    toggleFab(null, false);\n' +
'                }\n' +
'            }\n' +
'            const searchInput = document.getElementById(\'global-search\');\n' +
'            const resBox = document.getElementById(\'search-results\');\n' +
'            if (searchInput && resBox && !searchInput.contains(e.target) && !resBox.contains(e.target)) {\n' +
'                resBox.classList.add(\'hidden\');\n' +
'            }\n' +
'        });\n' +
'    </script>\n' +
'</body>\n' +
'</html>');
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => console.log('🚀 Server berjalan di http://localhost:' + PORT));
}
module.exports = app;