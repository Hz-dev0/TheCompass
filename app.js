--- TheCompass-main/TheCompass-main/app.js	2026-06-27 16:51:14.000000000 +0000
+++ fix/TheCompass/app.js	2026-06-28 12:13:05.501784207 +0000
@@ -822,6 +822,7 @@
 let titleBarVisible = true;
 let ttsUtterance = null;
 let ttsPlaying = false;
+let _ttsKeepAliveTimer = null;
 let toolbarCollapseTimer = null;
 let isMobile = () => window.innerWidth <= 768;
 
@@ -923,6 +924,10 @@
   metaRow.innerHTML = (art.tags||[]).map(t =>
     `<span class="reading-meta-tag" onclick="removeTagFromArticle('${escHtml(t)}')">${escHtml(t)} ×</span>`
   ).join('');
+  if (art.folderId) {
+    const f = folders.find(f => f.id === art.folderId);
+    if (f) metaRow.innerHTML += `<span class="reading-meta-tag" style="background:var(--accent2-light);color:var(--accent2);border-color:rgba(193,127,58,0.3)" onclick="setArticleFolder(null)">📁 ${escHtml(f.name)} ×</span>`;
+  }
   // Body
   renderBodyPane(art);
   // Notes
@@ -1270,9 +1275,19 @@
   if (!art) return;
   const tags = art.tags || [];
   const newTags = tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag];
-  await updateDoc(doc(db, 'articles', currentArticleId), { tags: newTags });
-  renderTagDropdown({...art, tags: newTags});
-  renderReadingPage({...art, tags: newTags});
+  // Optimistic update: reflect the change immediately, then sync to Firestore.
+  art.tags = newTags;
+  renderTagDropdown(art);
+  renderReadingPage(art);
+  try {
+    await updateDoc(doc(db, 'articles', currentArticleId), { tags: newTags });
+  } catch (e) {
+    // Roll back on failure
+    art.tags = tags;
+    renderTagDropdown(art);
+    renderReadingPage(art);
+    showToast('標籤更新失敗：' + e.message);
+  }
 }
 
 window.removeTagFromArticle = async (tag) => {
@@ -1297,12 +1312,24 @@
   });
 }
 
-async function setArticleFolder(folderId) {
+window.setArticleFolder = async function setArticleFolder(folderId) {
   if (!currentArticleId) return;
-  await updateDoc(doc(db, 'articles', currentArticleId), { folderId: folderId || null });
+  const art = articles.find(a => a.id === currentArticleId);
+  const prevFolderId = art ? art.folderId : undefined;
+  // Optimistic update
+  if (art) {
+    art.folderId = folderId || null;
+    renderReadingPage(art);
+  }
   closeTbDropdowns();
-  showToast(folderId ? '已移至資料夾' : '已移出資料夾');
-}
+  try {
+    await updateDoc(doc(db, 'articles', currentArticleId), { folderId: folderId || null });
+    showToast(folderId ? '已移至資料夾' : '已移出資料夾');
+  } catch (e) {
+    if (art) { art.folderId = prevFolderId; renderReadingPage(art); }
+    showToast('移動資料夾失敗：' + e.message);
+  }
+};
 
 // ── Read status (2 states: 待閱🔲 / 已閱☑️) ──
 window.toggleReadStatus = async () => {
@@ -1419,57 +1446,151 @@
   localStorage.setItem('tts_rate', r);
   document.getElementById('tts-speed-display').textContent = r.toFixed(1) + 'x';
   // If currently playing, restart with new rate
-  if (ttsUtterance && ttsPlaying) { speechSynthesis.cancel(); window.toggleTTS(); }
+  if (ttsPlaying) { stopTTS(); window.toggleTTS(); }
 };
 document.addEventListener('click', e => {
   const menu = document.getElementById('tts-menu');
   if (menu && !menu.contains(e.target) && e.target.id !== 'tb-tts-btn') menu.style.display = 'none';
 });
 
+// Split text into speakable chunks. Chrome's network-based voices (the
+// "Google 中文/國語" voices) are prone to failing completely — no audio,
+// no error — on a single very long utterance, and this gets noticeably
+// worse when the text switches between scripts (e.g. Chinese mixed with
+// English), since the synthesis request has to language-switch mid-chunk.
+// Keeping each utterance short avoids both problems.
+function _splitForTTS(text) {
+  const MAX_LEN = 180;
+  // First split on sentence-ish boundaries (CJK and Latin punctuation),
+  // then re-merge/re-split so each chunk stays under MAX_LEN.
+  const rough = text.split(/(?<=[。！？\.\!\?\n])\s*/).filter(s => s.trim());
+  const chunks = [];
+  let buf = '';
+  for (const piece of rough) {
+    if (piece.length > MAX_LEN) {
+      // A single sentence is itself too long (e.g. no punctuation) — hard-split it.
+      if (buf) { chunks.push(buf); buf = ''; }
+      for (let i = 0; i < piece.length; i += MAX_LEN) chunks.push(piece.slice(i, i + MAX_LEN));
+      continue;
+    }
+    if ((buf + piece).length > MAX_LEN) {
+      if (buf) chunks.push(buf);
+      buf = piece;
+    } else {
+      buf += piece;
+    }
+  }
+  if (buf) chunks.push(buf);
+  return chunks.length ? chunks : [text];
+}
+
+let _ttsQueue = [];
+let _ttsQueueIdx = 0;
+let _ttsTotalLen = 0;
+let _ttsCharsBefore = 0;
+let _ttsGen = 0; // bumped on every stop/restart so stale callbacks can be ignored
+
 window.toggleTTS = () => {
   if (ttsPlaying) { stopTTS(); return; }
   const art = articles.find(a => a.id === currentArticleId);
   if (!art) return;
-  // Resolve voice by saved lang (fuzzy match Google voice)
+  const text = (art.body || '').trim();
+  if (!text) { showToast('這篇文章沒有內容可以朗讀'); return; }
+
   const savedLang = localStorage.getItem('tts_lang') || 'zh-TW';
-  const preset = TTS_VOICES.find(p => p.lang === savedLang) || TTS_VOICES[0];
-  const text = (art.body || '');
-  const utter = new SpeechSynthesisUtterance(text);
-  utter.lang = preset.lang;
+  const savedVoiceName = localStorage.getItem('tts_voice') || '';
+  const voices = _getVoices();
+
+  // Resolve voice with the same priority as the Settings "試聽" preview:
+  // 1) the exact voice the user picked in Settings (if it's still available)
+  // 2) any voice matching the saved language
+  // 3) fuzzy "Google" voice match for the 3 quick presets (legacy fallback)
+  let resolvedVoice = savedVoiceName ? voices.find(v => v.name === savedVoiceName) : null;
+  if (!resolvedVoice) resolvedVoice = voices.find(v => v.lang === savedLang) || null;
+  if (!resolvedVoice) {
+    const preset = TTS_VOICES.find(p => p.lang === savedLang);
+    if (preset) resolvedVoice = _resolveVoice(preset);
+  }
+
+  if (voices.length && !resolvedVoice && !voices.some(v => v.lang.startsWith(savedLang.split('-')[0]))) {
+    // No installed voice can plausibly speak this language — speechSynthesis
+    // tends to fail silently in this case rather than throwing, so warn explicitly.
+    showToast('找不到對應的語音，請到設定 > 朗讀 選擇其他語言或人聲');
+    return;
+  }
+
+  _ttsQueue = _splitForTTS(text);
+  _ttsQueueIdx = 0;
+  _ttsTotalLen = text.length;
+  _ttsCharsBefore = 0;
   const rate = parseFloat(localStorage.getItem('tts_rate') || '1');
-  utter.rate = rate;
-  const resolvedVoice = _resolveVoice(preset);
-  if (resolvedVoice) utter.voice = resolvedVoice;
-  utter.onstart = () => {
-    ttsPlaying = true;
-    const btn = document.getElementById('tb-tts-btn');
-    if (btn) { btn.classList.add('active'); btn.textContent = '⏹'; }
-    document.getElementById('tts-progress').classList.add('active');
-  };
-  utter.onend = utter.onerror = () => {
-    ttsPlaying = false;
-    const btn = document.getElementById('tb-tts-btn');
-    if (btn) { btn.classList.remove('active'); btn.textContent = '🔊'; }
-    document.getElementById('tts-progress').classList.remove('active');
-    document.getElementById('tts-progress-bar').style.width = '0%';
-  };
-  utter.onboundary = (e) => {
-    if (utter.text.length > 0) {
-      const pct = Math.round((e.charIndex / utter.text.length) * 100);
+  const lang = resolvedVoice ? resolvedVoice.lang : savedLang;
+  const myGen = ++_ttsGen; // this run's identity
+
+  let failCount = 0;
+
+  const speakNext = () => {
+    if (myGen !== _ttsGen) return; // a newer run (or a stop) has superseded this one
+    if (_ttsQueueIdx >= _ttsQueue.length) { stopTTS(); return; }
+    const chunk = _ttsQueue[_ttsQueueIdx];
+    const utter = new SpeechSynthesisUtterance(chunk);
+    utter.lang = lang;
+    utter.rate = rate;
+    if (resolvedVoice) utter.voice = resolvedVoice;
+    utter.onstart = () => {
+      if (myGen !== _ttsGen) return;
+      ttsPlaying = true;
+      const btn = document.getElementById('tb-tts-btn');
+      if (btn) { btn.classList.add('active'); btn.textContent = '⏹'; }
+      document.getElementById('tts-progress').classList.add('active');
+    };
+    utter.onerror = (e) => {
+      if (myGen !== _ttsGen) return;
+      failCount++;
+      console.error('[TTS] chunk failed:', e?.error, chunk.slice(0, 30));
+      if (failCount === 1 && _ttsQueueIdx === 0) {
+        // First chunk failed outright — almost certainly a voice/lang problem,
+        // not a one-off network blip. Stop instead of silently limping through.
+        showToast('朗讀失敗，請到設定 > 朗讀 確認語言／人聲設定');
+        stopTTS();
+        return;
+      }
+      // Mid-article failure: skip this chunk and keep going so one bad
+      // sentence doesn't silence the rest of the article.
+      _ttsCharsBefore += chunk.length;
+      _ttsQueueIdx++;
+      speakNext();
+    };
+    utter.onend = () => {
+      if (myGen !== _ttsGen) return;
+      _ttsCharsBefore += chunk.length;
+      _ttsQueueIdx++;
+      const pct = Math.min(100, Math.round((_ttsCharsBefore / _ttsTotalLen) * 100));
       document.getElementById('tts-progress-bar').style.width = pct + '%';
-    }
+      speakNext();
+    };
+    ttsUtterance = utter;
+    speechSynthesis.speak(utter);
   };
-  ttsUtterance = utter;
-  speechSynthesis.speak(utter);
+
+  speakNext();
 };
 
 function stopTTS() {
   speechSynthesis.cancel();
   ttsPlaying = false;
+  _ttsGen++; // invalidate any in-flight callbacks from the run being stopped
+  clearInterval(_ttsKeepAliveTimer);
+  // Drop the queue so an in-flight onend from the previous utterance
+  // can't trigger speakNext() and resurrect playback after stop.
+  _ttsQueue = [];
+  _ttsQueueIdx = 0;
   const btn = document.getElementById('tb-tts-btn');
   if (btn) { btn.classList.remove('active'); btn.textContent = '🔊'; }
   const prog = document.getElementById('tts-progress');
   if (prog) prog.classList.remove('active');
+  const bar = document.getElementById('tts-progress-bar');
+  if (bar) bar.style.width = '0%';
 }
 
 // ── Mobile toolbar auto-hide ──
@@ -1691,7 +1812,7 @@
   ).join('');
   if (newFolderId) {
     const f = folders.find(f => f.id === newFolderId);
-    if (f) row.innerHTML += `<span class="reading-meta-tag" style="background:var(--accent2-light);color:var(--accent2);border-color:rgba(193,127,58,0.3)" onclick="newFolderId=null;renderNewMetaRow()">📁 ${escHtml(f.name)} ×</span>`;
+    if (f) row.innerHTML += `<span class="reading-meta-tag" style="background:var(--accent2-light);color:var(--accent2);border-color:rgba(193,127,58,0.3)" onclick="window.clearNewFolder()">📁 ${escHtml(f.name)} ×</span>`;
   }
 }
 
@@ -1723,6 +1844,8 @@
 
 window.removeNewTag = (tag) => { newTags = newTags.filter(t => t !== tag); renderNewMetaRow(); renderNewTagDropdown(); };
 
+window.clearNewFolder = () => { newFolderId = null; renderNewMetaRow(); renderNewFolderDropdown(); };
+
 function renderNewFolderDropdown() {
   const list = document.getElementById('new-folder-list');
   list.innerHTML = '';
@@ -1980,6 +2103,7 @@
   if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
 });
 
+window.renderSettingsBody = renderSettingsBody;
 function renderSettingsBody() {
   const body = document.getElementById('settings-body');
   if (currentSettingsTab === 'export') {
@@ -2058,7 +2182,7 @@
       </div>` : ''}
       <div class="settings-row" style="margin-top:4px">
         <label></label>
-        <button class="btn btn-danger" onclick="if(confirm('確定登出？'))signOut(auth)">登出</button>
+        <button class="btn btn-danger" onclick="doSignOut()">登出</button>
       </div>
     `;
   }
