import { Component, OnInit, OnDestroy, ViewEncapsulation } from '@angular/core';
import { NgIf, NgFor, NgClass, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Chart, registerables } from 'chart.js';
import { Subscription } from 'rxjs';
import { RealtimeService, SSEEvent } from './realtime.service';
import { ApiService } from './api.service';

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
  companyDescription?: string;
  mainDivisionDescription?: string;
  directorEmailAddress?: string;
  remarks?: string[];
  isStarred?: boolean;
  isHearted?: boolean;
  sheetOrder?: number;
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
  meetingRemarks: boolean;
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
  imports: [NgIf, NgFor, NgClass, FormsModule, DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
  encapsulation: ViewEncapsulation.None,
})
export class App implements OnInit, OnDestroy {

  private sseSub?: Subscription;

  // ── Auth ─────────────────────────────────────────────────────
  loggedIn = false;
  loginLoading = false;
  loginError = '';
  loginForm = { companyCode: '', mobile: '', countryCode: '+91' };

  employee: Employee | null = null;
  companyName = '';

  // ── Dashboard tabs ────────────────────────────────────────────
  dashTab: 'overview' | 'leads' | 'followups' | 'interested' | 'dnp' | 'converted' | 'hearted' = 'overview';

  // ── Period ────────────────────────────────────────────────────
  selectedPeriod: 'today' | 'yesterday' | 'lastweek' = 'today';

  // ── Call Stats ────────────────────────────────────────────────
  callStats: CallStats | null = null;
  statsLoading = false;
  donutChart: Chart | null = null;
  timelineChart: Chart | null = null;
  timelineData: any[] = [];
  chartType: 'line' | 'bar' = 'line';

  // ── Leads ─────────────────────────────────────────────────────
  allLeads: Lead[] = [];
  leads: Lead[] = [];
  leadSets: string[] = [];
  selectedLeadSet = 'none';
  leadsLoading = false;
  leadRemarksInputs: { [key: string]: string } = {};
  remarkPostingIds = new Set<string>();

  addLeadRemark(lead: Lead): void {
    const remark = this.leadRemarksInputs[lead._id];
    if (!remark || !remark.trim() || this.remarkPostingIds.has(lead._id)) return;

    this.remarkPostingIds.add(lead._id);

    this.api.post(`/api/leads/${lead._id}/remarks`, { remark }).subscribe({
      next: (res: any) => {
        this.remarkPostingIds.delete(lead._id);
        if (res.success) {
          this.leadRemarksInputs[lead._id] = '';
          // Immediate reflection
          const idx = this.leads.findIndex(l => l._id === lead._id);
          if (idx !== -1) {
            this.leads[idx] = this.normalizeLead(res.lead);
          }
        }
      },
      error: () => {
        this.remarkPostingIds.delete(lead._id);
      }
    });
  }

  deleteLeadRemark(lead: Lead, index: number): void {
    if (!confirm('Delete this remark?')) return;
    this.api.delete(`/api/leads/${lead._id}/remarks/${index}`).subscribe({
      next: (res: any) => {
        if (res.success) {
          const idx = this.leads.findIndex(l => l._id === lead._id);
          if (idx !== -1) {
            this.leads[idx] = this.normalizeLead(res.lead);
          }
        }
      }
    });
  }

  toggleStar(lead: Lead): void {
    const newValue = !lead.isStarred;
    lead.isStarred = newValue;
    this.api.patch(`/api/leads/${lead._id}/flags`, { isStarred: newValue }).subscribe({
      error: () => { lead.isStarred = !newValue; }
    });
  }

  toggleHeart(lead: Lead): void {
    const newValue = !lead.isHearted;
    lead.isHearted = newValue;
    this.api.patch(`/api/leads/${lead._id}/flags`, { isHearted: newValue }).subscribe({
      error: () => { lead.isHearted = !newValue; }
    });
  }

  leadSearch = '';
  leadStatusFilter = '';
  updatingLeadId = '';
  selectedLeadCompany = ''; // For sidebar layout

  get uniqueLeadCompanies(): string[] {
    const sets = new Set<string>();
    
    // Filter leads by set, status, and search
    const filtered = this.allLeads.filter(l => {
      if (this.selectedLeadSet === 'none') return false;
      if (this.selectedLeadSet && l.setLabel !== this.selectedLeadSet) return false;
      
      // If a status filter is active, the lead must match it
      if (this.leadStatusFilter && l.status !== this.leadStatusFilter) return false;
      
      // Search Filter
      if (this.leadSearch) {
        const q = this.leadSearch.toLowerCase();
        if (!(l.leadCompanyName.toLowerCase().includes(q) ||
              l.contactName?.toLowerCase().includes(q) ||
              l.contactNumber?.toLowerCase().includes(q))) return false;
      }
      return true;
    });

    filtered.forEach(l => {
      if (l.leadCompanyName) sets.add(l.leadCompanyName);
    });

    const arr = Array.from(sets).sort();
    
    // Auto-selection logic
    if (this.selectedLeadCompany && !sets.has(this.selectedLeadCompany)) {
      this.selectedLeadCompany = arr.length > 0 ? arr[0] : '';
    } else if (arr.length > 0 && !this.selectedLeadCompany) {
      this.selectedLeadCompany = arr[0];
    }
    
    return arr;
  }

  get leadsInSelectedCompany(): Lead[] {
    if (!this.selectedLeadCompany) return [];
    // Return ALL leads of the selected company. 
    // Respect set filter ONLY in the main 'leads' tab.
    return this.allLeads.filter(l => {
      if (l.leadCompanyName !== this.selectedLeadCompany) return false;
      if (this.dashTab === 'leads') {
        if (this.selectedLeadSet === 'none') return false;
        if (this.selectedLeadSet && l.setLabel !== this.selectedLeadSet) return false;
      }
      return true;
    }).sort((a, b) => (a.sheetOrder || 0) - (b.sheetOrder || 0));
  }

  selectLeadCompany(name: string): void {
    this.selectedLeadCompany = name;
  }

  // Admin-configurable lead statuses (fetched from backend)
  LEAD_STATUSES: string[] = ['New', 'Contacted', 'Interested', 'Not Interested', 'Converted', 'Follow Up'];
  INTERESTED_PAGE_STATUSES: string[] = ['Interested', 'Follow Up'];
  DNP_PAGE_STATUSES: string[] = ['Not Interested'];
  CONVERTED_PAGE_STATUSES: string[] = ['Converted'];
  selectedInterestedStatus: string = 'All';
  selectedDnpStatus: string = 'All';
  selectedConvertedStatus: string = 'All';
  breakHourLimitMin: number = 60; // minutes — fetched from company settings

  get todayFollowupsCount(): number {
    if (!this.followups.length) return 0;
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
    return this.followups.filter(f => {
      if (!f.reminderDate) return false;
      const d = new Date(f.reminderDate).toLocaleDateString('en-CA');
      return d === today;
    }).length;
  }

  get filteredLeads(): Lead[] {
    if (this.selectedLeadSet === 'none') return [];
    
    return this.allLeads.filter(l => {
      // Set Filter
      if (this.selectedLeadSet && l.setLabel !== this.selectedLeadSet) return false;

      // Search Filter
      if (this.leadSearch) {
        const q = this.leadSearch.toLowerCase();
        if (!(l.leadCompanyName.toLowerCase().includes(q) ||
              l.contactName?.toLowerCase().includes(q) ||
              l.contactNumber?.toLowerCase().includes(q))) return false;
      }
      
      // Status Filter
      if (this.leadStatusFilter && l.status !== this.leadStatusFilter) return false;
      
      return true;
    });
  }

  get uniqueInterestedCompanies(): string[] {
    const sets = new Set<string>();
    this.allLeads.forEach(l => {
      if (this.INTERESTED_PAGE_STATUSES.includes(l.status)) {
        if (this.selectedInterestedStatus === 'All' || l.status === this.selectedInterestedStatus) {
          if (l.leadCompanyName) sets.add(l.leadCompanyName);
        }
      }
    });
    return Array.from(sets).sort();
  }

  get uniqueDnpCompanies(): string[] {
    const sets = new Set<string>();
    this.allLeads.forEach(l => {
      if (this.DNP_PAGE_STATUSES.includes(l.status)) {
        if (this.selectedDnpStatus === 'All' || l.status === this.selectedDnpStatus) {
          if (l.leadCompanyName) sets.add(l.leadCompanyName);
        }
      }
    });
    return Array.from(sets).sort();
  }

  get uniqueConvertedCompanies(): string[] {
    const sets = new Set<string>();
    this.allLeads.forEach(l => {
      if (this.CONVERTED_PAGE_STATUSES.includes(l.status)) {
        if (this.selectedConvertedStatus === 'All' || l.status === this.selectedConvertedStatus) {
          if (l.leadCompanyName) sets.add(l.leadCompanyName);
        }
      }
    });
    return Array.from(sets).sort();
  }

  get uniqueHeartedCompanies(): string[] {
    const sets = new Set<string>();
    this.allLeads.forEach(l => {
      if (l.isHearted && l.leadCompanyName) sets.add(l.leadCompanyName);
    });
    return Array.from(sets).sort();
  }

  get interestedLeads(): Lead[] {
    let filtered = this.allLeads.filter(l => this.INTERESTED_PAGE_STATUSES.includes(l.status));
    if (this.selectedInterestedStatus !== 'All') {
      filtered = filtered.filter(l => l.status === this.selectedInterestedStatus);
    }
    return filtered;
  }

  get dnpLeads(): Lead[] {
    let filtered = this.allLeads.filter(l => this.DNP_PAGE_STATUSES.includes(l.status));
    if (this.selectedDnpStatus !== 'All') {
      filtered = filtered.filter(l => l.status === this.selectedDnpStatus);
    }
    return filtered;
  }

  get convertedLeads(): Lead[] {
    let filtered = this.allLeads.filter(l => this.CONVERTED_PAGE_STATUSES.includes(l.status));
    if (this.selectedConvertedStatus !== 'All') {
      filtered = filtered.filter(l => l.status === this.selectedConvertedStatus);
    }
    return filtered;
  }

  get heartedLeads(): Lead[] {
    return this.allLeads.filter(l => l.isHearted);
  }

  leadsInCompanyCount(company: string): number {
    return this.allLeads.filter(l => l.leadCompanyName === company).length;
  }

  // ── Follow-ups ────────────────────────────────────────────────
  followups: Bookmark[] = [];
  followupsLoading = false;
  followupSearch = '';
  followupFilter: 'all' | 'today' = 'all';

  get filteredFollowups(): Bookmark[] {
    let list = this.followups;

    if (this.followupFilter === 'today') {
      const today = new Date().toLocaleDateString('en-CA');
      list = list.filter(b => {
        if (!b.reminderDate) return false;
        return new Date(b.reminderDate).toLocaleDateString('en-CA') === today;
      });
    }

    if (this.followupSearch) {
      const q = this.followupSearch.toLowerCase();
      list = list.filter(b =>
        b.contactName?.toLowerCase().includes(q) ||
        b.contactNumber?.toLowerCase().includes(q) ||
        b.companyName?.toLowerCase().includes(q)
      );
    }
    return list;
  }

  // ── Follow-up Modal State ─────────────────────────────────────
  showFollowupModal = false;
  followupSaving = false;
  followupLead: Lead | null = null;
  editingBookmarkId: string | null = null;
  followupForm = {
    brochuresSent: false,
    techMeet: false,
    meetingRemarks: false,
    quotationSent: false,
    proposalSent: false,
    whatsappGrp: false,
    description: '',
    remarks: [] as string[],
    newRemark: '',
    reminderDate: ''
  };

  openFollowupModal(lead: Lead): void {
    this.followupLead = lead;
    this.editingBookmarkId = null;
    this.showFollowupModal = true;
    // Reset form
    this.followupForm = {
      brochuresSent: false,
      techMeet: false,
      meetingRemarks: false,
      quotationSent: false,
      proposalSent: false,
      whatsappGrp: false,
      description: '',
      remarks: [],
      newRemark: '',
      reminderDate: ''
    };
    
    // Check if there is an existing bookmark for this contact to pre-fill
    const existing = this.followups.find(f => f.contactNumber === lead.contactNumber);
    if (existing) {
      this.editingBookmarkId = existing._id;
      this.followupForm.brochuresSent = existing.brochuresSent;
      this.followupForm.techMeet = existing.techMeet;
      this.followupForm.meetingRemarks = existing.meetingRemarks;
      this.followupForm.quotationSent = existing.quotationSent;
      this.followupForm.proposalSent = existing.proposalSent;
      this.followupForm.whatsappGrp = existing.whatsappGrp;
      this.followupForm.description = existing.description;
      this.followupForm.remarks = [...(existing.remarks || [])];
      if (existing.reminderDate) {
        this.followupForm.reminderDate = new Date(existing.reminderDate).toISOString().split('T')[0];
      }
    }
  }

  openEditFollowupModal(b: Bookmark): void {
    this.editingBookmarkId = b._id;
    this.followupLead = {
      _id: '',
      companyCode: b.companyCode,
      assignedEmployeePhone: b.employeePhone,
      leadCompanyName: b.companyName,
      contactName: b.contactName,
      contactNumber: b.contactNumber,
      status: '',
      setLabel: '',
    };
    this.showFollowupModal = true;
    this.followupForm = {
      brochuresSent: b.brochuresSent,
      techMeet: b.techMeet,
      meetingRemarks: b.meetingRemarks,
      quotationSent: b.quotationSent,
      proposalSent: b.proposalSent,
      whatsappGrp: b.whatsappGrp,
      description: b.description,
      remarks: [...(b.remarks || [])],
      newRemark: '',
      reminderDate: b.reminderDate ? new Date(b.reminderDate).toISOString().split('T')[0] : ''
    };
  }

  removeRemark(index: number): void {
    this.followupForm.remarks.splice(index, 1);
  }

  trackByFn(index: any, item: any) {
    return index;
  }

  closeFollowupModal(): void {
    this.showFollowupModal = false;
    this.followupLead = null;
    this.editingBookmarkId = null;
  }

  saveFollowup(): void {
    if (!this.followupLead || !this.employee) return;
    this.followupSaving = true;

    const body = {
      companyCode: this.employee.companyCode,
      employeePhone: this.employee.mobile,
      contactNumber: this.followupLead.contactNumber,
      contactName: this.followupLead.contactName,
      companyName: this.followupLead.leadCompanyName,
      description: this.followupForm.description,
      brochuresSent: this.followupForm.brochuresSent,
      techMeet: this.followupForm.techMeet,
      meetingRemarks: this.followupForm.meetingRemarks,
      quotationSent: this.followupForm.quotationSent,
      proposalSent: this.followupForm.proposalSent,
      whatsappGrp: this.followupForm.whatsappGrp,
      reminderDate: this.followupForm.reminderDate || undefined,
      remarks: this.followupForm.remarks, // Send updated historical remarks
      newRemark: this.followupForm.newRemark.trim() || undefined
    };

    if (this.editingBookmarkId) {
      this.api.patch<any>(`/api/bookmarks/${this.editingBookmarkId}`, body).subscribe({
        next: res => {
          this.followupSaving = false;
          if (res.success) {
            this.closeFollowupModal();
            this.fetchFollowups();
          }
        },
        error: () => { this.followupSaving = false; }
      });
    } else {
      this.api.post<any>(`/api/bookmarks`, body).subscribe({
        next: res => {
          this.followupSaving = false;
          if (res.success) {
            this.closeFollowupModal();
            this.fetchFollowups();
          }
        },
        error: () => { this.followupSaving = false; }
      });
    }
  }

  // ── Util ──────────────────────────────────────────────────────
  sidebarOpen = false;
  sidebarMinimized = false;

  // ── Break button state ────────────────────────────────────────
  breakActive = false;
  breakPosting = false;
  breakTimerDisplay = '00:00';
  breakTotalSecondsToday = 0;
  private breakTimerRef: any;
  private breakStartedAt: number = 0;


  constructor(private http: HttpClient, private sse: RealtimeService, public api: ApiService) { }

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
        this.resumeBreakTimer();
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

    this.api.post<any>(`/api/employees/login`, {
      companyCode: companyCode.trim(),
      mobile: mobile.trim(),
      countryCode: this.loginForm.countryCode,
    }).subscribe({
      next: res => {
        this.loginLoading = false;
        if (res.success) {
          this.employee = res.employee;

          // Also fetch company name
          this.api.get<any>(`/api/auth/company/${companyCode.trim()}`).subscribe({
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

  normalizeLead(lead: any): Lead {
    if (!lead) return lead;
    return {
      ...lead,
      remarks: Array.isArray(lead.remarks) ? lead.remarks : (lead.remarks ? [lead.remarks] : [])
    };
  }

  handleRealtimeEvent(ev: SSEEvent): void {
    if (ev.type === 'LEADS_REFRESH' || ev.type === 'LEADS_BULK_CREATED' || ev.type === 'LEAD_SET_DELETED') {
      this.fetchLeads(); // bulk change, just refresh
    } else if (ev.type === 'LEAD_CREATED' && ev.lead) {
      if (!this.leads.find(l => l._id === ev.lead._id)) {
        const normalized = this.normalizeLead(ev.lead);
        this.leads.unshift(normalized);
        if (normalized.setLabel && !this.leadSets.includes(normalized.setLabel)) {
          this.leadSets.push(normalized.setLabel);
        }
      }
    } else if (ev.type === 'LEAD_UPDATED' && ev.lead) {
      const idx = this.leads.findIndex(l => l._id === ev.lead._id);
      if (idx !== -1) this.leads[idx] = this.normalizeLead(ev.lead);
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
    this.fetchLeadSets();
    this.fetchFollowups();
    this.fetchCompanySettings();
    this.fetchBreakStatus();
  }

  switchTab(tab: 'overview' | 'leads' | 'followups' | 'interested' | 'dnp' | 'converted' | 'hearted'): void {
    this.dashTab = tab;
    this.selectedLeadCompany = '';
    if (tab === 'overview') {
      this.fetchStats();
      this.fetchTimeline();
      setTimeout(() => {
        this.renderDonutChart();
        this.renderTimelineChart();
      }, 150);
    }
  }

  // ── Company Settings (lead statuses, break limit) ──
  fetchCompanySettings(): void {
    if (!this.employee) return;
    this.api.get<any>(`/api/auth/company/${this.employee.companyCode}/settings`).subscribe({
      next: res => {
        if (res.success && res.settings) {
          if (res.settings.leadStatuses?.length) {
            this.LEAD_STATUSES = res.settings.leadStatuses;
          }
          this.INTERESTED_PAGE_STATUSES = res.settings.interestedPageStatuses ?? ['Interested', 'Follow Up'];
          this.DNP_PAGE_STATUSES = res.settings.dnpPageStatuses ?? ['Not Interested'];
          this.breakHourLimitMin = res.settings.breakHourLimit ?? 60;
        }
      },
      error: () => {}
    });
  }

  // ── Break Button Logic ──
  fetchBreakStatus(): void {
    if (!this.employee) return;
    this.api.get<any>(`/api/breaklog/employee-today?companyCode=${this.employee.companyCode}&employeePhone=${this.employee.mobile}`).subscribe({
      next: res => {
        if (res.success) {
          this.breakTotalSecondsToday = res.totalSeconds ?? 0;
          this.breakHourLimitMin = Math.floor((res.limitSeconds ?? 3600) / 60);
        }
      },
      error: () => {}
    });
  }

  markBreak(): void {
    if (this.breakActive) {
      // Stop timer — compute how many seconds elapsed
      clearInterval(this.breakTimerRef);
      const elapsedMs = Date.now() - this.breakStartedAt;
      const elapsedSec = Math.max(1, Math.floor(elapsedMs / 1000));
      this.breakActive = false;
      this.breakTimerDisplay = '00:00';
      this.breakPosting = true;
      localStorage.removeItem('dv_break_state');

      // Post to backend
      this.api.post<any>('/api/breaklog/mark', {
        companyCode: this.employee!.companyCode,
        employeePhone: this.employee!.mobile,
        employeeName: this.employee!.name,
        durationSeconds: elapsedSec,
      }).subscribe({
        next: res => {
          this.breakPosting = false;
          if (res.success) {
            this.breakTotalSecondsToday = res.totalSeconds;
          }
        },
        error: () => { this.breakPosting = false; }
      });
    } else {
      // Start timer
      this.breakActive = true;
      this.breakStartedAt = Date.now();
      localStorage.setItem('dv_break_state', JSON.stringify({ startedAt: this.breakStartedAt }));
      this.startBreakTimerLoop();
    }
  }

  resumeBreakTimer(): void {
    const rawBreak = localStorage.getItem('dv_break_state');
    if (rawBreak) {
      try {
        const data = JSON.parse(rawBreak);
        if (data.startedAt) {
          this.breakActive = true;
          this.breakStartedAt = data.startedAt;
          this.startBreakTimerLoop();
        }
      } catch { localStorage.removeItem('dv_break_state'); }
    }
  }

  startBreakTimerLoop(): void {
    // Initial display update
    const sec = Math.floor((Date.now() - this.breakStartedAt) / 1000);
    this.breakTimerDisplay = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    
    this.breakTimerRef = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - this.breakStartedAt) / 1000);
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      this.breakTimerDisplay = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, 1000);
  }

  fmtSecs(totalSecs: number): string {
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
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
    this.api.get<any>(
      `/api/calllogs/employee?companyCode=${companyCode}&phone=${mobile}&period=${this.selectedPeriod}`
    ).subscribe({
      next: res => {
        this.statsLoading = false;
        if (res.success) {
          this.callStats = res.stats;
          if (this.dashTab === 'overview') {
            setTimeout(() => this.renderDonutChart(), 100);
          }
        }
      },
      error: () => { this.statsLoading = false; }
    });
    this.fetchTimeline();
  }

  fetchTimeline(): void {
    if (!this.employee) return;
    const { companyCode, mobile } = this.employee;
    this.api.get<any>(
      `/api/calllogs/timeline?companyCode=${companyCode}&phone=${mobile}&period=${this.selectedPeriod}`
    ).subscribe({
      next: res => {
        if (res.success) {
          this.timelineData = res.timeline;
          if (this.dashTab === 'overview') {
            setTimeout(() => this.renderTimelineChart(), 150);
          }
        }
      }
    });
  }

  setChartType(type: 'line' | 'bar'): void {
    this.chartType = type;
    setTimeout(() => this.renderTimelineChart(), 50);
  }

  renderTimelineChart(): void {
    if (this.timelineChart) { this.timelineChart.destroy(); this.timelineChart = null; }
    const canvas = document.getElementById('timelineChart') as HTMLCanvasElement;
    if (!canvas) return;

    const textColor = 'rgba(80,80,100,0.6)';
    const gridColor = 'rgba(0,0,0,0.04)';
    const ctx = canvas.getContext('2d');

    let chartType: any = this.chartType;
    let data: any;
    let options: any;

    if (this.chartType === 'line') {
      // Timeline Trend
      if (!this.timelineData.length) return;
      
      const filtered = this.timelineData.filter(d => 
        ((d.incoming || 0) + (d.outgoing || 0) + (d.missed || 0) + (d.rejected || 0)) > 0
      );
      
      if (!filtered.length) return;

      const isHourly = filtered.length > 0 && filtered[0]._isHourly;
      const labels = filtered.map(d => {
        let dt: Date;
        if (d.date.includes('T')) {
          // It's hourly data from backend, which is in UTC.
          // Appending 'Z' ensures the browser converts it to the user's local time correctly.
          dt = new Date(d.date + 'Z');
        } else {
          // It's daily data: 2026-04-28. Use local parsing.
          dt = new Date(d.date.replace(/-/g, '/'));
        }

        if (isHourly) {
          const h = dt.getHours();
          const ampm = h >= 12 ? 'PM' : 'AM';
          const displayH = h % 12 || 12;
          return `${String(displayH).padStart(2, '0')} ${ampm}`;
        }
        return dt.toLocaleDateString('en-US', { weekday: 'short' });
      });
      const totalCalls = filtered.map(d =>
        (d.incoming || 0) + (d.outgoing || 0) + (d.missed || 0) + (d.rejected || 0)
      );

      const grad = ctx ? ctx.createLinearGradient(0, 0, 0, 300) : null;
      if (grad) {
        grad.addColorStop(0, 'rgba(61,125,254,0.2)');
        grad.addColorStop(1, 'rgba(61,125,254,0)');
      }

      data = {
        labels: labels,
        datasets: [{
          label: 'Total Calls',
          data: totalCalls,
          borderColor: '#3D7DFE',
          backgroundColor: grad ?? 'rgba(61,125,254,0.1)',
          fill: true,
          tension: 0.4,
          borderWidth: 3,
          pointRadius: 4,
          pointBackgroundColor: '#fff',
          pointBorderColor: '#3D7DFE',
          pointBorderWidth: 2
        }]
      };
      options = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: '#1e293b', padding: 12, cornerRadius: 8 }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: textColor } },
          y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor } }
        }
      };

    } else {
      // Category Breakdown (Bar)
      if (!this.callStats) return;
      const counts = [
        this.callStats.incoming || 0,
        this.callStats.outgoing || 0,
        this.callStats.missed || 0,
        this.callStats.rejected || 0
      ];
      const labels = ['Incoming', 'Outgoing', 'Missed', 'Rejected'];
      const colors = ['#3b82f6', '#22c55e', '#f87171', '#f59e0b'];

      data = {
        labels: labels,
        datasets: [{
          label: 'Call Count',
          data: counts,
          backgroundColor: colors,
          borderColor: 'transparent',
          borderWidth: 0,
          borderRadius: 8,
          barPercentage: 0.6
        }]
      };

      options = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: '#1e293b', padding: 12, cornerRadius: 8 }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: textColor } },
          y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor, stepSize: 1 } }
        }
      };
    }

    this.timelineChart = new Chart(canvas, { type: chartType, data, options });
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
          legend: { display: false },
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
    // We always fetch ALL leads to ensure Interested/Not Connected pages have full data
    this.api.get<any>(`/api/leads/employee?companyCode=${companyCode}&phone=${mobile}`)
      .subscribe({
        next: res => {
          this.leadsLoading = false;
          if (res.success) {
            this.allLeads = (res.leads || []).map((l: any) => this.normalizeLead(l));
            this.leadSets = res.sets || [];
          }
        },
        error: () => { this.leadsLoading = false; }
      });
  }

  fetchLeadSets(): void {
    if (!this.employee) return;
    this.api.get<any>(`/api/leads/employee/sets?companyCode=${this.employee.companyCode}&phone=${this.employee.mobile}`).subscribe({
      next: res => {
        if (res.success) {
          this.leadSets = res.sets || [];
        }
      },
      error: () => {}
    });
  }

  onLeadSetChange(set: string): void {
    this.selectedLeadSet = set;
    // No need to re-fetch, local getter filteredLeads handles it
  }

  updateLeadStatus(lead: Lead, newStatus: string): void {
    this.updatingLeadId = lead._id;
    this.api.patch<any>(`/api/leads/${lead._id}/status`, { status: newStatus })
      .subscribe({
        next: res => {
          this.updatingLeadId = '';
          if (res.success) lead.status = newStatus;
        },
        error: () => { this.updatingLeadId = ''; }
      });
  }

  updateAllDirectorsStatus(newStatus: string): void {
    if (!this.selectedLeadCompany || !newStatus) return;
    if (!confirm(`Are you sure you want to change the status of ALL directors in ${this.selectedLeadCompany} to ${newStatus}?`)) return;

    const leadsToUpdate = this.leadsInSelectedCompany;
    leadsToUpdate.forEach(l => {
      this.api.patch<any>(`/api/leads/${l._id}/status`, { status: newStatus }).subscribe({
        next: res => {
          if (res.success) l.status = newStatus;
        }
      });
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
    const { companyCode, phone } = { companyCode: this.employee.companyCode, phone: this.employee.mobile };
    this.api.get<any>(`/api/bookmarks?companyCode=${companyCode}&phone=${phone}`)
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

  get totalLeadsCount(): number { return this.leads.length; }
  get convertedLeadsCount(): number { return this.leads.filter(l => l.status === 'Converted').length; }
  get pendingLeadsCount(): number { return this.leads.filter(l => l.status === 'New' || l.status === 'Contacted').length; }
}
