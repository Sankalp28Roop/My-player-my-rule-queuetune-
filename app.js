/**
 * StrictQueue - Strict Audiophile YouTube Music Queue Player
 * Zero Autoplay, Zero Algorithmic Recommendations, Strict Manual Queue.
 * Tab Navigation & State Preserving Multi-View Engine.
 */

(function () {
  'use strict';

  // --- STATE ---
  let queue = [];
  let currentIndex = -1;
  let isLoopQueue = false;
  let isMuted = false;
  let currentVolume = 100;
  let currentSpeed = 1.0;
  let isSeeking = false;
  let timeUpdateInterval = null;
  let toastTimer = null;
  let currentTheme = 'dark';
  let activeTab = 'dashboard';
  let autoSkipRestricted = true;
  let sessionTracksPlayed = 0;
  let profileDisplayName = 'Sankalp';

  // YouTube API Player Instance
  let ytPlayer = null;
  let isYtReady = false;
  let playerState = -1; // -1: unstarted, 0: ended, 1: playing, 2: paused, 3: buffering, 5: cued

  // Storage Keys
  const STORAGE_QUEUE = 'strictqueue_queue';
  const STORAGE_INDEX = 'strictqueue_current_index';
  const STORAGE_THEME = 'strictqueue_theme';
  const STORAGE_LAST_DARK = 'strictqueue_last_dark_theme';
  const STORAGE_GLOW = 'strictqueue_ambient_glow';
  const STORAGE_LOOP = 'strictqueue_loop';
  const STORAGE_AUTOSKIP = 'strictqueue_autoskip';
  const STORAGE_STATS = 'strictqueue_stats';
  const STORAGE_PROFILE = 'strictqueue_profile';
  const STORAGE_YT_API_KEY = 'strictqueue_yt_api_key';
  const STORAGE_GEMINI_API_KEY = 'strictqueue_gemini_api_key';
  const STORAGE_VOLUME = 'strictqueue_volume';
  const STORAGE_MUTED = 'strictqueue_muted';
  const STORAGE_HAS_SEEN_GUIDE = 'strictqueue_has_seen_guide';
  const STORAGE_DROPS = 'strictqueue_timestamp_drops';

  let lastDarkTheme = 'dark'; // 'dark' | 'slate' | 'oled'
  let isAmbientGlowOn = true;
  let currentIngestMode = 'url'; // 'url' | 'search'
  let searchDebounceTimer = null;
  let activeSearchResults = [];
  let youtubeApiKey = '';
  let geminiApiKey = '';
  let volumeHudTimer = null;

  // Voice Assistant State
  let voiceRecognition = null;
  let isVoiceListening = false;

  // Mini-Player & PiP State
  let pipWindow = null;
  let isFloatingMiniPlayerOpen = false;

  // Lyrics & Drops State
  let currentLyricsData = null; // { lines: [{ time, text }], isSynced: boolean }
  let activeLyricIndex = -1;
  let isLyricsLoading = false;
  let lyricsLastTrackId = null;
  let activeLyricsTab = 'lyrics'; // 'lyrics' | 'drops'

  // Per-Track DJ Tuning Modal State
  let tuningTrackIndex = -1;
  let tuningTempSpeed = 1.0;

  // AI Track Advisor State
  let currentAiVibe = 'same_vibe'; // 'same_vibe' | 'slowed' | 'remix' | 'discovery'
  let currentAiSuggestions = [];
  let isAiAdvisorCollapsed = false;
  let isAiAdvisorLoading = false;
  let aiAdvisorLastTrackId = null;

  // --- TRACK NORMALIZATION & SCHEMA INTEGRITY ---
  const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

  function isValidYouTubeId(id) {
    return typeof id === 'string' && YOUTUBE_ID_REGEX.test(id.trim());
  }

  function sanitizePlainString(input, fallback = '') {
    if (typeof input !== 'string') return fallback;
    // Strip control characters and trim
    return input.replace(/[\x00-\x1F\x7F]/g, '').trim() || fallback;
  }

  function normalizeTrack(rawTrack) {
    if (!rawTrack) return null;

    const rawId = rawTrack.videoId || rawTrack.id || (typeof rawTrack === 'string' ? parseYouTubeVideoId(rawTrack) : null);
    if (!rawId || !isValidYouTubeId(rawId)) return null;
    const videoId = rawId.trim();

    const rawTitle = sanitizePlainString(rawTrack.title || rawTrack.name || '', '');
    const cleanTitle = rawTitle.length > 0 ? rawTitle : `YouTube Video (${videoId})`;

    const rawArtist = sanitizePlainString(rawTrack.artist || rawTrack.author || rawTrack.channel || rawTrack.uploaderName || rawTrack.channelTitle || '', '');
    const cleanArtist = rawArtist.length > 0 ? rawArtist : 'YouTube';

    // Strictly enforce official YouTube thumbnail path to eliminate SSRF / malicious image URLs
    const cleanThumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const cleanDuration = sanitizePlainString(rawTrack.duration, '--:--');
    const uniqueId = (typeof rawTrack.id === 'string' && rawTrack.id.includes('-') && /^[a-zA-Z0-9_-]+$/.test(rawTrack.id))
      ? rawTrack.id
      : `${videoId}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

    // Smart Playback & DJ Micro-Controls (Per-Track Trim, Speed, Gain) - Strictly sanitize bounds
    const startAt = (typeof rawTrack.startAt === 'number' && Number.isFinite(rawTrack.startAt) && rawTrack.startAt >= 0 && rawTrack.startAt <= 86400)
      ? Math.round(rawTrack.startAt * 10) / 10
      : 0;
    const endAt = (typeof rawTrack.endAt === 'number' && Number.isFinite(rawTrack.endAt) && rawTrack.endAt > startAt && rawTrack.endAt <= 86400)
      ? Math.round(rawTrack.endAt * 10) / 10
      : null;
    const playbackRate = (typeof rawTrack.playbackRate === 'number' && Number.isFinite(rawTrack.playbackRate) && rawTrack.playbackRate >= 0.25 && rawTrack.playbackRate <= 2.0)
      ? Math.round(rawTrack.playbackRate * 100) / 100
      : 1.0;
    const gainOffset = (typeof rawTrack.gainOffset === 'number' && Number.isFinite(rawTrack.gainOffset) && rawTrack.gainOffset >= -20 && rawTrack.gainOffset <= 20)
      ? Math.round(rawTrack.gainOffset)
      : 0;

    return {
      id: uniqueId,
      videoId: videoId,
      title: cleanTitle,
      artist: cleanArtist,
      thumbnail: cleanThumb,
      duration: cleanDuration,
      restricted: !!rawTrack.restricted,
      startAt: startAt,
      endAt: endAt,
      playbackRate: playbackRate,
      gainOffset: gainOffset
    };
  }

  // Default Initial Tracks (Strict User Queue)
  const DEFAULT_INITIAL_TRACKS = [
    normalizeTrack({
      videoId: 'QCouL-DkKQ4',
      title: 'NUEKI, QMIIR - MONTAGEM AHORA (SLOWED)',
      artist: 'NUEKI, QMIIR',
      thumbnail: 'https://i.ytimg.com/vi/QCouL-DkKQ4/hqdefault.jpg',
      duration: '02:08'
    }),
    normalizeTrack({
      videoId: 'w5iymasCIRA',
      title: 'Montagem Nada Tropica (best part/tiktok vers.) - Eternxlkz [edit audio]',
      artist: 'Eternxlkz',
      thumbnail: 'https://i.ytimg.com/vi/w5iymasCIRA/hqdefault.jpg',
      duration: '01:54'
    }),
    normalizeTrack({
      videoId: '-bnCtE5Taqk',
      title: 'Dj Samir, Nulteex, John Bis.T, RXDXVIL - MONTAGEM ELDER (Ultra Slowed)',
      artist: 'Dj Samir, Nulteex, John Bis.T, RXDXVIL',
      thumbnail: 'https://i.ytimg.com/vi/-bnCtE5Taqk/hqdefault.jpg',
      duration: '01:46'
    }),
    normalizeTrack({
      videoId: 'OxXKDGO-MYQ',
      title: 'LAAVAN (Music Video) Jasmine Sandlas | Mofusion | Pro Media',
      artist: 'Jasmine Sandlas • Pro Media',
      thumbnail: 'https://i.ytimg.com/vi/OxXKDGO-MYQ/hqdefault.jpg',
      duration: '03:12'
    }),
    normalizeTrack({
      videoId: 'Hu0ZrBRNglo',
      title: 'Levitating x Woh Ladki Jo - (Dj Ruchir Mashup) | Instagram Trending Reel | Original Mashup | 2023',
      artist: 'Dj Ruchir',
      thumbnail: 'https://i.ytimg.com/vi/Hu0ZrBRNglo/hqdefault.jpg',
      duration: '02:44'
    })
  ].filter(Boolean);

  // Curated Preset Tracks for Quick Ingestion
  const CURATED_TRACKS = [...DEFAULT_INITIAL_TRACKS];

  // --- DOM ELEMENTS ---
  const els = {
    // Nav Tabs & Views
    navTabs: document.getElementById('nav-tabs'),
    views: {
      dashboard: document.getElementById('view-dashboard'),
      queue: document.getElementById('view-queue'),
      'now-playing': document.getElementById('view-now-playing'),
      settings: document.getElementById('view-settings')
    },

    // Inputs (Dashboard)
    urlInput: document.getElementById('url-input'),
    addToQueueBtn: document.getElementById('add-to-queue-btn'),
    playNextBtn: document.getElementById('play-next-btn'),
    inputModeIcon: document.getElementById('input-mode-icon'),
    tabUrlBtn: document.getElementById('tab-url-btn'),
    tabSearchBtn: document.getElementById('tab-search-btn'),
    searchSpinner: document.getElementById('search-spinner'),
    searchResultsDropdown: document.getElementById('search-results-dropdown'),
    searchDropdownList: document.getElementById('search-dropdown-list'),
    searchQueryBadge: document.getElementById('search-query-badge'),
    searchResultsContainer: document.getElementById('search-results-container'),
    searchStatusTag: document.getElementById('search-status-tag'),
    apiKeyInput: document.getElementById('youtube-api-key-input'),

    // Toast
    toastBanner: document.getElementById('toast-banner'),
    toastIcon: document.getElementById('toast-icon'),
    toastMessage: document.getElementById('toast-message'),

    // Player Theater HUD (Dashboard)
    videoTheater: document.getElementById('video-theater-container'),
    videoPoster: document.getElementById('video-poster'),
    playerTitle: document.getElementById('player-title'),
    playerChannel: document.getElementById('player-channel'),
    playerStatusBadge: document.getElementById('player-status-badge'),
    volumeHudPill: document.getElementById('volume-hud-pill'),
    volumeHudIcon: document.getElementById('volume-hud-icon'),
    volumeHudBar: document.getElementById('volume-hud-bar'),
    volumeHudText: document.getElementById('volume-hud-text'),
    queueCompleteOverlay: document.getElementById('queue-complete-overlay'),
    restrictedOverlay: document.getElementById('restricted-video-overlay'),
    restrictedLink: document.getElementById('restricted-external-link'),
    completeTracksCount: document.getElementById('complete-tracks-count'),

    // Video Card Controls (Dashboard)
    cardPlayPauseBtn: document.getElementById('card-play-pause-btn'),
    cardScrubBar: document.getElementById('card-scrub-bar'),
    cardScrubProgress: document.getElementById('card-scrub-progress'),
    cardTimeDisplay: document.getElementById('card-time-display'),
    cardVolumeSlider: document.getElementById('card-volume-slider'),
    cardVolumeBar: document.getElementById('card-volume-bar'),
    cardVolumeIcon: document.getElementById('card-volume-icon'),
    loopToggleBtn: document.getElementById('loop-toggle-btn'),
    loopModeLabel: document.getElementById('loop-mode-label'),

    // Queue Sidebar (Dashboard)
    queueContainer: document.getElementById('queue-items-container'),
    emptyQueueSlate: document.getElementById('empty-queue-slate'),
    clearConfirmBanner: document.getElementById('clear-confirm-banner'),
    navQueueCount: document.getElementById('nav-queue-count'),
    sidebarQueueBadge: document.getElementById('sidebar-queue-badge'),
    sidebarLoopBtn: document.getElementById('sidebar-loop-btn'),
    sidebarLoopLabel: document.getElementById('sidebar-loop-label'),

    // Footer Controls
    footerThumb: document.getElementById('footer-thumb'),
    footerPlaceholderIcon: document.getElementById('footer-placeholder-icon'),
    footerTitle: document.getElementById('footer-title'),
    footerArtist: document.getElementById('footer-artist'),
    footerPlayPauseBtn: document.getElementById('footer-play-pause-btn'),
    footerScrubBar: document.getElementById('footer-scrub-bar'),
    footerScrubProgress: document.getElementById('footer-scrub-progress'),
    footerTimeCurrent: document.getElementById('footer-time-current'),
    footerTimeTotal: document.getElementById('footer-time-total'),
    footerVolumeSlider: document.getElementById('footer-volume-slider'),
    footerVolumeBar: document.getElementById('footer-volume-bar'),
    footerVolumeIcon: document.getElementById('footer-volume-icon'),
    footerLoopBtn: document.getElementById('footer-loop-btn'),

    // Popovers & Header Actions
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    themeIcon: document.getElementById('theme-icon'),
    audioSettingsBtn: document.getElementById('audio-settings-btn'),
    audioPopover: document.getElementById('audio-popover'),
    popoverVolText: document.getElementById('popover-vol-text'),
    popoverVolIcon: document.getElementById('popover-vol-icon'),
    popoverVolSlider: document.getElementById('popover-vol-slider'),
    popoverVolBar: document.getElementById('popover-vol-bar'),
    popoverAutoSkipToggle: document.getElementById('popover-auto-skip-toggle'),
    profileBtn: document.getElementById('profile-btn'),
    profilePopover: document.getElementById('profile-popover'),
    profileDisplayName: document.getElementById('profile-display-name'),
    popoverStatQueue: document.getElementById('popover-stat-queue'),
    popoverStatPlayed: document.getElementById('popover-stat-played'),

    // Queue Manager View Elements (view-queue)
    qmFullQueueContainer: document.getElementById('qm-full-queue-container'),
    qmEmptySlate: document.getElementById('qm-empty-slate'),
    qmHeroThumb: document.getElementById('qm-hero-thumb'),
    qmHeroTitle: document.getElementById('qm-hero-title'),
    qmHeroArtist: document.getElementById('qm-hero-artist'),
    qmHeroScrubBar: document.getElementById('qm-hero-scrub-bar'),
    qmHeroTimeCur: document.getElementById('qm-hero-time-cur'),
    qmHeroTimeTotal: document.getElementById('qm-hero-time-total'),
    qmActivePos: document.getElementById('qm-active-pos'),
    qmRemainingTime: document.getElementById('qm-remaining-time'),

    // Now Playing View Elements (view-now-playing)
    npStageCanvas: document.getElementById('np-stage-canvas'),
    npEmptyStage: document.getElementById('np-empty-stage'),
    npStageTitle: document.getElementById('np-stage-title'),
    npStageUrl: document.getElementById('np-stage-url'),
    npTrackTitle: document.getElementById('np-track-title'),
    npTrackArtist: document.getElementById('np-track-artist'),
    npPlayPauseBtn: document.getElementById('np-play-pause-btn'),
    npTimeCur: document.getElementById('np-time-cur'),
    npTimeTotal: document.getElementById('np-time-total'),
    npScrubBar: document.getElementById('np-scrub-bar'),
    npUpNextTitle: document.getElementById('np-up-next-title'),
    npQueueItemsContainer: document.getElementById('np-queue-items-container'),
    npLoopBtn: document.getElementById('np-loop-btn'),

    // Settings View Elements (view-settings)
    geminiApiKeyInput: document.getElementById('gemini-api-key-input'),
    geminiKeyStatusBadge: document.getElementById('gemini-key-status-badge'),
    btnOpenClearModal: document.getElementById('btn-open-clear-modal'),
    clearConfirmModal: document.getElementById('clear-confirm-modal'),
    btnCancelClear: document.getElementById('btn-cancel-clear'),
    btnConfirmClear: document.getElementById('btn-confirm-clear'),

    // AI Track Advisor Elements
    aiAdvisorPanel: document.getElementById('ai-advisor-panel'),
    aiAdvisorContent: document.getElementById('ai-advisor-content'),
    aiAdvisorList: document.getElementById('ai-advisor-list'),
    aiAdvisorRefreshIcon: document.getElementById('ai-advisor-refresh-icon'),
    aiAdvisorCollapseIcon: document.getElementById('ai-advisor-collapse-icon'),
    aiAdvisorEngineBadge: document.getElementById('ai-advisor-engine-badge'),
    aiAdvisorTopBtn: document.getElementById('ai-advisor-top-btn'),
    aiAdvisorDrawer: document.getElementById('ai-advisor-drawer'),
    aiAdvisorDrawerBackdrop: document.getElementById('ai-advisor-drawer-backdrop'),
    aiDrawerCurrentTitle: document.getElementById('ai-drawer-current-title'),
    aiDrawerList: document.getElementById('ai-drawer-list'),

    // Overview Modal & Voice Elements
    guideModalBtn: document.getElementById('guide-modal-btn'),
    overviewModalBackdrop: document.getElementById('overview-modal-backdrop'),
    overviewDontShowCheckbox: document.getElementById('overview-dont-show-checkbox'),
    voiceSearchBtn: document.getElementById('voice-search-btn'),
    voiceMicIcon: document.getElementById('voice-mic-icon'),

    // Floating Mini-Player Elements
    floatingMiniPlayer: document.getElementById('floating-mini-player'),
    miniPlayerThumb: document.getElementById('mini-player-thumb'),
    miniPlayerTitle: document.getElementById('mini-player-title'),
    miniPlayerArtist: document.getElementById('mini-player-artist'),
    miniPlayerPlayBtn: document.getElementById('mini-player-play-btn'),
    miniPlayerVolIcon: document.getElementById('mini-player-vol-icon'),

    // Lyrics & Drops Drawer Elements
    lyricsDrawer: document.getElementById('lyrics-drawer'),
    lyricsDrawerBackdrop: document.getElementById('lyrics-drawer-backdrop'),
    lyricsTrackStatus: document.getElementById('lyrics-track-status'),
    tabLyricsBtn: document.getElementById('tab-lyrics-btn'),
    tabDropsBtn: document.getElementById('tab-drops-btn'),
    lyricsTabContent: document.getElementById('lyrics-tab-content'),
    dropsTabContent: document.getElementById('drops-tab-content'),
    lyricsLinesContainer: document.getElementById('lyrics-lines-container'),
    dropsCountBadge: document.getElementById('drops-count-badge'),
    dropsCurrentTimePeek: document.getElementById('drops-current-time-peek'),
    dropLabelInput: document.getElementById('drop-label-input'),
    dropsListContainer: document.getElementById('drops-list-container'),

    // Per-Track DJ Tuning Modal Elements
    trackTuningModal: document.getElementById('track-tuning-modal'),
    tuningTrackTitle: document.getElementById('tuning-track-title'),
    tuningStartAt: document.getElementById('tuning-start-at'),
    tuningEndAt: document.getElementById('tuning-end-at'),
    tuningSpeedDisplay: document.getElementById('tuning-speed-display'),
    tuningSpeedPills: document.getElementById('tuning-speed-pills'),
    tuningGainSlider: document.getElementById('tuning-gain-slider'),
    tuningGainDisplay: document.getElementById('tuning-gain-display')
  };

  // --- INITIALIZATION ---
  function init() {
    loadSavedSettings();
    updateTabPills();
    renderQueue();
    renderSearchResults(CURATED_TRACKS);
    setupEventListeners();
    initYouTubeAPI();
    initMediaSession();
    registerServiceWorker();
    checkSharedQueueHash();
    checkFirstVisitGuide();
  }

  // --- LOCAL STORAGE ---
  function loadSavedSettings() {
    // Theme
    try {
      const savedTheme = localStorage.getItem(STORAGE_THEME);
      const savedLastDark = localStorage.getItem(STORAGE_LAST_DARK);
      if (savedLastDark) lastDarkTheme = savedLastDark;

      if (savedTheme) {
        currentTheme = savedTheme;
      } else {
        currentTheme = 'dark';
      }
      applyTheme(currentTheme);

      const savedGlow = localStorage.getItem(STORAGE_GLOW);
      if (savedGlow !== null) {
        isAmbientGlowOn = savedGlow === 'true';
      }
      updateAmbientGlowUI();
    } catch (e) {
      console.warn('Storage theme error:', e);
    }

    // Volume & Mute
    try {
      const savedVol = localStorage.getItem(STORAGE_VOLUME);
      if (savedVol !== null) {
        currentVolume = parseInt(savedVol, 10);
        if (isNaN(currentVolume)) currentVolume = 100;
      }
      const savedMute = localStorage.getItem(STORAGE_MUTED);
      if (savedMute !== null) {
        isMuted = savedMute === 'true';
      }
      updateVolumeUI(isMuted ? 0 : currentVolume);
    } catch (e) {
      console.warn('Storage volume error:', e);
    }

    // Loop
    try {
      const savedLoop = localStorage.getItem(STORAGE_LOOP);
      if (savedLoop !== null) {
        isLoopQueue = savedLoop === 'true';
        updateLoopUI();
      }
    } catch (e) {
      console.warn('Storage loop error:', e);
    }

    // YouTube API Key
    try {
      const savedKey = localStorage.getItem(STORAGE_YT_API_KEY);
      if (savedKey) {
        youtubeApiKey = savedKey;
        if (els.apiKeyInput) els.apiKeyInput.value = youtubeApiKey;
      }
    } catch (e) {
      console.warn('Storage API key error:', e);
    }

    // Gemini API Key for AI Track Advisor
    try {
      const savedGeminiKey = localStorage.getItem(STORAGE_GEMINI_API_KEY);
      if (savedGeminiKey) {
        geminiApiKey = savedGeminiKey;
        if (els.geminiApiKeyInput) els.geminiApiKeyInput.value = geminiApiKey;
        updateGeminiKeyBadgeUI();
      }
    } catch (e) {
      console.warn('Storage Gemini API key error:', e);
    }
    try {
      const savedSkip = localStorage.getItem(STORAGE_AUTOSKIP);
      if (savedSkip !== null) {
        autoSkipRestricted = savedSkip === 'true';
        if (els.popoverAutoSkipToggle) els.popoverAutoSkipToggle.checked = autoSkipRestricted;
      }
    } catch (e) {
      console.warn('Storage autoskip error:', e);
    }

    // Profile & Stats
    try {
      const savedProfile = localStorage.getItem(STORAGE_PROFILE);
      if (savedProfile) {
        profileDisplayName = savedProfile;
        if (els.profileDisplayName) els.profileDisplayName.textContent = profileDisplayName;
      }
      const savedStats = localStorage.getItem(STORAGE_STATS);
      if (savedStats) {
        sessionTracksPlayed = parseInt(savedStats, 10) || 0;
      }
    } catch (e) {
      console.warn('Storage profile error:', e);
    }

    // Queue & Index
    try {
      const savedQueue = localStorage.getItem(STORAGE_QUEUE);
      const savedIndex = localStorage.getItem(STORAGE_INDEX);
      if (savedQueue) {
        const parsed = JSON.parse(savedQueue);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Filter out the old 4 dummy tracks if they exist in localStorage from previous session
          const dummyIds = new Set(['4NRXx6U8ABQ', 'MV_3Dpw-BRY', 'a1ThSi1wbqQ', 'dQw4w9WgXcQ']);
          const cleaned = parsed.filter(t => !dummyIds.has(t.videoId));

          // If cleanup removed unwanted songs or left it with custom songs, update queue
          if (cleaned.length > 0) {
            queue = cleaned.map(normalizeTrack).filter(Boolean);
          } else {
            // Unwanted dummy tracks removed; load the 5 default custom tracks
            queue = [...DEFAULT_INITIAL_TRACKS];
          }
          const idx = parseInt(savedIndex, 10);
          currentIndex = !isNaN(idx) && idx >= 0 && idx < queue.length ? idx : 0;
        } else {
          // If queue was empty or null, seed with the default tracks
          queue = [...DEFAULT_INITIAL_TRACKS];
          currentIndex = 0;
        }
      } else {
        // No saved queue exists yet, initialize with the default tracks
        queue = [...DEFAULT_INITIAL_TRACKS];
        currentIndex = 0;
      }
      saveQueueState();
    } catch (e) {
      console.warn('Storage queue error:', e);
      queue = [...DEFAULT_INITIAL_TRACKS];
      currentIndex = 0;
    }
  }

  function saveQueueState() {
    try {
      localStorage.setItem(STORAGE_QUEUE, JSON.stringify(queue));
      localStorage.setItem(STORAGE_INDEX, currentIndex.toString());
      localStorage.setItem(STORAGE_STATS, sessionTracksPlayed.toString());
    } catch (e) {
      console.warn('Storage save error:', e);
    }
    updateProfileStats();
  }

  function saveThemeState() {
    try {
      localStorage.setItem(STORAGE_THEME, currentTheme);
    } catch (e) {
      console.warn('Storage theme error:', e);
    }
  }

  function saveLoopState() {
    try {
      localStorage.setItem(STORAGE_LOOP, isLoopQueue.toString());
    } catch (e) {
      console.warn('Storage loop error:', e);
    }
  }

  function updateProfileStats() {
    if (els.popoverStatQueue) els.popoverStatQueue.textContent = queue.length;
    if (els.popoverStatPlayed) els.popoverStatPlayed.textContent = sessionTracksPlayed;
  }

  // --- TAB NAVIGATION (ZERO INTERRUPTIONS) ---
  window.switchTab = function (tabName) {
    if (!els.views[tabName]) return;

    activeTab = tabName;

    // Toggle view-panel visibility without destroying DOM or recreating iframe
    Object.keys(els.views).forEach((key) => {
      const panel = els.views[key];
      if (!panel) return;
      if (key === tabName) {
        panel.classList.remove('hidden');
      } else {
        panel.classList.add('hidden');
      }
    });

    updateTabPills();
    closeAllPopovers();

    // Trigger view-specific syncs
    if (tabName === 'queue') {
      renderFullQueueManager();
    } else if (tabName === 'now-playing') {
      renderNowPlayingView();
    }

    // Scroll to top smoothly
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function updateTabPills() {
    const navButtons = document.querySelectorAll('#nav-tabs button[data-tab]');
    navButtons.forEach((btn) => {
      const tab = btn.dataset.tab;
      if (tab === activeTab) {
        btn.className = 'px-space-md py-space-xs rounded-lg transition-all font-label-md text-label-md cursor-pointer flex items-center gap-1.5 tab-active';
        btn.setAttribute('aria-current', 'page');
      } else {
        btn.className = 'px-space-md py-space-xs rounded-lg transition-all font-label-md text-label-md cursor-pointer flex items-center gap-1.5 tab-inactive';
        btn.removeAttribute('aria-current');
      }
    });
  }

  // --- TOP-RIGHT POPOVERS ---
  window.toggleAudioPopover = function (e) {
    if (e) e.stopPropagation();
    const isHidden = els.audioPopover.classList.contains('hidden');
    closeAllPopovers();
    if (isHidden) {
      els.audioPopover.classList.remove('hidden');
      els.audioPopover.classList.add('flex');
    }
  };

  window.toggleProfilePopover = function (e) {
    if (e) e.stopPropagation();
    const isHidden = els.profilePopover.classList.contains('hidden');
    closeAllPopovers();
    if (isHidden) {
      updateProfileStats();
      els.profilePopover.classList.remove('hidden');
      els.profilePopover.classList.add('flex');
    }
  };

  window.closeAllPopovers = function () {
    if (els.audioPopover) {
      els.audioPopover.classList.add('hidden');
      els.audioPopover.classList.remove('flex');
    }
    if (els.profilePopover) {
      els.profilePopover.classList.add('hidden');
      els.profilePopover.classList.remove('flex');
    }
  };

  window.promptEditProfileName = function () {
    const newName = prompt('Enter custom curator name:', profileDisplayName);
    if (newName && newName.trim()) {
      profileDisplayName = newName.trim();
      localStorage.setItem(STORAGE_PROFILE, profileDisplayName);
      if (els.profileDisplayName) els.profileDisplayName.textContent = profileDisplayName;
      showToast(`Curator name updated to "${profileDisplayName}"`, 'person');
    }
  };

  window.toggleAutoSkipRestricted = function (checked) {
    autoSkipRestricted = checked;
    localStorage.setItem(STORAGE_AUTOSKIP, autoSkipRestricted.toString());
    showToast(autoSkipRestricted ? 'Auto-Skip Restricted Videos: ON' : 'Auto-Skip Restricted Videos: OFF', 'gpp_maybe');
  };

  // --- THEME ---
  window.applyTheme = function (theme) {
    // Valid theme names: 'dark', 'slate', 'oled', 'light'
    currentTheme = theme;

    if (theme !== 'light') {
      lastDarkTheme = theme;
      try {
        localStorage.setItem(STORAGE_LAST_DARK, lastDarkTheme);
      } catch (e) {}
    }

    // Set data-theme on <html>
    document.documentElement.setAttribute('data-theme', theme);

    if (theme === 'light') {
      document.documentElement.classList.remove('dark');
      if (els.themeIcon) els.themeIcon.textContent = 'dark_mode';
    } else {
      document.documentElement.classList.add('dark');
      if (els.themeIcon) els.themeIcon.textContent = 'light_mode';
    }

    saveThemeState();
    updateThemeSelectorCards();
    updateTabPills();
    updateAmbientGlowUI();
  };

  window.toggleTheme = function () {
    if (currentTheme === 'light') {
      // Toggle back to the last selected dark theme (or default 'dark')
      window.applyTheme(lastDarkTheme || 'dark');
      showToast(`Switched to ${getThemeName(lastDarkTheme || 'dark')}`, 'palette');
    } else {
      // Switch to Light Studio
      window.applyTheme('light');
      showToast('Switched to Light Studio theme', 'palette');
    }
  };

  function getThemeName(theme) {
    switch (theme) {
      case 'dark': return 'Audiophile Dark';
      case 'slate': return 'Studio Deep Slate';
      case 'oled': return 'High Contrast OLED';
      case 'light': return 'Light Studio';
      default: return 'Audiophile Dark';
    }
  }

  function updateThemeSelectorCards() {
    const cards = document.querySelectorAll('#theme-selector-group .theme-card');
    cards.forEach(card => {
      const cardTheme = card.getAttribute('data-theme');
      const checkIcon = card.querySelector('.theme-check');

      if (cardTheme === currentTheme) {
        card.classList.add('theme-card-active');
        card.classList.remove('theme-card-inactive');
        if (checkIcon) checkIcon.classList.remove('hidden');
      } else {
        card.classList.remove('theme-card-active');
        card.classList.add('theme-card-inactive');
        if (checkIcon) checkIcon.classList.add('hidden');
      }
    });
  }

  window.toggleAmbientGlow = function (enable) {
    if (enable !== undefined) {
      isAmbientGlowOn = !!enable;
    } else {
      const checkbox = document.getElementById('ambient-glow');
      if (checkbox) isAmbientGlowOn = checkbox.checked;
    }

    try {
      localStorage.setItem(STORAGE_GLOW, isAmbientGlowOn.toString());
    } catch (e) {}

    updateAmbientGlowUI();
    showToast(isAmbientGlowOn ? 'Ambient Glow Illumination: ON' : 'Ambient Glow Illumination: OFF', 'flare');
  };

  function updateAmbientGlowUI() {
    const checkbox = document.getElementById('ambient-glow');
    if (checkbox) checkbox.checked = isAmbientGlowOn;

    const videoContainer = document.getElementById('video-theater-container');
    if (videoContainer) {
      if (isAmbientGlowOn) {
        videoContainer.classList.add('ambient-glow-active');
      } else {
        videoContainer.classList.remove('ambient-glow-active');
      }
    }
  }

  // --- PLAYBACK SPEED ---
  window.setPlaybackSpeed = function (speed) {
    currentSpeed = speed;
    if (ytPlayer && typeof ytPlayer.setPlaybackRate === 'function') {
      ytPlayer.setPlaybackRate(speed);
    }

    const btns = document.querySelectorAll('#speed-selector-btns button');
    btns.forEach((btn) => {
      const s = parseFloat(btn.dataset.speed);
      if (s === speed) {
        btn.className = 'py-1 rounded bg-primary text-on-primary font-technical-mono text-xs transition-colors cursor-pointer';
      } else {
        btn.className = 'py-1 rounded bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface font-technical-mono text-xs transition-colors cursor-pointer';
      }
    });

    showToast(`Playback Speed set to ${speed}x`, 'speed');
  };

  // --- YOUTUBE IFRAME PLAYER API ---
  function initYouTubeAPI() {
    if (window.YT && window.YT.Player) {
      onYouTubeIframeAPIReady();
      return;
    }

    window.onYouTubeIframeAPIReady = function () {
      isYtReady = true;
      createPlayerInstance();
    };

    if (!document.getElementById('yt-iframe-script')) {
      const tag = document.createElement('script');
      tag.id = 'yt-iframe-script';
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    }
  }

  function createPlayerInstance() {
    const initialVideoId = (currentIndex >= 0 && queue[currentIndex]) ? queue[currentIndex].videoId : '';

    try {
      ytPlayer = new window.YT.Player('yt-player-target', {
        height: '100%',
        width: '100%',
        videoId: initialVideoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          playsinline: 1,
          modestbranding: 1,
          origin: window.location.origin
        },
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange,
          onError: onPlayerError
        }
      });
    } catch (err) {
      console.error('Failed to instantiate YT.Player:', err);
    }
  }

  function onPlayerReady(event) {
    isYtReady = true;
    updateHUDIdleOrTrack();

    // Sync saved volume and mute state
    try {
      if (typeof ytPlayer.setVolume === 'function') {
        ytPlayer.setVolume(currentVolume);
      }
      if (isMuted && typeof ytPlayer.mute === 'function') {
        ytPlayer.mute();
      } else if (!isMuted && typeof ytPlayer.unMute === 'function') {
        ytPlayer.unMute();
      }
      updateVolumeUI(isMuted ? 0 : currentVolume);
    } catch (e) {
      console.warn('Volume sync error:', e);
    }
    if (currentIndex >= 0 && queue[currentIndex]) {
      if (event && event.target && event.target.cueVideoById) {
        event.target.cueVideoById(queue[currentIndex].videoId);
      }
    }
  }

  function onPlayerStateChange(event) {
    playerState = event.data;

    // YT.PlayerState: ENDED (0), PLAYING (1), PAUSED (2), BUFFERING (3), CUED (5)
    if (event.data === window.YT.PlayerState.ENDED) {
      sessionTracksPlayed++;
      saveQueueState();
      handleTrackEnded();
    } else if (event.data === window.YT.PlayerState.PLAYING) {
      hideQueueCompleteOverlay();
      hideRestrictedOverlay();
      if (els.videoPoster) els.videoPoster.classList.add('hidden');
      updatePlayPauseUI(true);
      startPlaybackTimer();
      animateEqualizer(true);
      updateHUDStatus('PLAYING');

      // Enforce startAt marker if YouTube Player ignored startSeconds
      const curTrack = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
      if (curTrack && curTrack.startAt > 0 && typeof ytPlayer.getCurrentTime === 'function') {
        const curSec = ytPlayer.getCurrentTime();
        if (curSec < curTrack.startAt - 0.5) {
          ytPlayer.seekTo(curTrack.startAt, true);
        }
      }
      applyTrackDjSettings(curTrack);
    } else if (event.data === window.YT.PlayerState.PAUSED) {
      updatePlayPauseUI(false);
      animateEqualizer(false);
      updateHUDStatus('PAUSED');
    } else if (event.data === window.YT.PlayerState.BUFFERING) {
      updateHUDStatus('BUFFERING');
    } else if (event.data === window.YT.PlayerState.CUED) {
      updatePlayPauseUI(false);
      animateEqualizer(false);
      updateHUDStatus('READY');
      updateScrubUI(0, (ytPlayer && ytPlayer.getDuration) ? ytPlayer.getDuration() : 0);
    }
  }

  function onPlayerError(event) {
    console.warn('YouTube Player Error code:', event.data);
    const errCode = event.data;

    if (errCode === 101 || errCode === 150 || errCode === 100 || errCode === 2) {
      handleRestrictedVideo(errCode);
    }
  }

  // --- STRICT QUEUE END LOGIC (Zero Recommendations) ---
  function handleTrackEnded() {
    stopPlaybackTimer();
    animateEqualizer(false);

    if (queue.length === 0) {
      showQueueCompleteOverlay();
      return;
    }

    const nextIndex = currentIndex + 1;

    if (nextIndex < queue.length) {
      currentIndex = nextIndex;
      saveQueueState();
      renderQueue();
      loadAndPlayCurrentTrack();
    } else {
      if (isLoopQueue && queue.length > 0) {
        currentIndex = 0;
        saveQueueState();
        renderQueue();
        showToast('Looping queue from position #1', 'repeat');
        loadAndPlayCurrentTrack();
      } else {
        currentIndex = queue.length;
        saveQueueState();
        renderQueue();

        if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
          ytPlayer.stopVideo();
        }

        updatePlayPauseUI(false);
        updateHUDStatus('COMPLETED');
        showQueueCompleteOverlay();
      }
    }
  }

  function showQueueCompleteOverlay() {
    if (els.queueCompleteOverlay) {
      els.queueCompleteOverlay.classList.remove('hidden');
      els.queueCompleteOverlay.classList.add('flex');
    }
    if (els.completeTracksCount) {
      els.completeTracksCount.textContent = `${queue.length} tracks`;
    }
    if (els.videoPoster) {
      els.videoPoster.classList.remove('hidden');
    }
  }

  function hideQueueCompleteOverlay() {
    if (els.queueCompleteOverlay) {
      els.queueCompleteOverlay.classList.add('hidden');
      els.queueCompleteOverlay.classList.remove('flex');
    }
  }

  // --- RESTRICTED VIDEO HANDLING (Error 150 / 101) ---
  function handleRestrictedVideo(code) {
    if (currentIndex >= 0 && queue[currentIndex]) {
      queue[currentIndex].restricted = true;
      saveQueueState();
      renderQueue();
    }

    const curTrack = queue[currentIndex];
    const trackTitle = curTrack ? curTrack.title : 'Current Track';

    showToast(`Embedding restricted: "${trackTitle.substring(0, 30)}..." (Auto-skipping)`, 'gpp_maybe', 4000);

    if (els.restrictedOverlay) {
      els.restrictedOverlay.classList.remove('hidden');
      els.restrictedOverlay.classList.add('flex');
    }

    if (els.restrictedLink && curTrack) {
      els.restrictedLink.href = `https://www.youtube.com/watch?v=${curTrack.videoId}`;
    }

    if (autoSkipRestricted) {
      setTimeout(() => {
        hideRestrictedOverlay();
        playNext();
      }, 1500);
    }
  }

  function hideRestrictedOverlay() {
    if (els.restrictedOverlay) {
      els.restrictedOverlay.classList.add('hidden');
      els.restrictedOverlay.classList.remove('flex');
    }
  }

  // --- PLAYBACK CONTROLS ---
  function loadAndPlayCurrentTrack() {
    hideQueueCompleteOverlay();
    hideRestrictedOverlay();

    if (currentIndex < 0 || currentIndex >= queue.length) {
      updateHUDIdleOrTrack();
      return;
    }

    const track = queue[currentIndex];
    updateHUDIdleOrTrack();

    if (!ytPlayer) return;

    if (typeof ytPlayer.loadVideoById === 'function') {
      ytPlayer.loadVideoById({
        videoId: track.videoId,
        startSeconds: track.startAt || 0
      });
    } else if (typeof ytPlayer.cueVideoById === 'function') {
      ytPlayer.cueVideoById({
        videoId: track.videoId,
        startSeconds: track.startAt || 0
      });
    }

    // Apply per-track playback rate & DJ gain offset
    applyTrackDjSettings(track);
  }

  window.togglePlayPause = function () {
    if (!ytPlayer) return;

    if (queue.length === 0) {
      showToast('Add a song to the queue first', 'queue_music');
      focusIngestInput();
      return;
    }

    if (currentIndex >= queue.length) {
      currentIndex = 0;
      saveQueueState();
      renderQueue();
      loadAndPlayCurrentTrack();
      return;
    }

    if (currentIndex < 0) {
      currentIndex = 0;
      saveQueueState();
      renderQueue();
      loadAndPlayCurrentTrack();
      return;
    }

    const state = (typeof ytPlayer.getPlayerState === 'function') ? ytPlayer.getPlayerState() : -1;

    if (state === window.YT.PlayerState.PLAYING) {
      ytPlayer.pauseVideo();
    } else {
      ytPlayer.playVideo();
    }
  };

  window.playNext = function () {
    if (queue.length === 0) return;

    const nextIdx = currentIndex + 1;
    if (nextIdx < queue.length) {
      currentIndex = nextIdx;
      saveQueueState();
      renderQueue();
      loadAndPlayCurrentTrack();
    } else if (isLoopQueue) {
      currentIndex = 0;
      saveQueueState();
      renderQueue();
      loadAndPlayCurrentTrack();
    } else {
      currentIndex = queue.length;
      if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
      updatePlayPauseUI(false);
      showQueueCompleteOverlay();
    }
  };

  window.playPrev = function () {
    if (queue.length === 0) return;

    if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function' && ytPlayer.getCurrentTime() > 3) {
      ytPlayer.seekTo(0, true);
      return;
    }

    if (currentIndex > 0) {
      currentIndex--;
      saveQueueState();
      renderQueue();
      loadAndPlayCurrentTrack();
    } else {
      if (ytPlayer && ytPlayer.seekTo) ytPlayer.seekTo(0, true);
    }
  };

  window.toggleLoop = function () {
    isLoopQueue = !isLoopQueue;
    saveLoopState();
    updateLoopUI();
    showToast(isLoopQueue ? 'Loop Queue: ON' : 'Loop Queue: OFF', 'repeat');
  };

  function updateLoopUI() {
    if (els.loopToggleBtn) {
      if (isLoopQueue) {
        els.loopToggleBtn.classList.remove('bg-white/10', 'text-on-surface-variant');
        els.loopToggleBtn.classList.add('bg-primary/20', 'text-primary');
        if (els.loopModeLabel) els.loopModeLabel.textContent = 'Queue Loop';
      } else {
        els.loopToggleBtn.classList.add('bg-white/10', 'text-on-surface-variant');
        els.loopToggleBtn.classList.remove('bg-primary/20', 'text-primary');
        if (els.loopModeLabel) els.loopModeLabel.textContent = 'Off';
      }
    }

    if (els.sidebarLoopBtn) {
      if (isLoopQueue) {
        els.sidebarLoopBtn.classList.add('text-primary', 'bg-primary/10');
        if (els.sidebarLoopLabel) els.sidebarLoopLabel.textContent = 'Loop ON';
      } else {
        els.sidebarLoopBtn.classList.remove('text-primary', 'bg-primary/10');
        if (els.sidebarLoopLabel) els.sidebarLoopLabel.textContent = 'Loop';
      }
    }

    if (els.npLoopBtn) {
      if (isLoopQueue) {
        els.npLoopBtn.classList.add('text-primary');
      } else {
        els.npLoopBtn.classList.remove('text-primary');
      }
    }

    if (els.footerLoopBtn) {
      if (isLoopQueue) {
        els.footerLoopBtn.classList.add('text-primary');
      } else {
        els.footerLoopBtn.classList.remove('text-primary');
      }
    }
  }

  window.toggleMute = function () {
    if (isMuted) {
      if (ytPlayer && typeof ytPlayer.unMute === 'function') {
        ytPlayer.unMute();
      }
      isMuted = false;
      try {
        localStorage.setItem(STORAGE_MUTED, 'false');
      } catch (e) {}
      updateVolumeUI(currentVolume);
      showVolumeHud(currentVolume, false);
      showToast(`Unmuted (${currentVolume}%)`, 'volume_up', 1500);
    } else {
      if (ytPlayer && typeof ytPlayer.mute === 'function') {
        ytPlayer.mute();
      }
      isMuted = true;
      try {
        localStorage.setItem(STORAGE_MUTED, 'true');
      } catch (e) {}
      updateVolumeUI(0);
      showVolumeHud(0, true);
      showToast('Muted', 'volume_off', 1500);
    }
  };

  window.adjustVolumeBy = function (delta) {
    if (isMuted) {
      isMuted = false;
      if (ytPlayer && typeof ytPlayer.unMute === 'function') {
        ytPlayer.unMute();
      }
      try {
        localStorage.setItem(STORAGE_MUTED, 'false');
      } catch (e) {}
    }

    let newVol = Math.max(0, Math.min(100, currentVolume + delta));
    currentVolume = newVol;

    if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
      ytPlayer.setVolume(newVol);
    }

    try {
      localStorage.setItem(STORAGE_VOLUME, newVol.toString());
    } catch (e) {}

    updateVolumeUI(newVol);
    showVolumeHud(newVol, false);
  };

  function showVolumeHud(vol, muted) {
    if (!els.volumeHudPill) return;
    if (volumeHudTimer) clearTimeout(volumeHudTimer);

    const icon = muted || vol === 0 ? 'volume_off' : vol < 50 ? 'volume_down' : 'volume_up';
    if (els.volumeHudIcon) els.volumeHudIcon.textContent = icon;
    if (els.volumeHudBar) els.volumeHudBar.style.width = `${muted ? 0 : vol}%`;
    if (els.volumeHudText) els.volumeHudText.textContent = `${muted ? 0 : vol}%`;

    els.volumeHudPill.classList.remove('hidden', 'opacity-0', 'scale-95');
    els.volumeHudPill.classList.add('flex', 'opacity-100', 'scale-100');

    volumeHudTimer = setTimeout(() => {
      if (els.volumeHudPill) {
        els.volumeHudPill.classList.remove('opacity-100', 'scale-100');
        els.volumeHudPill.classList.add('opacity-0', 'scale-95');
        setTimeout(() => {
          if (els.volumeHudPill) {
            els.volumeHudPill.classList.remove('flex');
            els.volumeHudPill.classList.add('hidden');
          }
        }, 300);
      }
    }, 1200);
  }

  function updateVolumeUI(vol) {
    const icon = vol === 0 || isMuted ? 'volume_off' : vol < 50 ? 'volume_down' : 'volume_up';
    if (els.cardVolumeIcon) els.cardVolumeIcon.textContent = icon;
    if (els.footerVolumeIcon) els.footerVolumeIcon.textContent = icon;
    if (els.popoverVolIcon) els.popoverVolIcon.textContent = icon;
    if (els.cardVolumeBar) els.cardVolumeBar.style.width = `${vol}%`;
    if (els.footerVolumeBar) els.footerVolumeBar.style.width = `${vol}%`;
    if (els.popoverVolBar) els.popoverVolBar.style.width = `${vol}%`;
    if (els.popoverVolText) els.popoverVolText.textContent = `${vol}%`;
  }

  window.toggleFullscreen = function () {
    if (!els.videoTheater) return;
    if (!document.fullscreenElement) {
      els.videoTheater.requestFullscreen().then(() => {
        // Keep focus on the container element so keyboard shortcuts respond immediately
        els.videoTheater.focus();
      }).catch(err => {
        console.warn('Fullscreen error:', err);
      });
    } else {
      document.exitFullscreen().catch(err => {
        console.warn('Exit fullscreen error:', err);
      });
    }
  };

  window.replayQueue = function () {
    if (queue.length === 0) return;
    currentIndex = 0;
    saveQueueState();
    renderQueue();
    loadAndPlayCurrentTrack();
    showToast('Replaying queue from position #1', 'replay');
  };

  // --- PROGRESS / TIME UPDATES ---
  function startPlaybackTimer() {
    stopPlaybackTimer();
    timeUpdateInterval = setInterval(updatePlaybackTime, 500);
  }

  function stopPlaybackTimer() {
    if (timeUpdateInterval) {
      clearInterval(timeUpdateInterval);
      timeUpdateInterval = null;
    }
  }

  function updatePlaybackTime() {
    if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
    if (isSeeking) return;

    const current = ytPlayer.getCurrentTime() || 0;
    const duration = ytPlayer.getDuration() || 0;

    // Check per-track endAt marker (Auto-Skip Outro)
    const curTrack = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
    if (curTrack && curTrack.endAt && curTrack.endAt > 0 && current >= curTrack.endAt) {
      handleTrackEnded();
      return;
    }

    updateScrubUI(current, duration);
    syncLyricsProgress(current);
    updateDropTimePeek(current);
  }

  function updateScrubUI(current, duration) {
    const percent = duration > 0 ? (current / duration) * 100 : 0;
    const curStr = formatTime(current);
    const durStr = formatTime(duration);

    // Dashboard card scrubber
    if (els.cardScrubProgress) els.cardScrubProgress.style.width = `${percent}%`;
    if (els.cardTimeDisplay) els.cardTimeDisplay.textContent = `${curStr} / ${durStr}`;

    // Footer scrubber
    if (els.footerScrubProgress) els.footerScrubProgress.style.width = `${percent}%`;
    if (els.footerTimeCurrent) els.footerTimeCurrent.textContent = curStr;
    if (els.footerTimeTotal) els.footerTimeTotal.textContent = durStr;

    // View-Queue hero scrubber
    if (els.qmHeroScrubBar) els.qmHeroScrubBar.style.width = `${percent}%`;
    if (els.qmHeroTimeCur) els.qmHeroTimeCur.textContent = curStr;
    if (els.qmHeroTimeTotal) els.qmHeroTimeTotal.textContent = durStr;

    // View-Now-Playing scrubber
    if (els.npScrubBar) els.npScrubBar.style.width = `${percent}%`;
    if (els.npTimeCur) els.npTimeCur.textContent = curStr;
    if (els.npTimeTotal) els.npTimeTotal.textContent = durStr;
  }

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const mStr = mins < 10 ? `0${mins}` : `${mins}`;
    const sStr = secs < 10 ? `0${secs}` : `${secs}`;
    return `${mStr}:${sStr}`;
  }

  function animateEqualizer(active) {
    if (els.playerCenterEqualizer) {
      if (active) {
        els.playerCenterEqualizer.classList.remove('hidden');
        els.playerCenterEqualizer.classList.add('flex');
      } else {
        els.playerCenterEqualizer.classList.add('hidden');
        els.playerCenterEqualizer.classList.remove('flex');
      }
    }
  }

  function updatePlayPauseUI(isPlaying) {
    const icon = isPlaying ? 'pause' : 'play_arrow';
    if (els.cardPlayPauseBtn) {
      els.cardPlayPauseBtn.innerHTML = `<span class="material-symbols-outlined text-base">${icon}</span>`;
    }
    if (els.footerPlayPauseBtn) {
      els.footerPlayPauseBtn.innerHTML = `<span class="material-symbols-outlined text-xl">${icon}</span>`;
    }
    if (els.npPlayPauseBtn) {
      els.npPlayPauseBtn.innerHTML = `<span class="material-symbols-outlined text-3xl font-bold">${icon}</span>`;
    }
    if (els.miniPlayerPlayBtn) {
      els.miniPlayerPlayBtn.innerHTML = `<span class="material-symbols-outlined text-base">${icon}</span>`;
    }
    if (pipWindow && pipWindow.document) {
      const pipPlayBtn = pipWindow.document.getElementById('pip-play-btn');
      if (pipPlayBtn) {
        pipPlayBtn.innerHTML = `<span class="material-symbols-outlined">${icon}</span>`;
      }
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
  }

  function updateHUDStatus(status) {
    if (els.playerStatusBadge) {
      els.playerStatusBadge.textContent = status;
    }
  }

  function updateHUDIdleOrTrack() {
    if (currentIndex >= 0 && currentIndex < queue.length && queue[currentIndex]) {
      const track = queue[currentIndex];

      // Dashboard
      if (els.playerTitle) els.playerTitle.textContent = track.title;
      if (els.playerChannel) {
        els.playerChannel.innerHTML = `<span>${escapeHTML(track.artist)}</span><span>•</span><span class="text-primary">Direct Session</span>`;
      }
      if (els.videoPoster) {
        els.videoPoster.style.backgroundImage = `url('${track.thumbnail}')`;
      }

      // Footer
      if (els.footerTitle) els.footerTitle.textContent = track.title;
      if (els.footerArtist) els.footerArtist.textContent = track.artist;
      if (els.footerThumb) {
        els.footerThumb.src = track.thumbnail;
        els.footerThumb.classList.remove('hidden');
      }
      if (els.footerPlaceholderIcon) els.footerPlaceholderIcon.classList.add('hidden');

      // View-Queue Hero Unit
      if (els.qmHeroThumb) els.qmHeroThumb.src = track.thumbnail;
      if (els.qmHeroTitle) els.qmHeroTitle.textContent = track.title;
      if (els.qmHeroArtist) els.qmHeroArtist.textContent = track.artist;

      // View-Now-Playing
      if (els.npTrackTitle) els.npTrackTitle.textContent = track.title;
      if (els.npTrackArtist) els.npTrackArtist.textContent = track.artist;

      // View-Now-Playing Stage Card Artwork & Overlays
      if (els.npEmptyStage) els.npEmptyStage.classList.add('hidden');
      if (els.npStageTitle) els.npStageTitle.textContent = track.title;
      if (els.npStageUrl) els.npStageUrl.textContent = `https://youtube.com/watch?v=${track.videoId}`;
      if (els.npStageCanvas) {
        const maxResThumb = `https://i.ytimg.com/vi/${track.videoId}/maxresdefault.jpg`;
        const testImg = new Image();
        testImg.onload = () => {
          if (testImg.naturalWidth > 120) {
            if (els.npStageCanvas) els.npStageCanvas.style.backgroundImage = `url('${maxResThumb}')`;
          } else {
            if (els.npStageCanvas) els.npStageCanvas.style.backgroundImage = `url('${track.thumbnail}')`;
          }
        };
        testImg.onerror = () => {
          if (els.npStageCanvas) els.npStageCanvas.style.backgroundImage = `url('${track.thumbnail}')`;
        };
        testImg.src = maxResThumb;
      }

      // Next Up Fast Peek
      const nextTrack = queue[currentIndex + 1];
      if (els.npUpNextTitle) {
        els.npUpNextTitle.textContent = nextTrack ? `${nextTrack.title.substring(0, 22)}...` : 'Queue complete';
      }

      // Update Floating Mini-Player & PiP Window
      updateMiniPlayerUI(track);

      // Sync OS Media Session (Control Center & Hardware Media Keys)
      syncMediaSessionMetadata(track);

      // Update AI Track Advisor based on current active track
      if (track && track.videoId !== aiAdvisorLastTrackId) {
        aiAdvisorLastTrackId = track.videoId;
        refreshAiAdvisor(false);
      }
    } else {
      aiAdvisorLastTrackId = null;
      renderAiAdvisorUI();
      updateMiniPlayerUI(null);
      clearMediaSessionMetadata();
      if (els.playerTitle) els.playerTitle.textContent = 'StrictQueue Audiophile Player';
      if (els.playerChannel) {
        els.playerChannel.innerHTML = `<span>YouTube Strict Engine</span><span>•</span><span class="text-primary">Zero Autoplay Isolation</span>`;
      }
      if (els.footerTitle) els.footerTitle.textContent = 'No Track Selected';
      if (els.footerArtist) els.footerArtist.textContent = 'Manual Queue Empty';
      if (els.footerThumb) {
        els.footerThumb.src = '';
        els.footerThumb.classList.add('hidden');
      }
      if (els.footerPlaceholderIcon) els.footerPlaceholderIcon.classList.remove('hidden');

      if (els.qmHeroTitle) els.qmHeroTitle.textContent = 'No Track Selected';
      if (els.qmHeroArtist) els.qmHeroArtist.textContent = 'Manual Queue Empty';
      if (els.npTrackTitle) els.npTrackTitle.textContent = 'No Track Selected';
      if (els.npTrackArtist) els.npTrackArtist.textContent = 'Manual Queue Empty';
      if (els.npUpNextTitle) els.npUpNextTitle.textContent = 'Queue is empty';

      // View-Now-Playing Stage Card Artwork & Overlays (Empty / Idle state)
      if (els.npEmptyStage) els.npEmptyStage.classList.remove('hidden');
      if (els.npStageCanvas) els.npStageCanvas.style.backgroundImage = 'none';
      if (els.npStageTitle) els.npStageTitle.textContent = 'No Track Playing';
      if (els.npStageUrl) els.npStageUrl.textContent = 'youtube.com';

      updateScrubUI(0, 0);
    }
  }

  // --- URL PARSING & OEMBED METADATA FETCHING ---
  function parseYouTubeVideoId(input) {
    if (!input) return null;
    const str = input.trim();

    if (/^[a-zA-Z0-9_-]{11}$/.test(str)) {
      return str;
    }

    const patterns = [
      /(?:youtube\.com\/(?:watch\?.*v=|v\/|embed\/|shorts\/)|music\.youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/i,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/i
    ];

    for (let p of patterns) {
      const match = str.match(p);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  async function fetchVideoMetadata(videoId) {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);

    if (!response.ok) {
      throw new Error(`oEmbed request failed with status ${response.status}`);
    }

    const data = await response.json();
    return {
      videoId: videoId,
      title: data.title || `YouTube Video (${videoId})`,
      artist: data.author_name || 'YouTube Channel',
      thumbnail: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      duration: '03:45',
      restricted: false
    };
  }

  async function handleAddUrlSubmit() {
    const rawVal = els.urlInput.value.trim();
    if (!rawVal) {
      showToast('Please enter a song name or YouTube video URL', 'info');
      return;
    }

    const videoId = parseYouTubeVideoId(rawVal);
    if (!videoId) {
      // Plain text search term entered (e.g. "montagem ambra")
      // Auto-trigger YouTube Search instead of throwing error
      switchIngestMode('search');
      closeSearchDropdown();
      showToast(`Searching YouTube for "${rawVal}"...`, 'search');
      performLiveSearch(rawVal);
      return;
    }

    const dupIdx = queue.findIndex(t => t.videoId === videoId);
    if (dupIdx !== -1) {
      showToast(`Notice: "${queue[dupIdx].title.substring(0, 25)}..." is already in queue at position #${dupIdx + 1}`, 'info', 3500);
    }

    const origBtnHtml = els.addToQueueBtn.innerHTML;
    els.addToQueueBtn.disabled = true;
    els.addToQueueBtn.innerHTML = '<span class="material-symbols-outlined text-sm animate-spin">refresh</span><span>Fetching...</span>';

    try {
      const track = await fetchVideoMetadata(videoId);
      addTrackToQueue(track);
      els.urlInput.value = '';
      closeSearchDropdown();
      showToast(`Added: "${track.title.substring(0, 30)}..."`, 'check_circle');
    } catch (err) {
      console.warn('oEmbed fetch error, using fallback:', err);
      const fallbackTrack = {
        videoId: videoId,
        title: `YouTube Video (${videoId})`,
        artist: 'Direct Stream Audio',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        duration: '03:45',
        restricted: false
      };
      addTrackToQueue(fallbackTrack);
      els.urlInput.value = '';
      closeSearchDropdown();
      showToast(`Added: Video ID ${videoId}`, 'check_circle');
    } finally {
      els.addToQueueBtn.disabled = false;
      els.addToQueueBtn.innerHTML = origBtnHtml;
    }
  }

  async function handlePlayNextSubmit() {
    const rawVal = els.urlInput.value.trim();
    if (!rawVal) {
      if (activeSearchResults && activeSearchResults.length > 0) {
        insertNextTrack(activeSearchResults[0].videoId);
        return;
      }
      showToast('Please enter a song name or YouTube video URL', 'info');
      return;
    }

    const videoId = parseYouTubeVideoId(rawVal);
    if (!videoId) {
      // Search term: search and take top result to play next
      showToast(`Searching for top match: "${rawVal}"...`, 'search');
      const results = await searchYouTubeMultiSource(rawVal);
      if (results && results.length > 0) {
        insertTrackNext(results[0]);
        els.urlInput.value = '';
        closeSearchDropdown();
        showToast(`Set to play next: "${results[0].title.substring(0, 25)}..."`, 'queue_play_next');
      } else {
        showToast('No matching YouTube results found', 'error');
      }
      return;
    }

    try {
      const track = await fetchVideoMetadata(videoId);
      insertTrackNext(track);
      els.urlInput.value = '';
      closeSearchDropdown();
      showToast(`Set to play next: "${track.title.substring(0, 25)}..."`, 'queue_play_next');
    } catch (err) {
      const fallback = {
        videoId: videoId,
        title: `YouTube Video (${videoId})`,
        artist: 'Direct Stream Audio',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        duration: '03:45',
        restricted: false
      };
      insertTrackNext(fallback);
      els.urlInput.value = '';
      closeSearchDropdown();
      showToast(`Set to play next: Video ID ${videoId}`, 'queue_play_next');
    }
  }

  function addTrackToQueue(rawTrack) {
    const track = normalizeTrack(rawTrack);
    if (!track) return;

    const wasEmptyOrFinished = (queue.length === 0 || currentIndex >= queue.length);

    queue.push(track);
    saveQueueState();
    renderQueue();

    if (wasEmptyOrFinished) {
      currentIndex = queue.length - 1;
      saveQueueState();
      renderQueue();
      loadAndPlayCurrentTrack();
    }
  }

  function insertTrackNext(rawTrack) {
    const track = normalizeTrack(rawTrack);
    if (!track) return;

    const wasEmptyOrFinished = (queue.length === 0 || currentIndex >= queue.length);

    if (wasEmptyOrFinished) {
      addTrackToQueue(track);
      return;
    }

    const insertIdx = currentIndex + 1;
    queue.splice(insertIdx, 0, track);
    saveQueueState();
    renderQueue();
  }

  window.quickAdd = function (url) {
    if (!url) return;
    const vid = parseYouTubeVideoId(url);
    if (!vid) {
      showToast('Invalid YouTube URL or ID', 'error');
      return;
    }
    fetchVideoMetadata(vid).then(track => {
      addTrackToQueue(track);
      showToast(`Added: "${track.title.substring(0, 25)}..."`, 'playlist_add');
    }).catch(() => {
      addTrackToQueue({
        videoId: vid,
        title: `YouTube Video (${vid})`,
        artist: 'Direct Stream Audio',
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        duration: '03:45',
        restricted: false
      });
      showToast(`Added: Video ID ${vid}`, 'playlist_add');
    });
  };

  // --- QUEUE RENDERING ACROSS VIEWS ---
  function renderQueue() {
    renderSidebarQueue();
    renderFullQueueManager();
    renderNowPlayingQueue();
    updateHUDIdleOrTrack();
  }

  function renderSidebarQueue() {
    if (!els.queueContainer) return;

    els.queueContainer.innerHTML = '';
    const totalTracks = queue.length;

    if (els.navQueueCount) {
      els.navQueueCount.textContent = `${totalTracks} track${totalTracks === 1 ? '' : 's'}`;
    }
    if (els.sidebarQueueBadge) {
      const totalSec = queue.length * 240;
      const totalMin = Math.floor(totalSec / 60);
      els.sidebarQueueBadge.textContent = `${totalTracks} song${totalTracks === 1 ? '' : 's'} • ${totalMin}m`;
    }

    if (totalTracks === 0) {
      if (els.emptyQueueSlate) {
        els.emptyQueueSlate.classList.remove('hidden');
        els.emptyQueueSlate.classList.add('flex');
      }
      return;
    }

    if (els.emptyQueueSlate) {
      els.emptyQueueSlate.classList.add('hidden');
      els.emptyQueueSlate.classList.remove('flex');
    }

    queue.forEach((track, idx) => {
      const isCurrent = (idx === currentIndex);
      const isRestricted = !!track.restricted;
      const numStr = (idx + 1) < 10 ? `0${idx + 1}` : `${idx + 1}`;

      const row = document.createElement('div');
      row.className = isCurrent
        ? 'relative rounded-lg bg-surface-container shadow-md flex items-center justify-between gap-3 overflow-hidden amoled-border flex-shrink-0'
        : 'group rounded-lg bg-surface-container-lowest hover:bg-surface-container transition-all flex items-center justify-between gap-3 cursor-pointer amoled-border flex-shrink-0';
      row.style.minHeight = '64px';
      row.style.padding = '10px 14px';

      row.draggable = true;
      row.dataset.index = idx;
      row.addEventListener('dragstart', onDragStart);
      row.addEventListener('dragover', onDragOver);
      row.addEventListener('drop', onDrop);
      row.addEventListener('dragend', onDragEnd);

      if (isCurrent) {
        row.innerHTML = `
          <div class="absolute left-0 top-0 bottom-0 w-1 bg-primary shadow-[0_0_12px_rgba(0,255,102,0.8)] pointer-events-none"></div>
          <div class="flex items-center gap-3 min-w-0 flex-1 pl-1 z-10">
            <span class="font-technical-mono text-technical-mono text-primary font-bold text-xs flex-shrink-0 w-5">${numStr}</span>
            <div class="relative rounded-md bg-surface-container-highest flex-shrink-0 overflow-hidden shadow-inner flex items-center justify-center" style="width: 56px; height: 36px; min-width: 56px;">
              <img src="${escapeHTML(track.thumbnail)}" alt="Thumb" class="w-full h-full object-cover rounded-md" style="object-fit: cover;">
              <div class="absolute inset-0 bg-black/40 flex items-center justify-center">
                <div class="flex items-end gap-0.5 h-3">
                  <span class="w-0.5 bg-primary rounded-full animate-bounce" style="animation-delay: 0.1s; height: 100%;"></span>
                  <span class="w-0.5 bg-secondary rounded-full animate-bounce" style="animation-delay: 0.25s; height: 60%;"></span>
                  <span class="w-0.5 bg-primary rounded-full animate-bounce" style="animation-delay: 0.4s; height: 85%;"></span>
                </div>
              </div>
            </div>
            <div class="flex flex-col flex-1 min-w-0" style="min-width: 0;">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="font-label-md text-white font-semibold text-xs truncate" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(track.title)}</span>
                <span class="px-1.5 py-0.5 rounded bg-primary/20 text-primary font-technical-mono text-[9px] uppercase font-bold flex-shrink-0">Playing</span>
                ${isRestricted ? '<span class="px-1.5 py-0.5 rounded bg-error-container text-error font-technical-mono text-[9px] uppercase flex-shrink-0">Restricted</span>' : ''}
              </div>
              <span class="font-body-sm text-on-surface-variant text-[11px] truncate mt-0.5" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(track.artist)}</span>
            </div>
          </div>
          <div class="flex items-center gap-1 flex-shrink-0 z-10">
            <button class="text-outline hover:text-primary p-1 rounded transition-colors cursor-pointer" onclick="openTrackTuningModal(${idx}, event)" title="Tune Track (DJ Start/End/Speed/Volume)" type="button">
              <span class="material-symbols-outlined text-xs">tune</span>
            </button>
            <button class="text-outline hover:text-on-surface p-1 rounded transition-colors" onclick="moveTrack(${idx}, -1)" title="Move up" type="button" ${idx === 0 ? 'disabled' : ''}>
              <span class="material-symbols-outlined text-xs">arrow_upward</span>
            </button>
            <button class="text-outline hover:text-on-surface p-1 rounded transition-colors" onclick="moveTrack(${idx}, 1)" title="Move down" type="button" ${idx === queue.length - 1 ? 'disabled' : ''}>
              <span class="material-symbols-outlined text-xs">arrow_downward</span>
            </button>
            <button class="text-outline hover:text-error p-1 rounded transition-colors cursor-pointer" onclick="removeTrackAt(${idx}, event)" title="Remove track" type="button">
              <span class="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
        `;
      } else {
        row.innerHTML = `
          <div class="flex items-center gap-3 min-w-0 flex-1" onclick="playTrackAt(${idx})">
            <button class="cursor-grab text-outline group-hover:text-on-surface flex items-center flex-shrink-0" title="Drag to reorder" type="button">
              <span class="material-symbols-outlined text-sm">drag_indicator</span>
            </button>
            <span class="font-technical-mono text-technical-mono text-on-surface-variant text-xs flex-shrink-0 w-5">${numStr}</span>
            <div class="rounded-md bg-surface-container-highest flex-shrink-0 overflow-hidden shadow-inner" style="width: 56px; height: 36px; min-width: 56px;">
              <img src="${escapeHTML(track.thumbnail)}" alt="Thumb" class="w-full h-full object-cover rounded-md" style="object-fit: cover;">
            </div>
            <div class="flex flex-col flex-1 min-w-0" style="min-width: 0;">
              <span class="font-label-md text-on-surface group-hover:text-primary transition-colors text-xs truncate ${isRestricted ? 'line-through text-outline' : ''}" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(track.title)}</span>
              <span class="font-body-sm text-on-surface-variant text-[11px] truncate mt-0.5" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(track.artist)}</span>
            </div>
          </div>
          <div class="flex items-center gap-1 flex-shrink-0">
            <button class="text-outline hover:text-primary p-1 rounded transition-colors cursor-pointer" onclick="openTrackTuningModal(${idx}, event)" title="Tune Track (DJ Start/End/Speed/Volume)" type="button">
              <span class="material-symbols-outlined text-xs">tune</span>
            </button>
            <button class="text-outline hover:text-on-surface p-1 rounded transition-colors" onclick="moveTrack(${idx}, -1)" title="Move up" type="button" ${idx === 0 ? 'disabled' : ''}>
              <span class="material-symbols-outlined text-xs">arrow_upward</span>
            </button>
            <button class="text-outline hover:text-on-surface p-1 rounded transition-colors" onclick="moveTrack(${idx}, 1)" title="Move down" type="button" ${idx === queue.length - 1 ? 'disabled' : ''}>
              <span class="material-symbols-outlined text-xs">arrow_downward</span>
            </button>
            <button class="opacity-80 group-hover:opacity-100 text-outline hover:text-error p-1 rounded transition-all cursor-pointer" onclick="removeTrackAt(${idx}, event)" title="Remove track" type="button">
              <span class="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
        `;
      }

      els.queueContainer.appendChild(row);
    });
  }

  // View 2: Full-Width Queue Manager
  function renderFullQueueManager() {
    if (!els.qmFullQueueContainer) return;

    els.qmFullQueueContainer.innerHTML = '';

    if (els.qmActivePos) {
      els.qmActivePos.textContent = `${currentIndex >= 0 && currentIndex < queue.length ? currentIndex + 1 : 0}/${queue.length} Tracks`;
    }
    if (els.qmRemainingTime) {
      const remainingTracks = Math.max(0, queue.length - (currentIndex + 1));
      const remSec = remainingTracks * 240;
      const remMin = Math.floor(remSec / 60);
      els.qmRemainingTime.textContent = `${remMin}m ${remSec % 60}s`;
    }

    if (queue.length === 0) {
      if (els.qmEmptySlate) {
        els.qmEmptySlate.classList.remove('hidden');
        els.qmEmptySlate.classList.add('flex');
      }
      return;
    }

    if (els.qmEmptySlate) {
      els.qmEmptySlate.classList.add('hidden');
      els.qmEmptySlate.classList.remove('flex');
    }

    queue.forEach((track, idx) => {
      const isCurrent = (idx === currentIndex);
      const isRestricted = !!track.restricted;
      const numStr = (idx + 1) < 10 ? `0${idx + 1}` : `${idx + 1}`;

      const card = document.createElement('div');
      card.className = isCurrent
        ? 'group flex items-center justify-between p-space-sm rounded-xl bg-surface-container-high border border-primary amoled-border shadow-lg transition-all'
        : 'group flex items-center justify-between p-space-sm rounded-xl bg-surface-container-low hover:bg-surface-container transition-all shadow-sm amoled-border cursor-pointer';

      card.draggable = true;
      card.dataset.index = idx;
      card.addEventListener('dragstart', onDragStart);
      card.addEventListener('dragover', onDragOver);
      card.addEventListener('drop', onDrop);
      card.addEventListener('dragend', onDragEnd);

      card.innerHTML = `
        <div class="flex items-center gap-space-md min-w-0" onclick="${isCurrent ? '' : `playTrackAt(${idx})`}">
          <span class="material-symbols-outlined text-outline cursor-grab group-hover:text-primary transition-colors">drag_indicator</span>
          <span class="font-technical-mono text-technical-mono ${isCurrent ? 'text-primary font-bold' : 'text-on-surface-variant'} w-6 text-sm">${numStr}</span>
          <div class="w-12 h-12 rounded-lg bg-surface-container-lowest overflow-hidden flex-shrink-0 shadow relative">
            <img src="${escapeHTML(track.thumbnail)}" alt="Thumb" class="w-full h-full object-cover">
            ${isCurrent ? '<div class="absolute inset-0 bg-primary/20 flex items-center justify-center"><span class="material-symbols-outlined text-primary text-base">equalizer</span></div>' : ''}
          </div>
          <div class="flex flex-col min-w-0 truncate">
            <div class="flex items-center gap-2">
              <span class="font-label-md text-sm text-on-surface truncate group-hover:text-primary transition-colors ${isRestricted ? 'line-through text-outline' : ''}">${escapeHTML(track.title)}</span>
              ${isCurrent ? '<span class="px-1.5 py-0.2 rounded bg-primary/20 text-primary font-technical-mono text-[10px] uppercase font-bold">Now Playing</span>' : ''}
              ${isRestricted ? '<span class="px-1.5 py-0.2 rounded bg-error/20 text-error font-technical-mono text-[10px] uppercase font-bold">Restricted</span>' : ''}
            </div>
            <div class="flex items-center gap-2 text-xs text-on-surface-variant mt-0.5">
              <span class="font-body-sm truncate">${escapeHTML(track.artist)}</span>
              <span>•</span>
              <span class="font-technical-mono text-outline">ID: ${track.videoId}</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-space-sm flex-shrink-0">
          <button onclick="moveTrack(${idx}, -1)" class="p-1 rounded bg-surface-container hover:bg-surface-container-highest text-outline hover:text-on-surface transition-colors" title="Move up" type="button" ${idx === 0 ? 'disabled' : ''}>
            <span class="material-symbols-outlined text-sm">arrow_upward</span>
          </button>
          <button onclick="moveTrack(${idx}, 1)" class="p-1 rounded bg-surface-container hover:bg-surface-container-highest text-outline hover:text-on-surface transition-colors" title="Move down" type="button" ${idx === queue.length - 1 ? 'disabled' : ''}>
            <span class="material-symbols-outlined text-sm">arrow_downward</span>
          </button>
          <button onclick="removeTrackAt(${idx}, event)" class="p-1 rounded bg-surface-container hover:bg-error-container text-outline hover:text-error transition-colors cursor-pointer" title="Delete from queue" type="button">
            <span class="material-symbols-outlined text-base">delete</span>
          </button>
        </div>
      `;

      els.qmFullQueueContainer.appendChild(card);
    });
  }

  // View 3: Now Playing Theater
  function renderNowPlayingView() {
    renderNowPlayingQueue();
    updateHUDIdleOrTrack();
  }

  function renderNowPlayingQueue() {
    if (!els.npQueueItemsContainer) return;

    els.npQueueItemsContainer.innerHTML = '';

    if (queue.length <= 1) {
      els.npQueueItemsContainer.innerHTML = `
        <div class="p-space-md text-center text-on-surface-variant font-body-sm bg-surface-container-low rounded-lg amoled-border">
          No upcoming tracks queued.
        </div>
      `;
      return;
    }

    queue.forEach((track, idx) => {
      if (idx === currentIndex) return;

      const numStr = (idx + 1) < 10 ? `0${idx + 1}` : `${idx + 1}`;
      const row = document.createElement('div');
      row.className = 'group flex items-center justify-between p-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container-highest transition-all amoled-border cursor-pointer';

      row.innerHTML = `
        <div class="flex items-center gap-space-sm min-w-0" onclick="playTrackAt(${idx})">
          <span class="font-technical-mono text-technical-mono text-outline-variant w-4">${numStr}</span>
          <div class="w-10 h-10 rounded bg-surface-container-lowest overflow-hidden flex-shrink-0 relative">
            <img src="${escapeHTML(track.thumbnail)}" alt="Thumb" class="w-full h-full object-cover">
          </div>
          <div class="flex flex-col min-w-0 truncate">
            <span class="font-label-md text-label-md text-on-surface truncate group-hover:text-primary transition-colors">${escapeHTML(track.title)}</span>
            <span class="font-body-sm text-body-sm text-on-surface-variant truncate">${escapeHTML(track.artist)}</span>
          </div>
        </div>
        <div class="flex items-center gap-space-sm flex-shrink-0">
          <button onclick="removeTrackAt(${idx}, event)" class="opacity-0 group-hover:opacity-100 text-outline-variant hover:text-error transition-all p-1 cursor-pointer" title="Remove track" type="button">
            <span class="material-symbols-outlined text-base">close</span>
          </button>
        </div>
      `;

      els.npQueueItemsContainer.appendChild(row);
    });
  }

  window.playTrackAt = function (index) {
    if (index >= 0 && index < queue.length) {
      currentIndex = index;
      saveQueueState();
      renderQueue();
      loadAndPlayCurrentTrack();
    }
  };

  window.removeTrackAt = function (index, event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }

    if (index < 0 || index >= queue.length) return;

    const removed = queue.splice(index, 1)[0];
    showToast(`Removed "${removed.title.substring(0, 25)}..."`, 'delete');

    if (queue.length === 0) {
      currentIndex = -1;
      if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
      updatePlayPauseUI(false);
      updateHUDIdleOrTrack();
    } else if (index < currentIndex) {
      currentIndex--;
    } else if (index === currentIndex) {
      if (currentIndex >= queue.length) {
        currentIndex = queue.length - 1;
      }
      loadAndPlayCurrentTrack();
    }

    saveQueueState();
    renderQueue();
  };

  window.moveTrack = function (fromIdx, delta) {
    const toIdx = fromIdx + delta;
    if (toIdx < 0 || toIdx >= queue.length) return;

    const item = queue.splice(fromIdx, 1)[0];
    queue.splice(toIdx, 0, item);

    if (currentIndex === fromIdx) {
      currentIndex = toIdx;
    } else if (fromIdx < currentIndex && toIdx >= currentIndex) {
      currentIndex--;
    } else if (fromIdx > currentIndex && toIdx <= currentIndex) {
      currentIndex++;
    }

    saveQueueState();
    renderQueue();
  };

  window.shuffleQueue = function () {
    if (queue.length <= 1) {
      showToast('Queue too short to shuffle', 'info');
      return;
    }

    const currentTrack = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;

    let remaining = queue.filter((_, idx) => idx !== currentIndex);
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }

    if (currentTrack) {
      queue = [currentTrack, ...remaining];
      currentIndex = 0;
    } else {
      queue = remaining;
      currentIndex = 0;
    }

    saveQueueState();
    renderQueue();
    showToast('Queue shuffled (Active track retained)', 'shuffle');
  };

  // --- DRAG AND DROP REORDERING ---
  let draggedIndex = null;

  function onDragStart(e) {
    draggedIndex = parseInt(this.dataset.index, 10);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedIndex);
    this.classList.add('opacity-50');
  }

  function onDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
  }

  function onDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    const targetIndex = parseInt(this.dataset.index, 10);

    if (draggedIndex !== null && draggedIndex !== targetIndex) {
      const item = queue.splice(draggedIndex, 1)[0];
      queue.splice(targetIndex, 0, item);

      if (currentIndex === draggedIndex) {
        currentIndex = targetIndex;
      } else if (draggedIndex < currentIndex && targetIndex >= currentIndex) {
        currentIndex--;
      } else if (draggedIndex > currentIndex && targetIndex <= currentIndex) {
        currentIndex++;
      }

      saveQueueState();
      renderQueue();
      showToast('Queue reordered', 'swap_vert');
    }
    return false;
  }

  function onDragEnd() {
    this.classList.remove('opacity-50');
    draggedIndex = null;
  }

  // --- CLEAR QUEUE & RESET DATA ---
  window.toggleClearModal = function (show) {
    if (!els.clearConfirmBanner) return;
    if (show) {
      els.clearConfirmBanner.classList.remove('hidden');
      els.clearConfirmBanner.classList.add('flex');
    } else {
      els.clearConfirmBanner.classList.add('hidden');
      els.clearConfirmBanner.classList.remove('flex');
    }
  };

  window.confirmClearQueue = function () {
    queue = [];
    currentIndex = -1;
    saveQueueState();

    if (ytPlayer && ytPlayer.stopVideo) {
      ytPlayer.stopVideo();
    }

    toggleClearModal(false);
    renderQueue();
    updatePlayPauseUI(false);
    updateHUDIdleOrTrack();
    hideQueueCompleteOverlay();
    showToast('Queue cleared completely', 'delete_sweep');
  };

  window.loadDefaultPlaylist = function () {
    queue = [...DEFAULT_INITIAL_TRACKS];
    currentIndex = 0;
    saveQueueState();
    renderQueue();
    updatePlayPauseUI(false);
    updateHUDIdleOrTrack();
    hideQueueCompleteOverlay();
    if (ytPlayer && ytPlayer.cueVideoById) {
      ytPlayer.cueVideoById(queue[0].videoId);
    }
    showToast('Loaded default playlist (5 tracks)', 'playlist_add_check');
  };

  window.resetAllAppData = function () {
    if (confirm('Are you sure you want to reset all StrictQueue data, clear your queue, and restore default settings?')) {
      localStorage.clear();
      queue = [];
      currentIndex = -1;
      sessionTracksPlayed = 0;
      isLoopQueue = false;
      autoSkipRestricted = true;
      if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
      window.applyTheme('dark');
      renderQueue();
      updatePlayPauseUI(false);
      showToast('Application reset to factory defaults', 'restart_alt');
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    }
  };

  // --- EXPORT & IMPORT QUEUE JSON & TXT ---
  window.exportQueueJSON = function () {
    if (queue.length === 0) {
      showToast('Cannot export an empty queue', 'info');
      return;
    }

    const exportData = {
      app: 'StrictQueue',
      version: '2.0.0',
      exportedAt: new Date().toISOString(),
      curator: profileDisplayName,
      queue: queue
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `strictqueue_backup_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Queue exported (${queue.length} tracks .json)`, 'file_download');
  };

  window.exportQueueTXT = function () {
    if (queue.length === 0) {
      showToast('Cannot export an empty queue', 'info');
      return;
    }

    const lines = queue.map((t, i) => `${i + 1}. ${t.title} - ${t.artist}\nhttps://www.youtube.com/watch?v=${t.videoId}\n`);
    const content = `# StrictQueue Manual Playlist (${queue.length} tracks)\n# Exported: ${new Date().toLocaleString()}\n\n` + lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `strictqueue_urls_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Queue URLs exported (${queue.length} tracks .txt)`, 'description');
  };

  window.importQueueFile = function (file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (event) {
      const text = event.target.result;
      try {
        // Try parsing JSON first
        const data = JSON.parse(text);
        const importedQueue = Array.isArray(data) ? data : (data && typeof data === 'object' ? data.queue : null);

        if (Array.isArray(importedQueue) && importedQueue.length > 0) {
          const sanitizedTracks = [];
          for (const item of importedQueue) {
            if (!item || typeof item !== 'object') continue;
            // Validate YouTube video ID strictly
            const vid = item.videoId || item.id || (typeof item === 'string' ? parseYouTubeVideoId(item) : null);
            if (!isValidYouTubeId(vid)) continue;

            sanitizedTracks.push(normalizeTrack({
              videoId: vid,
              title: sanitizePlainString(item.title, `YouTube Video (${vid})`),
              artist: sanitizePlainString(item.artist, 'YouTube Artist'),
              thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              duration: sanitizePlainString(item.duration, '--:--')
            }));
          }

          if (sanitizedTracks.length > 0) {
            queue = sanitizedTracks.filter(Boolean);
            currentIndex = 0;
            saveQueueState();
            renderQueue();
            loadAndPlayCurrentTrack();
            showToast(`Successfully restored ${queue.length} verified tracks!`, 'check_circle');
            return;
          }
        }
      } catch (jsonErr) {
        // Fall back to plain text URL parsing
        const rawLines = text.split('\n');
        const extractedTracks = [];
        for (const line of rawLines) {
          const trimmed = sanitizePlainString(line);
          const vid = parseYouTubeVideoId(trimmed);
          if (vid && isValidYouTubeId(vid) && !extractedTracks.some(t => t.videoId === vid)) {
            extractedTracks.push(normalizeTrack({
              videoId: vid,
              title: `Imported YouTube Video (${vid})`,
              artist: 'Imported Track',
              thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              duration: '--:--'
            }));
          }
        }

        if (extractedTracks.length > 0) {
          queue = extractedTracks;
          currentIndex = 0;
          saveQueueState();
          renderQueue();
          loadAndPlayCurrentTrack();
          showToast(`Imported ${queue.length} tracks from text list!`, 'check_circle');
          return;
        }
      }
      showToast('No valid songs or YouTube URLs found in file', 'error');
    };
    reader.readAsText(file);
  };

  window.importQueueJSON = function (e) {
    const file = e.target.files && e.target.files[0];
    if (file) {
      window.importQueueFile(file);
    }
    e.target.value = '';
  };

  // --- STUDIO REFERENCE CHIME (440Hz Web Audio API) ---
  window.playReferenceChime = function () {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        showToast('Web Audio API not supported in this browser', 'error');
        return;
      }
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime); // Standard Concert A (440 Hz)

      // Audiophile envelope: 0.8s decay with smooth curve
      const volRatio = (currentVolume / 100);
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.01, 0.3 * volRatio), ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.85);

      showToast('Played 440Hz Reference Calibration Chime', 'graphic_eq');
    } catch (e) {
      console.warn('Reference chime audio error:', e);
      showToast('Audio test could not initialize', 'error');
    }
  };

    // --- REAL YOUTUBE SEARCH SERVICE ---
  async function searchYouTubeMultiSource(query) {
    if (!query) return [];

    // Source 1: If user configured an official YouTube Data API Key
    if (youtubeApiKey) {
      try {
        const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(query)}&key=${encodeURIComponent(youtubeApiKey)}`;
        const res = await fetch(apiUrl);
        if (res.ok) {
          const data = await res.json();
          if (data && data.items && data.items.length > 0) {
            return data.items.map(item => ({
              videoId: item.id.videoId,
              title: item.snippet.title,
              artist: item.snippet.channelTitle || 'YouTube Artist',
              duration: '--:--',
              thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${item.id.videoId}/hqdefault.jpg`,
              restricted: false
            }));
          }
        }
      } catch (e) {
        console.warn('Official API key search error, falling back:', e);
      }
    }

    // Source 2: Local dev proxy endpoint (/api/youtube-search)
    try {
      const res = await fetch(`/api/youtube-search?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const results = await res.json();
        if (Array.isArray(results) && results.length > 0) {
          return results;
        }
      }
    } catch (e) {
      console.warn('Local proxy search error, trying external public endpoints:', e);
    }

    // Source 3: Resilient public Invidious / Piped instances
    const fallbackEndpoints = [
      `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(query)}&filter=videos`,
      `https://inv.nadeko.net/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
      `https://vid.puffyan.us/api/v1/search?q=${encodeURIComponent(query)}&type=video`
    ];

    for (const ep of fallbackEndpoints) {
      try {
        const res = await fetch(ep, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const data = await res.json();
          const items = Array.isArray(data) ? data : (data.items || []);
          if (items.length > 0) {
            return items.slice(0, 8).map(v => {
              const vid = v.url ? v.url.replace('/watch?v=', '') : (v.videoId || '');
              return {
                videoId: vid,
                title: v.title || 'YouTube Video',
                artist: v.uploaderName || v.author || 'YouTube Channel',
                duration: v.duration ? (typeof v.duration === 'number' ? formatDuration(v.duration) : v.duration) : '--:--',
                thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                restricted: false
              };
            }).filter(v => v.videoId && v.videoId.length === 11);
          }
        }
      } catch (err) {
        // try next endpoint
      }
    }

    return [];
  }

  // --- SEARCH & CURATED LIST ---
  function renderSearchResults(tracks) {
    if (!els.searchResultsContainer) return;
    els.searchResultsContainer.innerHTML = '';

    tracks.forEach((track) => {
      const inQueue = queue.some(t => t.videoId === track.videoId);

      const div = document.createElement('div');
      div.className = 'group p-space-xs px-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container transition-all flex items-center justify-between gap-space-sm amoled-border';
      div.innerHTML = `
        <div class="flex items-center gap-space-sm min-w-0">
          <div class="relative w-20 h-11 rounded bg-surface-container-highest flex-shrink-0 overflow-hidden shadow">
            <img src="${escapeHTML(track.thumbnail)}" alt="Thumb" class="w-full h-full object-cover">
            <span class="absolute bottom-0.5 right-0.5 px-1 rounded bg-black/80 font-technical-mono text-technical-mono text-white text-[10px]">${track.duration || '04:00'}</span>
          </div>
          <div class="flex flex-col truncate">
            <span class="font-label-md text-label-md text-on-surface group-hover:text-primary transition-colors truncate">${escapeHTML(track.title)}</span>
            <div class="flex items-center gap-1 text-on-surface-variant text-xs">
              <span class="font-body-sm truncate">${escapeHTML(track.artist)}</span>
              <span class="material-symbols-outlined text-[11px] text-primary" style="font-variation-settings: 'FILL' 1;">check_circle</span>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-space-xs flex-shrink-0">
          <button class="px-space-sm py-1 rounded bg-surface-container-high hover:bg-primary hover:text-on-primary text-on-surface font-label-md text-xs transition-all flex items-center gap-1 shadow-sm cursor-pointer" type="button" title="Play Immediately" onclick="playNowTrack('${track.videoId}')">
            <span class="material-symbols-outlined text-xs">play_arrow</span>
            <span>Play</span>
          </button>
          <button class="px-space-sm py-1 rounded bg-surface-container-high hover:bg-surface-container-highest text-primary font-label-md text-xs transition-all flex items-center gap-1 shadow-sm cursor-pointer" type="button" title="Play Next" onclick="insertNextTrack('${track.videoId}')">
            <span class="material-symbols-outlined text-xs">queue_play_next</span>
          </button>
          <button class="px-space-sm py-1 rounded-lg ${inQueue ? 'bg-secondary-container text-on-secondary' : 'bg-primary text-on-primary'} font-label-md text-label-md text-xs transition-all flex items-center gap-1 shadow-sm cursor-pointer" type="button" onclick="addSearchedTrackToQueue('${track.videoId}')">
            <span class="material-symbols-outlined text-xs">${inQueue ? 'playlist_add_check' : 'add'}</span>
            <span>${inQueue ? 'In Queue' : 'Add to Queue'}</span>
          </button>
        </div>
      `;

      els.searchResultsContainer.appendChild(div);
    });
  }

  // --- LIVE SEARCH DROPDOWN ---
  function renderSearchDropdown(results, query) {
    if (!els.searchResultsDropdown || !els.searchDropdownList) return;
    activeSearchResults = results;

    if (!results || results.length === 0) {
      els.searchDropdownList.innerHTML = `
        <div class="p-space-md text-center text-on-surface-variant font-body-sm text-xs">
          No YouTube matches found for "${escapeHTML(query)}". Paste a direct YouTube link or try another search query.
        </div>
      `;
      els.searchResultsDropdown.classList.remove('hidden');
      return;
    }

    if (els.searchQueryBadge) els.searchQueryBadge.textContent = `("${query}")`;
    els.searchDropdownList.innerHTML = '';

    results.forEach((track) => {
      const inQueue = queue.some(t => t.videoId === track.videoId);
      const row = document.createElement('div');
      row.className = 'group p-space-xs px-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container-high transition-all flex items-center justify-between gap-space-sm amoled-border cursor-pointer';

      row.innerHTML = `
        <div class="flex items-center gap-space-sm min-w-0 flex-1" onclick="playNowTrack('${track.videoId}')">
          <div class="relative w-16 h-10 rounded overflow-hidden bg-black flex-shrink-0 shadow-sm">
            <img src="${escapeHTML(track.thumbnail)}" alt="" class="w-full h-full object-cover">
            <span class="absolute bottom-0.5 right-0.5 px-1 rounded bg-black/80 font-technical-mono text-[9px] text-white">${escapeHTML(track.duration)}</span>
          </div>
          <div class="flex flex-col min-w-0">
            <span class="font-label-md text-label-md text-on-surface group-hover:text-primary transition-colors truncate text-xs">${escapeHTML(track.title)}</span>
            <span class="font-technical-mono text-[10px] text-on-surface-variant truncate">${escapeHTML(track.artist)}</span>
          </div>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0" onclick="event.stopPropagation()">
          <button class="px-2 py-1 rounded bg-surface-container hover:bg-primary hover:text-on-primary text-on-surface font-label-md text-xs transition-all flex items-center gap-1 cursor-pointer" type="button" title="Play Immediately" onclick="playNowTrack('${track.videoId}')">
            <span class="material-symbols-outlined text-xs">play_arrow</span>
            <span class="hidden sm:inline">Play</span>
          </button>
          <button class="px-2 py-1 rounded bg-surface-container hover:bg-surface-bright text-primary font-label-md text-xs transition-all flex items-center gap-1 cursor-pointer" type="button" title="Insert Right After Active Track" onclick="insertNextTrack('${track.videoId}')">
            <span class="material-symbols-outlined text-xs">queue_play_next</span>
            <span class="hidden sm:inline">Next</span>
          </button>
          <button class="px-2.5 py-1 rounded ${inQueue ? 'bg-primary/20 text-primary' : 'bg-primary text-on-primary font-bold'} font-label-md text-xs transition-all flex items-center gap-1 cursor-pointer" type="button" title="Append to Queue" onclick="addSearchedTrackToQueue('${track.videoId}')">
            <span class="material-symbols-outlined text-xs">${inQueue ? 'check' : 'add'}</span>
            <span>${inQueue ? 'Queued' : '+ Queue'}</span>
          </button>
        </div>
      `;

      els.searchDropdownList.appendChild(row);
    });

    els.searchResultsDropdown.classList.remove('hidden');
  }

  window.closeSearchDropdown = function () {
    if (els.searchResultsDropdown) {
      els.searchResultsDropdown.classList.add('hidden');
    }
  };

  window.playNowTrack = async function (videoId) {
    let rawTrack = activeSearchResults.find(t => t.videoId === videoId) || CURATED_TRACKS.find(t => t.videoId === videoId);
    if (!rawTrack) {
      try {
        rawTrack = await fetchVideoMetadata(videoId);
      } catch (err) {
        rawTrack = { videoId };
      }
    }

    const track = normalizeTrack(rawTrack);
    if (!track) return;

    const wasEmpty = queue.length === 0;
    if (wasEmpty) {
      queue.push(track);
      currentIndex = 0;
    } else {
      queue.splice(currentIndex + 1, 0, track);
      currentIndex = currentIndex + 1;
    }

    saveQueueState();
    renderQueue();
    loadAndPlayCurrentTrack();
    closeSearchDropdown();
    showToast(`Playing now: "${track.title.substring(0, 25)}..."`, 'play_arrow');
  };

  window.insertNextTrack = async function (videoId) {
    let track = activeSearchResults.find(t => t.videoId === videoId) || CURATED_TRACKS.find(t => t.videoId === videoId);
    if (!track) {
      track = await fetchVideoMetadata(videoId);
    }
    insertTrackNext(track);
    closeSearchDropdown();
    showToast(`Set to play next: "${track.title.substring(0, 25)}..."`, 'queue_play_next');
  };

  window.addSearchedTrackToQueue = async function (videoId) {
    let track = activeSearchResults.find(t => t.videoId === videoId) || CURATED_TRACKS.find(t => t.videoId === videoId);
    if (!track) {
      track = await fetchVideoMetadata(videoId);
    }
    addTrackToQueue(track);
    renderSearchDropdown(activeSearchResults, els.urlInput.value.trim());
    showToast(`Added to queue: "${track.title.substring(0, 25)}..."`, 'playlist_add_check');
  };

  window.saveYoutubeApiKey = function () {
    if (els.apiKeyInput) {
      youtubeApiKey = els.apiKeyInput.value.trim();
      try {
        localStorage.setItem(STORAGE_YT_API_KEY, youtubeApiKey);
      } catch (e) {}
      showToast(youtubeApiKey ? 'YouTube API Key saved successfully' : 'YouTube API Key cleared (Using zero-key engine)', 'check_circle');
    }
  };

  window.saveGeminiApiKey = function () {
    if (els.geminiApiKeyInput) {
      geminiApiKey = els.geminiApiKeyInput.value.trim();
      try {
        localStorage.setItem(STORAGE_GEMINI_API_KEY, geminiApiKey);
      } catch (e) {}
      updateGeminiKeyBadgeUI();
      showToast(geminiApiKey ? 'Gemini API Key saved! Neural advisor active' : 'Gemini Key cleared (Using built-in Smart Query engine)', 'check_circle');
      // Re-trigger suggestions if current track exists
      refreshAiAdvisor(true);
    }
  };

  function updateGeminiKeyBadgeUI() {
    if (els.geminiKeyStatusBadge) {
      if (geminiApiKey) {
        els.geminiKeyStatusBadge.textContent = 'Gemini 2.5 Active';
        els.geminiKeyStatusBadge.className = 'font-technical-mono text-[10px] text-primary uppercase bg-primary/10 px-2 py-0.5 rounded';
      } else {
        els.geminiKeyStatusBadge.textContent = 'Smart Query Engine Active';
        els.geminiKeyStatusBadge.className = 'font-technical-mono text-[10px] text-tertiary uppercase bg-tertiary/10 px-2 py-0.5 rounded';
      }
    }
    if (els.aiAdvisorEngineBadge) {
      els.aiAdvisorEngineBadge.textContent = geminiApiKey ? 'Gemini 2.5 Flash' : 'Built-in AI';
    }
  }

  async function performLiveSearch(query) {
    if (!query) {
      closeSearchDropdown();
      return;
    }

    if (els.searchSpinner) {
      els.searchSpinner.classList.remove('hidden');
      els.searchSpinner.classList.add('flex');
    }

    try {
      const results = await searchYouTubeMultiSource(query);
      renderSearchDropdown(results, query);
      renderSearchResults(results);
    } catch (e) {
      console.error('Search failure:', e);
      showToast('Search request timed out. Please try direct video URL', 'error');
    } finally {
      if (els.searchSpinner) {
        els.searchSpinner.classList.add('hidden');
        els.searchSpinner.classList.remove('flex');
      }
    }
  }

  // --- INGEST MODE SWITCHER ---
  window.switchIngestMode = function (mode) {
    currentIngestMode = mode;
    if (mode === 'url') {
      if (els.tabUrlBtn) els.tabUrlBtn.className = 'flex items-center gap-space-xs px-space-sm py-1 rounded bg-primary-container text-on-primary font-label-md text-label-md transition-all shadow-sm cursor-pointer';
      if (els.tabSearchBtn) els.tabSearchBtn.className = 'flex items-center gap-space-xs px-space-sm py-1 rounded text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-all font-label-md text-label-md cursor-pointer';
      if (els.inputModeIcon) els.inputModeIcon.textContent = 'link';
      if (els.urlInput) {
        els.urlInput.placeholder = 'Paste YouTube link / ID or type any song name to search...';
        els.urlInput.focus();
      }
    } else {
      if (els.tabSearchBtn) els.tabSearchBtn.className = 'flex items-center gap-space-xs px-space-sm py-1 rounded bg-primary-container text-on-primary font-label-md text-label-md transition-all shadow-sm cursor-pointer';
      if (els.tabUrlBtn) els.tabUrlBtn.className = 'flex items-center gap-space-xs px-space-sm py-1 rounded text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-all font-label-md text-label-md cursor-pointer';
      if (els.inputModeIcon) els.inputModeIcon.textContent = 'search';
      if (els.urlInput) {
        els.urlInput.placeholder = 'Search songs, artists, or videos on YouTube...';
        els.urlInput.focus();
        if (els.urlInput.value.trim()) {
          performLiveSearch(els.urlInput.value.trim());
        }
      }
    }
  };

  window.focusIngestInput = function () {
    window.switchTab('dashboard');
    window.switchIngestMode('url');
    if (els.urlInput) {
      els.urlInput.focus();
      els.urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  window.scrollToQueue = function () {
    window.switchTab('dashboard');
    if (els.queueContainer) {
      els.queueContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // --- TOAST NOTIFICATIONS ---
  function showToast(message, iconName = 'info', duration = 3000) {
    if (!els.toastBanner) return;
    if (toastTimer) clearTimeout(toastTimer);

    if (els.toastIcon) els.toastIcon.textContent = iconName;
    if (els.toastMessage) els.toastMessage.textContent = message;

    els.toastBanner.classList.remove('hidden');
    els.toastBanner.classList.add('flex');

    toastTimer = setTimeout(() => {
      hideToast();
    }, duration);
  }

  window.hideToast = function () {
    if (els.toastBanner) {
      els.toastBanner.classList.add('hidden');
      els.toastBanner.classList.remove('flex');
    }
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  };

  // --- EVENT LISTENERS ---
  function setupEventListeners() {
    // URL & Search Ingestion
    if (els.addToQueueBtn) {
      els.addToQueueBtn.addEventListener('click', handleAddUrlSubmit);
    }
    if (els.playNextBtn) {
      els.playNextBtn.addEventListener('click', handlePlayNextSubmit);
    }
    if (els.urlInput) {
      els.urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAddUrlSubmit();
        } else if (e.key === 'Escape') {
          closeSearchDropdown();
        }
      });

      // Live debounced search (400ms)
      els.urlInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

        if (!val) {
          closeSearchDropdown();
          return;
        }

        // If it's a direct URL or 11-char ID, don't trigger search dropdown
        if (parseYouTubeVideoId(val)) {
          closeSearchDropdown();
          return;
        }

        // Plain text query -> live search
        searchDebounceTimer = setTimeout(() => {
          performLiveSearch(val);
        }, 400);
      });
    }

    // Close search dropdown on click outside
    document.addEventListener('click', (e) => {
      if (els.searchResultsDropdown && !els.searchResultsDropdown.contains(e.target) && e.target !== els.urlInput) {
        closeSearchDropdown();
      }
    });

    // Play/Pause buttons
    if (els.cardPlayPauseBtn) {
      els.cardPlayPauseBtn.addEventListener('click', window.togglePlayPause);
    }
    if (els.footerPlayPauseBtn) {
      els.footerPlayPauseBtn.addEventListener('click', window.togglePlayPause);
    }
    if (els.npPlayPauseBtn) {
      els.npPlayPauseBtn.addEventListener('click', window.togglePlayPause);
    }

    // Scrub Bars
    setupScrubber(els.cardScrubBar);
    setupScrubber(els.footerScrubBar);
    setupScrubber(els.npScrubBar);

    // Volume Sliders
    setupVolumeSlider(els.cardVolumeSlider);
    setupVolumeSlider(els.footerVolumeSlider);
    setupVolumeSlider(els.popoverVolSlider);

    // Close popovers on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#audio-popover') && !e.target.closest('#audio-settings-btn')) {
        if (els.audioPopover) {
          els.audioPopover.classList.add('hidden');
          els.audioPopover.classList.remove('flex');
        }
      }
      if (!e.target.closest('#profile-popover') && !e.target.closest('#profile-btn')) {
        if (els.profilePopover) {
          els.profilePopover.classList.add('hidden');
          els.profilePopover.classList.remove('flex');
        }
      }
    });

    // Keyboard Shortcuts (Works in standard & fullscreen mode)
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Smooth page scrolling with ArrowUp & ArrowDown
      if (e.code === 'ArrowDown' && !e.shiftKey) {
        e.preventDefault();
        window.scrollBy({ top: 120, behavior: 'smooth' });
        return;
      } else if (e.code === 'ArrowUp' && !e.shiftKey) {
        e.preventDefault();
        window.scrollBy({ top: -120, behavior: 'smooth' });
        return;
      }

      // Space: Toggle Play/Pause
      if (e.code === 'Space') {
        e.preventDefault();
        window.togglePlayPause();
      }
      // ArrowRight: Seek +5s
      else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (ytPlayer && ytPlayer.getCurrentTime) {
          const t = ytPlayer.getCurrentTime();
          ytPlayer.seekTo(t + 5, true);
        }
      }
      // ArrowLeft: Seek -5s
      else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (ytPlayer && ytPlayer.getCurrentTime) {
          const t = ytPlayer.getCurrentTime();
          ytPlayer.seekTo(Math.max(0, t - 5), true);
        }
      }
      // Volume Up (+, =, or Shift + ArrowUp)
      else if (e.key === '+' || e.key === '=' || (e.shiftKey && e.code === 'ArrowUp')) {
        e.preventDefault();
        window.adjustVolumeBy(5);
      }
      // Volume Down (-, _, or Shift + ArrowDown)
      else if (e.key === '-' || e.key === '_' || (e.shiftKey && e.code === 'ArrowDown')) {
        e.preventDefault();
        window.adjustVolumeBy(-5);
      }
      // Mute Toggle (M / m)
      else if (e.code === 'KeyM') {
        e.preventDefault();
        window.toggleMute();
      }
      // Fullscreen Toggle (F / f)
      else if (e.code === 'KeyF') {
        e.preventDefault();
        window.toggleFullscreen();
      }
    });

    // Theme Selector Cards (Appearance Console)
    const themeCards = document.querySelectorAll('#theme-selector-group .theme-card');
    themeCards.forEach(card => {
      card.addEventListener('click', () => {
        const selectedTheme = card.getAttribute('data-theme');
        if (selectedTheme) {
          window.applyTheme(selectedTheme);
          showToast(`Applied ${getThemeName(selectedTheme)} theme`, 'palette');
        }
      });
    });

    // Ambient Glow Toggle
    const ambientGlowCheckbox = document.getElementById('ambient-glow');
    if (ambientGlowCheckbox) {
      ambientGlowCheckbox.addEventListener('change', (e) => {
        window.toggleAmbientGlow(e.target.checked);
      });
    }

    // Clear Saved Data Modal in Settings
    if (els.btnOpenClearModal) {
      els.btnOpenClearModal.addEventListener('click', () => {
        if (els.clearConfirmModal) els.clearConfirmModal.classList.remove('hidden');
      });
    }
    if (els.btnCancelClear) {
      els.btnCancelClear.addEventListener('click', () => {
        if (els.clearConfirmModal) els.clearConfirmModal.classList.add('hidden');
      });
    }
    if (els.btnConfirmClear) {
      els.btnConfirmClear.addEventListener('click', () => {
        if (els.clearConfirmModal) els.clearConfirmModal.classList.add('hidden');
        window.resetAllAppData();
      });
    }
  }

  function setupScrubber(bar) {
    if (!bar) return;

    function seek(e) {
      const rect = bar.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const width = rect.width;
      const ratio = Math.max(0, Math.min(1, clickX / width));

      if (ytPlayer && typeof ytPlayer.getDuration === 'function') {
        const dur = ytPlayer.getDuration() || 0;
        const targetTime = dur * ratio;
        ytPlayer.seekTo(targetTime, true);
        updateScrubUI(targetTime, dur);
      }
    }

    bar.addEventListener('click', seek);
  }

  function setupVolumeSlider(slider) {
    if (!slider) return;

    function setVol(e) {
      const rect = slider.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const width = rect.width;
      const ratio = Math.max(0, Math.min(1, clickX / width));
      const vol = Math.round(ratio * 100);

      currentVolume = vol;
      isMuted = false;

      if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
        ytPlayer.unMute();
        ytPlayer.setVolume(vol);
      }

      try {
        localStorage.setItem(STORAGE_VOLUME, vol.toString());
        localStorage.setItem(STORAGE_MUTED, 'false');
      } catch (e) {}

      updateVolumeUI(vol);
      showVolumeHud(vol, false);
    }

    slider.addEventListener('click', setVol);
  }

  // --- AI TRACK ADVISOR (SUGGEST-ONLY COMPANION) ---
  window.toggleAiAdvisorDrawer = function () {
    if (!els.aiAdvisorDrawer || !els.aiAdvisorDrawerBackdrop) return;
    const isClosed = els.aiAdvisorDrawer.classList.contains('translate-x-full');
    if (isClosed) {
      els.aiAdvisorDrawer.classList.remove('translate-x-full');
      els.aiAdvisorDrawerBackdrop.classList.remove('hidden', 'pointer-events-none');
      requestAnimationFrame(() => {
        els.aiAdvisorDrawerBackdrop.classList.remove('opacity-0');
        els.aiAdvisorDrawerBackdrop.classList.add('opacity-100');
      });
      renderAiAdvisorUI();
    } else {
      closeAiAdvisorDrawer();
    }
  };

  window.closeAiAdvisorDrawer = function () {
    if (!els.aiAdvisorDrawer || !els.aiAdvisorDrawerBackdrop) return;
    els.aiAdvisorDrawer.classList.add('translate-x-full');
    els.aiAdvisorDrawerBackdrop.classList.remove('opacity-100');
    els.aiAdvisorDrawerBackdrop.classList.add('opacity-0');
    setTimeout(() => {
      els.aiAdvisorDrawerBackdrop.classList.add('hidden', 'pointer-events-none');
    }, 300);
  };

  window.toggleAiAdvisorCard = function () {
    if (!els.aiAdvisorContent || !els.aiAdvisorCollapseIcon) return;
    isAiAdvisorCollapsed = !isAiAdvisorCollapsed;
    if (isAiAdvisorCollapsed) {
      els.aiAdvisorContent.classList.add('hidden');
      els.aiAdvisorCollapseIcon.textContent = 'expand_more';
    } else {
      els.aiAdvisorContent.classList.remove('hidden');
      els.aiAdvisorCollapseIcon.textContent = 'expand_less';
    }
  };

  window.setAiVibe = function (vibe) {
    if (currentAiVibe === vibe) return;
    currentAiVibe = vibe;
    updateAiVibePillStyles();
    refreshAiAdvisor(true);
  };

  function updateAiVibePillStyles() {
    const pills = document.querySelectorAll('.ai-vibe-pill');
    pills.forEach(pill => {
      const v = pill.getAttribute('data-vibe');
      if (v === currentAiVibe) {
        pill.className = 'ai-vibe-pill px-2.5 py-1 rounded-full text-xs font-label-md whitespace-nowrap transition-all cursor-pointer bg-primary text-on-primary shadow-sm';
      } else {
        pill.className = 'ai-vibe-pill px-2.5 py-1 rounded-full text-xs font-label-md whitespace-nowrap transition-all cursor-pointer bg-surface-container-high text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest';
      }
    });
  }

  window.refreshAiAdvisor = async function (force = false) {
    const currentTrack = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
    if (!currentTrack) {
      currentAiSuggestions = [];
      renderAiAdvisorUI();
      return;
    }

    if (isAiAdvisorLoading) return;
    isAiAdvisorLoading = true;

    // Spin refresh icon
    if (els.aiAdvisorRefreshIcon) els.aiAdvisorRefreshIcon.classList.add('animate-spin');
    renderAiAdvisorLoadingState();

    try {
      if (geminiApiKey) {
        currentAiSuggestions = await generateGeminiRecommendations(currentTrack, currentAiVibe);
      } else {
        currentAiSuggestions = await generateSmartQueryRecommendations(currentTrack, currentAiVibe);
      }
    } catch (err) {
      console.warn('AI Advisor generation error, falling back to smart queries:', err);
      try {
        currentAiSuggestions = await generateSmartQueryRecommendations(currentTrack, currentAiVibe);
      } catch (e) {
        currentAiSuggestions = [];
      }
    } finally {
      isAiAdvisorLoading = false;
      if (els.aiAdvisorRefreshIcon) els.aiAdvisorRefreshIcon.classList.remove('animate-spin');
      renderAiAdvisorUI();
    }
  };

  // 1. Built-in Smart Query Engine (Zero API Key Required)
  async function generateSmartQueryRecommendations(track, vibe) {
    const title = track.title || '';
    const artist = track.artist || '';

    // Extract core song keywords
    const cleanTitle = title
      .replace(/\(.*?\)/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/ft\..*|feat\..*/i, '')
      .replace(/official video|music video|audio|lyric video/gi, '')
      .trim();

    const queries = [];
    let reasonTag = 'Matches artist & genre';

    if (vibe === 'same_vibe') {
      queries.push(`${artist} popular songs`);
      queries.push(`${cleanTitle} similar songs`);
      queries.push(`${artist} style phonk music`);
      reasonTag = 'Matches active tempo & vibe';
    } else if (vibe === 'slowed') {
      queries.push(`${cleanTitle} slowed reverb`);
      queries.push(`${artist} slowed bass boosted`);
      queries.push(`${cleanTitle} ultra slowed`);
      reasonTag = 'Slowed & enhanced bass';
    } else if (vibe === 'remix') {
      queries.push(`${cleanTitle} mashup`);
      queries.push(`${cleanTitle} remix bass`);
      queries.push(`${artist} club remix edit`);
      reasonTag = 'Mashup & high-energy remix';
    } else if (vibe === 'discovery') {
      queries.push(`songs like ${cleanTitle}`);
      queries.push(`underground ${artist || 'audiophile synth phonk'}`);
      queries.push(`trending phonk electro track`);
      reasonTag = 'Fresh algorithmic discovery';
    }

    const aggregated = [];
    const seenIds = new Set(queue.map(t => t.videoId));
    if (track.videoId) seenIds.add(track.videoId);

    for (const q of queries) {
      if (aggregated.length >= 5) break;
      try {
        const results = await searchYouTubeMultiSource(q);
        if (results && results.length > 0) {
          for (const item of results) {
            if (item.videoId && !seenIds.has(item.videoId)) {
              seenIds.add(item.videoId);
              aggregated.push({
                videoId: item.videoId,
                title: item.title,
                artist: item.artist,
                thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
                duration: item.duration || '--:--',
                reason: reasonTag
              });
              if (aggregated.length >= 5) break;
            }
          }
        }
      } catch (e) {
        console.warn('Smart query search error for query:', q, e);
      }
    }

    // Fallback: If search yielded less than 4, draw from curated presets not already in queue
    if (aggregated.length < 4) {
      for (const preset of CURATED_TRACKS) {
        if (!seenIds.has(preset.videoId)) {
          seenIds.add(preset.videoId);
          aggregated.push({
            ...preset,
            reason: 'Curated studio recommendation'
          });
          if (aggregated.length >= 4) break;
        }
      }
    }

    return aggregated.slice(0, 5);
  }

  // 2. Optional Gemini API Key Engine (gemini-2.5-flash with structured JSON)
  async function generateGeminiRecommendations(track, vibe) {
    const prompt = `You are an audiophile music expert for a strict manual queue music player.
The user is currently listening to:
Song Title: "${track.title}"
Artist: "${track.artist}"
Selected Vibe Preference: "${vibe}" (same_vibe = similar tempo/energy, slowed = slowed/reverb/deep bass, remix = mashups/edits, discovery = fresh hidden gems with similar sonic identity).

Recommend exactly 5 distinct, real songs available on YouTube that fit this criteria.
Return ONLY valid JSON in this exact structure without markdown backticks:
{
  "recommendations": [
    {
      "searchQuery": "Artist - Song Title",
      "reason": "Short 3-5 word rationale explaining why it fits"
    }
  ]
}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.7
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API returned status ${response.status}`);
    }

    const data = await response.json();
    const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidateText) throw new Error('No candidate content from Gemini');

    const parsed = JSON.parse(candidateText.trim());
    const recs = parsed.recommendations || [];
    if (!Array.isArray(recs) || recs.length === 0) throw new Error('Empty recommendations array');

    const resolved = [];
    const seenIds = new Set(queue.map(t => t.videoId));
    if (track.videoId) seenIds.add(track.videoId);

    for (const item of recs) {
      if (resolved.length >= 5) break;
      const q = item.searchQuery || item.title || '';
      if (!q) continue;
      try {
        const results = await searchYouTubeMultiSource(q);
        if (results && results.length > 0) {
          const match = results.find(r => !seenIds.has(r.videoId)) || results[0];
          if (match && !seenIds.has(match.videoId)) {
            seenIds.add(match.videoId);
            resolved.push({
              videoId: match.videoId,
              title: match.title,
              artist: match.artist,
              thumbnail: match.thumbnail,
              duration: match.duration,
              reason: item.reason || 'AI neural match'
            });
          }
        }
      } catch (err) {
        console.warn('Error resolving Gemini query to YouTube:', q, err);
      }
    }

    if (resolved.length === 0) {
      return generateSmartQueryRecommendations(track, vibe);
    }
    return resolved;
  }

  // --- RENDERING AI ADVISOR UI ---
  function renderAiAdvisorLoadingState() {
    const loadingHtml = `
      <div class="p-space-md rounded-lg bg-surface-container-low flex items-center justify-center gap-space-sm text-on-surface-variant font-technical-mono text-xs">
        <span class="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></span>
        <span>Curating recommendations for active track...</span>
      </div>
    `;
    if (els.aiAdvisorList) els.aiAdvisorList.innerHTML = loadingHtml;
    if (els.aiDrawerList) els.aiDrawerList.innerHTML = loadingHtml;
  }

  function renderAiAdvisorUI() {
    const currentTrack = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;

    if (els.aiDrawerCurrentTitle) {
      els.aiDrawerCurrentTitle.textContent = currentTrack ? `${currentTrack.title} (${currentTrack.artist})` : 'No track currently playing';
    }

    if (!currentTrack) {
      const emptyHtml = `
        <div class="p-space-md rounded-lg bg-surface-container-low text-center flex flex-col items-center gap-1">
          <span class="material-symbols-outlined text-outline text-xl">music_off</span>
          <span class="font-label-md text-xs text-on-surface">No Track Playing</span>
          <span class="font-body-sm text-[11px] text-on-surface-variant">Play or add a song to receive suggestions.</span>
        </div>
      `;
      if (els.aiAdvisorList) els.aiAdvisorList.innerHTML = emptyHtml;
      if (els.aiDrawerList) els.aiDrawerList.innerHTML = emptyHtml;
      return;
    }

    if (currentAiSuggestions.length === 0) {
      const noRecsHtml = `
        <div class="p-space-md rounded-lg bg-surface-container-low text-center flex flex-col items-center gap-1.5">
          <span class="font-label-md text-xs text-on-surface">No fresh recommendations available</span>
          <button onclick="refreshAiAdvisor(true)" class="px-space-sm py-1 rounded bg-primary text-on-primary font-technical-mono text-xs flex items-center gap-1 cursor-pointer">
            <span class="material-symbols-outlined text-xs">refresh</span> Retry Search
          </button>
        </div>
      `;
      if (els.aiAdvisorList) els.aiAdvisorList.innerHTML = noRecsHtml;
      if (els.aiDrawerList) els.aiDrawerList.innerHTML = noRecsHtml;
      return;
    }

    const cardsHtml = currentAiSuggestions.map((item, idx) => `
      <div class="group relative p-2 rounded-lg bg-surface-container-low hover:bg-surface-container transition-all flex items-center justify-between gap-2.5 amoled-border">
        <!-- Thumbnail -->
        <div class="relative w-16 h-10 rounded bg-surface-container-highest flex-shrink-0 overflow-hidden shadow">
          <img src="${escapeHTML(item.thumbnail)}" alt="Thumb" class="w-full h-full object-cover">
          <span class="absolute bottom-0.5 right-0.5 px-0.5 rounded bg-black/80 font-technical-mono text-technical-mono text-white text-[9px]">${item.duration || '--:--'}</span>
        </div>

        <!-- Info & Reason Tag -->
        <div class="flex flex-col min-w-0 flex-1">
          <span class="font-label-md text-xs text-on-surface truncate group-hover:text-primary transition-colors" title="${escapeHTML(item.title)}">${escapeHTML(item.title)}</span>
          <div class="flex items-center gap-1 text-on-surface-variant text-[11px] truncate">
            <span class="truncate">${escapeHTML(item.artist)}</span>
            <span>•</span>
            <span class="text-tertiary font-technical-mono text-[10px] font-semibold">${escapeHTML(item.reason || 'Vibe match')}</span>
          </div>
        </div>

        <!-- Strict Manual Actions Strip -->
        <div class="flex items-center gap-1 flex-shrink-0">
          <button onclick="addAiSuggestionNext('${item.videoId}')" class="px-2 py-1 rounded bg-surface-container-high hover:bg-surface-container-highest text-primary font-label-md text-[11px] transition-all flex items-center gap-0.5 cursor-pointer" title="Play Next after current song">
            <span class="material-symbols-outlined text-xs">queue_play_next</span>
            <span class="hidden sm:inline">Next</span>
          </button>
          <button onclick="addAiSuggestionToQueue('${item.videoId}')" class="px-2 py-1 rounded bg-primary hover:bg-primary/90 text-on-primary font-label-md text-[11px] transition-all flex items-center gap-0.5 cursor-pointer shadow-sm" title="Add to end of manual queue">
            <span class="material-symbols-outlined text-xs">add</span>
            <span class="hidden sm:inline">Queue</span>
          </button>
          <button onclick="dismissAiSuggestion(${idx})" class="p-1 rounded text-outline hover:text-error hover:bg-surface-container-highest transition-colors cursor-pointer" title="Dismiss this suggestion">
            <span class="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
      </div>
    `).join('');

    if (els.aiAdvisorList) els.aiAdvisorList.innerHTML = cardsHtml;
    if (els.aiDrawerList) els.aiDrawerList.innerHTML = cardsHtml;
  }

  // Suggestion Manual Actions
  window.addAiSuggestionToQueue = function (videoId) {
    const item = currentAiSuggestions.find(s => s.videoId === videoId);
    if (!item) return;

    addTrackToQueue({
      videoId: item.videoId,
      title: item.title,
      artist: item.artist,
      thumbnail: item.thumbnail,
      duration: item.duration
    });

    // Remove from suggestions list and refresh UI
    currentAiSuggestions = currentAiSuggestions.filter(s => s.videoId !== videoId);
    renderAiAdvisorUI();
    showToast(`Added to queue: "${item.title.substring(0, 24)}..."`, 'playlist_add_check');
  };

  window.addAiSuggestionNext = function (videoId) {
    const item = currentAiSuggestions.find(s => s.videoId === videoId);
    if (!item) return;

    insertTrackNext({
      videoId: item.videoId,
      title: item.title,
      artist: item.artist,
      thumbnail: item.thumbnail,
      duration: item.duration
    });

    currentAiSuggestions = currentAiSuggestions.filter(s => s.videoId !== videoId);
    renderAiAdvisorUI();
    showToast(`Set to play next: "${item.title.substring(0, 24)}..."`, 'queue_play_next');
  };

  window.dismissAiSuggestion = async function (idx) {
    if (idx >= 0 && idx < currentAiSuggestions.length) {
      const dismissed = currentAiSuggestions.splice(idx, 1)[0];
      renderAiAdvisorUI();
      showToast(`Dismissed: "${dismissed.title.substring(0, 20)}..."`, 'close');

      // If suggestions are running low, draw replacement from search
      if (currentAiSuggestions.length < 3) {
        const currentTrack = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
        if (currentTrack) {
          const replacements = await generateSmartQueryRecommendations(currentTrack, currentAiVibe);
          const existingIds = new Set(currentAiSuggestions.map(s => s.videoId));
          for (const rep of replacements) {
            if (!existingIds.has(rep.videoId)) {
              currentAiSuggestions.push(rep);
              break;
            }
          }
          renderAiAdvisorUI();
        }
      }
    }
  };

  // --- INTERACTIVE OVERVIEW MODAL ("HOW IT WORKS") ---
  function checkFirstVisitGuide() {
    try {
      const hasSeen = localStorage.getItem(STORAGE_HAS_SEEN_GUIDE);
      if (!hasSeen) {
        // Automatically display overview on first visit after a brief smooth delay
        setTimeout(() => {
          openOverviewModal();
        }, 600);
      }
    } catch (e) {
      console.warn('Error reading guide status from storage:', e);
    }
  }

  window.openOverviewModal = function () {
    if (!els.overviewModalBackdrop) return;
    closeAllPopovers();
    els.overviewModalBackdrop.classList.remove('hidden');
    requestAnimationFrame(() => {
      els.overviewModalBackdrop.classList.remove('opacity-0');
      els.overviewModalBackdrop.classList.add('opacity-100');
      const dialog = els.overviewModalBackdrop.querySelector('div');
      if (dialog) {
        dialog.classList.remove('scale-95');
        dialog.classList.add('scale-100');
      }
    });
  };

  window.closeOverviewModal = function () {
    if (!els.overviewModalBackdrop) return;
    els.overviewModalBackdrop.classList.remove('opacity-100');
    els.overviewModalBackdrop.classList.add('opacity-0');
    const dialog = els.overviewModalBackdrop.querySelector('div');
    if (dialog) {
      dialog.classList.remove('scale-100');
      dialog.classList.add('scale-95');
    }
    setTimeout(() => {
      els.overviewModalBackdrop.classList.add('hidden');
    }, 200);
  };

  window.dismissOverviewModal = function () {
    try {
      localStorage.setItem(STORAGE_HAS_SEEN_GUIDE, 'true');
    } catch (e) {}
    closeOverviewModal();
    showToast('Ready! Paste a URL, search songs, or use the mic to queue.', 'check_circle');
  };

  // --- HANDS-FREE VOICE SEARCH & COMMAND ASSISTANT ---
  window.toggleVoiceAssistant = function () {
    if (isVoiceListening) {
      stopVoiceAssistant();
    } else {
      startVoiceAssistant();
    }
  };

  function startVoiceAssistant() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      showToast('Voice Search is not supported in this browser. Please use Chrome, Edge, or Safari.', 'error');
      return;
    }

    try {
      voiceRecognition = new SpeechRecognition();
      voiceRecognition.lang = 'en-US';
      voiceRecognition.continuous = false;
      voiceRecognition.interimResults = true;
      voiceRecognition.maxAlternatives = 1;

      voiceRecognition.onstart = () => {
        isVoiceListening = true;
        setVoiceMicActiveUI(true);
        if (els.urlInput) {
          els.urlInput.placeholder = 'Listening... Speak your song or voice command';
        }
        showToast('Listening... Speak a song name or command', 'mic');
      };

      voiceRecognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interimTranscript += transcript;
          }
        }

        const currentSpoken = (finalTranscript || interimTranscript).trim();
        if (els.urlInput && currentSpoken) {
          els.urlInput.value = currentSpoken;
        }

        if (finalTranscript) {
          handleVoiceCommand(finalTranscript.trim());
        }
      };

      voiceRecognition.onerror = (event) => {
        console.warn('Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
          showToast('Microphone access denied. Please grant permission in browser.', 'error');
        } else if (event.error !== 'no-speech') {
          showToast(`Voice input: ${event.error}`, 'error');
        }
        stopVoiceAssistant();
      };

      voiceRecognition.onend = () => {
        stopVoiceAssistant();
      };

      voiceRecognition.start();
    } catch (err) {
      console.warn('Failed to start voice recognition:', err);
      showToast('Could not initialize microphone.', 'error');
      stopVoiceAssistant();
    }
  }

  function stopVoiceAssistant() {
    isVoiceListening = false;
    setVoiceMicActiveUI(false);
    if (voiceRecognition) {
      try {
        voiceRecognition.stop();
      } catch (e) {}
      voiceRecognition = null;
    }
    if (els.urlInput) {
      els.urlInput.placeholder = currentIngestMode === 'search'
        ? 'Search songs, artists, or videos on YouTube...'
        : 'Paste YouTube link / ID or type any song name to search...';
    }
  }

  function setVoiceMicActiveUI(active) {
    if (!els.voiceSearchBtn || !els.voiceMicIcon) return;
    if (active) {
      els.voiceSearchBtn.className = 'absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-primary text-on-primary animate-pulse transition-all flex items-center justify-center cursor-pointer shadow-md neon-glow';
      els.voiceMicIcon.textContent = 'mic';
    } else {
      els.voiceSearchBtn.className = 'absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full text-on-surface-variant hover:text-primary hover:bg-surface-container-highest transition-all flex items-center justify-center cursor-pointer';
      els.voiceMicIcon.textContent = 'mic';
    }
  }

  // Smart Voice Intent Routing
  async function handleVoiceCommand(rawTranscript) {
    if (!rawTranscript) return;
    const lower = rawTranscript.toLowerCase().trim();

    // 1. Player Transport Controls
    if (lower === 'pause' || lower === 'stop') {
      if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
        ytPlayer.pauseVideo();
        updatePlayPauseUI(false);
        showToast('Playback paused via voice', 'pause');
      }
      return;
    }

    if (lower === 'play' || lower === 'resume') {
      if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
        ytPlayer.playVideo();
        updatePlayPauseUI(true);
        showToast('Playback resumed via voice', 'play_arrow');
      } else if (queue.length > 0) {
        window.togglePlayPause();
      }
      return;
    }

    if (lower === 'next song' || lower === 'next' || lower === 'skip') {
      window.playNext();
      showToast('Skipped to next song via voice', 'skip_next');
      return;
    }

    if (lower === 'previous song' || lower === 'previous' || lower === 'prev') {
      window.playPrev();
      showToast('Playing previous track via voice', 'skip_previous');
      return;
    }

    if (lower === 'mute') {
      if (!isMuted) window.toggleMute();
      showToast('Muted via voice', 'volume_off');
      return;
    }

    if (lower === 'unmute') {
      if (isMuted) window.toggleMute();
      showToast('Unmuted via voice', 'volume_up');
      return;
    }

    // 2. Play Next Voice Command: "play next [song]"
    const playNextMatch = lower.match(/^play\s+next\s+(.+)$/i);
    if (playNextMatch && playNextMatch[1]) {
      const query = playNextMatch[1].trim();
      showToast(`Searching to play next: "${query}"...`, 'queue_play_next');
      const results = await searchYouTubeMultiSource(query);
      if (results && results.length > 0) {
        insertTrackNext(results[0]);
        if (els.urlInput) els.urlInput.value = '';
        closeSearchDropdown();
        showToast(`Set to play next: "${results[0].title.substring(0, 24)}..."`, 'queue_play_next');
      } else {
        showToast(`No results found for "${query}"`, 'error');
      }
      return;
    }

    // 3. Direct Queue Voice Command: "add [song] to queue" or "queue [song]"
    let queueQuery = null;
    const addToQueueMatch = lower.match(/^(?:add\s+)?(.+?)\s+(?:to\s+queue|in\s+queue)$/i);
    const queuePrefixMatch = lower.match(/^queue\s+(.+)$/i);

    if (addToQueueMatch && addToQueueMatch[1]) {
      queueQuery = addToQueueMatch[1].trim();
    } else if (queuePrefixMatch && queuePrefixMatch[1]) {
      queueQuery = queuePrefixMatch[1].trim();
    }

    if (queueQuery) {
      showToast(`Adding to queue: "${queueQuery}"...`, 'playlist_add');
      const results = await searchYouTubeMultiSource(queueQuery);
      if (results && results.length > 0) {
        addTrackToQueue(results[0]);
        if (els.urlInput) els.urlInput.value = '';
        closeSearchDropdown();
        showToast(`Queued: "${results[0].title.substring(0, 24)}..."`, 'playlist_add_check');
      } else {
        showToast(`No results found for "${queueQuery}"`, 'error');
      }
      return;
    }

    // 4. Default Voice Search: Switch to Search tab & display matching YouTube results
    window.switchIngestMode('search');
    if (els.urlInput) {
      els.urlInput.value = rawTranscript;
      performLiveSearch(rawTranscript);
    }
    showToast(`Voice Search: "${rawTranscript}"`, 'search');
  }

  // --- SERVICE WORKER REGISTRATION (PWA) ---
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
          .then((reg) => {
            console.log('StrictQueue Service Worker registered successfully:', reg.scope);
          })
          .catch((err) => {
            console.warn('Service Worker registration skipped or unavailable:', err);
          });
      });
    }
  }

  // --- HARDWARE MEDIA KEYS & OS CONTROL CENTER (Media Session API) ---
  function initMediaSession() {
    if (!('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler('play', () => {
        if (queue.length > 0) window.togglePlayPause();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (queue.length > 0) window.togglePlayPause();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        window.playPrev();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        window.playNext();
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (ytPlayer && typeof ytPlayer.seekTo === 'function' && details.seekTime !== undefined) {
          ytPlayer.seekTo(details.seekTime, true);
        }
      });
    } catch (err) {
      console.warn('MediaSession handler setup warning:', err);
    }
  }

  function syncMediaSessionMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      const artThumb = `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'StrictQueue Track',
        artist: track.artist || 'YouTube Audio',
        album: 'StrictQueue Audiophile Workstation',
        artwork: [
          { src: artThumb, sizes: '480x360', type: 'image/jpeg' },
          { src: track.thumbnail || artThumb, sizes: '120x90', type: 'image/jpeg' }
        ]
      });
    } catch (err) {
      console.warn('Error syncing MediaSession metadata:', err);
    }
  }

  function clearMediaSessionMetadata() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  }

  // --- FLOATING MINI-PLAYER & DOCUMENT PICTURE-IN-PICTURE ---
  window.toggleMiniPlayer = function () {
    if ('documentPictureInPicture' in window) {
      toggleMiniPlayerWindow();
    } else {
      toggleFloatingMiniPlayer();
    }
  };

  window.toggleFloatingMiniPlayer = function () {
    if (!els.floatingMiniPlayer) return;
    isFloatingMiniPlayerOpen = !isFloatingMiniPlayerOpen;
    if (isFloatingMiniPlayerOpen) {
      els.floatingMiniPlayer.classList.remove('hidden');
      const cur = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
      updateMiniPlayerUI(cur);
      showToast('Mini-player opened', 'picture_in_picture_alt');
    } else {
      els.floatingMiniPlayer.classList.add('hidden');
    }
  };

  window.closeFloatingMiniPlayer = function () {
    isFloatingMiniPlayerOpen = false;
    if (els.floatingMiniPlayer) {
      els.floatingMiniPlayer.classList.add('hidden');
    }
  };

  window.toggleMiniPlayerWindow = async function () {
    if (pipWindow) {
      pipWindow.close();
      pipWindow = null;
      return;
    }

    if (!('documentPictureInPicture' in window)) {
      toggleFloatingMiniPlayer();
      return;
    }

    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 360,
        height: 180
      });

      // Inject minimal styled PiP shell
      const doc = pipWindow.document;
      doc.title = 'StrictQueue Mini-Player';
      const cur = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
      const isPlaying = (ytPlayer && typeof ytPlayer.getPlayerState === 'function') ? ytPlayer.getPlayerState() === 1 : false;

      doc.body.innerHTML = `
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
          body { background: #050706; color: #fff; padding: 12px; display: flex; flex-direction: column; justify-content: space-between; height: 100vh; overflow: hidden; user-select: none; }
          .header { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: #00FF66; font-family: monospace; letter-spacing: 1px; }
          .track-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
          .thumb { width: 56px; height: 40px; border-radius: 6px; object-fit: cover; background: #111; flex-shrink: 0; }
          .info { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
          .title { font-size: 12px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; }
          .artist { font-size: 10px; color: #8E9B94; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .controls { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid #1F2923; padding-top: 8px; }
          .btn-group { display: flex; align-items: center; gap: 8px; }
          button { background: #151B18; border: 1px solid #1F2923; color: #fff; border-radius: 6px; padding: 6px 10px; font-size: 11px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
          button:hover { background: #1F2923; border-color: #00FF66; color: #00FF66; }
          .play-btn { background: #00FF66; color: #050706; border-radius: 50%; width: 32px; height: 32px; font-weight: bold; }
          .play-btn:hover { background: #10B981; color: #050706; }
        </style>
        <div class="header">
          <span>STRICTQUEUE MINI</span>
          <span>ZERO AUTOPLAY</span>
        </div>
        <div class="track-row">
          <img id="pip-thumb" class="thumb" src="${cur ? cur.thumbnail : 'logo.jpg'}" alt="">
          <div class="info">
            <div id="pip-title" class="title">${cur ? escapeHTML(cur.title) : 'No Track Playing'}</div>
            <div id="pip-artist" class="artist">${cur ? escapeHTML(cur.artist) : 'Queue Empty'}</div>
          </div>
        </div>
        <div class="controls">
          <div class="btn-group">
            <button id="pip-prev-btn">&laquo; Prev</button>
            <button id="pip-play-btn" class="play-btn">${isPlaying ? '&#10074;&#10074;' : '&#9654;'}</button>
            <button id="pip-next-btn">Next &raquo;</button>
          </div>
          <button id="pip-mute-btn">${isMuted ? 'Unmute' : 'Mute'}</button>
        </div>
      `;

      doc.getElementById('pip-play-btn').onclick = () => window.togglePlayPause();
      doc.getElementById('pip-prev-btn').onclick = () => window.playPrev();
      doc.getElementById('pip-next-btn').onclick = () => window.playNext();
      doc.getElementById('pip-mute-btn').onclick = () => {
        window.toggleMute();
        doc.getElementById('pip-mute-btn').textContent = isMuted ? 'Unmute' : 'Mute';
      };

      pipWindow.addEventListener('pagehide', () => {
        pipWindow = null;
      });

      showToast('Popped out mini-player window', 'picture_in_picture_alt');
    } catch (err) {
      console.warn('Document Picture-in-Picture failed, falling back:', err);
      toggleFloatingMiniPlayer();
    }
  };

  function updateMiniPlayerUI(track) {
    if (track) {
      if (els.miniPlayerThumb) els.miniPlayerThumb.src = track.thumbnail;
      if (els.miniPlayerTitle) els.miniPlayerTitle.textContent = track.title;
      if (els.miniPlayerArtist) els.miniPlayerArtist.textContent = track.artist;

      if (pipWindow && pipWindow.document) {
        const thumb = pipWindow.document.getElementById('pip-thumb');
        const title = pipWindow.document.getElementById('pip-title');
        const artist = pipWindow.document.getElementById('pip-artist');
        if (thumb) thumb.src = track.thumbnail;
        if (title) title.textContent = track.title;
        if (artist) artist.textContent = track.artist;
      }
    } else {
      if (els.miniPlayerThumb) els.miniPlayerThumb.src = 'logo.jpg';
      if (els.miniPlayerTitle) els.miniPlayerTitle.textContent = 'StrictQueue Player';
      if (els.miniPlayerArtist) els.miniPlayerArtist.textContent = 'Manual Queue Empty';

      if (pipWindow && pipWindow.document) {
        const thumb = pipWindow.document.getElementById('pip-thumb');
        const title = pipWindow.document.getElementById('pip-title');
        const artist = pipWindow.document.getElementById('pip-artist');
        if (thumb) thumb.src = 'logo.jpg';
        if (title) title.textContent = 'StrictQueue Player';
        if (artist) artist.textContent = 'Queue Empty';
      }
    }
  }

  // --- ZERO-SERVER SHAREABLE QUEUE URLS (#q=id1,id2,...) ---
  const MAX_SHARED_QUEUE_TRACKS = 50;

  window.shareQueueUrl = function () {
    if (!queue || queue.length === 0) {
      showToast('Queue is currently empty. Add songs before sharing.', 'error');
      return;
    }

    const validVideoIds = queue
      .map(t => t.videoId)
      .filter(id => id && isValidYouTubeId(id))
      .slice(0, MAX_SHARED_QUEUE_TRACKS);

    if (validVideoIds.length === 0) return;

    const shareUrl = `${window.location.origin}${window.location.pathname}#q=${validVideoIds.join(',')}`;

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(shareUrl).then(() => {
        showToast(`Shareable queue link copied to clipboard! (${validVideoIds.length} tracks)`, 'share');
      }).catch(() => {
        promptCopyFallback(shareUrl);
      });
    } else {
      promptCopyFallback(shareUrl);
    }
  };

  function promptCopyFallback(url) {
    prompt('Copy your shareable queue URL:', url);
    showToast('Shareable queue link ready!', 'share');
  }

  async function checkSharedQueueHash() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('q=')) return;

    try {
      const match = hash.match(/q=([^&]+)/);
      if (!match || !match[1]) return;

      const rawIds = decodeURIComponent(match[1]).split(',');
      // Enforce strict regex validation and hard cap at max 50 tracks
      const validIds = rawIds
        .map(id => id.trim())
        .filter(id => isValidYouTubeId(id))
        .slice(0, MAX_SHARED_QUEUE_TRACKS);

      if (validIds.length === 0) {
        cleanSharedQueueHash();
        return;
      }

      showToast(`Loading ${validIds.length} tracks from shared queue link...`, 'cloud_download');

      const loadedTracks = [];
      for (const vid of validIds) {
        try {
          const track = await fetchVideoMetadata(vid);
          if (track) loadedTracks.push(normalizeTrack(track));
        } catch (e) {
          loadedTracks.push(normalizeTrack({
            videoId: vid,
            title: `Shared Track (${vid})`,
            artist: 'YouTube',
            thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            duration: '--:--'
          }));
        }
      }

      const finalQueue = loadedTracks.filter(Boolean);
      if (finalQueue.length > 0) {
        queue = finalQueue;
        currentIndex = 0;
        saveQueueState();
        renderQueue();
        updateHUDIdleOrTrack();
        showToast(`Loaded ${queue.length} songs from shared link! Click Play to start.`, 'check_circle');
      }

      // Safely and immediately clear hash after hydration
      cleanSharedQueueHash();
    } catch (err) {
      console.warn('Error hydrating shared queue from hash:', err);
      cleanSharedQueueHash();
    }
  }

  function cleanSharedQueueHash() {
    try {
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
      } else {
        window.location.hash = '';
      }
    } catch (e) {
      // safe fallback
    }
  }

  // --- SMART PLAYBACK & DJ MICRO-CONTROLS (PER-TRACK SETTINGS) ---
  function applyTrackDjSettings(track) {
    if (!track || !ytPlayer) return;

    // Apply per-track playback rate
    const rate = track.playbackRate || 1.0;
    if (typeof ytPlayer.setPlaybackRate === 'function') {
      try {
        ytPlayer.setPlaybackRate(rate);
      } catch (e) {
        console.warn('Could not set playback rate on player:', e);
      }
    }

    // Apply per-track gain offset
    const effectiveVol = isMuted ? 0 : Math.min(100, Math.max(0, currentVolume + (track.gainOffset || 0)));
    if (typeof ytPlayer.setVolume === 'function') {
      try {
        if (!isMuted) ytPlayer.unMute();
        ytPlayer.setVolume(effectiveVol);
      } catch (e) {}
    }
  }

  window.openTrackTuningModal = function (idx, e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (idx < 0 || idx >= queue.length) return;

    tuningTrackIndex = idx;
    const track = queue[idx];

    if (els.tuningTrackTitle) els.tuningTrackTitle.textContent = track.title;
    if (els.tuningStartAt) els.tuningStartAt.value = track.startAt > 0 ? formatTime(track.startAt) : '';
    if (els.tuningEndAt) els.tuningEndAt.value = track.endAt ? formatTime(track.endAt) : '';

    tuningTempSpeed = track.playbackRate || 1.0;
    updateTuningSpeedPillsUI();

    const gain = track.gainOffset || 0;
    if (els.tuningGainSlider) els.tuningGainSlider.value = gain;
    if (els.tuningGainDisplay) els.tuningGainDisplay.textContent = `${gain > 0 ? '+' : ''}${gain}%`;

    if (els.tuningGainSlider) {
      els.tuningGainSlider.oninput = (ev) => {
        const val = parseInt(ev.target.value, 10);
        if (els.tuningGainDisplay) els.tuningGainDisplay.textContent = `${val > 0 ? '+' : ''}${val}%`;
      };
    }

    if (els.trackTuningModal) {
      els.trackTuningModal.classList.remove('hidden');
      requestAnimationFrame(() => {
        els.trackTuningModal.classList.remove('opacity-0');
        els.trackTuningModal.classList.add('opacity-100');
      });
    }
  };

  window.closeTrackTuningModal = function () {
    tuningTrackIndex = -1;
    if (els.trackTuningModal) {
      els.trackTuningModal.classList.remove('opacity-100');
      els.trackTuningModal.classList.add('opacity-0');
      setTimeout(() => {
        els.trackTuningModal.classList.add('hidden');
      }, 200);
    }
  };

  window.setTuningSpeed = function (speed) {
    tuningTempSpeed = speed;
    updateTuningSpeedPillsUI();
  };

  function updateTuningSpeedPillsUI() {
    if (els.tuningSpeedDisplay) els.tuningSpeedDisplay.textContent = `${tuningTempSpeed}x`;
    if (els.tuningSpeedPills) {
      const btns = els.tuningSpeedPills.querySelectorAll('button');
      btns.forEach(btn => {
        const s = parseFloat(btn.getAttribute('data-speed'));
        if (Math.abs(s - tuningTempSpeed) < 0.01) {
          btn.className = 'py-1 rounded bg-primary text-on-primary text-xs font-technical-mono cursor-pointer transition-all font-bold';
        } else {
          btn.className = 'py-1 rounded bg-surface-container-low hover:bg-surface-container-high text-on-surface-variant text-xs font-technical-mono cursor-pointer transition-all';
        }
      });
    }
  }

  function parseTimeStringToSeconds(str) {
    if (!str || typeof str !== 'string') return 0;
    const parts = str.trim().split(':').map(p => parseInt(p, 10));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return (parts[0] * 60) + parts[1];
    }
    if (parts.length === 1 && !isNaN(parts[0])) {
      return parts[0];
    }
    return 0;
  }

  window.saveTrackTuning = function () {
    if (tuningTrackIndex < 0 || tuningTrackIndex >= queue.length) return;

    const track = queue[tuningTrackIndex];
    const startStr = els.tuningStartAt ? els.tuningStartAt.value.trim() : '';
    const endStr = els.tuningEndAt ? els.tuningEndAt.value.trim() : '';
    const startSec = parseTimeStringToSeconds(startStr);
    const endSec = endStr ? parseTimeStringToSeconds(endStr) : null;
    const gainVal = els.tuningGainSlider ? parseInt(els.tuningGainSlider.value, 10) : 0;

    track.startAt = startSec;
    track.endAt = (endSec && endSec > startSec) ? endSec : null;
    track.playbackRate = tuningTempSpeed;
    track.gainOffset = isNaN(gainVal) ? 0 : Math.max(-20, Math.min(20, gainVal));

    saveQueueState();
    closeTrackTuningModal();
    showToast(`DJ settings saved for "${track.title.substring(0, 22)}..."`, 'tune');

    // If active track was tuned, apply live settings immediately
    if (tuningTrackIndex === currentIndex) {
      applyTrackDjSettings(track);
    }
  };

  // --- LIVE SYNCED LYRICS & TIMESTAMP DROPS ---
  window.toggleLyricsDrawer = function () {
    if (!els.lyricsDrawer || !els.lyricsDrawerBackdrop) return;
    const isClosed = els.lyricsDrawer.classList.contains('translate-x-full');
    if (isClosed) {
      closeAllPopovers();
      els.lyricsDrawer.classList.remove('translate-x-full');
      els.lyricsDrawerBackdrop.classList.remove('hidden', 'pointer-events-none');
      requestAnimationFrame(() => {
        els.lyricsDrawerBackdrop.classList.remove('opacity-0');
        els.lyricsDrawerBackdrop.classList.add('opacity-100');
      });
      // Fetch or refresh lyrics if active track is loaded
      const cur = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
      if (cur) {
        if (cur.videoId !== lyricsLastTrackId) {
          fetchLyricsForTrack(cur);
        }
        renderSavedDropsList(cur.videoId);
      } else {
        renderLyricsEmptyState('No Track Playing');
      }
    } else {
      closeLyricsDrawer();
    }
  };

  window.closeLyricsDrawer = function () {
    if (!els.lyricsDrawer || !els.lyricsDrawerBackdrop) return;
    els.lyricsDrawer.classList.add('translate-x-full');
    els.lyricsDrawerBackdrop.classList.remove('opacity-100');
    els.lyricsDrawerBackdrop.classList.add('opacity-0');
    setTimeout(() => {
      els.lyricsDrawerBackdrop.classList.add('hidden', 'pointer-events-none');
    }, 300);
  };

  window.switchLyricsTab = function (tab) {
    activeLyricsTab = tab;
    if (tab === 'lyrics') {
      if (els.tabLyricsBtn) els.tabLyricsBtn.className = 'flex-1 pb-2 border-b-2 border-primary text-primary font-label-md text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-all';
      if (els.tabDropsBtn) els.tabDropsBtn.className = 'flex-1 pb-2 border-b-2 border-transparent text-on-surface-variant hover:text-on-surface font-label-md text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-all';
      if (els.lyricsTabContent) els.lyricsTabContent.classList.remove('hidden');
      if (els.dropsTabContent) els.dropsTabContent.classList.add('hidden');
    } else {
      if (els.tabDropsBtn) els.tabDropsBtn.className = 'flex-1 pb-2 border-b-2 border-primary text-primary font-label-md text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-all';
      if (els.tabLyricsBtn) els.tabLyricsBtn.className = 'flex-1 pb-2 border-b-2 border-transparent text-on-surface-variant hover:text-on-surface font-label-md text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-all';
      if (els.dropsTabContent) {
        els.dropsTabContent.classList.remove('hidden');
        els.dropsTabContent.classList.add('flex');
      }
      if (els.lyricsTabContent) els.lyricsTabContent.classList.add('hidden');
      const cur = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
      if (cur) renderSavedDropsList(cur.videoId);
    }
  };

  async function fetchLyricsForTrack(track) {
    if (!track) return;
    lyricsLastTrackId = track.videoId;
    isLyricsLoading = true;
    currentLyricsData = null;
    activeLyricIndex = -1;

    if (els.lyricsTrackStatus) els.lyricsTrackStatus.textContent = 'Searching LRCLIB for lyrics...';
    renderLyricsLoadingState();

    // Clean common YouTube noise from song title
    const cleanQuery = track.title
      .replace(/\(.*?\)/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/\|.*/g, '')
      .replace(/ft\..*|feat\..*/i, '')
      .replace(/official video|official audio|music video|lyric video/gi, '')
      .trim();

    try {
      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${track.artist} ${cleanQuery}`)}`;
      const res = await fetch(searchUrl);
      if (!res.ok) throw new Error(`LRCLIB returned status ${res.status}`);

      const results = await res.json();
      if (Array.isArray(results) && results.length > 0) {
        // Find best match with syncedLyrics or plainLyrics
        const match = results.find(r => r.syncedLyrics) || results.find(r => r.plainLyrics) || results[0];
        if (match && match.syncedLyrics) {
          currentLyricsData = {
            lines: parseLrcString(match.syncedLyrics),
            isSynced: true
          };
          if (els.lyricsTrackStatus) els.lyricsTrackStatus.textContent = 'Synced Real-time Lyrics Active';
        } else if (match && match.plainLyrics) {
          currentLyricsData = {
            lines: match.plainLyrics.split('\n').map(l => ({ time: -1, text: l.trim() })).filter(l => l.text.length > 0),
            isSynced: false
          };
          if (els.lyricsTrackStatus) els.lyricsTrackStatus.textContent = 'Plain Lyrics Loaded';
        }
      }
    } catch (err) {
      console.warn('LRCLIB Lyrics fetch error:', err);
    } finally {
      isLyricsLoading = false;
      if (!currentLyricsData || currentLyricsData.lines.length === 0) {
        if (els.lyricsTrackStatus) els.lyricsTrackStatus.textContent = 'No Lyrics Available';
        renderLyricsEmptyState('No synced lyrics available for this track');
      } else {
        renderLyricsLines();
      }
    }
  }

  function parseLrcString(lrc) {
    const lines = lrc.split('\n');
    const parsed = [];
    const timeRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/;

    for (const rawLine of lines) {
      const match = rawLine.match(timeRegex);
      if (match) {
        const mins = parseInt(match[1], 10);
        const secs = parseInt(match[2], 10);
        const ms = match[3] ? parseInt(match[3].padEnd(3, '0').substring(0, 3), 10) : 0;
        const totalSeconds = (mins * 60) + secs + (ms / 1000);
        const text = rawLine.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim();
        if (text.length > 0) {
          parsed.push({ time: totalSeconds, text });
        }
      }
    }
    return parsed.sort((a, b) => a.time - b.time);
  }

  function renderLyricsLoadingState() {
    if (!els.lyricsLinesContainer) return;
    els.lyricsLinesContainer.innerHTML = `
      <div class="py-12 flex flex-col items-center justify-center gap-2 text-on-surface-variant font-technical-mono text-xs">
        <span class="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin"></span>
        <span>Fetching lyrics from LRCLIB...</span>
      </div>
    `;
  }

  function renderLyricsEmptyState(msg) {
    if (!els.lyricsLinesContainer) return;
    els.lyricsLinesContainer.innerHTML = `
      <div class="py-12 flex flex-col items-center justify-center gap-2 text-on-surface-variant">
        <span class="material-symbols-outlined text-outline text-3xl">music_off</span>
        <span class="font-label-md text-xs text-on-surface">${msg}</span>
        <span class="font-body-sm text-[11px] text-outline">Enjoy the instrumental audiophile stream.</span>
      </div>
    `;
  }

  function renderLyricsLines() {
    if (!els.lyricsLinesContainer || !currentLyricsData) return;
    els.lyricsLinesContainer.innerHTML = '';

    currentLyricsData.lines.forEach((line, idx) => {
      const p = document.createElement('p');
      p.id = `lyric-line-${idx}`;
      p.className = 'font-body-md text-sm text-on-surface-variant/70 hover:text-on-surface transition-all duration-200 cursor-pointer py-1 px-3 rounded-lg';
      p.textContent = line.text;

      if (currentLyricsData.isSynced) {
        p.onclick = () => {
          if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
            ytPlayer.seekTo(line.time, true);
          }
        };
      }

      els.lyricsLinesContainer.appendChild(p);
    });
  }

  function syncLyricsProgress(currentSec) {
    if (!currentLyricsData || !currentLyricsData.isSynced || currentLyricsData.lines.length === 0) return;

    let targetIdx = -1;
    for (let i = 0; i < currentLyricsData.lines.length; i++) {
      if (currentSec >= currentLyricsData.lines[i].time - 0.25) {
        targetIdx = i;
      } else {
        break;
      }
    }

    if (targetIdx !== activeLyricIndex && targetIdx !== -1) {
      if (activeLyricIndex !== -1) {
        const prevEl = document.getElementById(`lyric-line-${activeLyricIndex}`);
        if (prevEl) {
          prevEl.className = 'font-body-md text-sm text-on-surface-variant/70 hover:text-on-surface transition-all duration-200 cursor-pointer py-1 px-3 rounded-lg';
        }
      }

      activeLyricIndex = targetIdx;
      const curEl = document.getElementById(`lyric-line-${activeLyricIndex}`);
      if (curEl) {
        curEl.className = 'font-headline-sm text-base text-primary font-bold bg-primary/10 shadow-[0_0_12px_var(--accent-glow)] transition-all duration-200 cursor-pointer py-1.5 px-3 rounded-lg scale-[1.02]';
        curEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  // --- TIMESTAMPED DROP BOOKMARKS ---
  function updateDropTimePeek(currentSec) {
    if (els.dropsCurrentTimePeek) {
      els.dropsCurrentTimePeek.textContent = formatTime(currentSec);
    }
  }

  function getSavedDrops() {
    try {
      const raw = localStorage.getItem(STORAGE_DROPS);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveDrops(dropsObj) {
    try {
      localStorage.setItem(STORAGE_DROPS, JSON.stringify(dropsObj));
    } catch (e) {}
  }

  window.pinCurrentTimestamp = function () {
    const curTrack = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
    if (!curTrack || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') {
      showToast('Play a song first to pin a drop', 'error');
      return;
    }

    const curTime = Math.floor(ytPlayer.getCurrentTime());
    const label = els.dropLabelInput && els.dropLabelInput.value.trim() ? sanitizePlainString(els.dropLabelInput.value.trim()) : 'Beat Drop';

    const allDrops = getSavedDrops();
    if (!allDrops[curTrack.videoId]) {
      allDrops[curTrack.videoId] = [];
    }

    // Avoid duplicate timestamp pins
    if (!allDrops[curTrack.videoId].some(d => d.time === curTime)) {
      allDrops[curTrack.videoId].push({ time: curTime, label: label, id: Date.now() });
      allDrops[curTrack.videoId].sort((a, b) => a.time - b.time);
      saveDrops(allDrops);
      renderSavedDropsList(curTrack.videoId);
      showToast(`Pinned bookmark at ${formatTime(curTime)} (${label})`, 'bookmark_added');
    } else {
      showToast(`Drop bookmark already exists at ${formatTime(curTime)}`, 'info');
    }
  };

  window.jumpToDrop = function (seconds) {
    if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
      ytPlayer.seekTo(seconds, true);
      showToast(`Jumped to drop at ${formatTime(seconds)}`, 'fast_forward');
    }
  };

  window.deleteDrop = function (videoId, dropId, e) {
    if (e) e.stopPropagation();
    const allDrops = getSavedDrops();
    if (allDrops[videoId]) {
      allDrops[videoId] = allDrops[videoId].filter(d => d.id !== dropId);
      saveDrops(allDrops);
      renderSavedDropsList(videoId);
      showToast('Drop bookmark removed', 'delete');
    }
  };

  function renderSavedDropsList(videoId) {
    if (!els.dropsListContainer) return;
    const allDrops = getSavedDrops();
    const trackDrops = allDrops[videoId] || [];

    if (els.dropsCountBadge) els.dropsCountBadge.textContent = trackDrops.length.toString();

    if (trackDrops.length === 0) {
      els.dropsListContainer.innerHTML = `
        <div class="p-space-sm rounded-lg bg-surface-container-lowest text-center text-outline font-technical-mono text-xs">
          No drop marks saved for this track. Play track and click "Pin Now".
        </div>
      `;
      return;
    }

    els.dropsListContainer.innerHTML = trackDrops.map(d => {
      const safeTime = Number.isFinite(d.time) && d.time >= 0 ? d.time : 0;
      const safeId = Number.isFinite(d.id) ? d.id : 0;
      const safeVid = encodeURIComponent(videoId).replace(/['"\\]/g, '');
      return `
        <div onclick="jumpToDrop(${safeTime})" class="group p-2 px-3 rounded-lg bg-surface-container-low hover:bg-surface-container-high transition-all flex items-center justify-between cursor-pointer amoled-border">
          <div class="flex items-center gap-2 min-w-0">
            <span class="material-symbols-outlined text-primary text-sm">bookmark</span>
            <span class="font-technical-mono text-primary font-bold text-xs">${formatTime(safeTime)}</span>
            <span class="font-label-md text-xs text-on-surface truncate">${escapeHTML(d.label)}</span>
          </div>
          <button onclick="deleteDrop('${safeVid}', ${safeId}, event)" class="text-outline hover:text-error p-1 rounded transition-colors" title="Delete mark">
            <span class="material-symbols-outlined text-xs">close</span>
          </button>
        </div>
      `;
    }).join('');
  }

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  // Run on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
