import { resolvePhotoUrl, hasPhoto, generatePaginationHTML, bindPaginationEvents, generateQRToken, waitForImages, compressImageToBlob, uploadPhotoLocally, renderQRCodeInto } from '../../utils.js';
import Dialog from '../../services/Dialog.js';
import EmailService from '../../services/EmailService.js';
import { setButtonLoading } from '../../views/AppView.js';

export default class TGPController {
  static bind(controller) {
    const modal = document.getElementById('modal-tgp');
    const btnAdd = document.getElementById('btn-add-tgp');
    const btnClose = document.getElementById('btn-close-tgp');
    const btnCancel = document.getElementById('btn-cancel-tgp');
    const form = document.getElementById('form-tgp');

    // Grade → Section data (mirrors tgpForm.html)
    const TGP_SECTIONS = {
      'Grade 7':  ['Determination','Gratitude','Kindness','Mindfulness','Optimism','Resilience'],
      'Grade 8':  ['Creativity','Empathy','Enthusiasm','Integrity','Joy','Justice'],
      'Grade 9':  ['Compassion','Diligence','Fortitude','Generosity','Harmony','Sincerity'],
      'Grade 10': ['Commitment','Conviction','Leadership','Patriotism','Prudence','Responsibility','Teamwork'],
      'Grade 11': ['Competence','Efficiency','Excellence','Growth Mindset','Industry','Innovation','Synergy'],
      'Grade 12': ['Diplomacy','Dynamism','Grit','Initiative','Rigor','Service','Tenacity'],
      'IB1': ['Inquirers','Communicators'],
      'IB2': ['Risk-Takers','Balanced']
    };

    function populateTgpSections() {
      const gradeEl = document.getElementById('tgp-grade');
      const sectionEl = document.getElementById('tgp-section');
      if (!gradeEl || !sectionEl) return;
      const grade = gradeEl.value;
      sectionEl.innerHTML = '';
      if (!grade) {
        sectionEl.appendChild(new Option('Select grade first', ''));
        sectionEl.disabled = true;
        return;
      }
      const list = TGP_SECTIONS[grade] || [];
      sectionEl.appendChild(new Option('-- Section --', ''));
      list.forEach(s => sectionEl.appendChild(new Option(s, s)));
      sectionEl.disabled = false;
    }

    const gradeEl = document.getElementById('tgp-grade');
    if (gradeEl) gradeEl.addEventListener('change', populateTgpSections);

    // Photo state
    let tgpPhotoFile = null;
    function resetTgpModalState() {
      populateTgpSections();
      tgpPhotoFile = null;
      const ph = document.getElementById('tgp-photo-placeholder');
      const pv = document.getElementById('tgp-photo-preview');
      if (ph) ph.style.display = '';
      if (pv) pv.style.display = 'none';
    }

    const photoArea = document.getElementById('tgp-photo-area');
    const photoInput = document.getElementById('tgp-photo-input');
    if (photoArea && photoInput) {
      photoArea.addEventListener('click', () => photoInput.click());
      photoInput.addEventListener('change', () => {
        const file = photoInput.files[0];
        if (!file) return;
        tgpPhotoFile = file;
        document.getElementById('tgp-photo-name').textContent = file.name;
        const reader = new FileReader();
        reader.onload = ev => {
          document.getElementById('tgp-photo-img').src = ev.target.result;
          document.getElementById('tgp-photo-placeholder').style.display = 'none';
          document.getElementById('tgp-photo-preview').style.display = 'flex';
        };
        reader.readAsDataURL(file);
      });
    }

    if (btnAdd && modal) btnAdd.addEventListener('click', () => modal.style.display = 'flex');
    if (btnClose && modal) btnClose.addEventListener('click', () => { modal.style.display = 'none'; });
    if (btnCancel && modal) btnCancel.addEventListener('click', (e) => { e.preventDefault(); modal.style.display = 'none'; });

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const lastName    = (document.getElementById('tgp-last-name').value || '').trim();
        const firstName   = (document.getElementById('tgp-first-name').value || '').trim();
        const studentId   = (document.getElementById('tgp-studid').value || '').trim();
        const grade       = document.getElementById('tgp-grade').value;
        const section     = document.getElementById('tgp-section').value;
        const validDate   = document.getElementById('tgp-date').value;
        const gate        = document.getElementById('tgp-gate').value;
        const reason      = document.getElementById('tgp-reason').value;
        const requester   = document.getElementById('tgp-requester').value;
        const studentEmail = (document.getElementById('tgp-student-email').value || '').trim();
        const contactPhone = (document.getElementById('tgp-phone').value || '').trim();
        const parentEmail  = (document.getElementById('tgp-parent-email')?.value || '').trim();

        const name = lastName && firstName ? `${lastName}, ${firstName}` : (lastName || firstName || '');

        const newTGP = {
          // Cryptographic ID — TGP is accepted at the gate on this alone,
          // so it must not be guessable from earlier Math.random draws.
          id: 'TGP-' + generateQRToken(6),
          studentId,
          name,
          grade,
          section,
          studentEmail,
          contactPhone,
          parentEmail,
          validDate,
          gate,
          reason,
          requester,
          status: 'pending',
          source: 'staff',
          createdAt: new Date().toISOString()
        };

        const btnSubmit = document.getElementById('btn-submit-tgp');
        setButtonLoading(btnSubmit, true);

        try {
          // Optional photo: upload image bytes to Blob and store only its URL.
          if (tgpPhotoFile) {
            try {
              const imageBlob = await compressImageToBlob(tgpPhotoFile, 500, 500, 0.82);
              newTGP.photo = await uploadPhotoLocally(newTGP.id || studentId || newTGP.name || 'tgp-photo', imageBlob);
            } catch (err) {
              console.warn('Optional TGP photo upload failed:', err);
            }
          }

          await controller.model.addTGP(newTGP);
          controller.view.showToast('TGP Request Submitted');
          modal.style.display = 'none';
          form.reset();
          resetTgpModalState();
          controller.navigateToPage('tgp');
        } finally {
          setButtonLoading(btnSubmit, false);
        }
      });
    }

    // RBAC: Hide action buttons if guard
    if (controller.model.currentUser && controller.model.currentUser.role === 'guard') {
      document.querySelectorAll('.btn-tgp-action').forEach(btn => btn.style.display = 'none');
      if (btnAdd) btnAdd.style.display = 'none';
    }

    // Pill filters
    const defaultGate = controller.model.currentUser?.role === 'guard' && controller.model.currentUser?.gate
      ? controller.model.currentUser.gate
      : 'all';
    controller.tgpPagination = { page: 1, limit: 25, filter: 'all', gate: defaultGate };

    // Gate filter dropdown (added alongside pills)
    const gateFilter = document.getElementById('tgp-filter-gate');
    if (gateFilter) {
      gateFilter.value = defaultGate;
      gateFilter.addEventListener('change', () => {
        controller.tgpPagination.gate = gateFilter.value;
        controller.tgpPagination.page = 1;
        TGPController.updatePagination(controller);
      });
    }

    const pills = document.querySelectorAll('#tgp-table-filters .pill, button.pill[data-filter]');
    pills.forEach(pill => {
      pill.addEventListener('click', (e) => {
        pills.forEach(p => p.classList.remove('on'));
        e.currentTarget.classList.add('on');
        controller.tgpPagination.filter = e.currentTarget.dataset.filter || 'all';
        controller.tgpPagination.page = 1;
        TGPController.updatePagination(controller);
      });
    });

    TGPController.updatePagination(controller);
  }

  static bindRowActions(controller) {
    // Action buttons (Approve/Reject)
    document.querySelectorAll('.btn-tgp-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.dataset.id;
        const action = e.currentTarget.dataset.action;
        const isApprove = action === 'approved';
        const confirmed = await Dialog.confirm(
          isApprove ? 'Approve Pass' : 'Reject Pass',
          `Are you sure you want to ${isApprove ? 'APPROVE' : 'REJECT'} this pass?`,
          { confirmText: isApprove ? 'Yes, Approve' : 'Yes, Reject', type: isApprove ? 'primary' : 'danger' }
        );
        
        if (confirmed) {
          await controller.model.updateTGPStatus(id, action);
          controller.view.showToast(`Pass ${action}`);
          controller.navigateToPage('tgp');
        }
      });
    });

    TGPController.bindTGPCard(controller);
  }

  static updatePagination(controller) {
    let tgpList = controller.model.tgp || [];
    const p = controller.tgpPagination;
    
    let filtered = tgpList.filter(t => {
      if (p.filter !== 'all' && p.filter !== 'online' && t.status !== p.filter) return false;
      if (p.filter === 'online' && t.source !== 'online') return false;
      if (p.gate && p.gate !== 'all' && t.gate !== p.gate) return false;
      return true;
    });
    
    // Sort by createdAt descending
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = filtered.length;
    const maxPage = Math.ceil(total / p.limit) || 1;
    if (p.page > maxPage) p.page = maxPage;
    if (p.page < 1) p.page = 1;
    
    const start = (p.page - 1) * p.limit;
    const paginated = filtered.slice(start, start + p.limit);

    import('../../views/TGPView.js').then(module => {
      const tbody = document.querySelector('#tgp-table tbody');
      if (tbody) tbody.innerHTML = module.default.renderTableRows(paginated, controller.model);
      
      if (controller.model.currentUser && controller.model.currentUser.role === 'guard') {
        document.querySelectorAll('.btn-tgp-action').forEach(btn => btn.style.display = 'none');
      }

      TGPController.bindRowActions(controller);
      
      const tgpPaginationContainer = document.getElementById('tgp-pagination');
      if (tgpPaginationContainer) {
        tgpPaginationContainer.innerHTML = generatePaginationHTML(p, total);
        bindPaginationEvents(tgpPaginationContainer, p, () => TGPController.updatePagination(controller));
      }
    });
  }

  static bindTGPCard(controller) {
    const modalCard = document.getElementById('modal-tgp-card');
    const btnCloseCard = document.getElementById('btn-close-tgp-card');

    if (btnCloseCard && modalCard) {
      btnCloseCard.addEventListener('click', () => modalCard.style.display = 'none');
    }

    // View Pass buttons
    document.querySelectorAll('.btn-view-tgp').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tgpId = e.currentTarget.dataset.id;
        const tgp = controller.model.tgp.find(t => t.id === tgpId);
        if (!tgp) return;

        const student = controller.model.getStudentByPassId(tgp.studentId) || controller.model.getStudentByStudId(tgp.studentId);
        const sName = tgp.name || (student ? student.name : 'Unknown Student');
        const sGrade = (tgp.grade ? `${tgp.grade}${tgp.section ? ' - ' + tgp.section : ''}` : '') || (student ? `${student.grade}${student.section ? ' - ' + student.section : ''}` : '');
        const dateStr = new Date(tgp.validDate).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });

        const photoHtml = (student && hasPhoto(student.photo))
          ? `<img src="${resolvePhotoUrl(student.photo)}" style="width:100%;height:100%;object-fit:cover;">`
          : hasPhoto(tgp.photo)
          ? `<img src="${resolvePhotoUrl(tgp.photo)}" style="width:100%;height:100%;object-fit:cover;">`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:bold;color:#e08700;">${sName.substring(0,2).toUpperCase()}</div>`;

        const target = document.getElementById('tgp-card-render-target');
        target.innerHTML = `
          <div id="tgp-card-capture" style="width:300px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 15px rgba(0,0,0,0.1);font-family:'Segoe UI',sans-serif;">
            <div style="background:linear-gradient(135deg,#e08700,#f5a623);padding:15px;text-align:center;color:#fff;">
              <div style="font-size:14px;font-weight:800;letter-spacing:1px;">SOUTHVILLE INTERNATIONAL</div>
              <div style="font-size:10px;color:#fff;font-weight:700;margin-top:2px;opacity:0.9;">TEMPORARY GATE PASS</div>
            </div>
            <div style="padding:20px;text-align:center;">
              <div style="width:80px;height:80px;margin:0 auto 12px;border-radius:10px;border:3px solid #e08700;overflow:hidden;background:#fef3e0;">${photoHtml}</div>
              <div style="font-size:18px;font-weight:800;color:#1f2937;margin-bottom:2px;">${sName}</div>
              <div style="font-size:12px;color:#6b7280;font-weight:600;margin-bottom:12px;">${sGrade}</div>
              
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left;margin-bottom:16px;">
                <div style="background:#fef3e0;padding:8px 10px;border-radius:6px;">
                  <div style="font-size:9px;color:#b06c00;text-transform:uppercase;font-weight:700;">Valid Date</div>
                  <div style="font-size:12px;font-weight:700;color:#1f2937;margin-top:2px;">${dateStr}</div>
                </div>
                <div style="background:#fef3e0;padding:8px 10px;border-radius:6px;">
                  <div style="font-size:9px;color:#b06c00;text-transform:uppercase;font-weight:700;">Gate</div>
                  <div style="font-size:12px;font-weight:700;color:#1f2937;margin-top:2px;">${tgp.gate}</div>
                </div>
              </div>

              <div style="background:#f5f4f8;border-radius:8px;padding:10px;display:flex;flex-direction:column;align-items:center;">
                <div style="font-size:10px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:5px;">Scan to Verify</div>
                <div id="tgp-qrcode" style="border-radius:6px;overflow:hidden;line-height:0;"></div>
                <div style="font-size:11px;font-weight:700;font-family:monospace;color:#e08700;margin-top:5px;letter-spacing:1px;">${tgp.id}</div>
              </div>
            </div>
            <div style="background:#e08700;padding:8px;text-align:center;color:#fff;font-size:9px;font-weight:700;letter-spacing:0.5px;">ONE-DAY PASS · REQUIRES APPROVAL · ${tgp.requester ? 'Requested by: ' + tgp.requester : ''}</div>
          </div>`;

        // Generate QR Code
        setTimeout(() => {
          const qrTarget = document.getElementById('tgp-qrcode');
          if (qrTarget && typeof QRCode !== 'undefined') {
            // Same renderer as the PGP card: integer modules at high
            // resolution, pure black on white, with the quiet zone drawn in.
            // This drew the light modules in the panel's own #f5f4f8 before, so
            // the code had neither a silent margin nor a full contrast range —
            // the two things a scanner needs most.
            renderQRCodeInto(qrTarget, tgp.id, 96);
          }
        }, 50);

        // Show/hide the email button based on whether the TGP has a student email
        const btnEmail = document.getElementById('btn-email-tgp');
        if (btnEmail) {
          if (tgp.studentEmail) {
            btnEmail.style.display = '';
            btnEmail.dataset.tgpId = tgpId;
          } else {
            btnEmail.style.display = 'none';
          }
        }

        // Store context on download button so the filename can reference the student
        const btnDl = document.getElementById('btn-download-tgp');
        if (btnDl) { btnDl.dataset.tgpId = tgpId; btnDl.dataset.tgpName = sName; }

        modalCard.style.display = 'flex';
      });
    });

    // Download TGP Card
    const btnDownload = document.getElementById('btn-download-tgp');
    if (btnDownload) {
      btnDownload.addEventListener('click', async () => {
        const captureArea = document.getElementById('tgp-card-capture');
        if (!captureArea) return;
        btnDownload.innerHTML = 'Generating...';
        btnDownload.disabled = true;
        // Same pair as the permanent pass download: let the images decode,
        // and request them with CORS so a photo served from another origin
        // can actually be drawn into the canvas.
        await waitForImages(captureArea);
        html2canvas(captureArea, { scale: 3, useCORS: true }).then(canvas => {
          const a = document.createElement('a');
          a.href = canvas.toDataURL("image/png");
          const dlName = (btnDownload.dataset.tgpName || 'Student').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
          const dlId = btnDownload.dataset.tgpId || Date.now();
          a.download = `TGP_${dlName}_${dlId}.png`;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          btnDownload.innerHTML = 'Download Image';
          btnDownload.disabled = false;
        });
      });
    }

    // Email TGP Card — uses the card that's already rendered in the modal
    const btnEmail = document.getElementById('btn-email-tgp');
    if (btnEmail) {
      btnEmail.addEventListener('click', async () => {
        const tgpId = btnEmail.dataset.tgpId;
        const tgp = controller.model.tgp.find(t => t.id === tgpId);
        if (!tgp || !tgp.studentEmail) return;

        const confirmed = await Dialog.confirm(
          'Email Pass',
          `Send the TGP card to:\n${tgp.studentEmail}`,
          { confirmText: 'Send Email', type: 'primary' }
        );
        if (!confirmed) return;

        const captureArea = document.getElementById('tgp-card-capture');
        if (!captureArea) return;

        const originalHtml = btnEmail.innerHTML;
        btnEmail.disabled = true;
        btnEmail.innerHTML = 'Sending…';

        try {
          await waitForImages(captureArea);
          const canvas = await html2canvas(captureArea, { scale: 3, useCORS: true });
          const base64 = canvas.toDataURL('image/png');

          const student = controller.model.getStudentByPassId(tgp.studentId) || controller.model.getStudentByStudId(tgp.studentId);
          const sName = student ? student.name : (tgp.name || 'Unknown Student');
          const sGrade = student ? `${student.grade}${student.section ? ' - ' + student.section : ''}` : '';

          // EmailService attaches the session token and throws on failure
          // rather than returning one, so the catch below reports both a
          // network error and a rejected send in the same place.
          await EmailService.send({
            email_type: 'tgp_delivery',
            to_email: tgp.studentEmail,
            to_name: tgp.requester || '',
            student_name: sName,
            grade: sGrade,
            tgp_no: tgp.id,
            valid_date: tgp.validDate,
            gate_name: tgp.gate,
            attachment_base64: base64,
            attachment_name: `TGP_${tgp.id}.png`
          });

          controller.view.showToast(`Pass emailed to ${tgp.studentEmail}`);
        } catch (err) {
          controller.view.showToast(`Email failed: ${err.message || String(err)}`);
        } finally {
          btnEmail.disabled = false;
          btnEmail.innerHTML = originalHtml;
        }
      });
    }
  }
}
