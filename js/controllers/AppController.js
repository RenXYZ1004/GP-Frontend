import AppModel from '../models/AppModel.js';
import EmailService from '../services/EmailService.js';
import AppView, { ROLE_PERMISSIONS, setButtonLoading } from '../views/AppView.js';
import DashboardController from './pages/DashboardController.js';
import LogsController from './pages/LogsController.js';
import PGPController from './pages/PGPController.js';
import SettingsController from './pages/SettingsController.js';
import TGPController from './pages/TGPController.js';
import StudentsController from './pages/StudentsController.js';
import ScannerController from './pages/ScannerController.js';
import ReportsController from './pages/ReportsController.js';
import faceBiometrics from '../services/FaceBiometrics.js';
import Dialog from '../services/Dialog.js';
import Icons from '../icons.js';
import { generatePGP, generateQRToken } from '../utils.js';
import { loginUrl } from '../config.js';

// ── Camera scanning budget ───────────────────────────────────────
// jsQR's cost scales with the pixel count it is handed, and the decode runs
// on the main thread. Reading every camera frame at native resolution meant a
// full-frame getImageData plus a full decode up to 60 times a second, which
// saturates a phone's main thread: the preview stutters, frames arrive
// motion-blurred, and scans that should land on the first present take
// several tries. A downscaled frame a dozen times a second costs a fraction
// of that and is no slower to react — a card still has to be held up.
const SCAN_INTERVAL_MS = 80;    // ~12 decode attempts per second
const SCAN_MAX_EDGE = 800;      // longest edge handed to jsQR, in pixels

export default class AppController {
  constructor(model, view) {
    this.model = model;
    this.view = view;
    
    // Scanner tracking & cooldowns
    this.isScanPaused = false;
    this.scanResultTimeout = null;
    this.lastScannedStudents = {}; // Track student scans for 15s cooldown

    this.init();
  }

  init() {
    // 1. Initialize Theme
    this.initTheme();

    // 2. Initialize Sidebar State (Desktop)
    this.initSidebar();

    // 3. Render Initial Navigation & Page
    this.view.renderSidebar(this.model);
    this.view.renderBottomNav(this.model);

    // No valid session? The one and only login lives on the landing page.
    if (!this.model.currentUser) {
      this.redirectToLogin('Please sign in to continue.');
      return;
    }

    // The cached payload only decides what gets drawn. Confirm with the
    // server that the session is still real, and that this person still holds
    // the role the cache claims — someone demoted or deactivated should lose
    // access on their next load, not at some cache expiry.
    //
    // Deliberately not awaited: the UI renders from cache immediately, which
    // is what makes the app usable on a slow gate connection. If the check
    // comes back negative the redirect happens a moment later; if it cannot
    // reach the server at all, the session stands and the app works offline.
    this.model.restoreSession().then((user) => {
      if (!user) this.redirectToLogin('Your session has expired.');
      else this.view.renderSidebar(this.model);
    }).catch(() => { /* offline — handled inside restoreSession */ });

    // Check hash for direct link, default to dashboard
    const hashPage = window.location.hash.replace('#', '');
    const startPage = hashPage || 'dashboard';
    this.navigateToPage(startPage);

    // 4. Bind Global Event Listeners
    this.bindEvents();

    // Offline queue processing
    window.addEventListener('online', () => this.processEmailQueue());
    this.processEmailQueue();

    // 5. Initialize Sync Engine
    this.initSync();
  }
  async sendParentEmail(params) {
    // Endpoint selection, the bearer token and error extraction live in
    // EmailService, which posts to the Cloud Function on its own origin.
    return EmailService.send(params);
  }
  async processEmailQueue() {
    if (!this.model.emailQueue || this.model.emailQueue.length === 0) return;
    if (!navigator.onLine) return;

    console.log(`Attempting to send ${this.model.emailQueue.length} queued emails...`);

    while (this.model.emailQueue.length > 0) {
      const params = this.model.emailQueue[0];
      try {
        await this.sendParentEmail(params);
        console.log('Queued email sent successfully');
        await this.model.removeEmailFromQueue(0);
      } catch (err) {
        console.error('Queued email failed:', err);
        break; // Stop processing if one fails (no internet)
      }
    }
  }

  // ── Idle-Aware Sync Engine ──────────────────────────────
  // Sync Strategy:
  //   - NO polling while user is actively using the system
  //   - Auto-sync every 60s ONLY when user is idle (no activity)
  //   - Manual sync always available via btn-sync
  //   - Pauses entirely when tab is hidden (Visibility API)
  //   - Exponential backoff on errors (15s → 30s → 60s → 120s)
  // ──────────────────────────────────────────────────────────
  initSync() {
    // Initial sync on login
    if (this.model.currentUser) {
      this.performSync();
    }

    // ── Idle Detection Config ──
    this.IDLE_THRESHOLD = 60000;      // 60s of no activity = idle
    this.IDLE_SYNC_INTERVAL = 60000;  // When idle, sync every 60s
    this.lastActivityTime = Date.now();
    this.isUserIdle = false;
    this.idleSyncTimer = null;
    this.syncBackoffMs = 0;

    // ── Unified Activity Tracker (also handles session timeout) ──
    const activityEvents = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart', 'pointerdown'];
    let activityThrottle = 0;
    activityEvents.forEach(evt => {
      document.addEventListener(evt, () => {
        const now = Date.now();
        // Throttle: only process every 5 seconds to avoid excessive work
        if (now - activityThrottle > 5000) {
          activityThrottle = now;
          this.lastActivityTime = now;
          // Also update session activity (for session timeout tracking)
          this.model.updateActivity();
          // If user was idle, mark active and stop background sync
          if (this.isUserIdle) {
            this.isUserIdle = false;
            this.stopIdleSyncLoop();
          }
        }
      }, { passive: true });
    });

    // ── Idle State Checker (every 10s — lightweight, no API calls) ──
    this.idleCheckInterval = setInterval(() => {
      if (!this.model.currentUser) return;
      const idleFor = Date.now() - this.lastActivityTime;
      if (idleFor >= this.IDLE_THRESHOLD && !this.isUserIdle) {
        this.isUserIdle = true;
        this.startIdleSyncLoop();
      }
      // Update sync status badge every 10s (instead of every 1s)
      this.view.renderSyncStatus(this.model);
    }, 10000);

    // ── Visibility API: Pause when tab is hidden ──
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopIdleSyncLoop();
      } else if (this.model.currentUser && navigator.onLine) {
        // Tab regained focus — do one sync, then resume idle detection
        this.performSync();
      }
    });

    // ── Manual Sync Button ──
    const btnSync = document.getElementById('btn-sync');
    if (btnSync) btnSync.addEventListener('click', () => this.performSync());

    // ── Online/Offline Handlers ──
    window.addEventListener('online', () => {
      this.model.isOnline = true;
      if (this.model.currentUser) this.performSync();
    });
    window.addEventListener('offline', () => {
      this.model.isOnline = false;
      this.stopIdleSyncLoop();
      this.view.renderSyncStatus(this.model);
    });
  }

  startIdleSyncLoop() {
    if (this.idleSyncTimer) return; // Already running
    console.log('[Sync] User idle — starting background sync loop');
    // Sync immediately on entering idle state
    if (this.model.currentUser && navigator.onLine && !document.hidden) {
      this.performSync();
    }
    // Then repeat every IDLE_SYNC_INTERVAL
    this.idleSyncTimer = setInterval(() => {
      if (this.model.currentUser && navigator.onLine && !document.hidden) {
        this.performSync();
      }
    }, this.IDLE_SYNC_INTERVAL);
  }

  stopIdleSyncLoop() {
    if (this.idleSyncTimer) {
      clearInterval(this.idleSyncTimer);
      this.idleSyncTimer = null;
      console.log('[Sync] Idle sync loop stopped');
    }
  }

  async performSync() {
    if (this.model.syncStatus === 'syncing' || !navigator.onLine) return;

    // UI update
    this.model.syncStatus = 'syncing';
    this.view.renderSyncStatus(this.model);

    const result = await this.model.syncFromSheet();

    if (result.success && this.model.currentUser) {
      // SECURITY CHECK: Ensure the currently logged-in user still exists in the database.
      // Only trust this check when the sync actually returned a user list — an empty
      // list means the sheet answered oddly, and used to sign everyone out.
      const knownUsers = Array.isArray(this.model.users) ? this.model.users : [];
      if (knownUsers.length > 0) {
        const validUser = knownUsers.find(u => u.username === this.model.currentUser.username);
        if (!validUser) {
          this.performLogout('Your account is no longer valid. Please log in again.');
          return;
        }
      }

      // ONLY re-render if data actually changed (hash mismatch)
      if (result.changed) {
        // Guard: Do not re-render if user is interacting with a modal, input field, or active camera
        const hasOpenModal = Array.from(document.querySelectorAll('.overlay')).some(el => el.style.display !== 'none' && el.style.display !== '');
        const activeElement = document.activeElement;
        const isInputFocused = activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName);
        const isCameraActive = this.scannerActive || this.faceScanActive;

        if (!hasOpenModal && !isInputFocused && !isCameraActive) {
          // Re-render current page to show new data
          this.view.showPage(this.view.currentPage, this.model);
          this.bindPageEvents(this.view.currentPage);
        }
      }

      // Reset backoff on success
      this.syncBackoffMs = 0;
    } else if (!result.success) {
      // Exponential backoff: increase delay on repeated failures
      this.syncBackoffMs = Math.min((this.syncBackoffMs || 15000) * 2, 120000);
      this.view.showToast('Cloud sync failed. Showing available local data.', 'error');

      // If this was the first sync, show the actual page instead of leaving
      // the initial loading skeleton/blank content on screen forever.
      if (this.model.currentUser && !this.model.lastSyncTime) {
        this.view.showPage(this.view.currentPage || 'dashboard', this.model);
        this.bindPageEvents(this.view.currentPage || 'dashboard');
      }
    }

    this.view.renderSyncStatus(this.model);
  }

  // ── Navigation Wrapper ─────────────────────────────────
  navigateToPage(pageId) {
    // Authentication Guard — no session means back to the main login page
    if (!this.model.currentUser) {
      this.redirectToLogin('Please sign in to continue.');
      return;
    }
    // 'login' is not an in-app page any more; it always means the landing page
    if (pageId === 'login') pageId = 'dashboard';

    // RBAC Guard
    if (this.model.currentUser) {
      const perms = ROLE_PERMISSIONS[this.model.currentUser.role] || [];
      if (!perms.includes(pageId)) {
        this.view.showToast('Access denied for your role', 'error');
        pageId = 'dashboard';
      }
    }

    // Stop camera if leaving scanner
    if (this.view.currentPage === 'scanner' && pageId !== 'scanner') {
      this.stopCamera();
      this.stopFaceCamera();
    }

    this.view.showPage(pageId, this.model);
    window.location.hash = pageId;
    this.view.closeMobileSidebar();

    // Bind events for the newly rendered page
    this.bindPageEvents(pageId);

    // Auto-start camera if navigating to scanner and camera is default
    if (pageId === 'scanner') {
      const cameraTab = document.querySelector('.scan-tab[data-target="camera"]');
      if (cameraTab && cameraTab.classList.contains('active')) {
        setTimeout(() => this.startCamera(), 300);
      }
    }
  }

  // ── Initialization ─────────────────────────────────────
  initTheme() {
    const savedTheme = this.model.getTheme();
    this.view.applyTheme(savedTheme || 'auto');
  }

  initSidebar() {
    const isCollapsed = this.model.getSidebarCollapsed();
    this.view.setSidebarCollapsed(isCollapsed);
  }

  // ── Global Event Binding ──────────────────────────────
  bindEvents() {
    // Theme Toggle
    const btnTheme = document.getElementById('btn-theme');
    if (btnTheme) {
      btnTheme.addEventListener('click', () => {
        const isCurrentlyDark = this.view.isDarkMode();
        const newTheme = isCurrentlyDark ? 'light' : 'dark';
        this.model.setTheme(newTheme);
        this.view.applyTheme(newTheme);
      });
    }

    // Desktop Sidebar Toggle
    const btnCollapse = document.getElementById('btn-collapse-sidebar');
    if (btnCollapse) {
      btnCollapse.addEventListener('click', () => {
        const isCollapsed = !document.getElementById('sidebar').classList.contains('collapsed');
        this.model.setSidebarCollapsed(isCollapsed);
        this.view.setSidebarCollapsed(isCollapsed);
      });
    }

    // Topbar Menu Button (Mobile / Desktop)
    const btnMenu = document.getElementById('btn-menu');
    const overlay = document.getElementById('sidebar-overlay');
    if (btnMenu) {
      btnMenu.addEventListener('click', () => {
        if (window.innerWidth <= 767) {
          this.view.openMobileSidebar();
        } else {
          const isCollapsed = !document.getElementById('sidebar').classList.contains('collapsed');
          this.model.setSidebarCollapsed(isCollapsed);
          this.view.setSidebarCollapsed(isCollapsed);
        }
      });
    }
    if (overlay) overlay.addEventListener('click', () => this.view.closeMobileSidebar());

    // Navigation Delegation (Sidebar & Bottom Nav)
    document.addEventListener('click', (e) => {
      // Close Modals when clicking on the overlay background
      if (e.target.classList.contains('overlay')) {
        e.target.style.display = 'none';
      }

      const navItem = e.target.closest('.nav-item, .bottom-nav-item');
      if (navItem) {
        const pageId = navItem.dataset.page;
        if (pageId) {
          this.navigateToPage(pageId);
        }
      }

      // Bottom nav 'More' button
      if (e.target.closest('#btn-bottom-more')) {
        this.view.openMobileSidebar();
      }

      // Scan Result Modal Close Button
      if (e.target.closest('#btn-close-scan-result')) {
        this.closeScanModal();
      }

      // Logout handler (with confirmation)
      if (e.target.closest('#btn-logout')) {
        e.preventDefault();
        Dialog.confirm(
          'Sign Out',
          'Are you sure you want to sign out? You will need to log in again.',
          { confirmText: 'Yes, Sign Out', cancelText: 'Cancel', type: 'primary' }
        ).then(confirmed => {
          if (confirmed) this.performLogout();
        });
      }
    });

    // NOTE: Activity tracking is now handled by the Idle-Aware Sync Engine in initSync().
    // Session timeout (model.updateActivity) is also called there.

    // ── Session Timeout Checker (every 60 seconds) ────────
    this.sessionCheckInterval = setInterval(() => {
      if (this.model.currentUser && this.model.isSessionExpired()) {
        this.performLogout('Session expired due to inactivity. Please log in again.');
      }
    }, 60000);

    // ── Back-Button Guard ─────────────────────────────────
    window.addEventListener('hashchange', () => {
      if (!this.model.currentUser) {
        // Session gone (logged out in another tab, expired): leave the app shell
        this.redirectToLogin('Your session has ended. Please sign in again.');
      }
    });

    // ── Global Escape Key — Close topmost modal ──────────
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Don't interfere with Dialog.js dialogs (they handle their own Escape)
      if (document.querySelector('.dialog-overlay')) return;
      // Find the topmost visible overlay modal and close it
      const overlays = Array.from(document.querySelectorAll('.overlay'));
      for (let i = overlays.length - 1; i >= 0; i--) {
        if (overlays[i].style.display !== 'none' && overlays[i].style.display !== '') {
          overlays[i].style.display = 'none';
          break;
        }
      }
    });
  }

  // ── Logout Handler ──────────────────────────────────────
  // Signing out returns to the MAIN login on the landing page (index.html).
  // The app shell has no login form of its own.
  performLogout(message) {
    this.teardown();
    this.model.logout();
    this.redirectToLogin(message || 'You have been signed out.');
  }

  // ── Redirect to the one and only login page ─────────────
  // Uses location.replace so the back button cannot re-open the dashboard.
  redirectToLogin(notice) {
    if (this.isRedirecting) return;   // guard against redirect loops
    this.isRedirecting = true;
    this.teardown();
    window.location.replace(loginUrl(notice));
  }

  // ── Release timers, cameras and streams before leaving the page ──
  teardown() {
    try { this.stopIdleSyncLoop(); } catch (_) { }
    try { this.stopCamera(); } catch (_) { }
    try { this.stopFaceCamera(); } catch (_) { }
    if (this.sessionCheckInterval) { clearInterval(this.sessionCheckInterval); this.sessionCheckInterval = null; }
    if (this.idleCheckInterval) { clearInterval(this.idleCheckInterval); this.idleCheckInterval = null; }
    if (this.cameraIdleTimeout) { clearTimeout(this.cameraIdleTimeout); this.cameraIdleTimeout = null; }
    if (this.scanResultTimeout) { clearTimeout(this.scanResultTimeout); this.scanResultTimeout = null; }
  }

  // ── Page-Specific Event Binding (delegates to controllers) ──
  bindPageEvents(pageId) {
    if (pageId === 'dashboard') DashboardController.bind(this);
    if (pageId === 'students') StudentsController.bind(this);
    if (pageId === 'scanner') ScannerController.bind(this);
    if (pageId === 'logs') LogsController.bind(this);
    if (pageId === 'pgp') PGPController.bind(this);
    if (pageId === 'settings') SettingsController.bind(this);
    if (pageId === 'tgp') TGPController.bind(this);
    if (pageId === 'reports') ReportsController.bind(this);
  }

  // ── Wizard Helpers (used by StudentsController) ────────
  goToWizardStep(step) {
    this.currentWizardStep = step;

    // Hide all panels
    document.querySelectorAll('.wizard-panel').forEach(p => p.style.display = 'none');
    // Show current panel
    document.getElementById(`panel-step-${step}`).style.display = 'block';

    // Update indicators
    document.querySelectorAll('.wizard-step').forEach((el, idx) => {
      const isCurrent = idx + 1 === step;
      const isPast = idx + 1 < step;
      el.style.color = (isCurrent || isPast) ? 'var(--primary)' : 'var(--text3)';
      el.style.fontWeight = isCurrent ? '700' : '500';
      const circle = el.firstElementChild;
      circle.style.background = isCurrent ? 'var(--primary)' : 'var(--bg-card)';
      circle.style.color = isCurrent ? '#fff' : 'inherit';
      circle.style.borderColor = (isCurrent || isPast) ? 'var(--primary)' : 'var(--border2)';
      if (isPast) {
        circle.style.background = 'var(--primary-soft)';
        circle.style.color = 'var(--primary)';
      }
    });

    // Update buttons
    document.getElementById('btn-wizard-prev').style.display = step > 1 ? 'block' : 'none';
    document.getElementById('btn-wizard-next').style.display = step < 4 ? 'block' : 'none';
    document.getElementById('btn-wizard-submit').style.display = step === 4 ? 'block' : 'none';
  }

  async handleEnrollment() {
    const name = document.getElementById('w-name').value.trim();
    const studid = document.getElementById('w-studid').value.trim();
    const grade = document.getElementById('w-grade').value;
    const section = document.getElementById('w-section').value.trim();
    const gate = document.getElementById('w-gate').value;
    const arrangements = document.getElementById('w-arrangements').value;
    const vehicle = document.getElementById('w-vehicle').value.trim();
    const parentName = document.getElementById('w-parent-name').value.trim();
    const parentEmail = document.getElementById('w-parent-email').value.trim();
    const parentPhone = document.getElementById('w-parent-phone').value.trim();

    // Generate unique PGP ID: format {YY}{S}{GG}-{NNN} e.g. "26A07-001"
    const pgpId = generatePGP(grade, section, this.model.students);

    const newStudent = {
      id: pgpId,
      name,
      studid,
      grade,
      section,
      fullSection: section ? `${grade} - ${section}` : grade,
      preferredGate: gate,
      arrangements,
      vehicleDetails: vehicle,
      parentName,
      parentEmail,
      phone: parentPhone,
      address: '',
      photo: this.tempPhotoData || '',
      pgp: pgpId,
      status: 'active',
      qrToken: generateQRToken()
    };

    await this.model.addStudent(newStudent);
    this.view.showToast('Student enrolled & PGP generated!');
    document.getElementById('modal-wizard').style.display = 'none';
    this.tempPhotoData = null;
    this.navigateToPage('students');
  }

  // ── Approve "for approval" student — activates PGP and generates QR token ──
  async approveStudent(passId) {
    const student = this.model.getStudentByPassId(passId);
    if (!student) return;
    const updatedStudent = { ...student, status: 'active', qrToken: generateQRToken() };
    await this.model.updateStudent(updatedStudent);
    this.view.showToast(`${student.name} approved — PGP is now active!`);
    this.navigateToPage('students');
  }

  // ── Scanner Helpers (used by ScannerController) ────────
  startCamera(facingMode = null) {
    if (this.scannerActive) this.stopCamera();
    const video = document.getElementById('scan-video');
    const startUi = document.getElementById('scan-start-ui');
    const overlay = document.getElementById('scan-overlay');
    const activeUi = document.getElementById('scan-active-ui');

    if (!video) return;

    if (!facingMode) {
      this.currentFacingMode = "environment";
    } else {
      this.currentFacingMode = facingMode;
    }

    // Guard: mediaDevices API requires HTTPS or localhost
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.view.showToast("Camera API not available. Use HTTPS or localhost.", "error");
      return;
    }

    const onSuccess = (stream) => {
      this.videoStream = stream;
      video.srcObject = stream;
      video.setAttribute("playsinline", true);
      video.style.display = "block";
      if (startUi) startUi.style.display = "none";
      if (overlay) overlay.style.display = "block";
      if (activeUi) activeUi.style.display = "block";
      // play() rejects if the element is detached or the play is interrupted —
      // an unhandled rejection here used to surface as a console error.
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(err => console.warn('Video play interrupted:', err.name));
      }
      this.scannerActive = true;
      this.scanCtx = null;          // canvas is re-sized for the new stream
      this.lastDecodeAt = 0;
      this.resetCameraIdleTimeout();
      requestAnimationFrame(() => this.tickCamera());
    };

    const onFinalError = (err) => {
      console.error("Camera error:", err.name, err.message);
      let message;
      if (err.name === 'NotAllowedError') {
        message = "Camera permission denied. Please allow camera access in your browser and try again.";
      } else if (err.name === 'NotFoundError') {
        message = "No camera found on this device.";
      } else if (err.name === 'NotReadableError' || err.name === 'AbortError') {
        message = "Camera is in use by another application. Close it and try again.";
      } else {
        message = "Camera error: " + (err.message || 'Unknown error');
      }
      this.view.showToast(message, "error");
    };

    // Try requested camera first.
    // Without a resolution hint a modern phone hands back its largest mode —
    // 4K on some devices — and every frame of it is copied and decoded below.
    // 720p resolves a gate pass at arm's length with room to spare.
    const videoConstraints = {
      facingMode: this.currentFacingMode,
      width: { ideal: 1280 },
      height: { ideal: 720 }
    };
    navigator.mediaDevices.getUserMedia({ video: videoConstraints })
      .then(onSuccess)
      .catch(firstErr => {
        console.warn("Rear camera unavailable, trying any camera...", firstErr.name);
        navigator.mediaDevices.getUserMedia({ video: true })
          .then(onSuccess)
          .catch(onFinalError);
      });
  }

  stopCamera() {
    this.scannerActive = false;
    if (this.cameraIdleTimeout) clearTimeout(this.cameraIdleTimeout);
    if (this.videoStream) {
      this.videoStream.getTracks().forEach(track => track.stop());
      this.videoStream = null;
    }
    const video = document.getElementById('scan-video');
    const startUi = document.getElementById('scan-start-ui');
    const overlay = document.getElementById('scan-overlay');
    const activeUi = document.getElementById('scan-active-ui');
    if (video) video.style.display = 'none';
    if (startUi) startUi.style.display = 'block';
    if (overlay) overlay.style.display = 'none';
    if (activeUi) activeUi.style.display = 'none';
  }

  resetCameraIdleTimeout() {
    if (this.cameraIdleTimeout) clearTimeout(this.cameraIdleTimeout);
    this.cameraIdleTimeout = setTimeout(() => {
      if (this.scannerActive) {
        this.stopCamera();
        this.view.showToast("Camera stopped due to inactivity.", "info");
      }
    }, 30000);
  }

  switchCamera() {
    const newMode = this.currentFacingMode === "environment" ? "user" : "environment";
    this.startCamera(newMode);
  }

  tickCamera() {
    if (!this.scannerActive) return;

    const video = document.getElementById('scan-video');
    const canvasElement = document.getElementById('scan-canvas');
    if (!video || !canvasElement) return;

    // Hold the decode to SCAN_INTERVAL_MS. The rAF loop still runs, so the
    // camera keeps a frame ready and the browser can throttle us in background.
    const nowTs = Date.now();
    const due = nowTs - (this.lastDecodeAt || 0) >= SCAN_INTERVAL_MS;

    if (due && video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
      this.lastDecodeAt = nowTs;

      // Fit the frame inside SCAN_MAX_EDGE, never upscaling it.
      const ratio = Math.min(1, SCAN_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(1, Math.round(video.videoWidth * ratio));
      const h = Math.max(1, Math.round(video.videoHeight * ratio));

      // Assigning width/height reallocates the backing store and clears it, so
      // only do it when the size actually changed rather than on every frame.
      if (canvasElement.width !== w || canvasElement.height !== h) {
        canvasElement.width = w;
        canvasElement.height = h;
        this.scanCtx = null;
      }
      if (!this.scanCtx) {
        this.scanCtx = canvasElement.getContext('2d', { willReadFrequently: true });
      }
      const canvas = this.scanCtx;
      canvas.drawImage(video, 0, 0, w, h);

      const imageData = canvas.getImageData(0, 0, w, h);

      if (typeof window.jsQR !== 'function') {
        this.stopCamera();
        this.view.showToast("QR Scanner library failed to load. Please check internet connection.", "error");
        return;
      }
      const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "dontInvert" });

      if (code && code.data) {
        this.resetCameraIdleTimeout();
        const now = Date.now();
        if (this.lastScannedCode === code.data && (now - (this.lastScanTime || 0)) < 3000) {
           requestAnimationFrame(() => this.tickCamera());
           return;
        }
        
        this.lastScannedCode = code.data;
        this.lastScanTime = now;
        
        this.processScan(code.data, false);
        requestAnimationFrame(() => this.tickCamera());
        return;
      }
    }
    requestAnimationFrame(() => this.tickCamera());
  }

  // Exit-log ids are the key column of the scan_logs sheet. Date.now() on its
  // own repeats when two scans land in the same millisecond — two gates at
  // dismissal, or a queue flushing — and two rows then share a key, which is
  // what updateField and deleteRow match on. Same numeric-string format, just
  // never handed out twice in one session.
  nextLogId() {
    const now = Date.now();
    this._lastLogId = (this._lastLogId && this._lastLogId >= now) ? this._lastLogId + 1 : now;
    return this._lastLogId.toString();
  }

  async processScan(scannedData, isManual = false) {
    if (this.isScanPaused) return; // Ignore scans while modal is active

    // A scan is the guard working. Camera scanning fires no mouse or key
    // events, so without this a camera-only lane hits the 15-minute idle
    // timeout and signs the guard out in the middle of dismissal.
    this.model.updateActivity();

    let [rawId, token] = scannedData.split('|');
    rawId = rawId.trim();
    if (token) token = token.trim();
    
    // Check 15-second per-student cooldown
    const now = Date.now();
    if (this.lastScannedStudents[rawId] && (now - this.lastScannedStudents[rawId] < 15000)) {
      this.view.showToast('Student was just scanned recently.', 'info');
      return; 
    }
    this.lastScannedStudents[rawId] = now;
    // Entries past the cooldown can no longer block anything, and a gate
    // terminal stays open all day. Drop them instead of growing one key per
    // student scanned.
    for (const id in this.lastScannedStudents) {
      if (now - this.lastScannedStudents[id] >= 15000) delete this.lastScannedStudents[id];
    }

    let student = null;
    let isDenied = false;
    let msg = '';
    let passType = 'PGP';
    let designatedGate = 'Any authorized gate'; // fallback

    const gateSelect = document.getElementById('scan-gate');
    const scannerGate = gateSelect ? gateSelect.value : 'Gate 1';

    // Helper for gate validation. Empty gate = denied (no gate assigned).
    const isGateAllowed = (allowedStr) => {
      if (!allowedStr || !allowedStr.trim()) return false;
      if (allowedStr.includes('All Gates') || allowedStr.includes('Any authorized gate')) return true;
      return allowedStr.includes(scannerGate);
    };

    // 1. Check if it's a TGP
    const tgp = this.model.getTGP(rawId);
    if (tgp) {
      passType = 'TGP';
      student = this.model.getStudentByPassId(tgp.studentId) || this.model.getStudentByStudId(tgp.studentId);
      designatedGate = tgp.gate || 'Any authorized gate';

      const todayStr = new Date().toLocaleDateString('en-CA');
      // A pass row with a blank status used to throw here on .toUpperCase(),
      // which aborted the whole scan: no log written, no result shown, the
      // guard left with a frozen screen.
      const tgpStatus = String(tgp.status || '').trim().toLowerCase();
      if (tgpStatus !== 'approved') {
        isDenied = true;
        msg = tgpStatus === 'used'
          ? 'Pass already used'
          : `TGP is ${(tgpStatus || 'not approved').toUpperCase()}`;
      } else if (tgp.validDate !== todayStr) {
        isDenied = true;
        msg = `TGP valid only for ${tgp.validDate}`;
      } else if (!isGateAllowed(designatedGate)) {
        isDenied = true;
        msg = `Wrong gate. Must use: ${designatedGate}`;
      } else {
        msg = 'Valid Temporary Pass';
      }
    } else {
      // 2. Check PGP / Student ID
      student = this.model.students.find(s =>
        s.id === rawId ||
        s.studid === rawId ||
        s.pgp === rawId
      );

      if (!student) {
        isDenied = true;
        msg = 'Student not found in the system.';
      } else if (!isManual && student.qrToken && token !== student.qrToken) {
        // Cryptographic Token Verification Failed
        isDenied = true;
        msg = 'FORGED OR INVALID QR CODE';
      } else {
        designatedGate = student.preferredGate || '';
        if (student.status !== 'active') {
          isDenied = true;
          msg = `Pass is ${student.status}`;
        } else if (!designatedGate) {
          isDenied = true;
          msg = 'No gate assigned to this pass. Contact the admin.';
        } else if (!isGateAllowed(designatedGate)) {
          isDenied = true;
          msg = `Wrong gate. Must use: ${designatedGate}`;
        } else {
          msg = 'Valid Permanent Pass';
        }
      }
    }

    // Log the event
    await this.model.addExitLog({
      id: this.nextLogId(),
      studentId: student ? student.id : rawId,
      gate: scannerGate,
      timestamp: new Date().toISOString(),
      result: isDenied ? 'denied' : 'granted',
      passType: passType
    });

    // Mark TGP as used if successful
    if (passType === 'TGP' && !isDenied) {
      await this.model.updateTGPStatus(tgp.id, 'used');
    }

    // Render result in Modal
    const resultBox = document.getElementById('scan-result');
    const resultOverlay = document.getElementById('scan-result-overlay');
    if (resultBox && resultOverlay) {
      this.isScanPaused = true;
      resultOverlay.style.display = 'flex';
      
      // Small delay to allow display: flex to apply before opacity transition
      requestAnimationFrame(() => {
        resultOverlay.style.opacity = '1';
      });

      import('../views/ScannerView.js').then(module => {
        resultBox.innerHTML = module.default.renderResult(student, isDenied, msg, designatedGate);
        
        // Auto-hide result after 15s to allow reading arrangements
        if (this.scanResultTimeout) clearTimeout(this.scanResultTimeout);
        this.scanResultTimeout = setTimeout(() => {
          this.closeScanModal();
        }, 15000);
      });
    }

    // Refresh live feed
    const feedBox = document.getElementById('live-feed-container');
    if (feedBox) {
      import('../views/ScannerView.js').then(module => {
        const todayLogs = (this.model.exitLogs || []).filter(l => l.timestamp && l.timestamp.startsWith(new Date().toLocaleDateString('en-CA')));
        feedBox.innerHTML = module.default.renderLiveFeed(todayLogs, this.model);
      });
    }

    // Send email logic via API
    if (student && !isDenied && student.parentEmail) {
      const templateParams = {
        to_name: student.parentName || 'Parent/Guardian',
        to_email: student.parentEmail,
        student_name: student.name,
        gate_name: scannerGate,
        exit_time: new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
        exit_date: new Date().toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })
      };

      this.sendParentEmail(templateParams)
        .then(res => console.log('Email sent successfully', res))
        .catch(async err => {
          console.error('Failed to send email (offline?), queuing...', err);
          await this.model.addEmailToQueue(templateParams);
        });
    }
  }

  closeScanModal() {
    const resultOverlay = document.getElementById('scan-result-overlay');
    if (resultOverlay) {
      resultOverlay.style.opacity = '0';
      setTimeout(() => {
        resultOverlay.style.display = 'none';
        this.isScanPaused = false;
      }, 300); // Wait for transition
    } else {
      this.isScanPaused = false;
    }
    if (this.scanResultTimeout) {
      clearTimeout(this.scanResultTimeout);
      this.scanResultTimeout = null;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // FACE RECOGNITION — Completely separate from QR camera system
  // These methods use their own video element (#face-video) and
  // their own canvas (#face-overlay-canvas). The existing
  // startCamera/stopCamera/tickCamera methods are NOT modified.
  // ══════════════════════════════════════════════════════════════

  async startFaceCamera(mode = 'scan') {
    // ── RBAC Guard: Only admins can enroll faces ──
    if (mode === 'enroll') {
      if (!this.model.currentUser || this.model.currentUser.role !== 'admin') {
        this.view.showToast('Only administrators can enroll faces.', 'error');
        return;
      }

      // ── Consent Modal: Show RA 10173 disclaimer before enrollment ──
      const consent = await this.showFaceConsentModal();
      if (!consent) {
        this.view.showToast('Enrollment cancelled — consent not given.', 'error');
        return;
      }
    }

    this.faceMode = mode; // 'scan' or 'enroll'
    this.faceScanActive = false;
    this.blinkDetected = false; // Reset liveness state
    this.eyeOpenFrames = 0;
    this.blinkTransition = false;

    const video = document.getElementById('face-video');
    const startUi = document.getElementById('face-start-ui');
    const overlayCanvas = document.getElementById('face-overlay-canvas');
    const statusOverlay = document.getElementById('face-status-overlay');
    const livenessOverlay = document.getElementById('face-liveness-overlay');

    if (!video) return;

    // Guard: mediaDevices API
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.view.showToast('Camera API not available. Use HTTPS or localhost.', 'error');
      return;
    }

    // Show loading state
    if (statusOverlay) {
      statusOverlay.style.display = 'block';
      statusOverlay.textContent = 'Loading AI models...';
    }

    // Initialize face-api models (only loads once, cached after)
    const modelsReady = await faceBiometrics.init();
    if (!modelsReady) {
      this.view.showToast('Failed to load face recognition models.', 'error');
      if (statusOverlay) statusOverlay.style.display = 'none';
      return;
    }

    if (statusOverlay) {
      statusOverlay.textContent = mode === 'enroll' ? 'Position your face in frame...' : 'Scanning for faces...';
    }

    // Show liveness prompt for enrollment mode
    if (livenessOverlay) {
      livenessOverlay.style.display = mode === 'enroll' ? 'block' : 'none';
    }

    // Use FRONT camera for face scan (selfie mode)
    const onSuccess = (stream) => {
      this.faceStream = stream;
      video.srcObject = stream;
      video.style.display = 'block';
      if (startUi) startUi.style.display = 'none';
      if (overlayCanvas) overlayCanvas.style.display = 'block';
      video.play();
      this.faceScanActive = true;

      // Start the face detection loop
      requestAnimationFrame(() => this.tickFaceCamera());
    };

    const onError = (err) => {
      console.error('Face camera error:', err);
      this.view.showToast('Camera error: ' + (err.message || err.name), 'error');
      if (statusOverlay) statusOverlay.style.display = 'none';
      if (livenessOverlay) livenessOverlay.style.display = 'none';
    };

    // Prefer front camera (user-facing) for face scan
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
      .then(onSuccess)
      .catch(firstErr => {
        console.warn('Front camera unavailable, trying any camera...', firstErr.name);
        navigator.mediaDevices.getUserMedia({ video: true })
          .then(onSuccess)
          .catch(onError);
      });
  }

  stopFaceCamera() {
    this.faceScanActive = false;
    if (this.faceStream) {
      this.faceStream.getTracks().forEach(track => track.stop());
      this.faceStream = null;
    }
    const video = document.getElementById('face-video');
    const startUi = document.getElementById('face-start-ui');
    const overlayCanvas = document.getElementById('face-overlay-canvas');
    const statusOverlay = document.getElementById('face-status-overlay');
    const livenessOverlay = document.getElementById('face-liveness-overlay');
    if (video) video.style.display = 'none';
    if (startUi) startUi.style.display = 'block';
    if (overlayCanvas) overlayCanvas.style.display = 'none';
    if (statusOverlay) statusOverlay.style.display = 'none';
    if (livenessOverlay) livenessOverlay.style.display = 'none';
  }

  async tickFaceCamera() {
    if (!this.faceScanActive) return;

    const video = document.getElementById('face-video');
    const overlayCanvas = document.getElementById('face-overlay-canvas');
    const statusOverlay = document.getElementById('face-status-overlay');
    const livenessOverlay = document.getElementById('face-liveness-overlay');
    if (!video || !overlayCanvas) return;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      // Resize overlay canvas to match video
      overlayCanvas.width = video.videoWidth;
      overlayCanvas.height = video.videoHeight;
      const ctx = overlayCanvas.getContext('2d');
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

      // Detect face
      const detection = await faceBiometrics.detectFace(video);

      if (detection) {
        // Draw bounding box around detected face
        const box = detection.detection.box;
        ctx.strokeStyle = '#00c9b1';
        ctx.lineWidth = 3;
        ctx.strokeRect(box.x, box.y, box.width, box.height);

        // Draw corner accents
        const cornerLen = 20;
        ctx.strokeStyle = '#00e5c8';
        ctx.lineWidth = 4;
        // Top-left
        ctx.beginPath(); ctx.moveTo(box.x, box.y + cornerLen); ctx.lineTo(box.x, box.y); ctx.lineTo(box.x + cornerLen, box.y); ctx.stroke();
        // Top-right
        ctx.beginPath(); ctx.moveTo(box.x + box.width - cornerLen, box.y); ctx.lineTo(box.x + box.width, box.y); ctx.lineTo(box.x + box.width, box.y + cornerLen); ctx.stroke();
        // Bottom-left
        ctx.beginPath(); ctx.moveTo(box.x, box.y + box.height - cornerLen); ctx.lineTo(box.x, box.y + box.height); ctx.lineTo(box.x + cornerLen, box.y + box.height); ctx.stroke();
        // Bottom-right
        ctx.beginPath(); ctx.moveTo(box.x + box.width - cornerLen, box.y + box.height); ctx.lineTo(box.x + box.width, box.y + box.height); ctx.lineTo(box.x + box.width, box.y + box.height - cornerLen); ctx.stroke();

        if (this.faceMode === 'enroll') {
          // ── ENROLL MODE: Require liveness (blink) check first ──
          const ear = faceBiometrics.getEyeAspectRatio(detection.landmarks);
          const isBlinking = faceBiometrics.isBlinking(ear);

          if (!this.blinkDetected) {
            // Stage 1: Wait for eyes to be open (baseline)
            if (!isBlinking) {
              this.eyeOpenFrames++;
            }

            // Stage 2: Detect blink transition (open → closed)
            if (this.eyeOpenFrames >= 2 && isBlinking) {
              this.blinkTransition = true;
            }

            // Stage 3: Eyes re-opened after blink = liveness confirmed!
            if (this.blinkTransition && !isBlinking) {
              this.blinkDetected = true;
              // STOP the tick loop immediately to prevent re-triggering
              this.faceScanActive = false;

              if (livenessOverlay) {
                livenessOverlay.textContent = '✅ Liveness verified!';
                livenessOverlay.style.background = 'rgba(22,163,74,0.9)';
              }
              if (statusOverlay) {
                statusOverlay.textContent = 'Liveness confirmed — enrolling face...';
                statusOverlay.style.background = 'rgba(22,163,74,0.85)';
              }

              // Quick delay then enroll (tick loop is stopped)
              setTimeout(() => {
                this.enrollFaceFromDetection(detection);
              }, 400);
              return;
            }

            // Update status during liveness check
            if (statusOverlay) {
              statusOverlay.textContent = 'Face detected — Please blink to verify';
              statusOverlay.style.background = 'rgba(66,36,103,0.85)';
            }
          }
        } else {
          // ── SCAN MODE: Match against enrolled faces ──
          // Use merged descriptors (localStorage + Google Sheets sync)
          const enrolled = faceBiometrics.getAllEnrolledFaces(this.model.students);
          if (enrolled.length === 0) {
            if (statusOverlay) {
              statusOverlay.textContent = 'No faces enrolled yet. Enroll first!';
              statusOverlay.style.background = 'rgba(220,38,38,0.8)';
            }
          } else {
            const result = faceBiometrics.matchFace(detection.descriptor, enrolled);
            if (result.match) {
              // MATCH FOUND — Draw green box
              ctx.strokeStyle = '#16a34a';
              ctx.lineWidth = 4;
              ctx.strokeRect(box.x, box.y, box.width, box.height);

              if (statusOverlay) {
                statusOverlay.textContent = `✓ Match found! (${Math.round((1 - result.distance) * 100)}% confidence)`;
                statusOverlay.style.background = 'rgba(22,163,74,0.85)';
              }

              // Trigger the same processScan flow as QR/USB!
              this.faceScanActive = false; // Pause scanning
              this.processScan(result.studentId);

              // Cooldown: restart after 4 seconds
              setTimeout(() => {
                if (this.view.currentPage === 'scanner') {
                  this.stopFaceCamera();
                }
              }, 4000);
              return;
            } else {
              if (statusOverlay) {
                statusOverlay.textContent = 'Scanning... No match yet';
                statusOverlay.style.background = 'rgba(0,0,0,0.7)';
              }
            }
          }
        }
      } else {
        // No face detected
        const ctx2 = overlayCanvas.getContext('2d');
        ctx2.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        if (statusOverlay) {
          statusOverlay.textContent = this.faceMode === 'enroll' ? 'Position your face in frame...' : 'Scanning... No face detected';
          statusOverlay.style.background = 'rgba(0,0,0,0.7)';
        }
      }
    }

    // Continue the loop — fast during enrollment (150ms to catch blinks), slower during scan (500ms to save CPU)
    const tickDelay = this.faceMode === 'enroll' ? 150 : 500;
    setTimeout(() => {
      requestAnimationFrame(() => this.tickFaceCamera());
    }, tickDelay);
  }

  async enrollFaceFromDetection(detection) {
    // Ensure the tick loop is fully stopped
    this.faceScanActive = false;

    const statusOverlay = document.getElementById('face-status-overlay');
    const livenessOverlay = document.getElementById('face-liveness-overlay');

    // Prompt user to select which student to enroll
    const studentId = prompt(
      'Liveness verified! Enter the Student ID or PGP Pass ID to link this face to:',
      ''
    );

    if (!studentId || !studentId.trim()) {
      this.view.showToast('Enrollment cancelled.', 'error');
      this.stopFaceCamera();
      return;
    }

    const trimmedId = studentId.trim();

    // Verify the student exists
    const student = this.model.students.find(s =>
      s.id === trimmedId || s.studid === trimmedId || s.pgp === trimmedId
    );

    if (!student) {
      this.view.showToast('Student not found. Check the ID and try again.', 'error');
      this.stopFaceCamera();
      return;
    }

    // Save the face descriptor locally
    faceBiometrics.enrollFace(student.id, detection.descriptor);

    // ── Also save to Google Sheets (FaceDescriptor column) ──
    // We are restoring full mathematical precision for maximum accuracy!
    const descriptorArray = faceBiometrics.descriptorToArray(detection.descriptor);
    const descriptorJson = JSON.stringify(descriptorArray);

    student.faceDescriptor = descriptorJson;
    try {
      await this.model.updateStudent({ id: student.id, faceDescriptor: descriptorJson });
      console.log('[FaceBiometrics] Descriptor synced to Google Sheets.');
    } catch (err) {
      console.warn('[FaceBiometrics] Failed to sync descriptor to Sheets (will retry on next sync):', err);
    }

    // Update UI (elements may still exist since we stopped the tick loop, not the camera stream)
    const statusEl = document.getElementById('face-status-overlay');
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = `✓ Face enrolled for: ${student.name}`;
      statusEl.style.background = 'rgba(22,163,74,0.85)';
    }
    if (livenessOverlay) {
      livenessOverlay.style.display = 'none';
    }

    this.view.showToast(`Face enrolled for ${student.name}!`);
    this.updateFaceEnrolledCount();

    // Stop camera stream after 2 seconds
    setTimeout(() => this.stopFaceCamera(), 2000);
  }

  updateFaceEnrolledCount() {
    const countEl = document.getElementById('face-enrolled-count');
    if (countEl) {
      const localCount = faceBiometrics.getEnrolledCount();
      const syncedCount = this.model.students.filter(s => s.faceDescriptor).length;
      const total = Math.max(localCount, syncedCount);
      countEl.textContent = total > 0
        ? `${total} face${total !== 1 ? 's' : ''} enrolled`
        : 'No faces enrolled yet';
    }
  }

  // ── Consent Modal for Face Enrollment (RA 10173 Compliance) ──
  showFaceConsentModal() {
    return new Promise((resolve) => {
      const modalRoot = document.getElementById('modal-root');
      if (!modalRoot) { resolve(false); return; }

      modalRoot.innerHTML = `
        <div class="overlay" id="face-consent-overlay" style="display: flex;">
          <div class="modal" style="width: 480px;">
            <div class="modal-head">
              <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
                <span style="color: var(--primary);">${Icons['shield-check'](20)}</span>
                Biometric Data Consent
              </div>
            </div>
            <div class="modal-body" style="font-size: 13px; line-height: 1.7;">
              <div style="background: var(--primary-soft); border: 1px solid var(--primary); border-radius: var(--radius-sm); padding: 14px; margin-bottom: 16px;">
                <strong style="color: var(--primary);">Data Privacy Notice</strong>
                <div style="font-size: 12px; color: var(--text2); margin-top: 6px;">
                  In accordance with <strong>Republic Act No. 10173</strong> (Data Privacy Act of 2012), 
                  this system will process biometric data (facial recognition) for identity verification purposes.
                </div>
              </div>

              <p><strong>What will be collected:</strong></p>
              <ul style="margin: 6px 0 14px 18px; color: var(--text2); font-size: 12px;">
                <li>A mathematical face descriptor (128-number array) — <strong>NOT a photo</strong></li>
                <li>This data cannot be reversed into an image of the person</li>
              </ul>

              <p><strong>How it will be used:</strong></p>
              <ul style="margin: 6px 0 14px 18px; color: var(--text2); font-size: 12px;">
                <li>Gate exit identity verification only</li>
                <li>Stored locally on this device and in the school's secure database</li>
                <li>Not shared with any third party</li>
              </ul>

              <p><strong>Anti-spoofing:</strong></p>
              <ul style="margin: 6px 0 14px 18px; color: var(--text2); font-size: 12px;">
                <li>The student must <strong>blink</strong> during enrollment to verify they are a live person</li>
                <li>This prevents enrollment using photos or screens</li>
              </ul>

              <div style="background: var(--yellow-s); border: 1px solid var(--yellow); border-radius: var(--radius-sm); padding: 10px; margin-top: 10px; font-size: 11px; color: var(--yellow);">
                <strong>⚠ Consent Required:</strong> By proceeding, you confirm that the student (or parent/guardian 
                for minors) has given informed consent for biometric data processing.
              </div>
            </div>
            <div class="modal-foot">
              <button class="btn btn-ghost" id="face-consent-decline">Decline</button>
              <button class="btn btn-primary" id="face-consent-accept" style="gap: 6px;">
                ${Icons['shield-check'](14)} I Agree — Proceed
              </button>
            </div>
          </div>
        </div>
      `;

      document.getElementById('face-consent-accept').addEventListener('click', () => {
        modalRoot.innerHTML = '';
        resolve(true);
      });
      document.getElementById('face-consent-decline').addEventListener('click', () => {
        modalRoot.innerHTML = '';
        resolve(false);
      });
    });
  }
}
