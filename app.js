console.log('[boot] module script started');
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut, signInAnonymously, browserSessionPersistence, browserLocalPersistence, inMemoryPersistence, setPersistence } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, onSnapshot, query, where, serverTimestamp, waitForPendingWrites } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
console.log('[boot] firebase modules imported');

const firebaseConfig = {
  apiKey: "AIzaSyDVJPG00SlAS9Vku4MuJYHq2reB2ENRClE",
  authDomain: "thecompass-28808.firebaseapp.com",
  projectId: "thecompass-28808",
  storageBucket: "thecompass-28808.firebasestorage.app",
  messagingSenderId: "130679459961",
  appId: "1:130679459961:web:6a2f0fd8e6f4254864c4a8"
};


const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// DEBUG: expose internals to window for console testing
window.__debug = { auth, db, getDoc, doc, setDoc, signInAnonymously: null, getAuth, getFirestore, fbApp };
import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js').then(m => {
  window.__debug.signInAnonymously = m.signInAnonymously;
  console.log('[debug] window.__debug ready', window.__debug);
});

// ── State ──
let currentUser = null;
let articles = [];
let folders = [];
let currentFolderId = null; // null = root view (all)
let currentFolderPath = []; // breadcrumb [{id, name}]
let activeTag = '__all__';
let currentArticleId = null;
let mdMode = false;
let newMdMode = false;
let highlightMode = false;
let highlightState = 'off'; // 'off' | 'selecting' | 'confirming'
let pendingHighlightText = '';
let searchOpen = false;
let saveTimeout = null;
let selectionRange = null;
let passcodeTargetUid = null; // uid to load data for when using passcode login
let batchMode = false;
let folderMoveMode = false;
let batchSelected = new Set();

// ── Auth ──
window.signInWithGoogle = async () => {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch(e) {
    // popup blocked (incognito, browser setting) → fallback to redirect
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/cancelled-popup-request' || e.code === 'auth/popup-closed-by-user') {
      try { await signInWithRedirect(auth, provider); }
      catch(e2) { showToast('登入失敗：' + e2.message); }
    } else {
      showToast('登入失敗：' + e.message);
    }
  }
};

// Handle redirect result (after Google login redirect back)
getRedirectResult(auth).catch(e => {
  if (e && e.code !== 'auth/no-current-user') showToast('登入失敗：' + e.message);
});

onAuthStateChanged(auth, user => {
  if (user) {
    // Anonymous sign-in triggered by checkPasscode (page reload with saved session)
    if (user.isAnonymous && passcodeTargetUid) {
      const ownerUid = passcodeTargetUid;
      const anonUid = user.uid;
      const savedCode = localStorage.getItem('passcode_code');
      currentUser = { uid: ownerUid, _anonUid: anonUid, displayName: '匿名', photoURL: null, isAnonymous: true };
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app').classList.add('visible');
      document.getElementById('user-avatar-wrap').innerHTML = '<div class="user-initials" title="匿名模式">匿</div>';
      // Re-write delegate on reload (in case it was lost). Rules allow create only,
      // so if it already exists this will fail silently — that is fine.
      if (savedCode) {
        setDoc(doc(db, 'delegates', anonUid), { ownerUid, usedPasscode: savedCode }).catch(() => {});
      }
      passcodeTargetUid = null;
      subscribeData();
    } else if (!user.isAnonymous) {
      currentUser = user;
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app').classList.add('visible');
      renderUserAvatar();
      subscribeData();
    } else if (!currentUser) {
      // Stale anonymous session — but only sign out if loginWithPasscode is NOT in progress
      // (loginWithPasscode sets currentUser in Step 6, so during Steps 2-5 currentUser is still null)
      if (!window._passcodeLoginInProgress) {
        import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js').then(({signOut: so}) => so(auth));
      }
    }
  } else {
    currentUser = null;
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app').classList.remove('visible');
  }
});

function renderUserAvatar() {
  const wrap = document.getElementById('user-avatar-wrap');
  if (currentUser.photoURL) {
    wrap.innerHTML = `<img class="user-avatar" src="${currentUser.photoURL}" title="${currentUser.displayName}\n點擊登出" onclick="doSignOut()">`;
  } else {
    const initials = (currentUser.displayName || 'U').split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase();
    wrap.innerHTML = `<div class="user-initials" title="${currentUser.displayName}\n點擊登出" onclick="doSignOut()">${initials}</div>`;
  }
}

window.doSignOut = () => {
  if(confirm('確定要登出嗎？')) {
    localStorage.removeItem('passcode_uid');
    localStorage.removeItem('passcode_expires');
    localStorage.removeItem('passcode_code');
    signOut(auth);
  }
};

// ── Firestore Subscribe ──
// For anonymous (passcode) users, Firebase Security Rules reject collection-level
// queries where request.auth.uid != the uid field (even with a delegate mapping),
// because dynamic get() calls cannot be evaluated at query time.
// Fix: anonymous sessions subscribe using the real Firebase auth uid (anonUid),
// but we store ownerUid separately so we can query by it.
// The query uses ownerUid (= Google user's uid), and rules allow it via delegate.
// We achieve this by using a two-field approach:
//   - articles/folders have uid = ownerUid (unchanged)
//   - anonymous session stores anonUid in currentUser._anonUid
// For onSnapshot queries: if anonymous, use getDocs + manual polling (since
// Firebase rules block list queries for delegates at the collection level).
// Alternatively, we add the anonUid to a "readers" list on each doc — but that
// requires schema changes. The cleanest no-schema-change fix is to subscribe
// using the anonUid's auth token but query using ownerUid, which requires a
// special Firestore rule for list operations.
//
// ACTUAL FIX APPLIED: For anonymous users, we use onSnapshot but subscribe
// as if we are the owner — this works IF the Firestore rules allow list queries
// for delegates. Since standard Firebase rules don't support dynamic get() in
// list queries, we instead subscribe with the auth.currentUser.uid (anonUid)
// but query on the ownerUid field. To make this work, the rules must allow:
//   allow list: if request.auth != null && (
//     request.auth.uid == request.query.filters.uid ||
//     // delegate check is not possible in list rules without custom claims
//   );
//
// BEST COMPATIBLE FIX: store ownerUid as a custom claim OR use the anonUid
// as the query uid by also writing articles under anonUid. Since we cannot
// change the schema, we use getDocs (one-time) + re-fetch on focus for anon.
//
// IMPLEMENTED: For anon users we use getDocs (no realtime) to avoid the rules
// list-query limitation, and re-fetch when the window gains focus.

let _unsubArticles = null;
let _unsubFolders = null;

function subscribeData() {
  // Unsubscribe any existing listeners first (prevents duplicate subscriptions)
  if (_unsubArticles) { _unsubArticles(); _unsubArticles = null; }
  if (_unsubFolders) { _unsubFolders = null; }

  const ownerUid = currentUser.uid; // The uid that owns the data (Google uid)
  const anonUid = currentUser._anonUid || null; // Firebase auth uid for anon sessions
  const isAnon = currentUser.isAnonymous && !!anonUid;

  console.log('[subscribeData] ownerUid=', ownerUid, 'anonUid=', anonUid, 'isAnon=', isAnon);

  if (isAnon) {
    // Anonymous users: Firebase rules block list queries for delegates because
    // dynamic get() is not evaluated at query time. Use getDocs (one-time fetch)
    // which goes through the per-document read rule (delegate check works there).
    window._fetchAnonData = async function fetchAnonData(retryCount = 0) {
      try {
        const [artSnap, folSnap] = await Promise.all([
          getDocs(query(collection(db, 'articles'), where('uid','==',ownerUid))),
          getDocs(query(collection(db, 'folders'), where('uid','==',ownerUid)))
        ]);
        articles = artSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        articles.sort((a,b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0);
        });
        folders = folSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderTagBar();
        renderArticleList();
        renderFolderTree();
        renderFolderSelects();
        console.log('[subscribeData/anon] fetched articles=', articles.length, 'folders=', folders.length);
      } catch(err) {
        console.error('[subscribeData/anon] fetch error:', err);
        if (err.code === 'permission-denied' && retryCount < 6) {
          // delegate doc 可能還沒在 Firestore 生效，等待後重試
          const delay = (retryCount + 1) * 800;
          console.log('[subscribeData/anon] retrying in', delay, 'ms... attempt', retryCount + 1);
          setTimeout(() => window._fetchAnonData(retryCount + 1), delay);
        } else {
          showToast('讀取失敗：' + (err.code || err.message));
        }
      }
    }
    window._fetchAnonData();
    // Re-fetch on focus so data stays reasonably fresh
    const onFocus = () => window._fetchAnonData();
    window.addEventListener('focus', onFocus);
    // Store unsub as focus listener removal
    _unsubArticles = () => window.removeEventListener('focus', onFocus);
  } else {
    // Google users: use realtime onSnapshot (rules allow since auth.uid == data.uid)
    _unsubArticles = onSnapshot(query(collection(db, 'articles'), where('uid','==',ownerUid)), snap => {
      console.log('[subscribeData] articles snapshot, count=', snap.docs.length);
      articles = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      articles.sort((a,b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0);
      });
      renderTagBar();
      renderArticleList();
    }, err => {
      console.error('[subscribeData] articles error:', err);
      showToast('讀取文章失敗：' + err.code);
    });
    _unsubFolders = onSnapshot(query(collection(db, 'folders'), where('uid','==',ownerUid)), snap => {
      console.log('[subscribeData] folders snapshot, count=', snap.docs.length);
      folders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderFolderTree();
      renderFolderSelects();
    }, err => {
      console.error('[subscribeData] folders error:', err);
      showToast('讀取資料夾失敗：' + err.code);
    });
  }
}

// ── Tag bar ──
function renderTagBar() {
  const allTags = new Set();
  articles.forEach(a => (a.tags||[]).forEach(t => allTags.add(t)));
  const bar = document.getElementById('tag-bar');
  const prev = activeTag;
  bar.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.className = 'tag-pill' + (prev==='__all__' ? ' active':'');
  allBtn.dataset.tag = '__all__';
  allBtn.textContent = '全部';
  allBtn.onclick = () => filterTag(allBtn);
  bar.appendChild(allBtn);
  [...allTags].sort().forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'tag-pill' + (prev===tag ? ' active':'');
    btn.dataset.tag = tag;
    btn.textContent = tag;
    btn.onclick = () => filterTag(btn);
    btn.addEventListener('contextmenu', e => openCtxMenu(e, 'tag', tag, tag));
    bar.appendChild(btn);
  });
  // Show TAG button active if non-all tag selected
  const tagToggleBtn = document.getElementById('tag-toggle-btn');
  if (tagToggleBtn) tagToggleBtn.classList.toggle('active', prev !== '__all__' || bar.classList.contains('open'));
}

// toggleTagBar is defined below (mobile-aware version)

window.filterTag = (el) => {
  document.querySelectorAll('.tag-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  activeTag = el.dataset.tag;
  renderArticleList();
};

// ── Folder panel ──
window.toggleFolderPanel = () => {
  const panel = document.getElementById('folder-panel');
  const btn = document.getElementById('folder-toggle-btn');
  panel.classList.toggle('hidden');
  btn.classList.toggle('active');
};

function renderFolderTree() {
  const tree = document.getElementById('folder-tree');
  tree.innerHTML = '';

  // All articles item
  const allItem = document.createElement('div');
  allItem.className = 'folder-item' + (!currentFolderId ? ' active' : '');
  allItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> 全部文章 <span class="count">${articles.length}</span>`;
  allItem.onclick = () => { currentFolderId = null; currentFolderPath = []; renderFolderTree(); renderArticleList(); };
  // drag over to remove folder assignment
  allItem.addEventListener('dragover', e => { e.preventDefault(); allItem.classList.add('drag-over'); });
  allItem.addEventListener('dragleave', () => allItem.classList.remove('drag-over'));
  allItem.addEventListener('drop', async e => {
    e.preventDefault(); allItem.classList.remove('drag-over');
    const artId = e.dataTransfer.getData('articleId');
    if (artId) { await updateDoc(doc(db, 'articles', artId), { folderId: null }); showToast('已移出資料夾'); }
  });
  tree.appendChild(allItem);

  // 未分類 (filter only – not a folder, no nesting)
  const uncatCount = articles.filter(a => !a.folderId).length;
  const uncatItem = document.createElement('div');
  uncatItem.className = 'folder-item' + (currentFolderId === '__uncat__' ? ' active' : '');
  uncatItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg> 未分類 <span class="count">${uncatCount}</span>`;
  uncatItem.onclick = () => {
    // Toggle: clicking again goes back to all
    if (currentFolderId === '__uncat__') {
      currentFolderId = null; currentFolderPath = [];
    } else {
      currentFolderId = '__uncat__'; currentFolderPath = [];
    }
    renderFolderTree(); renderArticleList();
  };
  // Allow dragging articles here to remove folder assignment
  uncatItem.addEventListener('dragover', e => { e.preventDefault(); uncatItem.classList.add('drag-over'); });
  uncatItem.addEventListener('dragleave', () => uncatItem.classList.remove('drag-over'));
  uncatItem.addEventListener('drop', async e => {
    e.preventDefault(); uncatItem.classList.remove('drag-over');
    const artId = e.dataTransfer.getData('articleId');
    if (artId) { await updateDoc(doc(db, 'articles', artId), { folderId: null }); showToast('已移至未分類'); }
  });
  tree.appendChild(uncatItem);

  // Back button if inside folder
  if (currentFolderPath.length > 0) {
    const backItem = document.createElement('div');
    backItem.className = 'folder-item folder-back';
    const parentId = currentFolderPath.length > 1 ? currentFolderPath[currentFolderPath.length-2].id : null;
    backItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg> 上一層`;
    backItem.onclick = () => {
      if (folderMoveMode) return;
      currentFolderPath.pop();
      currentFolderId = parentId;
      renderFolderTree();
      renderArticleList();
    };
    // In move mode, dropping a folder here moves it up one level (out of current folder)
    if (folderMoveMode) {
      backItem.addEventListener('dragover', e => {
        if (!e.dataTransfer.types.includes('folderid')) return;
        e.preventDefault();
        backItem.classList.add('folder-move-target');
      });
      backItem.addEventListener('dragleave', () => backItem.classList.remove('folder-move-target'));
      backItem.addEventListener('drop', async e => {
        e.preventDefault();
        backItem.classList.remove('folder-move-target');
        const srcFolderId = e.dataTransfer.getData('folderId');
        if (!srcFolderId) return;
        const srcFolder = folders.find(f => f.id === srcFolderId);
        if (!srcFolder) return;
        const newParentId = parentId; // grandparent of current folder
        await updateDoc(doc(db, 'folders', srcFolderId), { parentId: newParentId || null });
        srcFolder.parentId = newParentId || null;
        renderFolderTree();
        showToast(`「${srcFolder.name}」已移至上一層`);
      });
    }
    tree.appendChild(backItem);
  }

  // Current path breadcrumb
  if (currentFolderPath.length > 0) {
    const crumb = document.createElement('div');
    crumb.style.cssText = 'padding:4px 8px 2px;font-size:11px;color:var(--text3);';
    crumb.textContent = currentFolderPath.map(p=>p.name).join(' › ');
    tree.appendChild(crumb);
  }

  tree.classList.toggle('move-mode', folderMoveMode);

  // Show children of current folder
  const parentId = (currentFolderId === '__uncat__' || currentFolderId === null) ? null : currentFolderId;
  const children = folders
    .filter(f => (f.parentId||null) === parentId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  children.forEach((folder, idx) => {
    const count = articles.filter(a => a.folderId === folder.id).length;
    const isEmpty = count === 0;
    const item = document.createElement('div');
    item.className = 'folder-item' + (currentFolderId===folder.id ? ' active':'') + (isEmpty ? ' folder-empty' : '');
    item.draggable = true;
    item.dataset.folderId = folder.id;
    item.dataset.folderIdx = idx;
    item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7c0-1.1.9-2 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg> ${escHtml(folder.name)}${isEmpty ? '' : ` <span class="count">${count}</span>`}`;
    item.onclick = (e) => {
      if (item.classList.contains('folder-dragging') || folderMoveMode) return;
      currentFolderId = folder.id;
      currentFolderPath = [...currentFolderPath, {id: folder.id, name: folder.name}];
      renderFolderTree();
      renderArticleList();
    };
    item.addEventListener('contextmenu', e => openCtxMenu(e, 'folder', folder.id, folder.name));

    if (folderMoveMode) {
      // ── Move mode: dragging a folder onto another folder nests it inside ──
      item.addEventListener('dragover', e => {
        if (!e.dataTransfer.types.includes('folderid')) return;
        e.preventDefault();
        item.classList.add('folder-move-target');
      });
      item.addEventListener('dragleave', () => item.classList.remove('folder-move-target'));
      item.addEventListener('drop', async e => {
        e.preventDefault();
        item.classList.remove('folder-move-target');
        const srcFolderId = e.dataTransfer.getData('folderId');
        if (!srcFolderId || srcFolderId === folder.id) return;
        const srcFolder = folders.find(f => f.id === srcFolderId);
        if (!srcFolder) return;
        // prevent moving a folder into its own descendant
        let p = folder.id;
        const visited = new Set();
        while (p) {
          if (p === srcFolderId) { showToast('不能移到自己的子資料夾中'); return; }
          if (visited.has(p)) break;
          visited.add(p);
          const pf = folders.find(f => f.id === p);
          p = pf ? (pf.parentId || null) : null;
        }
        await updateDoc(doc(db, 'folders', srcFolderId), { parentId: folder.id });
        srcFolder.parentId = folder.id;
        renderFolderTree();
        showToast(`已移入「${folder.name}」`);
      });
      // Article drop still allowed onto folders even in move mode
      item.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('articleid')) { e.preventDefault(); item.classList.add('drag-over'); }
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', async e => {
        const artId = e.dataTransfer.getData('articleId');
        if (!artId) return;
        e.preventDefault();
        item.classList.remove('drag-over');
        await updateDoc(doc(db, 'articles', artId), { folderId: folder.id });
        showToast(`已移到「${folder.name}」`);
        const art = articles.find(a => a.id === artId);
        if (art) art.folderId = folder.id;
        renderFolderTree();
      });
    } else {
      // ── Normal mode: drag article onto folder OR drag folder to reorder (no nesting) ──
      item.addEventListener('dragover', e => {
        e.preventDefault();
        const isDraggingFolder = e.dataTransfer.types.includes('folderid');
        if (!isDraggingFolder) {
          item.classList.add('drag-over');
        } else {
          item.classList.remove('drag-over');
          // Show reorder line based on cursor position relative to target
          const rect = item.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          item.classList.remove('folder-drop-above', 'folder-drop-below');
          if (e.clientY < mid) item.classList.add('folder-drop-above');
          else item.classList.add('folder-drop-below');
        }
      });
      item.addEventListener('dragleave', (e) => {
        item.classList.remove('drag-over', 'folder-drop-above', 'folder-drop-below');
      });
      item.addEventListener('drop', async e => {
        e.preventDefault();
        item.classList.remove('drag-over', 'folder-drop-above', 'folder-drop-below');
        const artId = e.dataTransfer.getData('articleId');
        const srcFolderId = e.dataTransfer.getData('folderId');
        if (artId) {
          await updateDoc(doc(db, 'articles', artId), { folderId: folder.id });
          showToast(`已移到「${folder.name}」`);
          const art = articles.find(a => a.id === artId);
          if (art) art.folderId = folder.id;
          renderFolderTree();
        } else if (srcFolderId && srcFolderId !== folder.id) {
          // Pure reorder among siblings: insert above or below target
          const rect = item.getBoundingClientRect();
          const insertAbove = e.clientY < rect.top + rect.height / 2;
          const srcFolder = folders.find(f => f.id === srcFolderId);
          const targetFolder = folder;
          if (!srcFolder) return;
          // Only reorder if same parent (move mode handles cross-folder moves)
          if ((srcFolder.parentId||null) !== parentId) {
            showToast('請使用移動模式跨資料夾移動');
            return;
          }
          const sibs = folders
            .filter(f => (f.parentId||null) === parentId && f.id !== srcFolderId)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          const targetIdx = sibs.findIndex(f => f.id === targetFolder.id);
          const insertIdx = insertAbove ? targetIdx : targetIdx + 1;
          sibs.splice(insertIdx, 0, srcFolder);
          const updates = sibs.map((f, i) => updateDoc(doc(db, 'folders', f.id), { order: i }));
          await Promise.all(updates);
          sibs.forEach((f, i) => { const lf = folders.find(x => x.id === f.id); if (lf) lf.order = i; });
          renderFolderTree();
          showToast('資料夾已排序');
        }
      });
    }

    // Folder drag-to-reorder/move events (common to both modes)
    item.addEventListener('dragstart', e => {
      // Only initiate folder drag if not dragging an article row
      e.stopPropagation();
      e.dataTransfer.setData('folderId', folder.id);
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('folder-dragging'), 0);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('folder-dragging', 'folder-drop-above', 'folder-drop-below', 'folder-move-target');
      // Clean up all siblings
      tree.querySelectorAll('.folder-item').forEach(el => el.classList.remove('folder-drop-above', 'folder-drop-below', 'folder-move-target', 'drag-over'));
    });
    tree.appendChild(item);
  });
}

window.toggleFolderMoveMode = () => {
  folderMoveMode = !folderMoveMode;
  document.getElementById('folder-move-toggle').classList.toggle('active', folderMoveMode);
  renderFolderTree();
};

function renderFolderSelects() {
  // For new article modal
  const sel = document.getElementById('new-folder');
  if (!sel) return;
  sel.innerHTML = '<option value="">無資料夾</option>';
  folders.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    if (currentFolderId === f.id) opt.selected = true;
    sel.appendChild(opt);
  });
  // For folder parent select
  const psel = document.getElementById('folder-parent-select');
  if (!psel) return;
  psel.innerHTML = '<option value="">根目錄</option>';
  folders.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    psel.appendChild(opt);
  });
}

// ── Article list ──
function getFilteredArticles() {
  let list = articles;
  // folder filter
  if (currentFolderId === '__uncat__') list = list.filter(a => !a.folderId);
  else if (currentFolderId) list = list.filter(a => a.folderId === currentFolderId);
  // tag filter
  if (activeTag !== '__all__') list = list.filter(a => (a.tags||[]).includes(activeTag));
  // search
  const q = document.getElementById('search-input')?.value.trim().toLowerCase();
  if (q) list = list.filter(a => a.title?.toLowerCase().includes(q) || a.body?.toLowerCase().includes(q) || a.author?.toLowerCase().includes(q));
  return list;
}

// ── Pagination state ──
const ARTICLES_PER_PAGE = 20;
let currentPage = 1;
let lastFilterKey = '';
let vsFiltered = [];

function buildArticleRow(art) {
  const row = document.createElement('div');
  row.className = 'article-row';
  row.draggable = true;
  row.dataset.id = art.id;
  const tagsHtml = (art.tags||[]).slice(0,3).map(t=>`<span class="article-tag">${escHtml(t)}</span>`).join('');
  const dateStr = art.createdAt ? formatDate(art.createdAt.seconds*1000) : '';
  // Search highlight in title
  const searchQ = document.getElementById('search-input')?.value.trim() || '';
  const rawTitle = art.title || '未命名';
  let titleHtml;
  if (searchQ) {
    const safeQ = searchQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    titleHtml = escHtml(rawTitle).replace(new RegExp(safeQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${escHtml(m)}</mark>`);
    // Re-do: escape then highlight
    const parts = rawTitle.split(new RegExp(`(${safeQ})`, 'gi'));
    titleHtml = parts.map(p => p.toLowerCase() === searchQ.toLowerCase() ? `<mark>${escHtml(p)}</mark>` : escHtml(p)).join('');
  } else {
    titleHtml = escHtml(rawTitle);
  }
  // Dot: pinned=red circle > favorite=❤️ > done=dash > pending=grey circle
  let dotHtml;
  if (art.pinned) {
    dotHtml = '<span class="article-row-dot" style="width:9px;height:9px;border-radius:50%;background:var(--danger);flex-shrink:0;display:inline-block;transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1),background 0.15s" title="置頂"></span>';
  } else if (art.favorite) {
    dotHtml = '<span class="article-row-dot" style="font-size:11px;flex-shrink:0;line-height:1;transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1)" title="收藏">❤️</span>';
  } else if (art.readStatus === 'done') {
    dotHtml = '<span class="article-row-dot" style="font-size:12px;flex-shrink:0;color:var(--text3);font-weight:600;line-height:1;transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1)" title="已閱">—</span>';
  } else {
    dotHtml = '<span class="article-row-dot" style="width:7px;height:7px;border-radius:50%;background:var(--border2);flex-shrink:0;display:inline-block;transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1),background 0.15s" title="待閱"></span>';
  }
  // Body snippet when searching
  let snippetHtml = '';
  if (searchQ && art.body) {
    const bodyLower = art.body.toLowerCase();
    const idx = bodyLower.indexOf(searchQ.toLowerCase());
    if (idx !== -1) {
      const start = Math.max(0, idx - 20);
      const end = Math.min(art.body.length, idx + searchQ.length + 50);
      const raw = (start > 0 ? '…' : '') + art.body.slice(start, end) + (end < art.body.length ? '…' : '');
      const safeQ2 = searchQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const parts2 = raw.split(new RegExp(`(${safeQ2})`, 'gi'));
      const snippetInner = parts2.map(p => p.toLowerCase() === searchQ.toLowerCase() ? `<mark>${escHtml(p)}</mark>` : escHtml(p)).join('');
      snippetHtml = `<span class="article-snippet">${snippetInner}</span>`;
    }
  }
  const authorHtml = art.author ? `<span class="article-author" title="${escHtml(art.author)}">${escHtml(art.author)}</span>` : '';
  row.innerHTML = `<input type="checkbox" class="batch-check" ${batchSelected.has(art.id)?'checked':''} onclick="event.stopPropagation();toggleBatchSelect('${art.id}',this)"><span class="ripple-dot2"></span>${dotHtml}<span class="article-title">${titleHtml}</span>${authorHtml}<div class="article-tags">${tagsHtml}</div><span class="article-date">${dateStr}</span>${snippetHtml}`;
  if (art.pinned) row.classList.add('pinned');
  if (batchSelected.has(art.id)) row.classList.add('batch-sel');
  row.onclick = batchMode ? () => {
    const cb = row.querySelector('.batch-check');
    cb.checked = !cb.checked;
    toggleBatchSelect(art.id, cb);
  } : () => openReading(art.id);
  row.addEventListener('dragstart', e => {
    e.dataTransfer.setData('articleId', art.id);
    row.classList.add('drag-dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('drag-dragging'));
  // Hover highlight tooltip (desktop only)
  if (art.highlight && !isMobile()) {
    row.addEventListener('mouseenter', e => showHighlightTooltip(e, art.highlight));
    row.addEventListener('mousemove', e => moveHighlightTooltip(e));
    row.addEventListener('mouseleave', hideHighlightTooltip);
  }
  return row;
}

function renderArticleList() {
  const rowsEl = document.getElementById('article-rows');
  const pagerEl = document.getElementById('pagination-bar');
  vsFiltered = getFilteredArticles();

  if (vsFiltered.length === 0) {
    rowsEl.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><p>還沒有文章</p><button class="empty-cta" onclick="openNewModal()">+ 新增第一篇</button></div>`;
    pagerEl.innerHTML = '';
    return;
  }

  // Reset to page 1 whenever the active filter (folder/tag/search) changes
  const filterKey = `${currentFolderId}|${activeTag}|${document.getElementById('search-input')?.value.trim().toLowerCase() || ''}`;
  if (filterKey !== lastFilterKey) {
    currentPage = 1;
    lastFilterKey = filterKey;
  }

  const totalPages = Math.max(1, Math.ceil(vsFiltered.length / ARTICLES_PER_PAGE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const start = (currentPage - 1) * ARTICLES_PER_PAGE;
  const end = Math.min(vsFiltered.length, start + ARTICLES_PER_PAGE);

  rowsEl.innerHTML = '';
  for (let i = start; i < end; i++) {
    rowsEl.appendChild(buildArticleRow(vsFiltered[i]));
  }
  rowsEl.scrollTop = 0;

  renderPaginationBar(totalPages);
}

function renderPaginationBar(totalPages) {
  const pagerEl = document.getElementById('pagination-bar');
  if (totalPages <= 1) { pagerEl.innerHTML = ''; return; }

  const makeBtn = (label, page, opts = {}) => {
    const { active = false, disabled = false, ellipsis = false } = opts;
    const cls = 'page-btn' + (active ? ' active' : '') + (ellipsis ? ' ellipsis' : '');
    const dis = disabled ? 'disabled' : '';
    const onclick = ellipsis || disabled ? '' : `onclick="goToPage(${page})"`;
    return `<button class="${cls}" ${dis} ${onclick}>${label}</button>`;
  };

  let html = '';
  html += makeBtn('‹', currentPage - 1, { disabled: currentPage === 1 });

  // Build page number list with ellipses
  const pages = [];
  const windowSize = 1; // pages shown around current
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= windowSize) {
      pages.push(p);
    } else if (pages[pages.length - 1] !== '…') {
      pages.push('…');
    }
  }
  pages.forEach(p => {
    if (p === '…') html += makeBtn('…', 0, { ellipsis: true });
    else html += makeBtn(String(p), p, { active: p === currentPage });
  });

  html += makeBtn('›', currentPage + 1, { disabled: currentPage === totalPages });
  html += `<span class="page-info">共 ${vsFiltered.length} 篇</span>`;

  pagerEl.innerHTML = html;
}

window.goToPage = (page) => {
  const totalPages = Math.max(1, Math.ceil(vsFiltered.length / ARTICLES_PER_PAGE));
  if (page < 1 || page > totalPages || page === currentPage) return;
  currentPage = page;
  renderArticleList();
};

window.filterArticles = () => renderArticleList();

// ── Batch mode ──
window.toggleBatchMode = () => {
  batchMode = !batchMode;
  batchSelected.clear();
  document.body.classList.toggle('batch-active', batchMode);
  document.getElementById('batch-bar').classList.toggle('visible', batchMode);
  document.getElementById('topbar-actions').style.display = batchMode ? 'none' : '';
  renderArticleList();
};

window.toggleBatchSelect = (id, cb) => {
  if (cb.checked) batchSelected.add(id);
  else batchSelected.delete(id);
  const row = document.querySelector(`.article-row[data-id="${id}"]`);
  if (row) row.classList.toggle('batch-sel', cb.checked);
  document.getElementById('batch-count').textContent = `已選 ${batchSelected.size} 篇`;
};

window.batchMarkDone = async () => {
  if (!batchSelected.size) { showToast('請先選取文章'); return; }
  const ids = [...batchSelected];
  await Promise.all(ids.map(id => updateDoc(doc(db, 'articles', id), { readStatus: 'done' })));
  showToast(`${ids.length} 篇已標為已讀`);
  toggleBatchMode();
};

window.batchDelete = async () => {
  if (!batchSelected.size) { showToast('請先選取文章'); return; }
  if (!confirm(`確定刪除選取的 ${batchSelected.size} 篇文章？`)) return;
  const ids = [...batchSelected];
  await Promise.all(ids.map(id => deleteDoc(doc(db, 'articles', id))));
  showToast(`已刪除 ${ids.length} 篇`);
  toggleBatchMode();
};

window.batchAddTag = async () => {
  if (!batchSelected.size) { showToast('請先選取文章'); return; }
  const tag = prompt('輸入要加入的標籤：');
  if (!tag?.trim()) return;
  const t = tag.trim();
  const ids = [...batchSelected];
  await Promise.all(ids.map(id => {
    const art = articles.find(a => a.id === id);
    const tags = [...new Set([...(art?.tags||[]), t])];
    return updateDoc(doc(db, 'articles', id), { tags });
  }));
  showToast(`已替 ${ids.length} 篇加上「${t}」`);
  toggleBatchMode();
};

window.batchMoveFolder = async () => {
  if (!batchSelected.size) { showToast('請先選取文章'); return; }
  if (!folders.length) { showToast('尚無資料夾'); return; }
  const opts = folders.map((f,i) => `${i+1}. ${f.name}`).join('\n');
  const choice = prompt(`選擇資料夾（輸入數字）：\n${opts}`);
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= folders.length) return;
  const folderId = folders[idx].id;
  const ids = [...batchSelected];
  await Promise.all(ids.map(id => updateDoc(doc(db, 'articles', id), { folderId })));
  showToast(`已移動 ${ids.length} 篇到「${folders[idx].name}」`);
  toggleBatchMode();
};

window.updateSearchClear = () => {
  const val = document.getElementById('search-input')?.value || '';
  const btn = document.getElementById('search-clear');
  if (btn) btn.classList.toggle('visible', val.length > 0);
};

window.clearSearch = () => {
  const input = document.getElementById('search-input');
  if (input) { input.value = ''; input.focus(); }
  updateSearchClear();
  renderArticleList();
};

// ── Highlight tooltip ──
function showHighlightTooltip(e, text) {
  const tip = document.getElementById('highlight-tooltip');
  const snippet = text.length > 80 ? text.slice(0, 80) + '…' : text;
  tip.innerHTML = `<span style="color:var(--accent2)">🪄</span> "${escHtml(snippet)}"`;
  tip.style.display = 'block';
  moveHighlightTooltip(e);
}
function moveHighlightTooltip(e) {
  const tip = document.getElementById('highlight-tooltip');
  const tipW = tip.offsetWidth;
  const margin = 12;
  let x = e.clientX + 14;
  let y = e.clientY - 10;
  if (x + tipW + margin > window.innerWidth) x = e.clientX - tipW - 10;
  tip.style.left = Math.max(margin, x) + 'px';
  tip.style.top = y + 'px';
}
function hideHighlightTooltip() {
  document.getElementById('highlight-tooltip').style.display = 'none';
}

// ── Reading modal ──
let notesVisible = true;
let titleBarVisible = true;
let ttsUtterance = null;
let ttsPlaying = false;
let toolbarCollapseTimer = null;
let isMobile = () => window.innerWidth <= 768;

window.openReading = (id) => {
  const art = articles.find(a => a.id === id);
  if (!art) return;
  currentArticleId = id;
  // Push history state so mobile back button returns to article list
  if (isMobile()) history.pushState({ reading: id }, '');
  mdMode = false;
  resetReadingFontSizeToDefault();
  highlightMode = false;
  highlightState = 'off';
  pendingHighlightText = '';
  titleBarVisible = true;
  // Show notes pane only if article has notes content; otherwise hide by default
  notesVisible = !isMobile() && !!(articles.find(a => a.id === id)?.notes?.trim());
  const banner = document.getElementById('highlight-mode-banner');
  if (banner) banner.style.display = 'none';
  hideHighlightConfirmBar();
  const hlBtn = document.getElementById('tb-highlight-btn');
  if (hlBtn) hlBtn.classList.remove('active');
  document.getElementById('reading-modal').classList.add('open');
  document.getElementById('tb-md-btn').classList.remove('active');
  document.getElementById('tb-notes-btn').classList.toggle('active', notesVisible);
  document.getElementById('reading-title-bar').classList.remove('collapsed');
  const notesPane = document.getElementById('reading-notes-pane');
  notesPane.classList.toggle('hidden', !notesVisible);
  document.getElementById('reading-body-pane').classList.toggle('full', !notesVisible);
  document.getElementById('tb-collapse-btn').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="18 15 12 9 6 15"/></svg>`;
  renderReadingPage(art);
  stopTTS();
  // Reading progress bar
  const bodyPane = document.getElementById('reading-body-pane');
  const progressBar = document.getElementById('reading-progress-bar');
  if (progressBar) progressBar.style.width = '0%';
  if (bodyPane) {
    bodyPane._progressHandler && bodyPane.removeEventListener('scroll', bodyPane._progressHandler);
    bodyPane._progressHandler = () => {
      const scrolled = bodyPane.scrollTop;
      const total = bodyPane.scrollHeight - bodyPane.clientHeight;
      const pct = total > 0 ? Math.min(100, Math.round(scrolled / total * 100)) : 0;
      if (progressBar) progressBar.style.width = pct + '%';
    };
    bodyPane.addEventListener('scroll', bodyPane._progressHandler);
  }
  // mobile toolbar auto-hide
  setupMobileToolbar();
};

window.closeReading = (fromPopstate) => {
  // Clean up highlight mode if active
  if (highlightState !== 'off') {
    highlightState = 'off';
    pendingHighlightText = '';
    const btn = document.getElementById('tb-highlight-btn');
    if (btn) btn.classList.remove('active');
    const banner = document.getElementById('highlight-mode-banner');
    if (banner) banner.style.display = 'none';
    hideHighlightConfirmBar();
  }
  // Reset mobile title bar margin
  const titleBar = document.getElementById('reading-title-bar');
  if (titleBar) titleBar.style.marginTop = '';
  clearTimeout(toolbarCollapseTimer);
  const modal = document.getElementById('reading-modal');
  modal.scrollTop = 0;
  modal.classList.remove('open');
  document.getElementById('highlight-menu').style.display = 'none';
  closeTbDropdowns();
  stopTTS();
  currentArticleId = null;
  // On mobile, if we pushed a history state and this wasn't triggered by popstate, go back so
  // the browser history stays clean (otherwise pressing back again would do nothing useful)
  if (isMobile() && !fromPopstate && history.state && history.state.reading) {
    history.back();
  }
};


// ── Mobile back button → close reading modal ──
window.addEventListener('popstate', (e) => {
  const modal = document.getElementById('reading-modal');
  if (modal && modal.classList.contains('open')) {
    closeReading(true); // true = triggered by popstate, don't call history.back() again
  }
});

function renderReadingPage(art) {
  // Title
  const titleEl = document.getElementById('reading-title-input');
  titleEl.value = art.title || '';
  autoResizeTitle(titleEl);
  // Author
  const authorEl = document.getElementById('reading-author-input');
  if (authorEl) authorEl.value = art.author || '';
  // Meta tags row
  const metaRow = document.getElementById('reading-meta-row');
  metaRow.innerHTML = (art.tags||[]).map(t =>
    `<span class="reading-meta-tag" onclick="removeTagFromArticle('${escHtml(t)}')">${escHtml(t)} ×</span>`
  ).join('');
  // Body
  renderBodyPane(art);
  // Notes
  const notesTA = document.getElementById('reading-notes-textarea');
  notesTA.value = art.notes || '';
  const tsEl = document.getElementById('notes-timestamp');
  if (tsEl && art.notesUpdatedAt) {
    const diff = Date.now() - art.notesUpdatedAt;
    if (diff < 60000) tsEl.textContent = '剛剛編輯';
    else if (diff < 3600000) tsEl.textContent = Math.floor(diff/60000) + ' 分鐘前';
    else if (diff < 86400000) tsEl.textContent = Math.floor(diff/3600000) + ' 小時前';
    else tsEl.textContent = new Date(art.notesUpdatedAt).toLocaleDateString('zh-TW');
  } else if (tsEl) { tsEl.textContent = ''; }
  // Toolbar state
  updateToolbarState(art);
  // Tag & folder dropdowns
  renderTagDropdown(art);
  renderFolderDropdown(art);
}

function renderMarkdown(text) {
  if (!text) return '';
  let md = text;
  // escape HTML first, but we'll re-insert our marks
  // Process line by line
  const lines = text.split('\n');
  let result = '';
  let inPre = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith('\x60\x60\x60')) { inPre = !inPre; result += inPre ? '<pre><code>' : '</code></pre>\n'; continue; }
    if (inPre) { result += escHtml(line) + '\n'; continue; }
    // table: header row followed by separator row (---|---)
    if (/^\s*\|?.+\|.+\|?\s*$/.test(line) && i+1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i+1])) {
      const splitRow = (row) => {
        let r = row.trim();
        if (r.startsWith('|')) r = r.slice(1);
        if (r.endsWith('|')) r = r.slice(0, -1);
        return r.split('|').map(c => c.trim());
      };
      const headerCells = splitRow(line);
      const aligns = splitRow(lines[i+1]).map(c => {
        const left = c.startsWith(':'), right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      });
      let tbl = '<table class="md-table"><thead><tr>';
      headerCells.forEach((c, idx) => {
        const style = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '';
        tbl += `<th${style}>${inlineMarkdown(c)}</th>`;
      });
      tbl += '</tr></thead><tbody>';
      let j = i + 2;
      while (j < lines.length && /\|/.test(lines[j]) && lines[j].trim() !== '') {
        const cells = splitRow(lines[j]);
        tbl += '<tr>';
        cells.forEach((c, idx) => {
          const style = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '';
          tbl += `<td${style}>${inlineMarkdown(c)}</td>`;
        });
        tbl += '</tr>';
        j++;
      }
      tbl += '</tbody></table>\n';
      result += tbl;
      i = j - 1;
      continue;
    }
    // headings
    if (/^### /.test(line)) { result += '<h3>' + inlineMarkdown(line.slice(4)) + '</h3>\n'; continue; }
    if (/^## /.test(line)) { result += '<h2>' + inlineMarkdown(line.slice(3)) + '</h2>\n'; continue; }
    if (/^# /.test(line)) { result += '<h1>' + inlineMarkdown(line.slice(2)) + '</h1>\n'; continue; }
    // hr
    if (/^---+$/.test(line.trim())) { result += '<hr>\n'; continue; }
    // blockquote
    if (/^> /.test(line)) { result += '<blockquote>' + inlineMarkdown(line.slice(2)) + '</blockquote>\n'; continue; }
    // ul
    if (/^[*-] /.test(line)) { result += '<ul><li>' + inlineMarkdown(line.slice(2)) + '</li></ul>\n'; continue; }
    // ol
    if (/^\d+\. /.test(line)) { result += '<ol><li>' + inlineMarkdown(line.replace(/^\d+\. /, '')) + '</li></ol>\n'; continue; }
    // blank line = paragraph break
    if (line.trim() === '') { result += '<br>\n'; continue; }
    result += '<p>' + inlineMarkdown(line) + '</p>\n';
  }
  // merge consecutive ul/ol
  result = result.replace(/<\/ul>\n<ul>/g, '').replace(/<\/ol>\n<ol>/g, '');
  return result;
}

function inlineMarkdown(text) {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\x60(.+?)\x60/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>');
}

function renderBodyPane(art) {
  const pane = document.getElementById('reading-body-content');
  if (mdMode) {
    pane.innerHTML = `<textarea class="art-body-editor" id="body-editor" oninput="scheduleFieldSave('body', this.value)">${escHtml(art.body||'')}</textarea>`;
  } else {
    let html = renderMarkdown(art.body||'');
    if (art.highlight) {
      // Escape highlight text for safe regex, then find it in the rendered HTML (which has escaped entities)
      const hEsc = escHtml(art.highlight);
      const safeRe = hEsc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(safeRe, 'g'), `<mark>${hEsc}</mark>`);
    }
    const cls = 'art-body-rendered' + (highlightState !== 'off' ? ' highlight-mode' : '');
    pane.innerHTML = `<div class="${cls}" id="body-rendered" ondblclick="toggleReadingMd()" title="雙擊進入編輯模式">${html}</div>`;
  }
}

function updateToolbarState(art) {
  // read status (2 states)
  const readBtn = document.getElementById('tb-read-btn');
  const isDone = art.readStatus === 'done';
  readBtn.className = 'tb-btn' + (isDone ? ' active' : '');
  readBtn.textContent = isDone ? '☑️' : '🔲';
  // fav
  const favBtn = document.getElementById('tb-fav-btn');
  favBtn.className = 'tb-btn' + (art.favorite ? ' fav-on' : '');
  favBtn.innerHTML = art.favorite
    ? '<svg viewBox="0 0 24 24" fill="#c0392b" stroke="#c0392b" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  // pin btn
  const pinBtn = document.getElementById('tb-pin-btn');
  if (pinBtn) {
    pinBtn.textContent = art.pinned ? '🔺' : '🔻';
    pinBtn.classList.toggle('active', !!art.pinned);
  }
}

window.autoResizeTitle = (el) => {
  el.style.height = 'auto';
  el.style.whiteSpace = 'pre-wrap';
  el.style.height = el.scrollHeight + 'px';
};

// ── Reading font size ──
// `reading_font_size_default` is the persisted setting (Settings > 外觀).
// `readingFontSize` is the active session value; +/- adjustments are temporary
// and reset to the saved default each time an article is opened.
let readingFontSize = parseInt(localStorage.getItem('reading_font_size_default') || '16');
function applyReadingFontSize() {
  document.documentElement.style.setProperty('--reading-font-size', readingFontSize + 'px');
  const lbl = document.getElementById('reading-font-size-label');
  if (lbl) lbl.textContent = readingFontSize;
}
applyReadingFontSize();
window.changeFontSize = (delta) => {
  // Temporary, session-only adjustment — not saved.
  readingFontSize = Math.min(32, Math.max(12, readingFontSize + delta));
  applyReadingFontSize();
};

window.resetReadingFontSizeToDefault = () => {
  readingFontSize = parseInt(localStorage.getItem('reading_font_size_default') || '16');
  applyReadingFontSize();
};

window.applyDefaultFontSize = (size) => {
  const s = Math.min(32, Math.max(12, size));
  localStorage.setItem('reading_font_size_default', s);
  readingFontSize = s;
  applyReadingFontSize();
  showToast('預設字體大小已更新');
};

window.scheduleFieldSave = (field, value) => {
  // Immediately update local state so list reflects changes before cloud sync
  if (currentArticleId) {
    const art = articles.find(a => a.id === currentArticleId);
    if (art) {
      art[field] = value;
      renderArticleList(); // refresh list immediately
    }
  }
  clearTimeout(saveTimeout);
  setSyncStatus('syncing');
  saveTimeout = setTimeout(async () => {
    if (!currentArticleId) return;
    try {
      await updateDoc(doc(db, 'articles', currentArticleId), { [field]: value });
      setSyncStatus('saved');
    } catch(e) { setSyncStatus('error'); }
  }, 800); // faster: 800ms instead of 2500ms for title/author
};

window.scheduleNotesSave = (value) => {
  clearTimeout(saveTimeout);
  setSyncStatus('syncing');
  saveTimeout = setTimeout(async () => {
    if (!currentArticleId) return;
    try {
      await updateDoc(doc(db, 'articles', currentArticleId), { notes: value, notesUpdatedAt: Date.now() });
      setSyncStatus('saved');
      // update timestamp display
      const ts = document.getElementById('notes-timestamp');
      if (ts) ts.textContent = '剛剛編輯';
    } catch(e) { setSyncStatus('error'); }
  }, 2500);
};

function setSyncStatus(status) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  if (status === 'syncing') {
    el.className = 'syncing';
    el.innerHTML = `<div class="looping-rhombuses-spinner"><div class="rhombus"></div><div class="rhombus"></div><div class="rhombus"></div></div>`;
    el.title = '同步中…';
  } else if (status === 'saved') {
    el.className = 'saved';
    el.innerHTML = `<div class="sync-saved-dot"></div>`;
    el.title = '已儲存';
    setTimeout(() => { el.className=''; el.innerHTML=''; }, 2500);
  } else if (status === 'error') {
    el.className = 'error';
    el.innerHTML = `<div class="sync-error-dot"></div>`;
    el.title = '儲存失敗';
  }
}

window.toggleReadingMd = () => {
  const art = articles.find(a => a.id === currentArticleId);
  if (!art) return;
  if (mdMode) {
    const editor = document.getElementById('body-editor');
    if (editor) { scheduleFieldSave('body', editor.value); art.body = editor.value; }
  }
  mdMode = !mdMode;
  document.getElementById('tb-md-btn').classList.toggle('active', mdMode);
  renderBodyPane(art);
};

window.toggleNewMd = () => {
  newMdMode = !newMdMode;
  document.getElementById('new-md-btn').classList.toggle('active', newMdMode);
  const pane = document.getElementById('new-body-pane');
  const textarea = document.getElementById('new-body');
  const viewDiv = document.getElementById('new-body-view');
  if (!newMdMode) {
    // switching to view (rendered) mode
    if (!viewDiv) {
      const div = document.createElement('div');
      div.id = 'new-body-view';
      div.className = 'art-body-viewonly';
      pane.insertBefore(div, textarea);
    }
    const vd = document.getElementById('new-body-view');
    vd.innerHTML = renderMarkdown(textarea.value);
    vd.style.display = 'block';
    textarea.style.display = 'none';
  } else {
    // switching to edit (raw) mode
    const vd = document.getElementById('new-body-view');
    if (vd) vd.style.display = 'none';
    textarea.style.display = '';
    textarea.focus();
  }
};

window.toggleNotesPane = () => {
  notesVisible = !notesVisible;
  const pane = document.getElementById('reading-notes-pane');
  const bodyPane = document.getElementById('reading-body-pane');
  pane.classList.toggle('hidden', !notesVisible);
  bodyPane.classList.toggle('full', !notesVisible);
  document.getElementById('tb-notes-btn').classList.toggle('active', notesVisible);
};

let newNotesVisible = false;
window.toggleNewNotesPane = () => {
  newNotesVisible = !newNotesVisible;
  const pane = document.getElementById('new-notes-pane');
  const bodyPane = document.getElementById('new-body-pane');
  if (pane) pane.classList.toggle('hidden', !newNotesVisible);
  if (bodyPane) bodyPane.classList.toggle('full', !newNotesVisible);
  const btn = document.getElementById('new-notes-btn');
  if (btn) btn.classList.toggle('active', newNotesVisible);
};

window.toggleTitleBar = () => {
  titleBarVisible = !titleBarVisible;
  document.getElementById('reading-title-bar').classList.toggle('collapsed', !titleBarVisible);
  const btn = document.getElementById('tb-collapse-btn');
  btn.innerHTML = titleBarVisible
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="18 15 12 9 6 15"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="6 9 12 15 18 9"/></svg>`;
};

// ── Toolbar dropdowns ──
window.toggleTbDropdown = (id) => {
  const dd = document.getElementById(id);
  const isOpen = dd.classList.contains('open');
  closeTbDropdowns();
  if (!isOpen) {
    dd.classList.add('open');
    // Position dropdown below its trigger button
    const btnId = id === 'folder-dropdown' ? 'tb-folder-btn' : 'tb-tag-btn';
    const btn = document.getElementById(btnId);
    if (btn) {
      const rect = btn.getBoundingClientRect();
      const wrap = document.querySelector('.reading-toolbar-wrap');
      const wRect = wrap.getBoundingClientRect();
      dd.style.left = (rect.left - wRect.left) + 'px';
      dd.style.right = 'auto';
    }
  }
};
function closeTbDropdowns() {
  document.querySelectorAll('.tb-dropdown').forEach(d => d.classList.remove('open'));
}
document.addEventListener('click', e => {
  if (!e.target.closest('.reading-toolbar-wrap')) closeTbDropdowns();
});

// ── Tag dropdown ──
function renderTagDropdown(art) {
  const list = document.getElementById('tag-dropdown-list');
  const allTags = new Set(articles.flatMap(a => a.tags||[]));
  list.innerHTML = '';
  [...allTags].sort().forEach(tag => {
    const hasTag = (art.tags||[]).includes(tag);
    const item = document.createElement('div');
    item.className = 'tb-drop-item' + (hasTag ? ' active' : '');
    item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> ${escHtml(tag)}`;
    item.onclick = () => toggleTagOnArticle(tag);
    list.appendChild(item);
  });
}

window.handleTagInput = (e) => {
  if (e.key === 'Enter') {
    const val = e.target.value.trim();
    if (val) { toggleTagOnArticle(val); e.target.value = ''; }
  }
};

async function toggleTagOnArticle(tag) {
  const art = articles.find(a => a.id === currentArticleId);
  if (!art) return;
  const tags = art.tags || [];
  const newTags = tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag];
  await updateDoc(doc(db, 'articles', currentArticleId), { tags: newTags });
  renderTagDropdown({...art, tags: newTags});
  renderReadingPage({...art, tags: newTags});
}

window.removeTagFromArticle = async (tag) => {
  await toggleTagOnArticle(tag);
};

// ── Folder dropdown ──
function renderFolderDropdown(art) {
  const list = document.getElementById('folder-dropdown-list');
  list.innerHTML = '';
  const noneItem = document.createElement('div');
  noneItem.className = 'tb-drop-item' + (!art.folderId ? ' active' : '');
  noneItem.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> 無資料夾`;
  noneItem.onclick = () => setArticleFolder(null);
  list.appendChild(noneItem);
  folders.forEach(f => {
    const item = document.createElement('div');
    item.className = 'tb-drop-item' + (art.folderId === f.id ? ' active' : '');
    item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7c0-1.1.9-2 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg> ${escHtml(f.name)}`;
    item.onclick = () => setArticleFolder(f.id);
    list.appendChild(item);
  });
}

async function setArticleFolder(folderId) {
  if (!currentArticleId) return;
  await updateDoc(doc(db, 'articles', currentArticleId), { folderId: folderId || null });
  closeTbDropdowns();
  showToast(folderId ? '已移至資料夾' : '已移出資料夾');
}

// ── Read status (2 states: 待閱🔲 / 已閱☑️) ──
window.toggleReadStatus = async () => {
  const art = articles.find(a => a.id === currentArticleId);
  if (!art) return;
  const cur = art.readStatus || '';
  const next = (cur === 'done') ? '' : 'done';
  art.readStatus = next; // optimistic update
  updateToolbarState(art);
  await updateDoc(doc(db, 'articles', currentArticleId), { readStatus: next });
  showToast(next === 'done' ? '已標記為已閱 ☑️' : '已標記為待閱 🔲');
};
// keep backward compat
window.cycleReadStatus = window.toggleReadStatus;

// ── Favorite ──
window.toggleFavorite = async () => {
  const art = articles.find(a => a.id === currentArticleId);
  if (!art) return;
  const newFav = !art.favorite;
  art.favorite = newFav; // optimistic update
  updateToolbarState(art);
  await updateDoc(doc(db, 'articles', currentArticleId), { favorite: newFav });
  showToast(newFav ? '已加入收藏 ♥' : '已取消收藏');
};

// ── Pin ──
window.togglePin = async () => {
  const art = articles.find(a => a.id === currentArticleId);
  if (!art) return;
  const newPinned = !art.pinned;
  art.pinned = newPinned; // optimistic update
  updateToolbarState(art);
  await updateDoc(doc(db, 'articles', currentArticleId), { pinned: newPinned });
  showToast(newPinned ? '已置頂 🔺' : '已取消置頂');
};

// ── TTS ──
// 保持模糊比對，但加入更寬鬆的語系判定
const TTS_VOICES = [
  { label: '台灣中文', match: v => v.lang.includes('zh-TW'), lang: 'zh-TW' },
  { label: '中國大陸', match: v => v.lang.includes('zh-CN'), lang: 'zh-CN' },
  { label: 'English',  match: v => v.lang.startsWith('en-'), lang: 'en-US' },
];

let _cachedVoices = [];
function _getVoices() {
  if (typeof speechSynthesis === 'undefined') return [];
  const v = speechSynthesis.getVoices();
  if (v.length) _cachedVoices = v;
  return _cachedVoices;
}

if (typeof speechSynthesis !== 'undefined') {
  _getVoices();
  speechSynthesis.onvoiceschanged = () => { _cachedVoices = speechSynthesis.getVoices(); };
}

function _resolveVoice(preset) {
  const all = _getVoices();
  // 優先找名字包含 google 的優質語音，找不到就找任何符合該語系的語音
  return all.find(v => preset.match(v) && v.name.toLowerCase().includes('google')) || all.find(preset.match) || null;
}

window.toggleTTS = () => {
  if (ttsPlaying) { stopTTS(); return; }
  
  const art = articles.find(a => a.id === currentArticleId);
  if (!art || !art.body) { showToast('沒有可朗讀的內容'); return; }

  // 1. 播放前先確保取消所有正在排隊的語音（防止卡死）
  speechSynthesis.cancel(); 

  const savedLang = localStorage.getItem('tts_lang') || 'zh-TW';
  const preset = TTS_VOICES.find(p => p.lang === savedLang) || TTS_VOICES[0];
  
  // 2. 建立朗讀實例
  const utter = new SpeechSynthesisUtterance(art.body);
  utter.lang = preset.lang;
  
  const rate = parseFloat(localStorage.getItem('tts_rate') || '1');
  utter.rate = rate;

  // 3. 安全指派語音：找不到就留空，瀏覽器會自動用系統預設音，才不會沒聲音
  const resolvedVoice = _resolveVoice(preset);
  if (resolvedVoice) {
    utter.voice = resolvedVoice;
  }

  utter.onstart = () => {
    ttsPlaying = true;
    const btn = document.getElementById('tb-tts-btn');
    if (btn) { btn.classList.add('active'); btn.textContent = '⏹'; }
    const prog = document.getElementById('tts-progress');
    if (prog) prog.classList.add('active');
  };

  utter.onend = () => {
    ttsPlaying = false;
    const btn = document.getElementById('tb-tts-btn');
    if (btn) { btn.classList.remove('active'); btn.textContent = '🔊'; }
    const prog = document.getElementById('tts-progress');
    if (prog) prog.classList.remove('active');
    document.getElementById('tts-progress-bar').style.width = '0%';
  };

  utter.onerror = (e) => {
    console.error('TTS 播放出錯:', e);
    ttsPlaying = false;
    const btn = document.getElementById('tb-tts-btn');
    if (btn) { btn.classList.remove('active'); btn.textContent = '🔊'; }
    // 如果是因為被瀏覽器攔截，提示使用者
    if (e.error === 'not-allowed') {
      showToast('播放被瀏覽器攔截，請再點擊一次');
    }
  };

  utter.onboundary = (e) => {
    if (utter.text.length > 0) {
      const pct = Math.round((e.charIndex / utter.text.length) * 100);
      const pb = document.getElementById('tts-progress-bar');
      if (pb) pb.style.width = pct + '%';
    }
  };

  ttsUtterance = utter;
  
  // 4. 正式播放
  speechSynthesis.speak(utter);
};

function stopTTS() {
  speechSynthesis.cancel();
  ttsPlaying = false;
  const btn = document.getElementById('tb-tts-btn');
  if (btn) { btn.classList.remove('active'); btn.textContent = '🔊'; }
  const prog = document.getElementById('tts-progress');
  if (prog) prog.classList.remove('active');
}

// ── Mobile toolbar auto-hide ──
function setupMobileToolbar() {
  if (!isMobile()) return;
  const toolbar = document.getElementById('reading-toolbar');
  const titleBar = document.getElementById('reading-title-bar');
  const hint = document.getElementById('reading-tap-hint');
  clearTimeout(toolbarCollapseTimer);
  toolbar.classList.remove('collapsed');
  if (titleBar) titleBar.style.marginTop = '44px';
  if (hint) hint.classList.remove('visible');

  const collapseToolbar = () => {
    toolbar.classList.add('collapsed');
    if (titleBar) titleBar.style.marginTop = '0';
    // Show tap hint briefly
    if (hint) {
      hint.classList.add('visible');
      setTimeout(() => hint.classList.remove('visible'), 1800);
    }
  };

  const resetTimer = () => {
    clearTimeout(toolbarCollapseTimer);
    toolbar.classList.remove('collapsed');
    if (titleBar) titleBar.style.marginTop = '44px';
    if (hint) hint.classList.remove('visible');
    toolbarCollapseTimer = setTimeout(collapseToolbar, 3500);
  };

  const modal = document.getElementById('reading-modal');
  if (!modal._mobileListenerSet) {
    modal._mobileListenerSet = true;
    modal.addEventListener('touchstart', resetTimer, {passive: true});
    modal.addEventListener('click', e => {
      if (e.target.closest('.reading-toolbar-wrap') || e.target.closest('.tb-dropdown')) return;
      resetTimer();
    }, {passive: true});

    // Swipe-back gesture (edge swipe from left or right → close reading)
    let swipeTouchStartX = null;
    let swipeTouchStartY = null;
    modal.addEventListener('touchstart', e => {
      const t = e.touches[0];
      swipeTouchStartX = t.clientX;
      swipeTouchStartY = t.clientY;
    }, {passive: true});
    modal.addEventListener('touchend', e => {
      if (swipeTouchStartX === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - swipeTouchStartX;
      const dy = t.clientY - swipeTouchStartY;
      // Edge swipe: started within 30px of left or right edge, horizontal > 60px, more horizontal than vertical
      const startedAtLeftEdge = swipeTouchStartX < 30;
      const startedAtRightEdge = swipeTouchStartX > window.innerWidth - 30;
      const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
      const swipedRight = dx > 60 && startedAtLeftEdge;
      const swipedLeft = dx < -60 && startedAtRightEdge;
      if (isHorizontal && (swipedRight || swipedLeft)) {
        closeReading();
      }
      swipeTouchStartX = null;
      swipeTouchStartY = null;
    }, {passive: true});
  }
  resetTimer();
}

// ── Highlight mode ──
// State: 'off' | 'selecting' | 'confirming'

window.toggleHighlightMode = () => {
  if (highlightState !== 'off') {
    // Already active — cancel
    exitHighlightMode();
    return;
  }
  highlightState = 'selecting';
  const btn = document.getElementById('tb-highlight-btn');
  if (btn) btn.classList.add('active');
  const banner = document.getElementById('highlight-mode-banner');
  if (banner) banner.style.display = 'block';
  // Apply highlight-mode cursor/selection style
  const art = articles.find(a => a.id === currentArticleId);
  if (art && !mdMode) renderBodyPane(art);
};

window.exitHighlightMode = function exitHighlightMode() {
  highlightState = 'off';
  pendingHighlightText = '';
  const btn = document.getElementById('tb-highlight-btn');
  if (btn) btn.classList.remove('active');
  const banner = document.getElementById('highlight-mode-banner');
  if (banner) banner.style.display = 'none';
  hideHighlightConfirmBar();
  window.getSelection()?.removeAllRanges();
  const art = articles.find(a => a.id === currentArticleId);
  if (art && !mdMode) renderBodyPane(art);
}

function showHighlightConfirmBar(text) {
  let bar = document.getElementById('hl-confirm-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'hl-confirm-bar';
    bar.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      z-index:800; background:var(--text); color:#fff;
      border-radius:20px; padding:8px 16px; font-size:13px;
      display:flex; align-items:center; gap:10px;
      box-shadow:var(--shadow-lg); font-family:var(--font-sans);
      white-space:nowrap; max-width:90vw;
    `;
    document.body.appendChild(bar);
  }
  const snippet = text.length > 28 ? text.slice(0,28) + '…' : text;
  bar.innerHTML = `
    <span style="color:var(--highlight-border);font-size:14px">🪄</span>
    <span style="opacity:.75;font-size:12px;overflow:hidden;text-overflow:ellipsis;max-width:180px">"${escHtml(snippet)}"</span>
    <button onclick="confirmHighlight()" style="background:var(--accent);color:#fff;border:none;border-radius:12px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:var(--font-sans)">✓ 確認</button>
    <button onclick="exitHighlightMode()" style="background:rgba(255,255,255,0.15);color:#fff;border:none;border-radius:12px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:var(--font-sans)">✕</button>
  `;
  bar.style.display = 'flex';
}

function hideHighlightConfirmBar() {
  const bar = document.getElementById('hl-confirm-bar');
  if (bar) bar.style.display = 'none';
}

window.confirmHighlight = async () => {
  if (!pendingHighlightText || !currentArticleId) return;
  const text = pendingHighlightText;
  exitHighlightMode();
  await updateDoc(doc(db, 'articles', currentArticleId), { highlight: text });
  const art = articles.find(a => a.id === currentArticleId);
  if (art) { art.highlight = text; renderBodyPane(art); }
  showToast('Highlight 已儲存 🪄');
};

document.addEventListener('mouseup', (e) => {
  const modal = document.getElementById('reading-modal');
  if (!modal.classList.contains('open')) return;
  if (mdMode) return;
  if (highlightState !== 'selecting') return;
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!text || text.length < 2) {
    hideHighlightConfirmBar();
    return;
  }
  // Only accept selections inside the body rendered area
  if (!e.target.closest('#body-rendered')) return;
  pendingHighlightText = text;
  highlightState = 'confirming';
  showHighlightConfirmBar(text);
});

// ── Delete ──
window.deleteCurrentArticle = async () => {
  if (!currentArticleId) return;
  const art = articles.find(a => a.id === currentArticleId);
  if (!confirm(`確定刪除「${art?.title||'文章'}」？`)) return;
  await deleteDoc(doc(db, 'articles', currentArticleId));
  closeReading();
  showToast('已刪除');
  if (currentUser?.isAnonymous && window._fetchAnonData) window._fetchAnonData();
};

// ── New article modal ──
// New article state
let newTags = [];
let newFolderId = null;

window.openNewModal = () => {
  newTags = [];
  newFolderId = currentFolderId || null;
  document.getElementById('new-title').value = '';
  document.getElementById('new-body').value = '';
  document.getElementById('new-notes').value = '';
  const newAuthorEl = document.getElementById('new-author');
  if (newAuthorEl) newAuthorEl.value = '';
  const newUrlEl = document.getElementById('new-url');
  if (newUrlEl) newUrlEl.value = '';
  document.getElementById('new-save-btn').disabled = false;
  document.getElementById('new-save-btn').textContent = '儲存';
  // Default to edit (raw) mode since a new article starts empty
  newMdMode = true;
  document.getElementById('new-md-btn').classList.add('active');
  const textarea = document.getElementById('new-body');
  const viewDiv = document.getElementById('new-body-view');
  textarea.style.display = '';
  if (viewDiv) viewDiv.style.display = 'none';
  // Default: hide notes pane
  newNotesVisible = false;
  const newNotesPane = document.getElementById('new-notes-pane');
  const newBodyPane = document.getElementById('new-body-pane');
  if (newNotesPane) newNotesPane.classList.add('hidden');
  if (newBodyPane) newBodyPane.classList.add('full');
  const newNotesBtnEl = document.getElementById('new-notes-btn');
  if (newNotesBtnEl) newNotesBtnEl.classList.remove('active');
  renderNewMetaRow();
  renderNewTagDropdown();
  renderNewFolderDropdown();
  document.getElementById('new-modal').classList.add('open');
  setTimeout(() => { const t = document.getElementById('new-title'); t.focus(); autoResizeTitle(t); }, 50);
};

window.closeNewModal = () => {
  document.getElementById('new-modal').classList.remove('open');
  closeNewDropdowns();
};

function renderNewMetaRow() {
  const row = document.getElementById('new-meta-row');
  row.innerHTML = newTags.map(t =>
    `<span class="reading-meta-tag" onclick="removeNewTag('${escHtml(t)}')">${escHtml(t)} ×</span>`
  ).join('');
  if (newFolderId) {
    const f = folders.find(f => f.id === newFolderId);
    if (f) row.innerHTML += `<span class="reading-meta-tag" style="background:var(--accent2-light);color:var(--accent2);border-color:rgba(193,127,58,0.3)" onclick="newFolderId=null;renderNewMetaRow()">📁 ${escHtml(f.name)} ×</span>`;
  }
}

function renderNewTagDropdown() {
  const list = document.getElementById('new-tag-list');
  const allTags = new Set(articles.flatMap(a => a.tags||[]));
  list.innerHTML = '';
  [...allTags].sort().forEach(tag => {
    const active = newTags.includes(tag);
    const item = document.createElement('div');
    item.className = 'tb-drop-item' + (active ? ' active' : '');
    item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> ${escHtml(tag)}`;
    item.onclick = () => {
      if (newTags.includes(tag)) newTags = newTags.filter(t => t !== tag);
      else newTags.push(tag);
      renderNewTagDropdown(); renderNewMetaRow();
    };
    list.appendChild(item);
  });
}

window.handleNewTagInput = (e) => {
  if (e.key === 'Enter') {
    const val = e.target.value.trim();
    if (val && !newTags.includes(val)) { newTags.push(val); renderNewTagDropdown(); renderNewMetaRow(); }
    e.target.value = '';
  }
};

window.removeNewTag = (tag) => { newTags = newTags.filter(t => t !== tag); renderNewMetaRow(); renderNewTagDropdown(); };

function renderNewFolderDropdown() {
  const list = document.getElementById('new-folder-list');
  list.innerHTML = '';
  const none = document.createElement('div');
  none.className = 'tb-drop-item' + (!newFolderId ? ' active' : '');
  none.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> 無資料夾`;
  none.onclick = () => { newFolderId = null; renderNewMetaRow(); closeNewDropdowns(); };
  list.appendChild(none);
  folders.forEach(f => {
    const item = document.createElement('div');
    item.className = 'tb-drop-item' + (newFolderId === f.id ? ' active' : '');
    item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7c0-1.1.9-2 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg> ${escHtml(f.name)}`;
    item.onclick = () => { newFolderId = f.id; renderNewMetaRow(); closeNewDropdowns(); };
    list.appendChild(item);
  });
}

window.toggleNewDropdown = (id) => {
  const dd = document.getElementById(id);
  const isOpen = dd.classList.contains('open');
  closeNewDropdowns();
  if (!isOpen) {
    dd.classList.add('open');
    const btnId = id === 'new-folder-dropdown' ? 'new-tb-folder-btn' : 'new-tb-tag-btn';
    const btn = document.getElementById(btnId);
    if (btn) {
      const rect = btn.getBoundingClientRect();
      const wrap = btn.closest('.reading-toolbar-wrap');
      if (wrap) {
        const wRect = wrap.getBoundingClientRect();
        dd.style.left = (rect.left - wRect.left) + 'px';
        dd.style.right = 'auto';
      }
    }
  }
};
function closeNewDropdowns() {
  ['new-tag-dropdown','new-folder-dropdown'].forEach(id => {
    document.getElementById(id)?.classList.remove('open');
  });
}
document.addEventListener('click', e => {
  if (!e.target.closest('#new-toolbar') && !e.target.closest('.tb-dropdown')) closeNewDropdowns();
});


window.saveNewArticle = async () => {
  const title = document.getElementById('new-title').value.trim();
  const body = document.getElementById('new-body').value.trim();
  if (!title) { showToast('請填寫標題'); return; }
  const saveBtn = document.getElementById('new-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = '儲存中…';
  const notes = document.getElementById('new-notes').value.trim();
  const author = (document.getElementById('new-author')?.value || '').trim();
  const url = (document.getElementById('new-url')?.value || '').trim();
  try {
    const docRef = await addDoc(collection(db, 'articles'), {
      uid: currentUser.uid,
      title, body, author, url, tags: [...newTags], folderId: newFolderId,
      notes, highlight: '',
      readStatus: '', favorite: false,
      createdAt: serverTimestamp()
    });
    closeNewModal();
    showToast('文章已儲存 ✓');
    if (currentUser?.isAnonymous && window._fetchAnonData) window._fetchAnonData();
    // Auto-open the article
    setTimeout(() => openReading(docRef.id), 300);
  } catch(e) {
    showToast('儲存失敗：' + e.message);
    console.error('Firestore error:', e);
    saveBtn.disabled = false;
    saveBtn.textContent = '儲存';
  }
};

// ── Folder modal ──
window.openFolderModal = () => {
  document.getElementById('folder-name-input').value = '';
  renderFolderSelects();
  document.getElementById('folder-modal').classList.add('open');
  setTimeout(() => document.getElementById('folder-name-input').focus(), 50);
};
window.closeFolderModal = () => document.getElementById('folder-modal').classList.remove('open');

window.saveFolderModal = async () => {
  const name = document.getElementById('folder-name-input').value.trim();
  if (!name) { showToast('請填寫資料夾名稱'); return; }
  const parentId = document.getElementById('folder-parent-select').value || null;
  // assign order = max existing order + 1 for same parent
  const siblings = folders.filter(f => (f.parentId||null) === parentId);
  const maxOrder = siblings.reduce((m, f) => Math.max(m, f.order ?? 0), 0);
  await addDoc(collection(db, 'folders'), { uid: currentUser.uid, name, parentId, order: maxOrder + 1 });
  closeFolderModal();
  showToast(`資料夾「${name}」已建立`);
  if (currentUser?.isAnonymous && window._fetchAnonData) window._fetchAnonData();
};

// ── Search ──
window.toggleSearch = () => {
  if (isMobile()) {
    openMobileSearch();
    return;
  }
  searchOpen = !searchOpen;
  const wrap = document.getElementById('search-wrap');
  const btn = document.getElementById('search-btn');
  wrap.classList.toggle('open', searchOpen);
  btn.classList.toggle('active', searchOpen);
  if (searchOpen) setTimeout(() => { document.getElementById('search-input').focus(); }, 250);
  else { document.getElementById('search-input').value = ''; updateSearchClear(); renderArticleList(); }
};

function openMobileSearch() {
  const overlay = document.getElementById('mobile-search-overlay');
  overlay.classList.add('open');
  setTimeout(() => document.getElementById('mobile-search-input').focus(), 100);
}

window.closeMobileSearch = () => {
  const overlay = document.getElementById('mobile-search-overlay');
  overlay.classList.remove('open');
  document.getElementById('mobile-search-input').value = '';
  renderArticleList(); // reset
};

window.filterArticlesMobile = () => {
  const q = document.getElementById('mobile-search-input').value.trim().toLowerCase();
  const results = document.getElementById('mobile-search-results');
  if (!q) { results.innerHTML = ''; return; }
  const matched = articles.filter(a =>
    a.title?.toLowerCase().includes(q) || a.body?.toLowerCase().includes(q)
  );
  if (matched.length === 0) {
    results.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">沒有找到相關文章</div>`;
    return;
  }
  results.innerHTML = '';
  matched.forEach(art => {
    const row = document.createElement('div');
    row.className = 'article-row';
    row.style.cssText = 'padding:10px 14px;';
    // Build snippet
    let snippetHtml = '';
    const q2 = document.getElementById('mobile-search-input').value.trim();
    if (q2 && art.body) {
      const idx = art.body.toLowerCase().indexOf(q2.toLowerCase());
      if (idx !== -1) {
        const start = Math.max(0, idx - 20);
        const end = Math.min(art.body.length, idx + q2.length + 50);
        const raw = (start > 0 ? '…' : '') + art.body.slice(start, end) + (end < art.body.length ? '…' : '');
        const safeQ = q2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const parts = raw.split(new RegExp(`(${safeQ})`, 'gi'));
        const inner = parts.map(p => p.toLowerCase() === q2.toLowerCase() ? `<mark>${escHtml(p)}</mark>` : escHtml(p)).join('');
        snippetHtml = `<span class="article-snippet">${inner}</span>`;
      }
    }
    row.innerHTML = `<span class="article-title" style="font-size:14px">${escHtml(art.title||'未命名')}</span>${snippetHtml}`;
    row.onclick = () => { closeMobileSearch(); openReading(art.id); };
    results.appendChild(row);
  });
};

// ── Mobile tag popover ──
window.toggleTagBar = () => {
  if (isMobile()) {
    toggleMobileTagPopover();
    return;
  }
  const bar = document.getElementById('tag-bar');
  const btn = document.getElementById('tag-toggle-btn');
  const isOpen = bar.classList.contains('open');
  if (isOpen) {
    bar.classList.remove('open');
    btn.classList.remove('active');
    setTimeout(() => { if (!bar.classList.contains('open')) bar.style.display = 'none'; }, 250);
  } else {
    bar.style.display = 'flex';
    requestAnimationFrame(() => {
      bar.classList.add('open');
      btn.classList.add('active');
    });
  }
};

function toggleMobileTagPopover() {
  const pop = document.getElementById('mobile-tag-popover');
  const btn = document.getElementById('tag-toggle-btn');
  const isOpen = pop.classList.contains('open');
  pop.classList.toggle('open', !isOpen);
  btn.classList.toggle('active', !isOpen);
  if (!isOpen) renderMobileTagPopover();
}

function renderMobileTagPopover() {
  const pop = document.getElementById('mobile-tag-popover');
  pop.innerHTML = '';
  const allTags = new Set();
  articles.forEach(a => (a.tags||[]).forEach(t => allTags.add(t)));
  // All button
  const allBtn = document.createElement('button');
  allBtn.className = 'tag-pill' + (activeTag === '__all__' ? ' active' : '');
  allBtn.textContent = '全部';
  allBtn.onclick = () => { filterTagMobile('__all__'); };
  pop.appendChild(allBtn);
  [...allTags].sort().forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'tag-pill' + (activeTag === tag ? ' active' : '');
    btn.textContent = tag;
    btn.onclick = () => filterTagMobile(tag);
    pop.appendChild(btn);
  });
}

function filterTagMobile(tag) {
  activeTag = tag;
  renderArticleList();
  const pop = document.getElementById('mobile-tag-popover');
  pop.classList.remove('open');
  document.getElementById('tag-toggle-btn').classList.remove('active');
  // Update desktop pills too (keeps state consistent)
  document.querySelectorAll('.tag-pill').forEach(p => p.classList.toggle('active', p.dataset.tag === tag));
}

// Close mobile popover on outside tap
document.addEventListener('click', e => {
  const pop = document.getElementById('mobile-tag-popover');
  if (pop && pop.classList.contains('open')) {
    if (!e.target.closest('#mobile-tag-popover') && !e.target.closest('#tag-toggle-btn')) {
      pop.classList.remove('open');
      document.getElementById('tag-toggle-btn').classList.remove('active');
    }
  }
});

// ── Settings modal ──
let currentSettingsTab = 'tts';
window.openSettings = (tab) => {
  currentSettingsTab = tab || 'tts';
  renderSettingsBody();
  document.getElementById('settings-modal').classList.add('open');
  ['tts','appearance','account','export'].forEach(t => {
    document.getElementById('snav-'+t)?.classList.toggle('active', t === currentSettingsTab);
  });
};
window.switchSettingsTab = (tab) => {
  currentSettingsTab = tab;
  ['tts','appearance','account','export'].forEach(t => {
    document.getElementById('snav-'+t)?.classList.toggle('active', t === tab);
  });
  renderSettingsBody();
};
document.getElementById('settings-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

function renderSettingsBody() {
  const body = document.getElementById('settings-body');
  if (currentSettingsTab === 'export') {
    body.innerHTML = `
      <div class="settings-row">
        <label>備份資料</label>
        <button class="btn btn-primary" onclick="exportData()">匯出 JSON</button>
      </div>
      <div class="settings-row">
        <label style="font-size:12px;color:var(--text3)">自動儲存</label>
        <span style="font-size:12px;color:var(--text3)">停止輸入後 2.5 秒同步</span>
      </div>
    `;
    return;
  }
  if (currentSettingsTab === 'tts') {
    const allVoices = speechSynthesis.getVoices();
    const savedLang = localStorage.getItem('tts_lang') || 'zh-TW';
    const savedVoice = localStorage.getItem('tts_voice') || '';
    const savedRate = localStorage.getItem('tts_rate') || '1';
    const zhVoices = allVoices.filter(v =>
      (v.lang.startsWith('zh-TW') || v.lang.startsWith('zh-CN') || v.lang.startsWith('cmn'))
      && !v.lang.includes('HK') && !v.name.toLowerCase().includes('cantonese') && !v.name.toLowerCase().includes('粵'));
    const enVoices = allVoices.filter(v => v.lang.startsWith('en-US') || v.lang.startsWith('en-GB'));
    const voices = savedLang.startsWith('en') ? enVoices : zhVoices;
    const testText = savedLang.startsWith('en') ? 'Hello! This is a voice test.' : '測試語音，你好！';
    body.innerHTML = `
      <div class="settings-row">
        <label>語言</label>
        <select id="tts-lang-select" onchange="localStorage.setItem('tts_lang',this.value);localStorage.removeItem('tts_voice');renderSettingsBody()">
          <option value="zh-TW" ${savedLang==='zh-TW'?'selected':''}>中文（普通話）</option>
          <option value="en-US" ${savedLang==='en-US'?'selected':''}>English (US)</option>
          <option value="en-GB" ${savedLang==='en-GB'?'selected':''}>English (GB)</option>
        </select>
      </div>
      <div class="settings-row">
        <label>人聲</label>
        <select id="voice-select" onchange="localStorage.setItem('tts_voice',this.value)">
          <option value="">系統預設</option>
          ${voices.map(v=>`<option value="${escHtml(v.name)}" ${v.name===savedVoice?'selected':''}>${escHtml(v.name)}</option>`).join('')}
        </select>
      </div>
      <div class="settings-row">
        <label>語速</label>
        <input type="range" min="0.5" max="2" step="0.1" value="${savedRate}" style="flex:1"
          oninput="localStorage.setItem('tts_rate',this.value);document.getElementById('speed-val').textContent=parseFloat(this.value).toFixed(1)+'x'" />
        <span class="speed-val" id="speed-val">${parseFloat(savedRate).toFixed(1)}x</span>
      </div>
      <div class="settings-row">
        <label></label>
        <button class="btn" onclick="(()=>{const u=new SpeechSynthesisUtterance('${testText}');u.lang='${savedLang}';u.rate=parseFloat(localStorage.getItem('tts_rate')||1);const v=speechSynthesis.getVoices().find(v=>v.name===localStorage.getItem('tts_voice'));if(v)u.voice=v;speechSynthesis.speak(u)})()">▶ 試聽</button>
      </div>
    `;
  } else if (currentSettingsTab === 'appearance') {
    const savedSize = parseInt(localStorage.getItem('reading_font_size_default') || '16');
    body.innerHTML = `
      <div class="settings-row">
        <label>閱讀字體</label>
        <select onchange="applyDefaultFontSize(parseInt(this.value))">
          ${[12,14,16,18,20,22,24,26,28,30,32].map(s=>`<option value="${s}" ${s===savedSize?'selected':''}>${s}px</option>`).join('')}
        </select>
      </div>
    `;
  } else if (currentSettingsTab === 'account') {
    const name = escHtml(currentUser?.displayName || currentUser?.email || '匿名');
    const isAnon = currentUser?.isAnonymous;
    body.innerHTML = `
      <div class="settings-row">
        <label>帳號</label>
        <span style="font-size:13px;color:var(--text2)">${name}</span>
      </div>
      ${!isAnon ? `
      <div class="settings-row">
        <label>匿名驗證碼</label>
        <button class="btn btn-primary" onclick="generatePasscode()">產生</button>
      </div>` : ''}
      <div class="settings-row" style="margin-top:4px">
        <label></label>
        <button class="btn btn-danger" onclick="if(confirm('確定登出？'))signOut(auth)">登出</button>
      </div>
    `;
  }
}

// ── Passcode ──
window.generatePasscode = async () => {
  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000; // 10 分鐘有效
    await setDoc(doc(db, 'passcodes', code), {
      ownerUid: currentUser.uid,
      uid: currentUser.uid,
      expires,
      used: false
    });
    document.getElementById('passcode-code').textContent = code;
    document.getElementById('passcode-modal').classList.add('open');
    document.getElementById('settings-modal').classList.remove('open');
  } catch(e) {
    showToast('產生驗證碼失敗：' + e.message);
  }
};

window.copyPasscode = () => {
  const code = document.getElementById('passcode-code').textContent;
  navigator.clipboard.writeText(code).then(() => showToast('驗證碼已複製'));
};

console.log('[boot] defining loginWithPasscode');
window.loginWithPasscode = async () => {
  const code = document.getElementById('passcode-input').value.trim();
  if (code.length !== 6) { showToast('請輸入驗證碼'); return; }
  const btn = document.querySelector('#auth-screen .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '驗證中…'; }
  window._passcodeLoginInProgress = true;
  try {
    // Step 1: 讀取 passcode doc
    const snap = await getDoc(doc(db, 'passcodes', code));
    if (!snap.exists()) { showToast('驗證碼無效'); if (btn) { btn.disabled=false; btn.textContent='匿名登入'; } return; }
    const data = snap.data();
    const ownerUid = data.ownerUid || data.uid;
    if (!ownerUid) { showToast('驗證碼格式錯誤'); if (btn) { btn.disabled=false; btn.textContent='匿名登入'; } return; }
    if (Date.now() > Number(data.expires)) { showToast('驗證碼已過期'); if (btn) { btn.disabled=false; btn.textContent='匿名登入'; } return; }
    if (data.used) { showToast('驗證碼已使用過'); if (btn) { btn.disabled=false; btn.textContent='匿名登入'; } return; }
    console.log('[LP] passcode ok, ownerUid=', ownerUid);

    // Step 2: 匿名登入 — 用 sessionStorage 確保 auth 在頁面生命週期內持久
    await setPersistence(auth, browserSessionPersistence);
    const anonCred = await Promise.race([
      signInAnonymously(auth),
      new Promise((_, rej) => setTimeout(() => rej(new Error('登入逾時')), 15000))
    ]);
    const anonUid = anonCred.user.uid;
    const anonUser = anonCred.user;
    console.log('[LP] anonUid=', anonUid);

    // Step 3: 等 onAuthStateChanged 確認 auth.currentUser 更新
    if (auth.currentUser?.uid !== anonUid) {
      await new Promise((resolve) => {
        const unsub = onAuthStateChanged(auth, (u) => {
          if (u?.uid === anonUid) { unsub(); resolve(); }
        });
      });
    }
    console.log('[LP] auth.currentUser=', auth.currentUser?.uid);

    // Step 4: 強制刷新 token 確保 Firestore SDK 同步新的 auth 狀態
    await auth.currentUser.getIdToken(true);
    console.log('[LP] token refreshed');

    // Step 4: 寫入 delegate doc，失敗就重試（auth token 需要時間在 Firestore 生效）
    let delegateWritten = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await setDoc(doc(db, 'delegates', anonUid), { ownerUid, usedPasscode: code });
        console.log('[LP] delegate written on attempt', attempt);
        delegateWritten = true;
        break;
      } catch (e2) {
        console.warn('[LP] delegate write attempt', attempt, 'failed:', e2?.code);
        if (attempt < 5) {
          await new Promise(r => setTimeout(r, attempt * 500));
        }
      }
    }
    if (!delegateWritten) {
      showToast('登入失敗：無法建立授權，請重試');
      if (btn) { btn.disabled=false; btn.textContent='匿名登入'; }
      return;
    }

    // Step 5: 標記 passcode 已使用
    try {
      await setDoc(doc(db, 'passcodes', code), { used: true }, { merge: true });
      console.log('[LP] passcode marked used');
    } catch (e3) {
      console.warn('[LP] mark used failed (non-critical):', e3.message);
    }

    // Step 6: 進入 app
    localStorage.setItem('passcode_uid', ownerUid);
    localStorage.setItem('passcode_code', code);
    localStorage.setItem('passcode_expires', data.expires);
    showToast('驗證成功，載入中…');
    currentUser = { uid: ownerUid, _anonUid: anonUid, displayName: '匿名', photoURL: null, isAnonymous: true };
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').classList.add('visible');
    document.getElementById('user-avatar-wrap').innerHTML = '<div class="user-initials" title="匿名模式">匿</div>';
    passcodeTargetUid = null;
    window._passcodeLoginInProgress = false;
    // 確認 delegate doc 可讀（代表已寫入並生效）再讀取資料
    let delegateReady = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const delSnap = await getDoc(doc(db, 'delegates', anonUid));
        if (delSnap.exists()) { delegateReady = true; break; }
      } catch(e) { /* 還沒就緒，繼續等 */ }
    }
    console.log('[LP] delegate ready=', delegateReady);
    subscribeData();
    console.log('[LP] ALL DONE');
  } catch(e) {
    console.error('[LP] CAUGHT ERROR:', e);
    showToast('登入失敗：' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '匿名登入'; }
  } finally {
    window._passcodeLoginInProgress = false;
  }
};


function loadAnonymousData(uid, anonUid) {
  // anonUid = Firebase Auth uid of the anonymous session (may differ from ownerUid)
  currentUser = { uid, _anonUid: anonUid || null, displayName: '匿名', photoURL: null, isAnonymous: true };
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('user-avatar-wrap').innerHTML = '<div class="user-initials" title="匿名模式">匿</div>';
  subscribeData();
}

// Check saved passcode on load
(async function checkPasscode() {
  const uid = localStorage.getItem('passcode_uid');
  const exp = parseInt(localStorage.getItem('passcode_expires') || '0');
  if (uid && Date.now() < exp) {
    await new Promise(r => setTimeout(r, 1200));
    if (!currentUser) {
      try {
        const { signInAnonymously: _sia } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
        passcodeTargetUid = uid;
        await _sia(auth);
        // onAuthStateChanged handles the rest
      } catch(e) {
        localStorage.removeItem('passcode_uid');
        localStorage.removeItem('passcode_expires');
        localStorage.removeItem('passcode_code');
      }
    }
  }
})();

// ── Export ──
window.exportData = () => {
  const exportObj = { exportedAt: new Date().toISOString(), articles: articles.map(a => ({...a, createdAt: a.createdAt?.seconds ? new Date(a.createdAt.seconds*1000).toISOString() : null})), folders };
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '收集冊_' + new Date().toISOString().slice(0,10) + '.json';
  a.click(); URL.revokeObjectURL(url);
  showToast('匯出完成 ✓');
};

// ── Helpers ──
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatDate(ms) {
  const d = new Date(ms);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 86400000) return '今天';
  if (diff < 172800000) return '昨天';
  if (diff < 604800000) return Math.floor(diff/86400000) + '天前';
  return `${d.getMonth()+1}/${d.getDate()}`;
}
window.showToast = (msg) => {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
};

// Close modals on backdrop click
document.getElementById('new-modal').addEventListener('click', e => { if(e.target===e.currentTarget) closeNewModal(); });
document.getElementById('folder-modal').addEventListener('click', e => { if(e.target===e.currentTarget) closeFolderModal(); });

// ── Context menu (folder / tag rename) ──
let ctxTarget = null; // { type: 'folder'|'tag', id, name }

function openCtxMenu(e, type, id, name) {
  e.preventDefault();
  e.stopPropagation();
  ctxTarget = { type, id, name };
  const menu = document.getElementById('ctx-menu');
  // Only show delete for folders; tags don't have a delete in this simple version
  document.getElementById('ctx-delete-folder').style.display = type === 'folder' ? 'flex' : 'none';
  menu.classList.add('open');
  const x = Math.min(e.clientX, window.innerWidth - 160);
  const y = Math.min(e.clientY, window.innerHeight - 120);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function closeCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('open');
}

window.startRename = () => {
  closeCtxMenu();
  if (!ctxTarget) return;
  const wrap = document.getElementById('rename-wrap');
  const input = document.getElementById('rename-input');
  const label = document.getElementById('rename-label');
  label.textContent = ctxTarget.type === 'folder' ? '重新命名資料夾' : '重新命名標籤';
  input.value = ctxTarget.name;
  wrap.classList.add('open');
  // Position near center
  wrap.style.left = '50%';
  wrap.style.top = '50%';
  wrap.style.transform = 'translate(-50%, -50%)';
  setTimeout(() => { input.focus(); input.select(); }, 50);
};

window.closeRename = () => {
  document.getElementById('rename-wrap').classList.remove('open');
  ctxTarget = null;
};

window.onRenameKey = (e) => {
  if (e.key === 'Enter') confirmRename();
  if (e.key === 'Escape') closeRename();
};

window.confirmRename = async () => {
  const newName = document.getElementById('rename-input').value.trim();
  if (!newName || !ctxTarget) return;
  if (ctxTarget.type === 'folder') {
    await updateDoc(doc(db, 'folders', ctxTarget.id), { name: newName });
    showToast(`已重新命名為「${newName}」`);
  } else if (ctxTarget.type === 'tag') {
    // Rename tag across all articles
    const affected = articles.filter(a => (a.tags||[]).includes(ctxTarget.name));
    const updates = affected.map(a => updateDoc(doc(db, 'articles', a.id), {
      tags: a.tags.map(t => t === ctxTarget.name ? newName : t)
    }));
    await Promise.all(updates);
    showToast(`標籤已重新命名為「${newName}」`);
  }
  closeRename();
};

window.deleteCtxTarget = async () => {
  if (!ctxTarget || ctxTarget.type !== 'folder') return;
  closeCtxMenu();
  const folder = folders.find(f => f.id === ctxTarget.id);
  const artCount = articles.filter(a => a.folderId === ctxTarget.id).length;
  const msg = artCount > 0
    ? `確定刪除資料夾「${folder?.name}」？\n其中 ${artCount} 篇文章將移至未分類。`
    : `確定刪除資料夾「${folder?.name}」？`;
  if (!confirm(msg)) return;
  // Move articles out of folder
  const moveUpdates = articles.filter(a => a.folderId === ctxTarget.id)
    .map(a => updateDoc(doc(db, 'articles', a.id), { folderId: null }));
  await Promise.all(moveUpdates);
  await deleteDoc(doc(db, 'folders', ctxTarget.id));
  if (currentUser?.isAnonymous && window._fetchAnonData) window._fetchAnonData();
  if (currentFolderId === ctxTarget.id) { currentFolderId = null; currentFolderPath = []; }
  ctxTarget = null;
  showToast('資料夾已刪除');
};

// Close ctx menu on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#ctx-menu')) closeCtxMenu();
  if (!e.target.closest('#rename-wrap') && !e.target.closest('#ctx-menu')) {
    // don't close rename when clicking confirm/cancel (handled by buttons)
  }
});

// ESC closes rename too

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // close dropdowns first
    const anyDd = document.querySelector('.tb-dropdown.open');
    if (anyDd) { anyDd.classList.remove('open'); return; }
    if (document.getElementById('settings-modal').classList.contains('open')) { document.getElementById('settings-modal').classList.remove('open'); return; }
    if (document.getElementById('passcode-modal').classList.contains('open')) { document.getElementById('passcode-modal').classList.remove('open'); return; }
    if (document.getElementById('reading-modal').classList.contains('open')) { closeReading(); return; }
    if (document.getElementById('new-modal').classList.contains('open')) { closeNewModal(); return; }
    if (document.getElementById('folder-modal').classList.contains('open')) { closeFolderModal(); return; }
    if (searchOpen) toggleSearch();
  }
});
