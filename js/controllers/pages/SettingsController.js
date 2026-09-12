import Dialog from '../../services/Dialog.js';
import ApiService from '../../services/ApiService.js';
import { generatePGP, escapeHTML, generateQRToken } from '../../utils.js';
import SettingsView from '../../views/SettingsView.js';

export default class SettingsController {

  static async revealUserManual() {
    const link = document.getElementById('btn-user-manual');
    if (!link) return;
    try {
      const res = await fetch('manual.pdf', { method: 'HEAD', cache: 'no-store' });
      const type = res.headers.get('content-type') || '';
      if (res.ok && !type.includes('text/html')) link.style.display = 'inline-flex';
    } catch (_) {
      /* offline or missing — leave the button hidden */
    }
  }

  static bind(controller) {
    // User manual — the PDF is deployed alongside the app rather than kept in
    // the repo, so only reveal the button once we know the file is actually
    // there. A dead link that 404s is worse than no link.
    SettingsController.revealUserManual();

    // Theme Select
    const themeSel = document.getElementById('settings-theme');
    if (themeSel) {
      themeSel.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val === 'auto') {
          controller.model.setTheme(null);
          controller.view.applyTheme('auto');
        } else {
          controller.model.setTheme(val);
          controller.view.applyTheme(val);
        }
        controller.view.showToast('Theme preference updated');
      });
    }

    // Export Data
    const btnExport = document.getElementById('settings-export');
    if (btnExport) {
      btnExport.addEventListener('click', () => {
        const data = {
          exportDate: new Date().toISOString(),
          students: controller.model.students,
          exitLogs: controller.model.exitLogs,
          tgp: controller.model.tgp
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `PGP_Backup_${new Date().toLocaleDateString('en-CA')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        controller.view.showToast('Data exported successfully');
      });
    }

    // Import Data
    const btnImport = document.getElementById('settings-import-btn');
    const fileImport = document.getElementById('settings-import-file');
    
    if (btnImport && fileImport) {
      btnImport.addEventListener('click', () => fileImport.click());
      
      fileImport.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const confirmed = await Dialog.confirm(
          'Import Data',
          'Are you sure you want to import data? This will overwrite existing students, logs, and TGPs. This action cannot be undone.',
          { confirmText: 'Yes, Import', type: 'warning' }
        );
        if (confirmed) {
          const reader = new FileReader();
          reader.onload = (event) => {
            try {
              const data = JSON.parse(event.target.result);
              if (data.students) controller.model.students = data.students;
              if (data.exitLogs) controller.model.exitLogs = data.exitLogs;
              if (data.tgp) controller.model.tgp = data.tgp;
              
              controller.model.cacheAll();
              
              controller.view.showToast('Data imported successfully. Refreshing...', 'success');
              setTimeout(() => window.location.reload(), 1500);
            } catch (err) {
              console.error(err);
              controller.view.showToast('Error importing data. Invalid JSON format.', 'error');
            }
          };
          reader.readAsText(file);
        }
        fileImport.value = ''; // Reset input
      });
    }

    // Clear Data
    const btnClear = document.getElementById('settings-clear-db');
    if (btnClear) {
      btnClear.addEventListener('click', async () => {
        const confirmed1 = await Dialog.confirm(
          'CRITICAL WARNING',
          'This will permanently delete ALL students and logs. Are you absolutely sure?',
          { confirmText: 'Delete All', type: 'danger' }
        );
        if (confirmed1) {
          const confirmed2 = await Dialog.confirm(
            'Final Confirmation',
            'Are you REALLY sure? This cannot be undone.',
            { confirmText: 'Yes, Delete Everything', type: 'danger' }
          );
          if (confirmed2) {
            controller.model.students = [];
            controller.model.exitLogs = [];
            controller.model.tgp = [];
            controller.model.cacheAll();
            controller.view.showToast('All database records cleared', 'error');
            setTimeout(() => window.location.reload(), 1000);
          }
        }
      });
    }

    // ══════════════════════════════════════════════════════════
    // Gate Management (Admin Only)
    // ══════════════════════════════════════════════════════════

    const openGateModal = (gate = null) => {
      const existing = document.getElementById('modal-gate');
      if (existing) existing.remove();
      document.body.insertAdjacentHTML('beforeend', SettingsView.renderGateModal(controller.model, gate));

      const modal = document.getElementById('modal-gate');
      const closeModal = () => modal.remove();

      document.getElementById('btn-close-gate-modal').addEventListener('click', closeModal);
      document.getElementById('btn-cancel-gate-modal').addEventListener('click', closeModal);
      modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

      document.getElementById('form-gate').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('gate-id').value.trim();
        const name = document.getElementById('gate-name').value.trim();
        const assignedGuard = document.getElementById('gate-guard').value;
        const status = document.getElementById('gate-status').value;

        if (!name) { controller.view.showToast('Gate name is required', 'error'); return; }

        const saveBtn = document.getElementById('btn-save-gate');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
          if (id) {
            await controller.model.updateGate({ id, name, assignedGuard, status });
            controller.view.showToast(`Gate "${name}" updated`);
          } else {
            const newId = 'gate-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            await controller.model.addGate({ id: newId, name, assignedGuard, status });
            controller.view.showToast(`Gate "${name}" added`);
          }
          closeModal();
          document.getElementById('gates-table-wrap').innerHTML = SettingsView.renderGatesTable(controller.model);
          bindGateEditButtons();
        } catch (err) {
          controller.view.showToast('Failed to save gate: ' + err.message, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = id ? 'Save Changes' : 'Add Gate';
        }
      });
    };

    const bindGateEditButtons = () => {
      document.querySelectorAll('.btn-edit-gate').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          const gate = controller.model.gates.find(g => g.id === id);
          if (gate) openGateModal(gate);
        });
      });
    };

    const btnAddGate = document.getElementById('btn-add-gate');
    if (btnAddGate) {
      btnAddGate.addEventListener('click', () => openGateModal());
      bindGateEditButtons();
    }

    // ══════════════════════════════════════════════════════════
    // Pass ID Regeneration Tool
    // ══════════════════════════════════════════════════════════

    // Helper: check if a PGP ID matches the new format {YY}{S}{GG}-{NNN} and has a QR Token
    const isFullyProvisioned = (student) => {
      const pgp = student.pgp;
      if (!pgp || typeof pgp !== 'string') return false;
      if (!student.qrToken || student.qrToken === '' || student.qrToken === 'undefined' || student.qrToken === 'null') return false;
      if (student.qrToken.length < 8) return false; // Tokens should be 8 chars
      // Matches: 26EMP07-001, 26INQB1-001, etc.
      return /^\d{2}[A-Z]{3}[A-Z0-9]{2}-\d{3}$/.test(pgp);
    };

    const btnPreview = document.getElementById('btn-preview-regen');
    const btnRegen = document.getElementById('btn-regen-ids');
    const statusBox = document.getElementById('regen-status');

    if (btnPreview) {
      btnPreview.addEventListener('click', () => {
        const students = controller.model.students || [];
        const oldFormatStudents = students.filter(s => !isFullyProvisioned(s));

        if (oldFormatStudents.length === 0) {
          statusBox.style.display = 'block';
          statusBox.innerHTML = `
            <div style="background: var(--green-s); border: 1px solid var(--green); border-radius: var(--radius); padding: 12px; color: var(--green); font-size: 13px; font-weight: 600;">
              ✓ All ${students.length} student(s) already have standardized Pass IDs AND secure QR Tokens. Nothing to fix!
            </div>`;
          if (btnRegen) btnRegen.disabled = true;
          return;
        }

        statusBox.style.display = 'block';
        statusBox.innerHTML = `
          <div style="background: var(--orange-s, rgba(251,191,36,0.1)); border: 1px solid var(--orange, #f59e0b); border-radius: var(--radius); padding: 12px; margin-bottom: 8px;">
            <div style="font-size: 13px; font-weight: 700; color: var(--orange, #f59e0b); margin-bottom: 8px;">
              ⚠ Found ${oldFormatStudents.length} student(s) requiring a Pass ID or QR Token update
            </div>
            <div style="max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-card);">
              <table style="width: 100%; font-size: 11px; border-collapse: collapse;">
                <thead>
                  <tr>
                    <th style="padding: 6px 8px; text-align: left; background: var(--bg-elevated); border-bottom: 1px solid var(--border);">Student</th>
                    <th style="padding: 6px 8px; text-align: left; background: var(--bg-elevated); border-bottom: 1px solid var(--border);">Student ID</th>
                    <th style="padding: 6px 8px; text-align: left; background: var(--bg-elevated); border-bottom: 1px solid var(--border);">Current Pass ID</th>
                    <th style="padding: 6px 8px; text-align: left; background: var(--bg-elevated); border-bottom: 1px solid var(--border);">Grade</th>
                  </tr>
                </thead>
                <tbody>
                  ${oldFormatStudents.slice(0, 50).map(s => `
                    <tr>
                      <td style="padding: 4px 8px; border-bottom: 1px solid var(--border);">${escapeHTML(s.name)}</td>
                      <td style="padding: 4px 8px; border-bottom: 1px solid var(--border); font-family: monospace;">${escapeHTML(s.studid || '—')}</td>
                      <td style="padding: 4px 8px; border-bottom: 1px solid var(--border); font-family: monospace; color: var(--red);">${escapeHTML(s.pgp)}</td>
                      <td style="padding: 4px 8px; border-bottom: 1px solid var(--border);">${escapeHTML(s.grade || '—')}</td>
                    </tr>
                  `).join('')}
                  ${oldFormatStudents.length > 50 ? `<tr><td colspan="4" style="padding: 6px 8px; text-align: center; color: var(--text3); font-style: italic;">...and ${oldFormatStudents.length - 50} more</td></tr>` : ''}
                </tbody>
              </table>
            </div>
          </div>`;

        if (btnRegen) btnRegen.disabled = false;
      });
    }

    if (btnRegen) {
      btnRegen.addEventListener('click', async () => {
        const confirmed = await Dialog.confirm(
          'Regenerate All Pass IDs & Tokens',
          'This will assign standardized Pass IDs (e.g., 26EMP07-001) and secure QR Tokens to all flagged students. The changes will be saved to the database. Continue?',
          { confirmText: 'Yes, Regenerate', type: 'warning' }
        );
        if (!confirmed) return;

        btnRegen.disabled = true;
        btnRegen.innerHTML = 'Regenerating...';
        if (btnPreview) btnPreview.disabled = true;

        const students = controller.model.students || [];
        let updated = 0;
        let failed = 0;

        for (const student of students) {
          if (isFullyProvisioned(student)) continue; // Already good

          try {
            const oldPgp = student.pgp || student.id;
            // Only generate a completely new PGP if the old one isn't the standardized format
            const isOldFormat = !oldPgp || !/^\d{2}[A-Z]{3}[A-Z0-9]{2}-\d{3}$/.test(oldPgp);
            const newPgp = isOldFormat ? generatePGP(student.grade, student.section, students) : oldPgp;

            // Step 1: Update the local student object
            student.id = newPgp;
            student.pgp = newPgp;
            student.qrToken = generateQRToken();

            const sheetData = controller.model.mapStudentToSheet(student);

            // Step 2: Push to the API (update if same ID, replace if new ID)
            if (newPgp !== oldPgp) {
              try { await ApiService.removeStudent(oldPgp); } catch (e) {}
              await ApiService.addStudent(sheetData);
            } else {
              // We just added a qrToken, the ID is the same, so just do an update
              await ApiService.updateStudent(sheetData);
            }

            updated++;
            console.log(`[Regen] ${student.name}: ${oldPgp} → ${newPgp}`);
            
            // Add a short delay to prevent Google Apps Script rate limits
            await new Promise(resolve => setTimeout(resolve, 600));
          } catch (err) {
            console.error(`[Regen] Failed for ${student.name}:`, err);
            failed++;
          }
        }

        // Save updated local cache and clear stale write queue from old IDs
        controller.model.cacheAll();
        controller.model.writeQueue = [];
        localStorage.setItem('pgp_write_queue', JSON.stringify([]));

        statusBox.style.display = 'block';
        statusBox.innerHTML = `
          <div style="background: var(--green-s); border: 1px solid var(--green); border-radius: var(--radius); padding: 12px; color: var(--green); font-size: 13px; font-weight: 600;">
            ✓ Regeneration complete! ${updated} student(s) updated.${failed > 0 ? ` ${failed} failed (will retry on next sync).` : ''}
          </div>`;

        btnRegen.innerHTML = '✓ Done';
        controller.view.showToast(`${updated} Pass IDs regenerated successfully!`);

        // Refresh the page after a short delay
        setTimeout(() => {
          controller.navigateToPage('settings');
        }, 2000);
      });
    }
  }
}
