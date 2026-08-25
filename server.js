const express = require('express');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

// Kapasitas besar untuk unlimited blocks & data teks panjang
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/favicon.ico', (req, res) => res.status(204).end());

// Setup Google Drive OAuth2
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// In-memory Caches
let fileCache = { data: null, timestamp: 0 };
let contentCache = {}; // Cache isi file JSON untuk fast deep search
const CACHE_TTL = 30 * 1000;

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
        fileCache = { data: response.data.files, timestamp: now };
        res.json(response.data.files);
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

// DEEP SEARCH API: Folder, Halaman, dan Sub-Heading
app.get('/api/search', async (req, res) => {
    try {
        const query = (req.query.q || '').trim().toLowerCase();
        if (!query) return res.json([]);

        // Pastikan daftar file tersedia
        const now = Date.now();
        if (!fileCache.data || (now - fileCache.timestamp >= CACHE_TTL)) {
            const response = await drive.files.list({
                q: `'${FOLDER_ID}' in parents and mimeType='application/json' and trashed=false`,
                fields: 'files(id, name, createdTime)',
                orderBy: 'name',
            });
            fileCache = { data: response.data.files, timestamp: now };
        }
        const files = fileCache.data || [];
        const results = [];

        // Scan seluruh isi folder dan file secara paralel
        await Promise.all(files.map(async (file) => {
            const cleanFolderName = file.name.replace('.json', '').replace(/-/g, ' ');

            // 1. Cek Kecocokan Nama Folder
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

            // Ambil isi konten untuk mencari Halaman & Sub-heading
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

                // 2. Cek Kecocokan Judul Halaman
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

                // 3. Cek Kecocokan Sub-Heading
                const blocks = p.blocks || [];
                blocks.forEach((b, bIdx) => {
                    if (b.type === 'header' && b.content && b.content.toLowerCase().includes(query)) {
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
                });
            });
        }));

        res.json(results.slice(0, 20)); // Limit 20 hasil terbaik
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
    <title>Shanz</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    fontFamily: { sans: ['Inter', 'sans-serif'] },
                    colors: { 
                        brand: { 500: '#10b981', 600: '#059669', 700: '#047857' },
                        slate: { 850: '#151c28', 900: '#0f172a', 950: '#0b0f19' }
                    }
                }
            }
        }
    </script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    <style>
        html { scroll-behavior: smooth; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.2); border-radius: 6px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(148, 163, 184, 0.4); }
        textarea { overflow: hidden; }
        .highlight-pulse {
            animation: pulseBlock 2s cubic-bezier(0.4, 0, 0.6, 1);
        }
        @keyframes pulseBlock {
            0%, 100% { background-color: transparent; }
            50% { background-color: rgba(168, 85, 247, 0.15); border-radius: 0.75rem; }
        }
    </style>
</head>
<body class="bg-slate-950 text-slate-200 font-sans h-screen flex flex-col overflow-hidden selection:bg-brand-500/30 selection:text-emerald-300">

    <!-- TOP NAVBAR -->
    <header class="h-14 border-b border-slate-800/80 px-4 sm:px-6 flex justify-between items-center bg-slate-900/80 backdrop-blur-xl z-30">
        <div class="flex items-center gap-3 w-1/4">
            <button onclick="toggleSidebar()" class="p-2 rounded-lg bg-slate-800/60 hover:bg-slate-800 text-slate-300 hover:text-white transition flex items-center gap-2 border border-slate-700/50">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
                <span class="text-xs font-semibold uppercase tracking-wider hidden sm:inline">Menu</span>
            </button>
        </div>
        
        <!-- DEEP SEARCH BAR (FOLDER, HALAMAN, SUB-HEADING) -->
        <div class="flex-1 max-w-xl mx-3 relative">
            <div class="relative group">
                <div class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-emerald-400 transition">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                </div>
                <input type="text" id="global-search" oninput="handleDeepSearch(this.value)" placeholder="Cari folder, judul halaman, atau sub-heading..." class="w-full bg-slate-850/80 text-sm pl-10 pr-16 py-1.5 rounded-xl outline-none border border-slate-700/60 focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 text-slate-100 placeholder-slate-400 shadow-inner transition">
            </div>

            <!-- SEARCH RESULTS DROPDOWN DENGAN VISUAL BADGE -->
            <div id="search-results" class="absolute top-full left-0 right-0 mt-2 bg-slate-900/95 backdrop-blur-2xl border border-slate-700/80 rounded-2xl shadow-2xl max-h-96 overflow-y-auto hidden z-50 p-2 divide-y divide-slate-800/60"></div>
        </div>

        <div class="flex items-center justify-end gap-2 w-1/4">
            <button id="admin-auth-btn" onclick="handleAdminToggle()" class="text-xs px-3.5 py-1.5 rounded-lg font-semibold transition bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30">Sign In</button>
        </div>
    </header>

    <!-- LAYOUT UTAMA -->
    <div class="flex-1 flex overflow-hidden relative">
        <div id="sidebar-overlay" onclick="toggleSidebar()" class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 hidden transition-opacity"></div>

        <!-- SIDEBAR -->
        <aside id="sidebar" class="fixed inset-y-0 left-0 z-50 w-72 bg-slate-900 border-r border-slate-800 flex flex-col transform -translate-x-full transition-transform duration-300 h-full shadow-2xl">
            <div class="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/80">
                <div class="flex items-center gap-2">
                    <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                    <span class="text-xs font-bold text-slate-300 uppercase tracking-wider">Materi Folder</span>
                </div>
                <div class="flex items-center gap-1">
                    <button id="new-folder-btn" onclick="createNewFolder()" class="text-xs bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2.5 py-1 rounded-md transition font-medium hidden">+ Folder</button>
                    <button onclick="toggleSidebar()" class="p-1 rounded text-slate-400 hover:text-white text-xs hover:bg-slate-800 transition">✕</button>
                </div>
            </div>

            <div id="folder-list" class="flex-1 overflow-y-auto p-3 space-y-1">
                <p class="text-xs text-slate-400 p-4 text-center animate-pulse">Memuat daftar...</p>
            </div>
        </aside>

        <!-- MAIN READER & EDITOR -->
        <main id="main-scroll" class="flex-1 overflow-y-auto bg-slate-950 relative">
            <div id="main-content-container" class="max-w-4xl mx-auto w-full px-6 sm:px-12 py-10 pb-44">
                
                <!-- TOP PAGE NAVIGATION -->
                <div id="top-nav-container" class="hidden justify-between items-center mb-8 pb-4 border-b border-slate-800/80">
                    <button id="top-btn-prev" onclick="goToPrevPage()" class="invisible bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 hover:text-white px-4 py-1.5 text-xs rounded-xl transition font-medium">❮ Sebelumnya</button>
                    
                    <div id="page-indicator" class="text-xs font-medium px-3.5 py-1 bg-emerald-500/10 text-emerald-400 rounded-full border border-emerald-500/20 font-mono">
                        Halaman 0 / 0
                    </div>

                    <button id="top-btn-next" onclick="goToNextPage()" class="invisible bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-xs rounded-xl transition font-medium shadow-sm">Selanjutnya ❯</button>
                </div>

                <!-- JUDUL HALAMAN AKTIF -->
                <div id="title-wrapper" class="hidden mb-8 relative group">
                    <textarea id="page-title" rows="1" oninput="autoResize(this); updateCurrentPageTitle(this.value)" placeholder="Judul Halaman..." readonly class="text-3xl sm:text-4xl font-extrabold bg-transparent outline-none w-full text-white resize-none tracking-tight placeholder-slate-600 whitespace-pre-wrap"></textarea>
                </div>
                
                <!-- BLOK KONTEN UNLIMITED -->
                <div id="editor-container" class="space-y-4"></div>
                
                <!-- BOTTOM PAGE NAVIGATION -->
                <div id="bot-nav-container" class="hidden justify-between items-center mt-14 pt-8 border-t border-slate-800/80">
                    <button id="bot-btn-prev" onclick="goToPrevPage()" class="invisible bg-slate-900 hover:bg-slate-850 border border-slate-800 text-slate-300 hover:text-white px-5 py-2 text-xs rounded-xl transition font-medium">❮ Sebelumnya</button>
                    <button id="bot-btn-next" onclick="goToNextPage()" class="invisible bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 text-xs rounded-xl transition font-medium shadow-sm">Selanjutnya ❯</button>
                </div>
            </div>
        </main>
    </div>

    <!-- SAVE FAB (POJOK KIRI BAWAH) -->
    <div id="save-fab-container" class="fixed bottom-6 left-6 z-[9999] hidden">
        <button type="button" id="save-fab-btn" onclick="saveCurrentFolder()" title="Simpan Semua Perubahan (Ctrl + S)" class="w-14 h-14 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full shadow-2xl flex items-center justify-center p-3.5 transition-all duration-200 active:scale-90 focus:outline-none border border-emerald-400/30 cursor-pointer select-none">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path>
            </svg>
        </button>
    </div>

    <!-- ACTION FAB (POJOK KANAN BAWAH) -->
    <div id="fab-container" class="fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-2.5 hidden" onclick="event.stopPropagation()">
        <!-- FAB POPUP MENU -->
        <div id="fab-menu" class="hidden flex-col gap-2 mb-1 bg-slate-900/95 backdrop-blur-2xl p-3.5 rounded-2xl shadow-2xl border border-slate-700/80 min-w-[220px] max-h-[75vh] overflow-y-auto">
            <div class="flex items-center justify-between px-2 pb-1 border-b border-slate-800">
                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Aksi Halaman</span>
                <span class="text-[10px] text-emerald-400 font-mono font-semibold" id="fab-page-badge">Hal 1</span>
            </div>
            <button type="button" onclick="addNewPage()" class="text-left text-xs px-3 py-2 rounded-xl hover:bg-slate-800 text-slate-200 font-medium flex items-center gap-2 transition active:scale-95">
                <svg class="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg> + Halaman Baru
            </button>
            <button type="button" onclick="deleteCurrentPage()" class="text-left text-xs px-3 py-2 rounded-xl hover:bg-red-500/10 text-red-400 font-medium flex items-center gap-2 transition active:scale-95">
                <svg class="w-4 h-4 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg> Hapus Halaman Ini
            </button>
            
            <div class="h-px bg-slate-800 my-1"></div>
            <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-2">Tambah Blok</span>
            <button type="button" onclick="addBlock('paragraph')" class="text-left text-xs px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2">
                <span class="text-emerald-400 font-mono text-xs">¶</span> Teks Paragraf
            </button>
            <button type="button" onclick="addBlock('header')" class="text-left text-xs px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2">
                <span class="text-emerald-400 font-mono text-xs">H</span> Heading Sub-Bab
            </button>
            <button type="button" onclick="addBlock('code')" class="text-left text-xs px-3 py-1.5 rounded-xl hover:bg-slate-800 text-slate-300 font-medium transition flex items-center gap-2">
                <span class="text-emerald-400 font-mono text-xs">&lt;/&gt;</span> Snippet Kode
            </button>
        </div>

        <!-- MAIN FAB TOGGLE -->
        <button type="button" id="fab-main-btn" onclick="toggleFab(event)" class="w-14 h-14 bg-emerald-600 hover:bg-emerald-500 text-white rounded-full shadow-2xl flex items-center justify-center p-3.5 transition-all duration-200 active:scale-90 focus:outline-none border border-emerald-400/30 cursor-pointer select-none">
            <svg id="fab-icon" class="w-6 h-6 transition-transform duration-200 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
            </svg>
        </button>
    </div>

    <!-- TOAST NOTIFICATION -->
    <div id="toast" class="fixed top-18 right-6 bg-slate-900 border border-slate-700 text-white text-xs px-4 py-3 rounded-xl shadow-2xl transform translate-x-full opacity-0 transition-all duration-300 z-50 font-medium"></div>

    <script>
        let folders = [];
        let currentFolderId = null;
        let currentFolderData = { title: '', pages: [] };
        let currentPageIndex = 0;
        let isAdmin = localStorage.getItem('isAdmin') === 'true';
        let isFabOpen = false;
        let searchDebounceTimer = null;

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

        function autoResize(el) { 
            if(!el) return;
            el.style.height = 'auto'; 
            el.style.height = el.scrollHeight + 'px'; 
        }

        function showToast(msg, isError = false) {
            const toast = document.getElementById('toast');
            toast.innerText = msg;
            toast.className = \`fixed top-18 right-6 \${isError ? 'bg-red-950/90 border-red-800 text-red-200' : 'bg-slate-900 border-slate-700 text-emerald-400'} border text-xs px-4 py-3 rounded-xl shadow-2xl transform transition-all duration-300 z-50 font-medium\`;
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

        function syncDomToBlocks() {
            if (!currentFolderData.pages || !currentFolderData.pages[currentPageIndex]) return;
            const blocks = currentFolderData.pages[currentPageIndex].blocks || [];
            const container = document.getElementById('editor-container');
            if (!container) return;
            
            const blockEls = container.children;
            for (let i = 0; i < blockEls.length; i++) {
                if (!blocks[i]) continue;
                if (blocks[i].type === 'paragraph' || blocks[i].type === 'header') {
                    const input = blockEls[i].querySelector('textarea, input[type="text"]');
                    if (input) blocks[i].content = input.value;
                } else if (blocks[i].type === 'code') {
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
                btn.className = 'text-xs px-3.5 py-1.5 rounded-lg font-semibold transition bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30';
                newFolderBtn.classList.remove('hidden');
                fab.classList.remove('hidden');
                saveFab.classList.remove('hidden');
                titleInput.removeAttribute('readonly');
            } else {
                btn.innerText = 'Sign In';
                btn.className = 'text-xs px-3.5 py-1.5 rounded-lg font-semibold transition bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30';
                newFolderBtn.classList.add('hidden');
                fab.classList.add('hidden');
                saveFab.classList.add('hidden');
                titleInput.setAttribute('readonly', true);
            }
        }

        async function handleAdminToggle() {
            if(isAdmin) {
                isAdmin = false; localStorage.setItem('isAdmin', 'false');
                updateAdminUI(); showToast('Signed out.'); 
                if (currentFolderId) renderCurrentPage();
            } else {
                const pwd = prompt('Enter Admin Password:');
                if(!pwd) return;
                try {
                    const res = await fetch('/api/verify-password', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ password: pwd }) });
                    if((await res.json()).success) {
                        isAdmin = true; localStorage.setItem('isAdmin', 'true');
                        updateAdminUI(); showToast('Access Granted'); 
                        if (currentFolderId) renderCurrentPage();
                    } else showToast('Password salah', true);
                } catch(e) { showToast('Connection failed', true); }
            }
        }

        async function loadFolders() {
            try {
                const res = await fetch('/api/pages');
                const data = await res.json();
                folders = Array.isArray(data) ? data : [];
                renderFolderList();
            } catch(e) { document.getElementById('folder-list').innerHTML = '<p class="text-xs text-red-400 p-4">Gagal memuat folder.</p>'; }
        }

        function renderWelcomeView() {
            currentFolderId = null;
            document.getElementById('top-nav-container').classList.replace('flex', 'hidden');
            document.getElementById('bot-nav-container').classList.replace('flex', 'hidden');
            document.getElementById('title-wrapper').classList.add('hidden');

            const container = document.getElementById('editor-container');
            container.innerHTML = \`
                <div class="flex flex-col items-center justify-center text-center py-24 px-4">
                    <div class="w-16 h-16 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-emerald-400 mb-5 shadow-inner">
                        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>
                    </div>
                    <h2 class="text-xl font-bold mb-2 text-white">Mulai Membaca Materi</h2>
                    <p class="text-slate-400 max-w-sm text-xs mb-6 leading-relaxed">Buka menu sidebar untuk memilih bab materi, atau gunakan fitur pencarian di atas.</p>
                    <button onclick="toggleSidebar()" class="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold transition shadow-lg shadow-emerald-950/50 flex items-center gap-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
                        Buka Sidebar
                    </button>
                </div>
            \`;
        }

        async function createNewFolder() {
            const title = prompt("Masukkan Nama Folder Baru:");
            if(!title || title.trim() === '') return;
            
            showToast('Membuat folder...');
            try {
                const folderName = title.trim();
                const payload = { 
                    title: folderName, 
                    pages: [{ title: folderName, blocks: [] }] 
                };
                const res = await fetch('/api/pages', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                const result = await res.json();
                if(result.success) {
                    showToast('Folder dibuat!');
                    await loadFolders(); 
                    loadFolderContent(result.file.id, 0);
                } else showToast('Gagal membuat folder', true);
            } catch(e) { showToast('Kesalahan jaringan', true); }
        }

        async function renameFolder(id, oldName) {
            const newTitle = prompt("Ubah Nama Folder:", oldName);
            if(!newTitle || newTitle === oldName) return;
            
            showToast('Mengubah nama...');
            try {
                const res = await fetch(\`/api/pages/\${id}/rename\`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ title: newTitle }) });
                if(res.ok) {
                    showToast('Nama folder diubah!');
                    await loadFolders();
                } else showToast('Gagal mengubah nama', true);
            } catch(e) { showToast('Kesalahan jaringan', true); }
        }

        async function deleteFolder(id, name) {
            if(!confirm(\`Yakin ingin menghapus folder "\${name}" beserta seluruh isinya?\`)) return;
            
            showToast('Menghapus folder...');
            try {
                const res = await fetch(\`/api/pages/\${id}\`, { method: 'DELETE' });
                if(res.ok) {
                    showToast('Folder dihapus!');
                    await loadFolders();
                    renderWelcomeView();
                } else showToast('Gagal menghapus', true);
            } catch(e) { showToast('Kesalahan jaringan', true); }
        }

        function renderFolderList() {
            const listEl = document.getElementById('folder-list');
            listEl.innerHTML = '';
            if(folders.length === 0) { listEl.innerHTML = '<p class="text-xs text-slate-500 p-4 text-center">Belum ada folder materi.</p>'; return; }
            
            folders.forEach((file) => {
                const cleanName = file.name.replace('.json', '').replace(/-/g, ' ');
                const isActive = currentFolderId === file.id;
                
                const div = document.createElement('div');
                div.className = \`group relative flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition \${
                    isActive 
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold' 
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white border border-transparent'
                }\`;
                
                const btnContent = document.createElement('button');
                btnContent.className = "flex-1 text-left truncate cursor-pointer flex items-center gap-2.5";
                btnContent.innerHTML = \`
                    <svg class="w-4 h-4 shrink-0 \${isActive ? 'text-emerald-400' : 'text-slate-500 group-hover:text-slate-400'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                    <span class="truncate capitalize">\${cleanName}</span>
                \`;
                btnContent.onclick = () => { 
                    loadFolderContent(file.id, 0); 
                    toggleSidebar();
                };
                div.appendChild(btnContent);

                if(isAdmin) {
                    const actions = document.createElement('div');
                    actions.className = "hidden group-hover:flex items-center gap-1 shrink-0";
                    
                    const btnRename = document.createElement('button');
                    btnRename.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>';
                    btnRename.className = "p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition";
                    btnRename.onclick = (e) => { e.stopPropagation(); renameFolder(file.id, cleanName); };
                    
                    const btnDelete = document.createElement('button');
                    btnDelete.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>';
                    btnDelete.className = "p-1 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 transition";
                    btnDelete.onclick = (e) => { e.stopPropagation(); deleteFolder(file.id, cleanName); };
                    
                    actions.appendChild(btnRename);
                    actions.appendChild(btnDelete);
                    div.appendChild(actions);
                }
                listEl.appendChild(div);
            });
        }

        // LOAD FOLDER DENGAN DUKUNGAN DIRECT TARGET PAGE & BLOCK
        async function loadFolderContent(id, targetPageIndex = 0, targetBlockIndex = null) {
            try {
                const res = await fetch(\`/api/pages/\${id}\`);
                const data = await res.json();
                currentFolderId = id;
                
                if(!data.pages || !Array.isArray(data.pages)) {
                    currentFolderData = {
                        title: data.title || 'Untitled Folder',
                        pages: [{ title: data.title || 'Halaman 1', blocks: data.blocks || [] }]
                    };
                } else {
                    currentFolderData = data;
                }

                currentPageIndex = targetPageIndex || 0;
                renderFolderList();
                renderCurrentPage();

                // Scroll & Efek Pulse Highlight ke Sub-Heading yang dicari
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
            } catch(e) { showToast('Gagal memuat folder', true); }
        }

        function renderCurrentPage() {
            const pages = currentFolderData.pages || [];
            
            document.getElementById('top-nav-container').classList.replace('hidden', 'flex');
            document.getElementById('bot-nav-container').classList.replace('hidden', 'flex');
            document.getElementById('title-wrapper').classList.remove('hidden');

            if(currentPageIndex >= pages.length) currentPageIndex = pages.length - 1;
            if(currentPageIndex < 0) currentPageIndex = 0;

            const page = pages[currentPageIndex] || { title: 'Untitled Page', blocks: [] };
            const titleEl = document.getElementById('page-title');
            titleEl.value = page.title || '';
            setTimeout(() => autoResize(titleEl), 50);

            const container = document.getElementById('editor-container');
            container.innerHTML = '';
            
            const blocks = page.blocks || [];
            if(blocks.length === 0 && isAdmin) {
                container.innerHTML = '<p class="text-slate-500 text-xs italic p-4 border border-dashed border-slate-800 rounded-xl">Halaman ini kosong. Buka tombol aksi di kanan bawah untuk menambah blok isi.</p>';
            }

            blocks.forEach((block, index) => {
                const wrapper = document.createElement('div');
                wrapper.id = \`block-\${index}\`;
                wrapper.className = "group relative w-full mb-5 transition-all duration-300";
                
                if(isAdmin) {
                    let inner = '';
                    if(block.type === 'paragraph') inner = \`<textarea rows="2" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" placeholder="Ketik teks paragraf..." class="w-full bg-transparent text-slate-300 leading-relaxed outline-none resize-none px-3 py-1.5 -ml-3 rounded-lg hover:bg-slate-900 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition text-sm whitespace-pre-wrap font-sans">\${block.content || ''}</textarea>\`;
                    else if(block.type === 'header') inner = \`<input type="text" value="\${block.content || ''}" oninput="updateBlockContent(\${index}, this.value)" placeholder="Heading Sub-Bab" class="w-full bg-transparent text-xl font-bold text-white outline-none px-3 py-1.5 -ml-3 rounded-lg hover:bg-slate-900 focus:bg-slate-900 border border-transparent focus:border-slate-800 transition whitespace-pre-wrap">\`;
                    else if(block.type === 'code') inner = \`<div class="bg-slate-900 text-slate-200 p-4 rounded-xl font-mono text-xs border border-slate-800 shadow-inner"><input type="text" value="\${block.language || 'html'}" oninput="updateBlockLang(\${index}, this.value)" placeholder="Bahasa kode (e.g. bash, javascript, html)" class="bg-transparent text-[11px] text-emerald-400 font-bold pb-2 outline-none w-full border-b border-slate-800 block"/><textarea rows="4" oninput="autoResize(this); updateBlockContent(\${index}, this.value)" class="w-full bg-transparent outline-none resize-none text-slate-100 mt-2 font-mono whitespace-pre" placeholder="Paste kode program di sini...">\${block.content || ''}</textarea></div>\`;
                    wrapper.innerHTML = \`<div class="flex items-start gap-1 relative">\${inner}<button type="button" onclick="removeBlock(\${index})" class="absolute -right-7 top-1 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition p-1" title="Hapus Blok">✕</button></div>\`;
                } else {
                    if(block.type === 'paragraph') wrapper.innerHTML = \`<p class="text-slate-300 leading-relaxed text-sm my-2 whitespace-pre-wrap font-sans">\${escapeHtml(block.content)}</p>\`;
                    else if(block.type === 'header') wrapper.innerHTML = \`<h2 class="text-xl font-bold text-white mt-8 mb-2 tracking-tight whitespace-pre-wrap">\${escapeHtml(block.content)}</h2><div class="h-px w-full bg-slate-800/80 mb-4"></div>\`;
                    else if(block.type === 'code') wrapper.innerHTML = \`<div class="relative group/code bg-slate-900 border border-slate-800/90 p-4 rounded-xl my-4"><button type="button" onclick="copyCode(this)" class="absolute top-3 right-3 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] px-2.5 py-1 rounded-md opacity-0 group-hover/code:opacity-100 transition shadow border border-slate-700">Salin</button><pre class="font-mono text-xs overflow-x-auto"><code class="language-\${block.language || 'html'}">\${escapeHtml(block.content)}</code></pre></div>\`;
                }
                container.appendChild(wrapper);
            });

            if(isAdmin) document.querySelectorAll('#editor-container textarea, #page-title').forEach(el => autoResize(el));
            else hljs.highlightAll();

            updateNavigationUI(currentPageIndex + 1, pages.length);
        }

        function updateNavigationUI(current, total) {
            document.getElementById('page-indicator').innerText = total > 0 ? \`Halaman \${current} / \${total}\` : 'Halaman 0 / 0';
            
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
            const title = prompt("Masukkan Judul Halaman Baru:");
            if(!title || title.trim() === '') return;
            
            syncDomToBlocks();
            if(!currentFolderData.pages) currentFolderData.pages = [];
            currentFolderData.pages.push({
                title: title.trim(),
                blocks: [{ type: 'paragraph', content: '' }]
            });
            currentPageIndex = currentFolderData.pages.length - 1;
            toggleFab(null, false);
            renderCurrentPage();
            document.getElementById('main-scroll').scrollTo({top: 0, behavior: 'smooth'});
            showToast('Halaman baru ditambahkan. Klik tombol Simpan di kiri bawah!');
        }

        function deleteCurrentPage() {
            if (!currentFolderId) {
                showToast('Belum ada folder yang dipilih!', true);
                toggleFab(null, false);
                return;
            }
            if(!currentFolderData.pages || currentFolderData.pages.length <= 1) {
                alert('Folder minimal harus memiliki 1 halaman!');
                toggleFab(null, false);
                return;
            }
            if(!confirm('Yakin ingin menghapus halaman ini?')) return;
            
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
                language: type === 'code' ? 'html' : undefined 
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
            showToast('Menyimpan perubahan...');
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
            navigator.clipboard.writeText(btn.nextElementSibling.innerText);
            btn.innerText = 'Tersalin!'; btn.classList.add('text-emerald-400');
            setTimeout(() => { btn.innerText = 'Salin'; btn.classList.remove('text-emerald-400'); }, 2000);
        }

        function escapeHtml(t) { return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

        // ================= HANDLER DEEP SEARCH REALTIME =================
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
                            div.className = 'flex items-center justify-between p-3 hover:bg-slate-800/80 rounded-xl cursor-pointer transition group gap-3';
                            
                            // Badge & Icon Spesifik per Tipe (Folder, Halaman, Sub-Heading)
                            let badgeHtml = '';
                            let iconSvg = '';

                            if (item.type === 'folder') {
                                badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">Folder</span>';
                                iconSvg = '<svg class="w-4 h-4 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>';
                            } else if (item.type === 'page') {
                                badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">Halaman</span>';
                                iconSvg = '<svg class="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>';
                            } else if (item.type === 'heading') {
                                badgeHtml = '<span class="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase bg-purple-500/10 text-purple-400 border border-purple-500/20 shrink-0">Sub Heading</span>';
                                iconSvg = '<svg class="w-4 h-4 text-purple-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"></path></svg>';
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

        // Event listener: Tutup FAB dan Search hanya jika klik benar-benar di luar
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
    app.listen(PORT, () => console.log(`🚀 Server lokal jalan di http://localhost:${PORT}`));
}
module.exports = app;