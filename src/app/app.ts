import { Component, OnInit, OnDestroy, ViewEncapsulation } from '@angular/core';
import { NgIf, NgFor, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Chart, registerables } from 'chart.js';
import { Subscription } from 'rxjs';
import { RealtimeService, SSEEvent } from './realtime.service';

const API = 'http://localhost:4000';

interface Employee {
  _id: string;
  name: string;
  mobile: string;
  companyCode: string;
  countryCode?: string;
  tags?: string[];
  lastSyncTime?: string;
  lastCallTime?: string;
}

interface Lead {
  _id: string;
  companyCode: string;
  assignedEmployeePhone: string;
  leadCompanyName: string;
  contactName: string;
  contactNumber: string;
  status: string;
  setLabel: string;
  createdAt?: string;
}

interface Bookmark {
  _id: string;
  companyCode: string;
  employeePhone: string;
  contactNumber: string;
  contactName: string;
  companyName: string;
  description: string;
  remarks: string[];
  brochuresSent: boolean;
  techMeet: boolean;
  quotationSent: boolean;
  proposalSent: boolean;
  whatsappGrp: boolean;
  reminderDate?: string;
  createdAt?: string;
}

interface CallStats {
  incoming: number;
  outgoing: number;
  missed: number;
  rejected: number;
  connected: number;
  totalDuration: number;
  incomingDuration: number;
  outgoingDuration: number;
  total: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgIf, NgFor, NgClass, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
  encapsulation: ViewEncapsulation.None,
})
export class App implements OnInit, OnDestroy {

  readonly BASE = API;

  private sseSub?: Subscription;

  // ── Auth ─────────────────────────────────────────────────────
  loggedIn = false;
  loginLoading = false;
  loginError = '';
  loginForm = { companyCode: '', mobile: '', countryCode: '+91' };

  employee: Employee | null = null;
  companyName = '';

  // ── Dashboard tabs ────────────────────────────────────────────
  dashTab: 'overview' | 'leads' | 'followups' = 'overview';

  // ── Period ────────────────────────────────────────────────────
  selectedPeriod: 'today' | 'yesterday' | 'lastweek' = 'today';

  // ── Call Stats ────────────────────────────────────────────────
  callStats: CallStats | null = null;
  statsLoading = false;
  donutChart: Chart | null = null;

  // ── Leads ─────────────────────────────────────────────────────
  leads: Lead[] = [];
  leadSets: string[] = [];
  selectedLeadSet = '';
  leadsLoading = false;
  leadSearch = '';
  leadStatusFilter = '';
  updatingLeadId = '';

  readonly LEAD_STATUSES = ['New', 'Contacted', 'Interested', 'Not Interested', 'Converted', 'Follow Up'];

  get filteredLeads(): Lead[] {
    return this.leads.filter(l => {
      if (this.leadSearch) {
        const q = this.leadSearch.toLowerCase();
        if (!(l.leadCompanyName.toLowerCase().includes(q) ||
              l.contactName?.toLowerCase().includes(q) ||
              l.contactNumber?.toLowerCase().includes(q))) return false;
      }
      if (this.leadStatusFilter && l.status !== this.leadStatusFilter) return false;
      return true;
    });
  }

  // ── Follow-ups ────────────────────────────────────────────────
  followups: Bookmark[] = [];
  followupsLoading = false;
  followupSearch = '';

  get filteredFollowups(): Bookmark[] {
    if (!this.followupSearch) return this.followups;
    const q = this.followupSearch.toLowerCase();
    return this.followups.filter(b =>
      b.contactName?.toLowerCase().includes(q) ||
      b.contactNumber?.toLowerCase().includes(q) ||
      b.companyName?.toLowerCase().includes(q)
    );
  }

  // ── Util ──────────────────────────────────────────────────────
  sidebarOpen = false;
  sidebarMinimized = false;

  private headers = new HttpHeaders({ 'Content-Type': 'application/json' });

  constructor(private http: HttpClient, private sse: RealtimeService) { }

  ngOnInit(): void {
    Chart.register(...registerables);
    const raw = localStorage.getItem('dv_employee');
    if (raw) {
      try {
        const data = JSON.parse(raw);
        this.employee = data.employee;
        this.companyName = data.companyName || '';
        this.loggedIn = true;
        this.loadDashboard();
        this.initRealtime();
      } catch { localStorage.removeItem('dv_employee'); }
    }
  }

  ngOnDestroy(): void {
    if (this.donutChart) this.donutChart.destroy();
    this.sse.disconnect();
    this.sseSub?.unsubscribe();
  }

  // ── Login ─────────────────────────────────────────────────────
  login(): void {
    const { companyCode, mobile } = this.loginForm;
    if (!companyCode.trim() || !mobile.trim()) {
      this.loginError = 'Company code and mobile number are required.';
      return;
    }
    this.loginLoading = true;
    this.loginError = '';

    this.http.post<any>(`${API}/api/employees/login`, {
      companyCode: companyCode.trim(),
      mobile: mobile.trim(),
      countryCode: this.loginForm.countryCode,
    }, { headers: this.headers }).subscribe({
      next: res => {
        this.loginLoading = false;
        if (res.success) {
          this.employee = res.employee;

          // Also fetch company name
          this.http.get<any>(`${API}/api/auth/company/${companyCode.trim()}`).subscribe({
            next: cr => {
              this.companyName = cr.company?.companyName || '';
              localStorage.setItem('dv_employee', JSON.stringify({
                employee: this.employee,
                companyName: this.companyName,
              }));
            },
            error: () => {
              localStorage.setItem('dv_employee', JSON.stringify({ employee: this.employee, companyName: '' }));
            }
          });

          this.loggedIn = true;
          this.loadDashboard();
          this.initRealtime();
        } else {
          this.loginError = res.message || 'Login failed.';
        }
      },
      error: err => {
        this.loginLoading = false;
        this.loginError = err.error?.message || 'Employee not found with this number & company code.';
      }
    });
  }

  logout(): void {
    this.loggedIn = false;
    this.employee = null;
    this.companyName = '';
    this.callStats = null;
    this.leads = [];
    this.followups = [];
    this.dashTab = 'overview';
    localStorage.removeItem('dv_employee');
    this.sse.disconnect();
    this.sseSub?.unsubscribe();
    if (this.donutChart) { this.donutChart.destroy(); this.donutChart = null; }
  }

  // ── Dashboard Loader ──────────────────────────────────────────
  initRealtime(): void {
    if (!this.employee) return;
    this.sse.connect(this.employee.companyCode, this.employee.mobile);
    this.sseSub = this.sse.events$.subscribe((ev: SSEEvent) => {
      this.handleRealtimeEvent(ev);
    });
  }

  handleRealtimeEvent(ev: SSEEvent): void {
    if (ev.type === 'LEADS_REFRESH' || ev.type === 'LEADS_BULK_CREATED' || ev.type === 'LEAD_SET_DELETED') {
      this.fetchLeads(); // bulk change, just refresh
    } else if (ev.type === 'LEAD_CREATED' && ev.lead) {
      if (!this.leads.find(l => l._id === ev.lead._id)) {
        this.leads.unshift(ev.lead);
        if (ev.lead.setLabel && !this.leadSets.includes(ev.lead.setLabel)) {
          this.leadSets.push(ev.lead.setLabel);
        }
      }
    } else if (ev.type === 'LEAD_UPDATED' && ev.lead) {
      const idx = this.leads.findIndex(l => l._id === ev.lead._id);
      if (idx !== -1) this.leads[idx] = ev.lead;
    } else if (ev.type === 'LEAD_DELETED' && ev.id) {
      this.leads = this.leads.filter(l => l._id !== ev.id);
    } else if (ev.type === 'BOOKMARK_CREATED' && ev.bookmark) {
      if (!this.followups.find(b => b._id === ev.bookmark._id)) {
        this.followups.unshift(ev.bookmark);
      }
    } else if (ev.type === 'BOOKMARK_UPDATED' && ev.bookmark) {
      const idx = this.followups.findIndex(b => b._id === ev.bookmark._id);
      if (idx !== -1) this.followups[idx] = ev.bookmark;
    } else if (ev.type === 'BOOKMARK_DELETED' && ev.id) {
      this.followups = this.followups.filter(b => b._id !== ev.id);
    }
  }

  loadDashboard(): void {
    this.fetchStats();
    this.fetchLeads();
    this.fetchFollowups();
  }

  switchTab(tab: 'overview' | 'leads' | 'followups'): void {
    this.dashTab = tab;
    this.sidebarOpen = false;
    if (tab === 'overview') setTimeout(() => this.renderDonutChart(), 100);
  }

  onPeriodChange(p: 'today' | 'yesterday' | 'lastweek'): void {
    this.selectedPeriod = p;
    this.fetchStats();
  }

  // ── Call Stats ────────────────────────────────────────────────
  fetchStats(): void {
    if (!this.employee) return;
    this.statsLoading = true;
    const { companyCode, mobile } = this.employee;
    this.http.get<any>(
      `${API}/api/calllogs/employee?companyCode=${companyCode}&phone=${mobile}&period=${this.selectedPeriod}`
    ).subscribe({
      next: res => {
        this.statsLoading = false;
        if (res.success) {
          this.callStats = res.stats;
          if (this.dashTab === 'overview') setTimeout(() => this.renderDonutChart(), 100);
        }
      },
      error: () => { this.statsLoading = false; }
    });
  }

  renderDonutChart(): void {
    const canvas = document.getElementById('empDonutChart') as HTMLCanvasElement;
    if (!canvas || !this.callStats) return;
    if (this.donutChart) { this.donutChart.destroy(); this.donutChart = null; }

    const s = this.callStats;
    this.donutChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['Incoming', 'Outgoing', 'Missed', 'Rejected'],
        datasets: [{
          data: [s.incoming, s.outgoing, s.missed, s.rejected],
          backgroundColor: ['#3D7DFE', '#10b981', '#f59e0b', '#ef4444'],
          borderWidth: 0,
          hoverOffset: 6,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { font: { family: 'Onest, Inter, sans-serif', size: 12 }, padding: 16, usePointStyle: true }
          },
          tooltip: { bodyFont: { family: 'Onest' } }
        }
      }
    });
  }

  // ── Leads ─────────────────────────────────────────────────────
  fetchLeads(): void {
    if (!this.employee) return;
    this.leadsLoading = true;
    const { companyCode, mobile } = this.employee;
    const setParam = this.selectedLeadSet ? `&setLabel=${encodeURIComponent(this.selectedLeadSet)}` : '';
    this.http.get<any>(`${API}/api/leads/employee?companyCode=${companyCode}&phone=${mobile}${setParam}`)
      .subscribe({
        next: res => {
          this.leadsLoading = false;
          if (res.success) {
            this.leads = res.leads || [];
            this.leadSets = res.sets || [];
          }
        },
        error: () => { this.leadsLoading = false; }
      });
  }

  onLeadSetChange(set: string): void {
    this.selectedLeadSet = set;
    this.fetchLeads();
  }

  updateLeadStatus(lead: Lead, newStatus: string): void {
    this.updatingLeadId = lead._id;
    this.http.patch<any>(`${API}/api/leads/${lead._id}/status`, { status: newStatus }, { headers: this.headers })
      .subscribe({
        next: res => {
          this.updatingLeadId = '';
          if (res.success) lead.status = newStatus;
        },
        error: () => { this.updatingLeadId = ''; }
      });
  }

  getLeadStatusClass(status: string): string {
    const map: Record<string, string> = {
      'New': 'status-new',
      'Contacted': 'status-contacted',
      'Interested': 'status-interested',
      'Not Interested': 'status-not-interested',
      'Converted': 'status-converted',
      'Follow Up': 'status-followup',
    };
    return map[status] || 'status-new';
  }

  // ── Follow-ups ────────────────────────────────────────────────
  fetchFollowups(): void {
    if (!this.employee) return;
    this.followupsLoading = true;
    const { companyCode, mobile } = this.employee;
    this.http.get<any>(`${API}/api/bookmarks?companyCode=${companyCode}&phone=${mobile}`)
      .subscribe({
        next: res => {
          this.followupsLoading = false;
          if (res.success) this.followups = res.bookmarks || [];
        },
        error: () => { this.followupsLoading = false; }
      });
  }

  // ── Helpers ───────────────────────────────────────────────────
  fmtDur(secs: number): string {
    if (!secs) return '0s';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  fmtDate(d: string | undefined | null): string {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  get initials(): string {
    if (!this.employee?.name) return 'E';
    return this.employee.name.split(' ').map(w => w[0]).join('').toUpperCase().substring(0, 2);
  }

  get totalLeads(): number { return this.leads.length; }
  get convertedLeads(): number { return this.leads.filter(l => l.status === 'Converted').length; }
  get pendingLeads(): number { return this.leads.filter(l => l.status === 'New' || l.status === 'Contacted').length; }
}
