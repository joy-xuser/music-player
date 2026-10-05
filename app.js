/* ═══════════════════════════════════════════════════════════════
   SurPlayer — app.js   (GitHub Pages build)
   Fixes vs previous version
   ─────────────────────────────────────────────────────────────
   1. Jamendo: fetch() with no-cors won't work from GH Pages;
      use JSONP instead (Jamendo supports ?callback=xxx).
   2. YT playlist: call cuePlaylist() in onReady → wait for
      CUED state → then getPlaylist() is guaranteed to return IDs.
   3. ytFrame sized 200×113 in CSS so the IFrame API inits OK.
   4. All global functions declared before the HTML onclick="" fires.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ── CONFIG ── */
const JAMENDO_CID = '709fa152';           // public test client_id
const YT_LIST     = 'PLTSRCGR4a75c';

/* ── STATE ── */
const S = {
  tab     : 'free',
  playing : false,
  muted   : false,
  looping : false,
  shuffled: false,
  vol     : 80,

  freeList : [],   // Jamendo results
  freeIdx  : -1,
  audio    : null, // current HTMLAudioElement (free music)

  ytPlayer : null,
  ytReady  : false,
  ytTracks : [],
  ytIdx    : 0,
  ytTimer  : null,
  ytCued   : false,
};

/* ── DOM ── */
const $  = id => document.getElementById(id);
const el = {
  playBtn   : $('playBtn'),
  prevBtn   : $('prevBtn'),
  nextBtn   : $('nextBtn'),
  shuffleBtn: $('shuffleBtn'),
  loopBtn   : $('loopBtn'),
  muteBtn   : $('muteBtn'),
  volSlider : $('volSlider'),
  progFill  : $('progFill'),
  progDot   : $('progDot'),
  progWrap  : $('progWrap'),
  tCur      : $('tCur'),
  tTot      : $('tTot'),
  heroTitle : $('heroTitle'),
  heroArtist: $('heroArtist'),
  heroSrc   : $('heroSrc'),
  artWrap   : $('artWrap'),
  artImg    : $('artImg'),
  artFb     : $('artFb'),
  ringBar   : $('ringBar'),
  eqBars    : $('eqBars'),
  bgBlur    : $('bgBlur'),
  freeList  : $('freeList'),
  freeLabel : $('freeLabel'),
  ytList    : $('ytList'),
  ytLabel   : $('ytLabel'),
  ytStatus  : $('ytStatus'),
  toast     : $('toast'),
  clock     : $('clock'),
  hornAudio : $('hornAudio'),
  canvas    : $('viz'),
};

/* ═══════════════════════════════════════════════════════════════
   BOOT — runs as soon as the script loads
═══════════════════════════════════════════════════════════════ */
(function boot() {
  clock();
  setupSeek();
  setupKeys();
  setupCanvas();
  // Load default genre right away so Free tab has content
  jamSearch('pop');
})();

/* ═══════════════════════════════════════════════════════════════
   CLOCK
═══════════════════════════════════════════════════════════════ */
function clock() {
  const tick = () => {
    const n = new Date(), p = v => String(v).padStart(2, '0');
    el.clock.textContent =
      `${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

/* ═══════════════════════════════════════════════════════════════
   CANVAS VISUALISER
═══════════════════════════════════════════════════════════════ */
let _actx, _analyser, _src, _raf;
const CIRC = 2 * Math.PI * 100; // ring circumference r=100

function setupCanvas() {
  const cv  = el.canvas;
  const ctx = cv.getContext('2d');
  const resize = () => { cv.width = innerWidth; cv.height = innerHeight; };
  addEventListener('resize', resize);
  resize();
  // idle loop — draws nothing but keeps raf running
  (function idle() { ctx.clearRect(0, 0, cv.width, cv.height); _raf = requestAnimationFrame(idle); })();
}

function connectAnalyser(audioEl) {
  try {
    if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
    if (_src)   { try { _src.disconnect(); } catch (_) {} }
    _src      = _actx.createMediaElementSource(audioEl);
    _analyser = _actx.createAnalyser();
    _analyser.fftSize = 64;
    _src.connect(_analyser);
    _analyser.connect(_actx.destination);
    cancelAnimationFrame(_raf);
    drawBars();
  } catch (_) {
    // cross-origin audio blocks analyser → fall back to CSS animation only
  }
}

function drawBars() {
  if (!_analyser) return;
  const cv  = el.canvas;
  const ctx = cv.getContext('2d');
  const buf = new Uint8Array(_analyser.frequencyBinCount);

  (function frame() {
    _raf = requestAnimationFrame(frame);
    _analyser.getByteFrequencyData(buf);
    ctx.clearRect(0, 0, cv.width, cv.height);

    const W = cv.width, H = cv.height;
    const bw = Math.max(2, W / buf.length - 1);

    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] / 255;
      const h = v * H * 0.65;
      const x = i * (bw + 1);
      const g = ctx.createLinearGradient(0, H, 0, H - h);
      g.addColorStop(0, `rgba(224,119,40,${0.2 + v * 0.3})`);
      g.addColorStop(1, `rgba(232,168,50,${0.2 + v * 0.3})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, H - h, bw, h, 3);
      else               ctx.rect(x, H - h, bw, h);
      ctx.fill();
    }

    // update EQ bars in sidebar
    const spans = el.eqBars.querySelectorAll('b');
    const step  = Math.max(1, Math.floor(buf.length / spans.length));
    spans.forEach((b, i) => {
      b.style.height = (5 + ((buf[i * step] || 0) / 255) * 24) + 'px';
    });

    ringProgress();
  })();
}

/* ═══════════════════════════════════════════════════════════════
   RING PROGRESS  (SVG circle around album art)
═══════════════════════════════════════════════════════════════ */
function ringProgress() {
  let pct = 0;
  if (S.tab === 'free' && S.audio && S.audio.duration) {
    pct = S.audio.currentTime / S.audio.duration;
  } else if (S.tab === 'yt' && S.ytReady) {
    try {
      const dur = S.ytPlayer.getDuration();
      if (dur) pct = S.ytPlayer.getCurrentTime() / dur;
    } catch (_) {}
  }
  el.ringBar.style.strokeDashoffset = CIRC - pct * CIRC;
}

/* ═══════════════════════════════════════════════════════════════
   TAB SWITCHING
═══════════════════════════════════════════════════════════════ */
function setTab(tab) {
  S.tab = tab;
  $('panelFree').classList.toggle('hidden', tab !== 'free');
  $('panelYT').classList.toggle('hidden',   tab !== 'yt');
  $('tabFree').classList.toggle('active',   tab === 'free');
  $('tabYT').classList.toggle('active',     tab === 'yt');

  if (tab === 'yt'   && S.audio && !S.audio.paused)   S.audio.pause();
  if (tab === 'free' && S.ytReady && S.playing)        S.ytPlayer.pauseVideo();
}
window.setTab = setTab;

/* ═══════════════════════════════════════════════════════════════
   FREE MUSIC — JAMENDO  (JSONP to avoid CORS issues)
═══════════════════════════════════════════════════════════════ */
let _jamCB = 0; // counter for unique callback names

function jamSearch(query) {
  query = (query || '').trim();
  if (!query) { toast('Type something to search'); return; }

  el.freeLabel.textContent = `Searching "${query}"…`;
  el.freeList.innerHTML =
    '<li class="row-loading"><div class="spinner"></div>Loading from Jamendo…</li>';

  // Build JSONP request
  const cbName = `_jam${++_jamCB}`;
  const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${JAMENDO_CID}`
    + `&format=jsonp&callback=${cbName}`
    + `&limit=40&search=${encodeURIComponent(query)}`
    + `&audioformat=mp32&imagesize=200&order=popularity_total`;

  // Timeout if Jamendo doesn't respond
  const tid = setTimeout(() => {
    if (window[cbName]) {
      delete window[cbName];
      el.freeList.innerHTML =
        '<li class="row-empty"><div class="ico">🔌</div>'
        + '<div>Jamendo did not respond — check connection</div></li>';
      el.freeLabel.textContent = 'Error';
      toast('⚠️ Jamendo unreachable');
    }
  }, 10000);

  window[cbName] = function (data) {
    clearTimeout(tid);
    delete window[cbName];
    document.getElementById(`_jscb_${cbName}`)?.remove();

    const tracks = (data && data.results) || [];
    S.freeList = tracks;
    S.freeIdx  = -1;

    if (!tracks.length) {
      el.freeList.innerHTML =
        `<li class="row-empty"><div class="ico">😕</div>`
        + `<div>No results for "${esc(query)}"</div></li>`;
      el.freeLabel.textContent = `No results for "${query}"`;
      return;
    }

    el.freeLabel.textContent = `${tracks.length} tracks · "${query}"`;
    renderFreeList();
  };

  const sc = document.createElement('script');
  sc.id  = `_jscb_${cbName}`;
  sc.src = url;
  sc.onerror = () => {
    clearTimeout(tid);
    delete window[cbName];
    sc.remove();
    el.freeList.innerHTML =
      '<li class="row-empty"><div class="ico">🔌</div>'
      + '<div>Could not reach Jamendo</div></li>';
    el.freeLabel.textContent = 'Error';
    toast('⚠️ Jamendo unreachable');
  };
  document.head.appendChild(sc);
}

function renderFreeList() {
  el.freeList.innerHTML = '';
  S.freeList.forEach((t, i) => {
    const active = i === S.freeIdx;
    const li     = document.createElement('li');
    li.className = 'track-item' + (active ? ' active' : '');

    const numCell = active && S.playing
      ? '<div class="ti-bars"><span></span><span></span><span></span></div>'
      : `<span class="ti-num">${i + 1}</span>`;

    const thumb = t.image
      ? `<img class="ti-thumb" src="${t.image}" alt="" loading="lazy"
             onerror="this.outerHTML='<div class=ti-ph>🎵</div>'">`
      : '<div class="ti-ph">🎵</div>';

    li.innerHTML = `
      <div>${numCell}</div>
      ${thumb}
      <div class="ti-meta">
        <div class="ti-title">${esc(t.name)}</div>
        <div class="ti-artist">${esc(t.artist_name)}</div>
      </div>
      <div class="ti-dur">${fmt(t.duration || 0)}</div>`;

    li.addEventListener('click', () => playFree(i));
    el.freeList.appendChild(li);
  });
}

function playFree(idx) {
  const t = S.freeList[idx];
  if (!t) return;

  // same track → toggle play/pause
  if (S.freeIdx === idx && S.audio) {
    if (S.playing && S.tab === 'free') { S.audio.pause(); }
    else { S.tab = 'free'; S.audio.play().catch(() => {}); }
    return;
  }

  // stop YouTube
  if (S.ytReady && S.playing && S.tab === 'yt') S.ytPlayer.pauseVideo();

  // destroy old audio element
  if (S.audio) { S.audio.pause(); S.audio.src = ''; S.audio = null; }

  const src = t.audio || t.audiodownload;
  if (!src) { toast('⚠️ No stream URL for this track'); return; }

  S.freeIdx = idx;
  S.tab     = 'free';

  // update hero immediately
  setHero(t.name, t.artist_name, '🆓 Free Music', t.image || '');
  el.tTot.textContent = fmt(t.duration || 0);
  el.tCur.textContent = '0:00';
  setBar(0, 1);

  const a = new Audio();
  a.crossOrigin = 'anonymous';
  a.src    = src;
  a.volume = S.vol / 100;
  a.muted  = S.muted;
  S.audio  = a;

  // connect analyser (may fail for cross-origin — that's fine)
  connectAnalyser(a);

  a.addEventListener('play', () => {
    S.playing = true;
    syncPlay(); spin(true); eq(true);
    renderFreeList();
    scrollTo('freeList', idx);
    toast(`▶  ${t.name}`);
  });
  a.addEventListener('pause', () => {
    S.playing = false; syncPlay(); spin(false); eq(false);
    renderFreeList();
  });
  a.addEventListener('timeupdate', () => {
    setBar(a.currentTime, a.duration || 0);
    el.tCur.textContent = fmt(a.currentTime);
    el.tTot.textContent = fmt(a.duration || 0);
    ringProgress();
  });
  a.addEventListener('ended', () => {
    S.playing = false; spin(false); eq(false);
    if (S.looping) { a.currentTime = 0; a.play().catch(() => {}); }
    else freeNext();
  });
  a.addEventListener('error', () => {
    toast('⚠️ Stream error — skipping');
    setTimeout(freeNext, 1200);
  });

  a.play().catch(() => {
    toast('▶ Tap the play button to start (autoplay blocked)');
    S.playing = false; syncPlay();
  });
}

function freeNext() {
  if (!S.freeList.length) return;
  const next = S.shuffled
    ? randIdx(S.freeList.length, S.freeIdx)
    : (S.freeIdx + 1) % S.freeList.length;
  playFree(next);
}
function freePrev() {
  if (!S.freeList.length) return;
  if (S.audio && S.audio.currentTime > 3) { S.audio.currentTime = 0; return; }
  const prev = S.shuffled
    ? randIdx(S.freeList.length, S.freeIdx)
    : (S.freeIdx - 1 + S.freeList.length) % S.freeList.length;
  playFree(prev);
}

/* exposed to HTML onclick */
function doSearch() {
  const q = $('searchInp').value.trim();
  if (!q) { toast('Type a search term first'); return; }
  jamSearch(q);
}
window.doSearch = doSearch;

function quickSearch(btn) {
  const q = btn.dataset.q;
  $('searchInp').value = q;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  jamSearch(q);
}
window.quickSearch = quickSearch;

/* ═══════════════════════════════════════════════════════════════
   YOUTUBE — IFrame API
   Flow: iframe loads → onYTReady fires → cuePlaylist() →
         CUED state fires → getPlaylist() works → render list
═══════════════════════════════════════════════════════════════ */
window.onYouTubeIframeAPIReady = function () {
  S.ytPlayer = new YT.Player('ytFrame', {
    events: {
      onReady:       onYTReady,
      onStateChange: onYTState,
      onError:       onYTError,
    }
  });
};

function onYTReady() {
  S.ytReady = true;
  S.ytPlayer.setVolume(S.vol);
  el.ytStatus.textContent = 'Cueing playlist…';

  // cuePlaylist() transitions player to CUED state
  // — that's when getPlaylist() returns the ID array.
  try {
    S.ytPlayer.cuePlaylist({ listType: 'playlist', list: YT_LIST, index: 0 });
  } catch (e) {
    // If API isn't fully ready yet, retry once
    setTimeout(() => {
      try { S.ytPlayer.cuePlaylist({ listType: 'playlist', list: YT_LIST, index: 0 }); }
      catch (_) { el.ytStatus.textContent = 'Could not load playlist'; }
    }, 1500);
  }
}

function onYTState(e) {
  const YS = YT.PlayerState;

  /* ── CUED: playlist IDs are now available ── */
  if (e.data === YS.CUED) {
    if (!S.ytCued) {
      S.ytCued = true;
      loadYTIds();
    }
    S.playing = false;
    syncPlay();
    return;
  }

  /* ── PLAYING ── */
  if (e.data === YS.PLAYING) {
    S.playing = true; S.tab = 'yt';
    syncPlay(); spin(true); eq(true);
    startYTTimer();

    const idx = S.ytPlayer.getPlaylistIndex();
    if (idx >= 0) {
      S.ytIdx = idx;
      // Fill real title/artist from video data
      const vd = S.ytPlayer.getVideoData();
      if (vd && vd.title && S.ytTracks[idx]) {
        S.ytTracks[idx].title  = vd.title;
        if (vd.author)   S.ytTracks[idx].artist = vd.author;
        if (vd.video_id) {
          S.ytTracks[idx].id    = vd.video_id;
          S.ytTracks[idx].thumb =
            `https://img.youtube.com/vi/${vd.video_id}/mqdefault.jpg`;
        }
      }
      const dur = S.ytPlayer.getDuration();
      if (dur && S.ytTracks[idx]) {
        S.ytTracks[idx].dur = fmt(dur);
        el.tTot.textContent = fmt(dur);
      }
      const tr = S.ytTracks[idx];
      setHero(tr.title, tr.artist, '▶ YouTube', tr.thumb);
      renderYTList();
      scrollTo('ytList', idx);
    }
    return;
  }

  /* ── PAUSED ── */
  if (e.data === YS.PAUSED) {
    S.playing = false; syncPlay(); spin(false); eq(false);
    stopYTTimer();
    return;
  }

  /* ── ENDED ── */
  if (e.data === YS.ENDED) {
    S.playing = false; syncPlay(); spin(false); eq(false);
    stopYTTimer();
    if (S.looping) { S.ytPlayer.seekTo(0); S.ytPlayer.playVideo(); }
    else ytNext();
    return;
  }

  /* ── BUFFERING ── */
  if (e.data === YS.BUFFERING) {
    // keep UI in playing state while buffering
    syncPlay();
  }
}

function onYTError(e) {
  console.warn('YT error code:', e.data);
  toast('⚠️ YouTube video error — skipping');
  setTimeout(ytNext, 1500);
}

/* Called once CUED fires — getPlaylist() is reliable now */
function loadYTIds() {
  try {
    const ids = S.ytPlayer.getPlaylist();
    if (!ids || !ids.length) {
      el.ytStatus.textContent = 'Playlist empty — try refreshing';
      return;
    }

    S.ytTracks = ids.map((id, i) => ({
      index : i,
      id    : id,
      title : `Track ${i + 1}`,
      artist: 'Boithak — Indie',
      thumb : `https://img.youtube.com/vi/${id}/mqdefault.jpg`,
      dur   : '—',
    }));

    el.ytLabel.textContent  = `${ids.length} tracks · Boithak Indie`;
    el.ytStatus.textContent = `${ids.length} tracks loaded — click to play`;
    renderYTList();
    toast(`🎵 YouTube playlist ready — ${ids.length} tracks`);

  } catch (err) {
    console.warn('loadYTIds error:', err);
    el.ytStatus.textContent = 'Could not read playlist IDs';
  }
}

function renderYTList() {
  el.ytList.innerHTML = '';

  if (!S.ytTracks.length) {
    el.ytList.innerHTML =
      '<li class="row-loading"><div class="spinner"></div>Waiting for YouTube…</li>';
    return;
  }

  S.ytTracks.forEach((t, i) => {
    const active = i === S.ytIdx;
    const li     = document.createElement('li');
    li.className = 'track-item' + (active ? ' active' : '');

    const numCell = active && S.playing
      ? '<div class="ti-bars"><span></span><span></span><span></span></div>'
      : `<span class="ti-num">${i + 1}</span>`;

    li.innerHTML = `
      <div>${numCell}</div>
      <img class="ti-thumb" src="${t.thumb}" alt="" loading="lazy"
           onerror="this.outerHTML='<div class=ti-ph>🎵</div>'">
      <div class="ti-meta">
        <div class="ti-title">${esc(t.title)}</div>
        <div class="ti-artist">${esc(t.artist)}</div>
      </div>
      <div class="ti-dur">${t.dur}</div>`;

    li.addEventListener('click', () => ytPlayAt(i));
    el.ytList.appendChild(li);
  });
}

function ytPlayAt(i) {
  if (!S.ytReady || !S.ytPlayer) { toast('YouTube still loading…'); return; }
  S.ytIdx = i; S.tab = 'yt';
  if (S.audio) S.audio.pause();
  S.ytPlayer.playVideoAt(i);
  S.playing = true; syncPlay(); spin(true); eq(true);
  const tr = S.ytTracks[i];
  if (tr) setHero(tr.title, tr.artist, '▶ YouTube', tr.thumb);
  renderYTList();
  scrollTo('ytList', i);
}

function ytNext() {
  if (!S.ytReady) return;
  if (S.shuffled) ytPlayAt(randIdx(S.ytTracks.length, S.ytIdx));
  else            S.ytPlayer.nextVideo();
}
function ytPrev() {
  if (!S.ytReady) return;
  try {
    if (S.ytPlayer.getCurrentTime() > 3) { S.ytPlayer.seekTo(0, true); return; }
  } catch (_) {}
  if (S.shuffled) ytPlayAt(randIdx(S.ytTracks.length, S.ytIdx));
  else            S.ytPlayer.previousVideo();
}

/* YT progress timer (polls every 300 ms while playing) */
function startYTTimer() {
  stopYTTimer();
  S.ytTimer = setInterval(() => {
    if (!S.ytReady || S.tab !== 'yt') return;
    try {
      const cur = S.ytPlayer.getCurrentTime();
      const dur = S.ytPlayer.getDuration();
      if (!dur) return;
      setBar(cur, dur);
      el.tCur.textContent = fmt(cur);
      el.tTot.textContent = fmt(dur);
      ringProgress();
    } catch (_) {}
  }, 300);
}
function stopYTTimer() { clearInterval(S.ytTimer); S.ytTimer = null; }

/* ═══════════════════════════════════════════════════════════════
   UNIFIED CONTROLS  (hooked to HTML onclick="" attributes)
═══════════════════════════════════════════════════════════════ */
function doPlay() {
  if (S.tab === 'free') {
    if (!S.audio) {
      if (S.freeList.length) playFree(0);
      else toast('Search for a song first');
      return;
    }
    S.playing ? S.audio.pause() : S.audio.play().catch(() => {});
  } else {
    if (!S.ytReady) { toast('YouTube still loading…'); return; }
    S.playing ? S.ytPlayer.pauseVideo() : S.ytPlayer.playVideo();
  }
}
window.doPlay = doPlay;

function doPrev() {
  S.tab === 'free' ? freePrev() : ytPrev();
}
window.doPrev = doPrev;

function doNext() {
  S.tab === 'free' ? freeNext() : ytNext();
}
window.doNext = doNext;

function toggleShuffle() {
  S.shuffled = !S.shuffled;
  el.shuffleBtn.classList.toggle('on', S.shuffled);
  toast(S.shuffled ? '⇄ Shuffle ON' : '⇄ Shuffle OFF');
}
window.toggleShuffle = toggleShuffle;

function toggleLoop() {
  S.looping = !S.looping;
  el.loopBtn.classList.toggle('on', S.looping);
  toast(S.looping ? '↻ Loop ON' : '↻ Loop OFF');
}
window.toggleLoop = toggleLoop;

function doMute() {
  S.muted = !S.muted;
  if (S.audio)   S.audio.muted = S.muted;
  if (S.ytReady) S.muted ? S.ytPlayer.mute() : S.ytPlayer.unMute();
  el.muteBtn.textContent  = S.muted ? '🔇' : (S.vol < 40 ? '🔉' : '🔊');
  el.volSlider.value      = S.muted ? 0 : S.vol;
}
window.doMute = doMute;

function setVol(v) {
  S.vol   = v;
  S.muted = v === 0;
  if (S.audio)   S.audio.volume = v / 100;
  if (S.ytReady) S.ytPlayer.setVolume(v);
  el.muteBtn.textContent = v === 0 ? '🔇' : v < 40 ? '🔉' : '🔊';
}
window.setVol = setVol;

/* ═══════════════════════════════════════════════════════════════
   SEEK BAR
═══════════════════════════════════════════════════════════════ */
function setupSeek() {
  let drag = false;

  const seek = cx => {
    const r   = el.progWrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (cx - r.left) / r.width));
    if (S.tab === 'free' && S.audio) {
      const dur = S.audio.duration || 0;
      if (dur) { S.audio.currentTime = pct * dur; setBar(pct * dur, dur); }
    } else if (S.ytReady) {
      try {
        const dur = S.ytPlayer.getDuration();
        if (dur) { S.ytPlayer.seekTo(pct * dur, true); setBar(pct * dur, dur); }
      } catch (_) {}
    }
  };

  el.progWrap.addEventListener('mousedown',  e  => { drag = true; seek(e.clientX); });
  document.addEventListener(   'mousemove',  e  => { if (drag) seek(e.clientX); });
  document.addEventListener(   'mouseup',    () => { drag = false; });
  el.progWrap.addEventListener('touchstart', e  => { drag = true; seek(e.touches[0].clientX); }, { passive: true });
  document.addEventListener(   'touchmove',  e  => { if (drag) seek(e.touches[0].clientX); },    { passive: true });
  document.addEventListener(   'touchend',   () => { drag = false; });
}

function setBar(cur, dur) {
  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  el.progFill.style.width = pct + '%';
  el.progDot.style.left   = `calc(${pct}% - 6px)`;
}

/* ═══════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
═══════════════════════════════════════════════════════════════ */
function setupKeys() {
  document.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

    const seekRel = delta => {
      if (S.tab === 'free' && S.audio) {
        S.audio.currentTime =
          Math.max(0, Math.min(S.audio.duration || 0, S.audio.currentTime + delta));
      } else if (S.ytReady) {
        try {
          const c = S.ytPlayer.getCurrentTime();
          const d = S.ytPlayer.getDuration();
          S.ytPlayer.seekTo(Math.max(0, Math.min(d, c + delta)), true);
        } catch (_) {}
      }
    };

    switch (e.code) {
      case 'Space':
        e.preventDefault(); doPlay(); break;
      case 'ArrowRight':
        e.preventDefault(); e.shiftKey ? doNext() : seekRel(+10); break;
      case 'ArrowLeft':
        e.preventDefault(); e.shiftKey ? doPrev() : seekRel(-10); break;
      case 'ArrowUp':
        e.preventDefault();
        setVol(Math.min(100, S.vol + 10));
        el.volSlider.value = S.vol; break;
      case 'ArrowDown':
        e.preventDefault();
        setVol(Math.max(0, S.vol - 10));
        el.volSlider.value = S.vol; break;
      case 'KeyH': blowHorn();       break;
      case 'KeyM': doMute();         break;
      case 'KeyS': toggleShuffle();  break;
      case 'KeyL': toggleLoop();     break;
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   HORN  🐚
═══════════════════════════════════════════════════════════════ */
function blowHorn() {
  const ha = el.hornAudio;
  if (ha && ha.readyState >= 2) {
    ha.currentTime = 0;
    ha.play().catch(hornSynth);
  } else {
    hornSynth();
  }
  toast('🐚 শঙ্খ বেজে উঠলো!');
}
window.blowHorn = blowHorn;

function hornSynth() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator();
    const g = c.createGain();
    const w = c.createWaveShaper();
    const b = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i * 2) / 256 - 1;
      b[i] = (Math.PI + 180) * x / (Math.PI + 180 * Math.abs(x));
    }
    w.curve = b;
    o.connect(w); w.connect(g); g.connect(c.destination);
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(145, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(275, c.currentTime + 0.22);
    o.frequency.setValueAtTime(255, c.currentTime + 0.28);
    o.frequency.exponentialRampToValueAtTime(192, c.currentTime + 1.5);
    g.gain.setValueAtTime(0.38, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 1.8);
    o.start(c.currentTime);
    o.stop(c.currentTime + 1.8);
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════════════════
   THEME TOGGLE
═══════════════════════════════════════════════════════════════ */
function toggleTheme() {
  document.body.classList.toggle('light');
  $('themeBtn').textContent =
    document.body.classList.contains('light') ? '☀️' : '🌙';
}
window.toggleTheme = toggleTheme;

/* ═══════════════════════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════════════════════ */
function setHero(title, artist, src, imgUrl) {
  el.heroTitle.textContent  = title;
  el.heroArtist.textContent = artist;
  el.heroSrc.textContent    = src;

  if (imgUrl) {
    el.artImg.src = imgUrl;
    el.artImg.style.display = 'block';
    el.artFb.style.display  = 'none';
    el.bgBlur.style.backgroundImage = `url('${imgUrl}')`;
  } else {
    el.artImg.style.display = 'none';
    el.artFb.style.display  = 'flex';
    el.bgBlur.style.backgroundImage = 'none';
  }
  el.artImg.onerror = () => {
    el.artImg.style.display = 'none';
    el.artFb.style.display  = 'flex';
  };
}

function syncPlay() {
  el.playBtn.textContent = S.playing ? '⏸' : '▶';
}

function spin(on) {
  el.artWrap.classList.toggle('spin', on);
}

function eq(on) {
  el.eqBars.classList.toggle('on', on);
}

function scrollTo(listId, idx) {
  const ul    = $(listId);
  const items = ul.querySelectorAll('.track-item');
  if (items[idx]) items[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── TOAST ── */
let _toastT = null;
function toast(msg, ms = 2800) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.toast.classList.remove('show'), ms);
}

/* ── UTILITIES ── */
function fmt(s) {
  if (!s || isNaN(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function randIdx(len, cur) {
  if (len <= 1) return 0;
  let i;
  do { i = Math.floor(Math.random() * len); } while (i === cur);
  return i;
}
