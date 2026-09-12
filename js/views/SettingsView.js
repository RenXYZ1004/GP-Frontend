import Icons from '../icons.js';
import { escapeHTML } from '../utils.js';

export default class SettingsView {
  static renderGatesTable(model) {
    const gates = model.gates || [];
    const guards = (model.users || []).filter(u => u.role === 'guard');
    if (!gates.length) {
      return `<div style="color:var(--text3);font-size:13px;padding:8px 0;">No gates configured yet. Click "Add Gate" to create the first one.</div>`;
    }
    return `
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Gate Name</th>
              <th>Assigned Guard</th>
              <th>Status</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${gates.map(g => {
              const guard = guards.find(u => u.username === g.assignedGuard);
              const guardName = guard ? escapeHTML(guard.name || guard.username) : (g.assignedGuard ? escapeHTML(g.assignedGuard) : '<span style="color:var(--text3);">Unassigned</span>');
              const statusBadge = g.status === 'active'
                ? `<span class="badge badge-green">Active</span>`
                : `<span class="badge badge-gray">Inactive</span>`;
              return `
                <tr>
                  <td style="font-weight:600;">${escapeHTML(g.name)}</td>
                  <td>${guardName}</td>
                  <td>${statusBadge}</td>
                  <td style="text-align:right;">
                    <button class="btn btn-ghost btn-sm btn-edit-gate" data-id="${escapeHTML(g.id)}">${Icons['edit'](14)} Edit</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  static renderGateModal(model, gate = null) {
    const guards = (model.users || []).filter(u => u.role === 'guard');
    const isEdit = !!gate;
    return `
      <div id="modal-gate" class="overlay" style="display:flex;">
        <div class="modal" style="max-width:420px;">
          <div class="modal-head">
            <div class="modal-title">${isEdit ? 'Edit Gate' : 'Add New Gate'}</div>
            <button class="close-btn" id="btn-close-gate-modal">${Icons['x-close'](14)}</button>
          </div>
          <div class="modal-body">
            <form id="form-gate">
              <input type="hidden" id="gate-id" value="${gate ? escapeHTML(gate.id) : ''}">
              <div class="form-group required mb-12">
                <label for="gate-name">Gate Name</label>
                <input type="text" id="gate-name" class="form-input" required placeholder="e.g. Monarchs Gym" value="${gate ? escapeHTML(gate.name) : ''}">
              </div>
              <div class="form-group mb-12">
                <label for="gate-guard">Assigned Guard</label>
                <select id="gate-guard" class="form-input">
                  <option value="">-- Unassigned --</option>
                  ${guards.map(u => `<option value="${escapeHTML(u.username)}" ${gate && gate.assignedGuard === u.username ? 'selected' : ''}>${escapeHTML(u.name || u.username)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group mb-12">
                <label for="gate-status">Status</label>
                <select id="gate-status" class="form-input">
                  <option value="active" ${!gate || gate.status === 'active' ? 'selected' : ''}>Active</option>
                  <option value="inactive" ${gate && gate.status === 'inactive' ? 'selected' : ''}>Inactive</option>
                </select>
              </div>
            </form>
          </div>
          <div class="modal-foot">
            <button type="button" class="btn btn-ghost" id="btn-cancel-gate-modal">Cancel</button>
            <button type="submit" class="btn btn-primary" id="btn-save-gate" form="form-gate">${isEdit ? 'Save Changes' : 'Add Gate'}</button>
          </div>
        </div>
      </div>`;
  }

  static render(model) {
    const currentTheme = model.getTheme() || 'auto';
    
    return `
      <div class="grid-2">
        <!-- Appearance -->
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Appearance</div>
              <div class="card-sub">Customize the application theme</div>
            </div>
          </div>
          <div class="card-body">
            <div class="form-group mb-12">
              <label>Theme Preference</label>
              <select id="settings-theme" class="form-input">
                <option value="auto" ${currentTheme === 'auto' ? 'selected' : ''}>Default (Light Mode)</option>
                <option value="light" ${currentTheme === 'light' ? 'selected' : ''}>Light Mode</option>
                <option value="dark" ${currentTheme === 'dark' ? 'selected' : ''}>Dark Mode</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Data Management -->
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Data Management</div>
              <div class="card-sub">Export or clear your system data</div>
            </div>
          </div>
          <div class="card-body">
            <div style="display: flex; flex-direction: column; gap: 12px;">
              <button class="btn btn-ghost" id="settings-export" style="justify-content: center;">
                ${Icons['download'](16)} Export All Data (JSON)
              </button>
              
              <button class="btn btn-ghost" id="settings-import-btn" style="justify-content: center;">
                ${Icons['upload'](16)} Import Data (JSON)
              </button>
              <input type="file" id="settings-import-file" style="display: none;" accept=".json">
              
              <div style="border-top: 1px solid var(--border); margin: 8px 0;"></div>
              
              <button class="btn btn-danger" id="settings-clear-db" style="justify-content: center;">
                ${Icons['trash'](16)} Erase Database...
              </button>
              <div style="font-size: 11px; color: var(--text3); text-align: center;">
                This will permanently delete all students and logs.
              </div>
            </div>
          </div>
        </div>

        ${model.currentUser?.role === 'admin' ? `
        <!-- Gate Management (Admin Only) -->
        <div class="card" style="grid-column: 1 / -1;">
          <div class="card-head">
            <div>
              <div class="card-title">Gate Management</div>
              <div class="card-sub">Add, edit, or deactivate campus gates. Changes apply immediately across the system.</div>
            </div>
            <button class="btn btn-primary btn-sm" id="btn-add-gate">
              ${Icons['plus'](14)} Add Gate
            </button>
          </div>
          <div class="card-body">
            <div id="gates-table-wrap">
              ${SettingsView.renderGatesTable(model)}
            </div>
          </div>
        </div>

        <!-- Pass ID Management (Admin Only) -->
        <div class="card" style="grid-column: 1 / -1;">
          <div class="card-head">
            <div>
              <div class="card-title">Pass ID Management</div>
              <div class="card-sub">Fix or regenerate student Pass IDs to the standardized format (26A07-001)</div>
            </div>
          </div>
          <div class="card-body">
            <div style="background: var(--accent-soft); border: 1px solid var(--accent); border-radius: var(--radius); padding: 16px; margin-bottom: 16px;">
              <div style="font-size: 13px; font-weight: 600; color: var(--primary); margin-bottom: 6px;">How it works</div>
              <ul style="font-size: 12px; color: var(--text2); margin: 0; padding-left: 18px; line-height: 1.8;">
                <li>Scans all students for IDs that <strong>don't match</strong> the new format (<code>26A07-001</code>)</li>
                <li>Generates a new PGP ID based on each student's <strong>grade</strong> and <strong>section</strong></li>
                <li>Updates both the local cache <strong>and</strong> the database</li>
                <li>All QR codes will automatically match the new IDs</li>
              </ul>
            </div>
            <div id="regen-status" style="display: none; margin-bottom: 12px;"></div>
            <div style="display: flex; gap: 12px; flex-wrap: wrap;">
              <button class="btn btn-ghost" id="btn-preview-regen" style="justify-content: center;">
                ${Icons['scan-line'](16)} Preview Old IDs
              </button>
              <button class="btn btn-primary" id="btn-regen-ids" style="justify-content: center;" disabled>
                ${Icons['settings-gear'](16)} Regenerate All Pass IDs
              </button>
            </div>
          </div>
        </div>
        ` : ''}
      </div>

      <!-- About / Version -->
      <div class="card" style="max-width: 100%; margin-top: 24px;">
        <div class="card-head">
          <div>
            <div class="card-title">About e-gatepass</div>
            <div class="card-sub">System Version and Information</div>
          </div>
        </div>
        <div class="card-body">
          <div style="display: flex; align-items: flex-start; gap: 16px;">
            <div style="width: 56px; height: 56px; background: #fff; border-radius: 12px; display: flex; align-items: center; justify-content: center; padding: 4px; border: 1px solid var(--border); flex-shrink: 0; margin-top: 4px;">
              <img src="logo.png" alt="SISC" style="width:100%;height:100%;object-fit:contain;">
            </div>
            <div>
              <div style="font-size: 18px; font-weight: 700; color: var(--text);">e-gatepass System</div>
              <div style="font-size: 13px; color: var(--text2); font-weight: 600; margin-bottom: 8px;">Version 1.4.5 (Production)</div>
              
              <div style="font-size: 13px; color: var(--text2); line-height: 1.6; margin-bottom: 16px;">
                The <strong>e-gatepass system</strong> is a secure, automated verification platform designed for student safety. It ensures that students are authorized to leave the campus by instantly retrieving their gate pass arrangements and guardian details, while simultaneously logging the exit and sending real-time email notifications to parents.
              </div>

              <div style="font-size: 13px; color: var(--text2); line-height: 1.6; margin-bottom: 16px; background: var(--bg-body); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">
                <div style="font-weight: 600; color: var(--text); margin-bottom: 6px;">How It Works:</div>
                <ul style="margin: 0; padding-left: 20px;">
                  <li><strong>1. Scan/Search:</strong> Security scans the student's ID or searches their name manually.</li>
                  <li><strong>2. Verify:</strong> System verifies if the student is permitted to leave and who is fetching them.</li>
                  <li><strong>3. Record & Notify:</strong> The exit is securely logged locally and synced to the cloud, triggering an automatic email to the parents.</li>
                </ul>
              </div>
              

              <div style="font-size: 11px; color: var(--text3); border-top: 1px solid var(--border); padding-top: 12px;">&copy; 2026 Southville International School and Colleges</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
