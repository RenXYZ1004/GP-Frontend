import Icons from '../icons.js';
import { escapeHTML } from '../utils.js';

export default class UsersView {
  static render(model) {
    const users = model.users || [];
    
    const adminCount = users.filter(u => u.role === 'admin').length;
    const secCount = users.filter(u => u.role === 'secretary').length;
    const guardCount = users.filter(u => u.role === 'guard').length;

    return `
      <div class="kpi-strip">
        <div class="kpi-card kpi-purple">
          <div class="kpi-icon">${Icons['users'](20)}</div>
          <div class="kpi-info"><div class="kpi-val">${users.length}</div><div class="kpi-lbl">Total Users</div></div>
        </div>
        <div class="kpi-card kpi-red">
          <div class="kpi-icon">${Icons['shield-check'](20)}</div>
          <div class="kpi-info"><div class="kpi-val">${adminCount}</div><div class="kpi-lbl">Administrators</div></div>
        </div>
        <div class="kpi-card kpi-blue">
          <div class="kpi-icon">${Icons['file-text'](20)}</div>
          <div class="kpi-info"><div class="kpi-val">${secCount}</div><div class="kpi-lbl">Secretaries</div></div>
        </div>
        <div class="kpi-card kpi-green">
          <div class="kpi-icon">${Icons['door-open'](20)}</div>
          <div class="kpi-info"><div class="kpi-val">${guardCount}</div><div class="kpi-lbl">Guards</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">User Management</div>
            <div class="card-sub">Manage system access and roles</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="alert('Accounts are managed in the Supabase dashboard under Authentication. A new sign-in also needs a matching row in the profiles table carrying their role and gate.')">
            ${Icons['plus'](14)} Manage Accounts
          </button>
        </div>

        <div class="tbl-wrap">
          <table id="users-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Gate/Campus</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${users.length === 0 ? '<tr><td colspan="5" class="empty">No users found.</td></tr>' : ''}
              ${users.map(u => `
                <tr>
                  <td>
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <div style="width: 28px; height: 28px; border-radius: 50%; background: var(--primary-soft); display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--primary); font-weight: 700; font-size: 10px;">
                        ${escapeHTML((u.name || u.username || 'U').substring(0, 2).toUpperCase())}
                      </div>
                      <div style="font-weight: 600;">${escapeHTML(u.name || 'Unknown')}</div>
                    </div>
                  </td>
                  <td>${escapeHTML(u.username)}</td>
                  <td>
                    <span class="badge ${u.role === 'admin' ? 'b-info' : (u.role === 'guard' ? 'b-active' : 'b-pending')}">${(u.role || '').toUpperCase()}</span>
                  </td>
                  <td>${escapeHTML(u.gate || 'Main Office')}</td>
                  <td>
                    ${(() => {
                      const status = (u.status || 'active').toLowerCase();
                      if (status === 'archived') return '<span class="badge b-denied" style="font-size:11px;">Archived</span>';
                      if (status === 'inactive') return '<span class="badge b-pending" style="font-size:11px;">Inactive</span>';
                      return '<span class="badge b-active" style="font-size:11px;">Active</span>';
                    })()}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
}
