/* ============================================================
   SCHOOL MANAGEMENT SYSTEM 2.0 — Application Logic
   Preserves all existing functionality + adds:
   - Global search
   - Real dashboard stats
   - Custom confirmation dialogs
   - Table pagination + filtering
   - Mobile sidebar drawer
   - Chart.js with real data
   - Animated number counters
   - Enhanced loading/empty states
   - Keyboard shortcuts
   ============================================================ */

const API_URL = '/api';

const app = {
    token: localStorage.getItem('school_token'),
    
    // Data caches for search/filter
    _students: [],
    _teachers: [],
    _classes: [],
    _attendance: [],
    
    // Pagination state
    _pagination: {
        students: { page: 1, perPage: 10 },
        teachers: { page: 1, perPage: 10 },
        classes:  { page: 1, perPage: 10 },
        users:    { page: 1, perPage: 10 },
    },

    // Confirmation callback
    _confirmCallback: null,

    // Charts
    attendanceChart: null,
    genderChart: null,

    // Submitting flags to prevent double-submit
    _submitting: {},

    /* =========================================================
       INITIALIZATION
       ========================================================= */
    init() {
        this.cacheDOM();
        this.bindEvents();
        this.checkAuth();
    },

    cacheDOM() {
        this.loginSection = document.getElementById('login-section');
        this.appSection = document.getElementById('app-section');
        this.emailForm = document.getElementById('email-form');
        this.otpForm = document.getElementById('otp-form');
        this.otpBoxes = document.querySelectorAll('.otp-box');
        this.resendBtn = document.getElementById('resend-code-btn');
        this.logoutBtn = document.getElementById('logout-btn');
        this.navItems = document.querySelectorAll('.nav-item');
        this.viewSections = document.querySelectorAll('.view-content');
        this.notification = document.getElementById('notification');
        this.notificationMsg = document.getElementById('notification-message');
        this.notificationIcon = document.getElementById('notification-icon');

        // Modal forms
        this.studentForm = document.getElementById('student-form');
        this.teacherForm = document.getElementById('teacher-form');
        this.classForm = document.getElementById('class-form');
        this.userForm = document.getElementById('user-form');
        this.resetPasswordForm = document.getElementById('reset-password-form');

        // Attendance Date
        this.attendanceDate = document.getElementById('attendance-date');
        if (this.attendanceDate) {
            this.attendanceDate.valueAsDate = new Date();
        }

        // Layout
        this.themeToggleBtn = document.getElementById('theme-toggle-btn');
        this.sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
        this.sidebar = document.getElementById('sidebar');
        this.sidebarOverlay = document.getElementById('sidebar-overlay');
        this.mobileMenuBtn = document.getElementById('mobile-menu-btn');
        this.breadcrumbCurrent = document.getElementById('breadcrumb-current');
        this.chartCtx = document.getElementById('attendanceChart');
        this.genderChartCtx = document.getElementById('genderChart');
        this.bellBadge = document.getElementById('bell-badge');
        this.globalSearchInput = document.getElementById('global-search-input');
        this.searchResults = document.getElementById('search-results');

        // Set initial theme icon
        if (this.themeToggleBtn) {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            this.themeToggleBtn.innerHTML = currentTheme === 'dark'
                ? '<i class="fa-solid fa-moon"></i>'
                : '<i class="fa-solid fa-sun"></i>';
        }
    },

    bindEvents() {
        // Auth forms
        this.emailForm.addEventListener('submit', this.sendOTP.bind(this));
        this.otpForm.addEventListener('submit', this.verifyOTP.bind(this));
        if (this.resendBtn) {
            this.resendBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.sendOTP(e);
            });
        }

        // OTP UX
        this.otpBoxes.forEach((box, index) => {
            box.addEventListener('input', (e) => {
                const val = e.target.value;
                if (!/^[0-9]$/.test(val)) { e.target.value = ''; return; }
                if (val.length === 1 && index < this.otpBoxes.length - 1) {
                    this.otpBoxes[index + 1].focus();
                }
            });
            box.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !e.target.value && index > 0) {
                    this.otpBoxes[index - 1].focus();
                }
            });
            box.addEventListener('paste', (e) => {
                e.preventDefault();
                const pasteData = e.clipboardData.getData('text').slice(0, 6).replace(/[^0-9]/g, '');
                pasteData.split('').forEach((char, i) => {
                    if (this.otpBoxes[index + i]) {
                        this.otpBoxes[index + i].value = char;
                        if (index + i < 5) this.otpBoxes[index + i + 1].focus();
                    }
                });
            });
        });

        // Logout
        this.logoutBtn.addEventListener('click', this.logout.bind(this));

        // Navigation
        this.navItems.forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigate(e.currentTarget);
            });
        });

        // Form submissions
        this.studentForm.addEventListener('submit', this.saveStudent.bind(this));
        this.teacherForm.addEventListener('submit', this.saveTeacher.bind(this));
        this.classForm.addEventListener('submit', this.saveClass.bind(this));

        // Academic Foundation forms (P2 #1)
        const ayForm = document.getElementById('academic-year-form');
        if (ayForm) ayForm.addEventListener('submit', this.saveAcademicYear.bind(this));
        const termForm = document.getElementById('term-form');
        if (termForm) termForm.addEventListener('submit', this.saveTerm.bind(this));
        const subjectForm = document.getElementById('subject-form');
        if (subjectForm) subjectForm.addEventListener('submit', this.saveSubject.bind(this));
        const csForm = document.getElementById('class-subject-form');
        if (csForm) csForm.addEventListener('submit', this.saveClassSubject.bind(this));
        const examForm = document.getElementById('exam-form');
        if (examForm) examForm.addEventListener('submit', this.saveExam.bind(this));
        const markForm = document.getElementById('mark-form');
        if (markForm) markForm.addEventListener('submit', this.saveMark.bind(this));
        if (this.userForm) this.userForm.addEventListener('submit', this.saveUser.bind(this));
        if (this.resetPasswordForm) this.resetPasswordForm.addEventListener('submit', this.submitPasswordReset.bind(this));

        // Update exam total display when exam selection changes in mark modal
        const markExamSel = document.getElementById('mark-exam');
        if (markExamSel) markExamSel.addEventListener('change', this.onMarkExamChange.bind(this));

        // Theme toggle
        if (this.themeToggleBtn) {
            this.themeToggleBtn.addEventListener('click', this.toggleTheme.bind(this));
        }

        // Sidebar collapse (desktop)
        if (this.sidebarToggleBtn) {
            this.sidebarToggleBtn.addEventListener('click', () => {
                this.sidebar.classList.toggle('collapsed');
                localStorage.setItem('sidebar_collapsed', this.sidebar.classList.contains('collapsed'));
            });
            // Restore collapsed state
            if (localStorage.getItem('sidebar_collapsed') === 'true') {
                this.sidebar.classList.add('collapsed');
            }
        }

        // Mobile menu
        if (this.mobileMenuBtn) {
            this.mobileMenuBtn.addEventListener('click', () => this.openMobileSidebar());
        }
        if (this.sidebarOverlay) {
            this.sidebarOverlay.addEventListener('click', () => this.closeMobileSidebar());
        }

        // Global search
        if (this.globalSearchInput) {
            this.globalSearchInput.addEventListener('input', this.debounce(this.handleGlobalSearch.bind(this), 300));
            this.globalSearchInput.addEventListener('focus', () => {
                if (this.globalSearchInput.value.trim()) this.handleGlobalSearch();
            });
            document.addEventListener('click', (e) => {
                if (!e.target.closest('#global-search-container')) {
                    this.searchResults.classList.remove('active');
                }
            });
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Escape to close modals
            if (e.key === 'Escape') {
                const openModal = document.querySelector('.modal:not(.hidden)');
                if (openModal) {
                    const modalId = openModal.id;
                    if (modalId === 'confirm-modal') {
                        this.cancelConfirm();
                    } else {
                        this.closeModal(modalId);
                    }
                }
                this.searchResults.classList.remove('active');
            }
            // "/" to focus search
            if (e.key === '/' && !e.target.closest('input, textarea, select')) {
                e.preventDefault();
                this.globalSearchInput?.focus();
            }
        });

        // Close modals on backdrop click
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    if (modal.id === 'confirm-modal') {
                        this.cancelConfirm();
                    } else {
                        this.closeModal(modal.id);
                    }
                }
            });
        });
    },

    /* =========================================================
       AUTH
       ========================================================= */
    checkAuth() {
        if (this.token) {
            this.loginSection.classList.add('hidden');
            this.appSection.classList.remove('hidden');
            this.loadDashboard();
        } else {
            this.loginSection.classList.remove('hidden');
            this.appSection.classList.add('hidden');
        }
    },

    async sendOTP(e) {
        if (e && e.preventDefault) e.preventDefault();
        const email = document.getElementById('email').value;
        if (!email) { this.showNotification('Email is required', true); return; }

        const btn = document.getElementById('send-otp-btn');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';

        try {
            const res = await fetch(`${API_URL}/send-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const data = await res.json();
            if (res.ok) {
                this.showNotification('Verification code sent');
                this.emailForm.classList.add('hidden');
                this.otpForm.classList.remove('hidden');
                document.getElementById('display-email').innerText = email;
                this.otpBoxes[0].focus();
            } else {
                this.showNotification(data.message || 'Failed to send OTP', true);
            }
        } catch (err) {
            this.showNotification('Server connection error', true);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    },

    async verifyOTP(e) {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const otp = Array.from(this.otpBoxes).map(b => b.value).join('');
        if (otp.length !== 6) { this.showNotification('Enter a 6-digit code', true); return; }

        const btn = document.getElementById('verify-otp-btn');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';

        try {
            const res = await fetch(`${API_URL}/verify-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, otp })
            });
            const data = await res.json();
            if (res.ok) {
                this.token = data.token;
                localStorage.setItem('school_token', data.token);
                this.showNotification('Login successful!');
                this.checkAuth();
                this.emailForm.classList.remove('hidden');
                this.otpForm.classList.add('hidden');
                this.otpBoxes.forEach(b => b.value = '');
                document.getElementById('email').value = '';
            } else {
                this.showNotification(data.message || 'Verification failed', true);
            }
        } catch (err) {
            this.showNotification('Server connection error', true);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    },

    logout() {
        this.token = null;
        localStorage.removeItem('school_token');
        this._students = [];
        this._teachers = [];
        this._classes = [];
        this.checkAuth();
    },

    /* =========================================================
       NAVIGATION
       ========================================================= */
    navigate(navElement) {
        this.navItems.forEach(i => i.classList.remove('active'));
        navElement.classList.add('active');

        const targetId = navElement.getAttribute('data-target');
        this.viewSections.forEach(s => {
            s.classList.add('hidden');
            s.classList.remove('active');
        });
        const target = document.getElementById(targetId);
        target.classList.remove('hidden');
        target.classList.add('active');

        // Update breadcrumb
        const pageName = navElement.querySelector('span')?.textContent || 'Dashboard';
        if (this.breadcrumbCurrent) {
            this.breadcrumbCurrent.textContent = pageName;
        }

        // Load data
        if (targetId === 'dashboard-view') this.loadDashboard();
        else if (targetId === 'students-view') this.loadStudents();
        else if (targetId === 'teachers-view') this.loadTeachers();
        else if (targetId === 'classes-view') this.loadClasses();
        else if (targetId === 'attendance-view') this.loadAttendance();
        else if (targetId === 'academic-years-view') this.loadAcademicYears();
        else if (targetId === 'terms-view') { this.populateTermsYearFilter().then(() => this.loadTerms()); }
        else if (targetId === 'subjects-view') this.loadSubjects();
        else if (targetId === 'class-subjects-view') { this.populateCSFilters().then(() => this.loadClassSubjects()); }
        else if (targetId === 'exams-view') { this.populateExamFilters().then(() => this.loadExams()); }
        else if (targetId === 'marks-view') { this.populateMarkFilters().then(() => this.loadMarks()); }
        else if (targetId === 'results-view') { this.populateResultFilters().then(() => this.loadResults()); }
        else if (targetId === 'reports-view') { this.populateReportFilters().then(() => this.onReportTypeChange()); }
        else if (targetId === 'users-view') { this.loadUsers(); }
        else if (targetId === 'settings-view') { this.loadSettings(); }
        else if (targetId === 'timetable-view') { this.populateTimetableFilters().then(() => this.loadTimetable()); }
        else if (targetId === 'notices-view') { this.loadNotices(); }

        // Close mobile sidebar
        this.closeMobileSidebar();
    },

    navigateTo(viewId) {
        const navEl = document.querySelector(`.nav-item[data-target="${viewId}"]`);
        if (navEl) this.navigate(navEl);
    },

    /* =========================================================
       MOBILE SIDEBAR
       ========================================================= */
    openMobileSidebar() {
        this.sidebar.classList.add('mobile-open');
        this.sidebarOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    },
    closeMobileSidebar() {
        this.sidebar.classList.remove('mobile-open');
        this.sidebarOverlay.classList.remove('active');
        document.body.style.overflow = '';
    },

    /* =========================================================
       THEME
       ========================================================= */
    toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('school_theme', newTheme);

        if (this.themeToggleBtn) {
            this.themeToggleBtn.innerHTML = newTheme === 'dark'
                ? '<i class="fa-solid fa-moon"></i>'
                : '<i class="fa-solid fa-sun"></i>';
        }
        this.initCharts();
    },

    /* =========================================================
       API HELPER
       ========================================================= */
    async apiCall(endpoint, method = 'GET', body = null) {
        const headers = {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
        };
        const config = { method, headers };
        if (body) config.body = JSON.stringify(body);

        try {
            const res = await fetch(`${API_URL}${endpoint}`, config);
            // Only 401 (invalid/expired token) triggers logout.
            // 403 (Forbidden role) must NOT log the user out — it is a RBAC rejection, not an auth failure.
            if (res.status === 401) {
                this.logout();
                throw new Error('Session expired — please log in again');
            }
            const data = await res.json();
            // Attach the HTTP status to the response so callers can inspect it
            if (data && typeof data === 'object') data._status = res.status;
            return data;
        } catch (err) {
            console.error('API Error:', err);
            return null;
        }
    },

    /* =========================================================
       DASHBOARD
       ========================================================= */
    async loadDashboard() {
        // Show skeletons
        ['stat-students', 'stat-teachers', 'stat-classes', 'stat-attendance'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<div class="skeleton skeleton-text" style="width:60px;height:32px"></div>';
        });

        // Fetch data from the enhanced stats endpoint first, fallback to basic
        let data = await this.apiCall('/dashboard/stats');
        if (!data) {
            data = await this.apiCall('/dashboard');
        }

        if (data) {
            this.animateNumber('stat-students', data.students || 0);
            this.animateNumber('stat-teachers', data.teachers || 0);
            this.animateNumber('stat-classes', data.classes || 0);

            // Attendance percentage
            if (data.attendancePercent !== undefined) {
                this.animateNumber('stat-attendance', data.attendancePercent, '%');
                const attChange = document.getElementById('stat-attendance-change');
                if (attChange) {
                    const pct = data.attendancePercent;
                    attChange.className = `stat-change ${pct >= 90 ? 'positive' : pct >= 70 ? 'neutral' : 'negative'}`;
                    attChange.innerHTML = `<i class="fa-solid fa-${pct >= 90 ? 'arrow-up' : pct >= 70 ? 'minus' : 'arrow-down'}"></i> ${pct >= 90 ? 'Good' : pct >= 70 ? 'Average' : 'Low'}`;
                }
            } else {
                document.getElementById('stat-attendance').textContent = '—';
            }

            // Gender distribution for chart
            if (data.genderDistribution) {
                this.initGenderChart(data.genderDistribution);
            }


            // Hide bell badge if no pending items
            if (this.bellBadge) {
                this.bellBadge.style.display = (data.students > 0 || data.teachers > 0) ? 'block' : 'none';
            }
        } else {
            ['stat-students', 'stat-teachers', 'stat-classes', 'stat-attendance'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = '0';
            });
        }

        this.initCharts();
        this.loadDashboardNotices();
    },

    animateNumber(elementId, target, suffix = '') {
        const el = document.getElementById(elementId);
        if (!el) return;
        const duration = 600;
        const start = performance.now();
        const initial = 0;

        const update = (now) => {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.round(initial + (target - initial) * eased);
            el.textContent = current.toLocaleString() + suffix;
            if (progress < 1) requestAnimationFrame(update);
        };
        requestAnimationFrame(update);
    },

    /* =========================================================
       CHARTS
       ========================================================= */
    initCharts() {
        this.initAttendanceChart();
    },

    initAttendanceChart() {
        if (!this.chartCtx) return;
        if (this.attendanceChart) this.attendanceChart.destroy();

        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const textColor = isDark ? '#8a8a8a' : '#6b6b6b';
        const gridColor = isDark ? '#262626' : '#e5e5e5';
        const lineColor = isDark ? '#d4d4d4' : '#333333';

        // Try to load real data
        this.apiCall('/dashboard/attendance-chart').then(chartData => {
            if (this.attendanceChart) this.attendanceChart.destroy();

            let labels, data;
            if (chartData && chartData.labels && chartData.data) {
                labels = chartData.labels;
                data = chartData.data;
            } else {
                // Fallback to days of the week with no data
                labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
                data = [0, 0, 0, 0, 0];
            }

            this.attendanceChart = new Chart(this.chartCtx, {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Attendance %',
                        data: data,
                        borderColor: lineColor,
                        backgroundColor: isDark ? 'rgba(212, 212, 212, 0.05)' : 'rgba(51, 51, 51, 0.05)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointBackgroundColor: lineColor,
                        pointBorderColor: lineColor,
                        pointRadius: 4,
                        pointHoverRadius: 6,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: isDark ? '#262626' : '#ffffff',
                            titleColor: isDark ? '#f5f5f5' : '#1a1a1a',
                            bodyColor: isDark ? '#d4d4d4' : '#333333',
                            borderColor: isDark ? '#333333' : '#e5e5e5',
                            borderWidth: 1,
                            cornerRadius: 8,
                            padding: 12,
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100,
                            grid: { color: gridColor, drawBorder: false },
                            ticks: { color: textColor, font: { size: 11 } },
                            border: { display: false },
                        },
                        x: {
                            grid: { display: false },
                            ticks: { color: textColor, font: { size: 11 } },
                            border: { display: false },
                        }
                    }
                }
            });
        });
    },

    initGenderChart(genderData) {
        if (!this.genderChartCtx) return;
        if (this.genderChart) this.genderChart.destroy();

        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const textColor = isDark ? '#8a8a8a' : '#6b6b6b';

        this.genderChart = new Chart(this.genderChartCtx, {
            type: 'doughnut',
            data: {
                labels: ['Male', 'Female'],
                datasets: [{
                    data: [genderData.male || 0, genderData.female || 0],
                    backgroundColor: isDark
                        ? ['#d4d4d4', '#6b6b6b']
                        : ['#333333', '#a3a3a3'],
                    borderWidth: 0,
                    spacing: 2,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: textColor,
                            padding: 20,
                            font: { size: 12 },
                            usePointStyle: true,
                            pointStyleWidth: 10,
                        }
                    },
                    tooltip: {
                        backgroundColor: isDark ? '#262626' : '#ffffff',
                        titleColor: isDark ? '#f5f5f5' : '#1a1a1a',
                        bodyColor: isDark ? '#d4d4d4' : '#333333',
                        borderColor: isDark ? '#333333' : '#e5e5e5',
                        borderWidth: 1,
                        cornerRadius: 8,
                        padding: 12,
                    }
                }
            }
        });
    },


    /* =========================================================
       STUDENTS
       ========================================================= */
    async loadStudents() {
        const tbody = document.querySelector('#students-table tbody');
        tbody.innerHTML = Array(5).fill('<tr>' + Array(6).fill('<td><div class="skeleton skeleton-row"></div></td>').join('') + '</tr>').join('');

        const students = await this.apiCall('/students');
        this._students = students || [];

        // Populate class filter
        const classFilter = document.getElementById('students-filter-class');
        if (classFilter) {
            const classes = [...new Set(this._students.map(s => s.class_name).filter(Boolean))].sort();
            classFilter.innerHTML = '<option value="">All Classes</option>' +
                classes.map(c => `<option value="${c}">${c}</option>`).join('');
        }

        this._pagination.students.page = 1;
        this.renderStudents();
    },

    renderStudents() {
        const tbody = document.querySelector('#students-table tbody');
        const search = (document.getElementById('students-search')?.value || '').toLowerCase();
        const classFilter = document.getElementById('students-filter-class')?.value || '';
        const genderFilter = document.getElementById('students-filter-gender')?.value || '';

        let filtered = this._students.filter(s => {
            const matchSearch = !search ||
                s.full_name?.toLowerCase().includes(search) ||
                s.id_number?.toLowerCase().includes(search) ||
                s.class_name?.toLowerCase().includes(search) ||
                s.contact?.toLowerCase().includes(search);
            const matchClass = !classFilter || s.class_name === classFilter;
            const matchGender = !genderFilter || s.gender === genderFilter;
            return matchSearch && matchClass && matchGender;
        });

        // Update count
        const countEl = document.getElementById('students-count');
        if (countEl) countEl.textContent = `${filtered.length} student${filtered.length !== 1 ? 's' : ''}`;

        // Paginate
        const pag = this._pagination.students;
        const totalPages = Math.max(1, Math.ceil(filtered.length / pag.perPage));
        if (pag.page > totalPages) pag.page = totalPages;
        const start = (pag.page - 1) * pag.perPage;
        const pageData = filtered.slice(start, start + pag.perPage);

        tbody.innerHTML = '';
        if (pageData.length > 0) {
            pageData.forEach(student => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><span class="badge badge-neutral">${this.escapeHtml(student.id_number)}</span></td>
                    <td>${this.escapeHtml(student.full_name)}</td>
                    <td>${this.escapeHtml(student.class_name || 'Unassigned')}</td>
                    <td>${this.escapeHtml(student.gender)}</td>
                    <td>${this.escapeHtml(student.contact)}</td>
                    <td>
                        <button class="btn-icon btn-action" onclick='app.editStudent(${JSON.stringify(student).replace(/'/g, "&#39;")})' title="Edit" aria-label="Edit student">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="btn-icon btn-action" onclick="app.confirmDelete('student', '${student.id}', '${this.escapeHtml(student.full_name)}')" title="Delete" aria-label="Delete student" style="color: var(--danger);">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } else {
            tbody.innerHTML = `<tr><td colspan="6">
                <div class="empty-state" style="padding: var(--space-10) var(--space-6);">
                    <div class="empty-state-icon"><i class="fa-solid fa-user-graduate"></i></div>
                    <h3>No students found</h3>
                    <p>Try adjusting your search or filters, or add a new student.</p>
                    <button class="btn-primary btn-sm" onclick="app.showModal('student-modal')"><i class="fa-solid fa-plus"></i> Add Student</button>
                </div>
            </td></tr>`;
        }

        this.renderPagination('students', filtered.length, totalPages);
    },

    async loadClassOptionsForStudent() {
        const classes = await this.apiCall('/classes');
        const select = document.getElementById('student-class');
        select.innerHTML = '<option value="">Select a Class</option>';
        if (classes) {
            classes.forEach(c => {
                const option = document.createElement('option');
                option.value = c.name;
                option.innerText = c.name;
                select.appendChild(option);
            });
        }
    },

    async saveStudent(e) {
        e.preventDefault();
        if (this._submitting.student) return;
        this._submitting.student = true;

        const btn = document.getElementById('student-submit-btn');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        const id = document.getElementById('student-id').value;
        const student = {
            id_number: document.getElementById('student-id-num').value,
            full_name: document.getElementById('student-name').value,
            class_name: document.getElementById('student-class').value,
            gender: document.getElementById('student-gender').value,
            contact: document.getElementById('student-contact').value
        };

        let res;
        if (id) {
            res = await this.apiCall(`/students/${id}`, 'PUT', student);
        } else {
            res = await this.apiCall('/students', 'POST', student);
        }

        if (res && !res.error) {
            this.showNotification(`Student ${id ? 'updated' : 'added'} successfully`);
            this.closeModal('student-modal');
            this.loadStudents();
        } else {
            this.showNotification(res?.error || 'Failed to save student', true);
        }

        btn.disabled = false;
        btn.innerHTML = originalText;
        this._submitting.student = false;
    },

    editStudent(student) {
        this.loadClassOptionsForStudent();
        document.getElementById('student-modal-title').innerText = 'Edit Student';
        document.getElementById('student-id').value = student.id;
        document.getElementById('student-id-num').value = student.id_number;
        document.getElementById('student-name').value = student.full_name;
        document.getElementById('student-gender').value = student.gender;
        document.getElementById('student-contact').value = student.contact;
        setTimeout(() => {
            document.getElementById('student-class').value = student.class_name;
        }, 100);
        this.showModal('student-modal', true);
    },

    async deleteStudent(id) {
        const res = await this.apiCall(`/students/${id}`, 'DELETE');
        if (res && res.deleted) {
            this.showNotification('Student deleted');
            this.loadStudents();
        }
    },

    /* =========================================================
       TEACHERS
       ========================================================= */
    async loadTeachers() {
        const tbody = document.querySelector('#teachers-table tbody');
        tbody.innerHTML = Array(5).fill('<tr>' + Array(4).fill('<td><div class="skeleton skeleton-row"></div></td>').join('') + '</tr>').join('');

        const teachers = await this.apiCall('/teachers');
        this._teachers = teachers || [];

        // Populate subject filter
        const subjectFilter = document.getElementById('teachers-filter-subject');
        if (subjectFilter) {
            const subjects = [...new Set(this._teachers.map(t => t.subject).filter(Boolean))].sort();
            subjectFilter.innerHTML = '<option value="">All Subjects</option>' +
                subjects.map(s => `<option value="${s}">${s}</option>`).join('');
        }

        this._pagination.teachers.page = 1;
        this.renderTeachers();
    },

    renderTeachers() {
        const tbody = document.querySelector('#teachers-table tbody');
        const search = (document.getElementById('teachers-search')?.value || '').toLowerCase();
        const subjectFilter = document.getElementById('teachers-filter-subject')?.value || '';

        let filtered = this._teachers.filter(t => {
            const matchSearch = !search ||
                t.name?.toLowerCase().includes(search) ||
                t.subject?.toLowerCase().includes(search) ||
                t.phone?.toLowerCase().includes(search);
            const matchSubject = !subjectFilter || t.subject === subjectFilter;
            return matchSearch && matchSubject;
        });

        const countEl = document.getElementById('teachers-count');
        if (countEl) countEl.textContent = `${filtered.length} teacher${filtered.length !== 1 ? 's' : ''}`;

        const pag = this._pagination.teachers;
        const totalPages = Math.max(1, Math.ceil(filtered.length / pag.perPage));
        if (pag.page > totalPages) pag.page = totalPages;
        const start = (pag.page - 1) * pag.perPage;
        const pageData = filtered.slice(start, start + pag.perPage);

        tbody.innerHTML = '';
        if (pageData.length > 0) {
            pageData.forEach(teacher => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${this.escapeHtml(teacher.name)}</td>
                    <td><span class="badge badge-neutral">${this.escapeHtml(teacher.subject)}</span></td>
                    <td>${this.escapeHtml(teacher.phone)}</td>
                    <td>
                        <button class="btn-icon btn-action" onclick='app.editTeacher(${JSON.stringify(teacher).replace(/'/g, "&#39;")})' title="Edit" aria-label="Edit teacher">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="btn-icon btn-action" onclick="app.confirmDelete('teacher', '${teacher.id}', '${this.escapeHtml(teacher.name)}')" title="Delete" aria-label="Delete teacher" style="color: var(--danger);">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } else {
            tbody.innerHTML = `<tr><td colspan="4">
                <div class="empty-state" style="padding: var(--space-10) var(--space-6);">
                    <div class="empty-state-icon"><i class="fa-solid fa-chalkboard-user"></i></div>
                    <h3>No teachers found</h3>
                    <p>Try adjusting your search or filters, or add a new teacher.</p>
                    <button class="btn-primary btn-sm" onclick="app.showModal('teacher-modal')"><i class="fa-solid fa-plus"></i> Add Teacher</button>
                </div>
            </td></tr>`;
        }

        this.renderPagination('teachers', filtered.length, totalPages);
    },

    async saveTeacher(e) {
        e.preventDefault();
        if (this._submitting.teacher) return;
        this._submitting.teacher = true;

        const btn = document.getElementById('teacher-submit-btn');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        const id = document.getElementById('teacher-id').value;
        const teacher = {
            name: document.getElementById('teacher-name').value,
            subject: document.getElementById('teacher-subject').value,
            phone: document.getElementById('teacher-phone').value
        };

        let res;
        if (id) {
            res = await this.apiCall(`/teachers/${id}`, 'PUT', teacher);
        } else {
            res = await this.apiCall('/teachers', 'POST', teacher);
        }

        if (res && !res.error) {
            this.showNotification(`Teacher ${id ? 'updated' : 'added'} successfully`);
            this.closeModal('teacher-modal');
            this.loadTeachers();
        } else {
            this.showNotification(res?.error || 'Failed to save teacher', true);
        }

        btn.disabled = false;
        btn.innerHTML = originalText;
        this._submitting.teacher = false;
    },

    editTeacher(teacher) {
        document.getElementById('teacher-modal-title').innerText = 'Edit Teacher';
        document.getElementById('teacher-id').value = teacher.id;
        document.getElementById('teacher-name').value = teacher.name;
        document.getElementById('teacher-subject').value = teacher.subject;
        document.getElementById('teacher-phone').value = teacher.phone;
        this.showModal('teacher-modal', true);
    },

    async deleteTeacher(id) {
        const res = await this.apiCall(`/teachers/${id}`, 'DELETE');
        if (res && res.deleted) {
            this.showNotification('Teacher deleted');
            this.loadTeachers();
        }
    },

    /* =========================================================
       CLASSES
       ========================================================= */
    async loadClasses() {
        const tbody = document.querySelector('#classes-table tbody');
        tbody.innerHTML = Array(5).fill('<tr>' + Array(3).fill('<td><div class="skeleton skeleton-row"></div></td>').join('') + '</tr>').join('');

        const classes = await this.apiCall('/classes');
        this._classes = classes || [];

        this._pagination.classes.page = 1;
        this.renderClasses();
    },

    renderClasses() {
        const tbody = document.querySelector('#classes-table tbody');
        const search = (document.getElementById('classes-search')?.value || '').toLowerCase();

        let filtered = this._classes.filter(c => {
            return !search ||
                c.name?.toLowerCase().includes(search) ||
                (c.teacher_name || '').toLowerCase().includes(search);
        });

        const countEl = document.getElementById('classes-count');
        if (countEl) countEl.textContent = `${filtered.length} class${filtered.length !== 1 ? 'es' : ''}`;

        const pag = this._pagination.classes;
        const totalPages = Math.max(1, Math.ceil(filtered.length / pag.perPage));
        if (pag.page > totalPages) pag.page = totalPages;
        const start = (pag.page - 1) * pag.perPage;
        const pageData = filtered.slice(start, start + pag.perPage);

        tbody.innerHTML = '';
        if (pageData.length > 0) {
            pageData.forEach(c => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${this.escapeHtml(c.name)}</strong></td>
                    <td>${c.teacher_name ? this.escapeHtml(c.teacher_name) : '<span style="color:var(--text-muted)">Unassigned</span>'}</td>
                    <td>
                        <button class="btn-icon btn-action" onclick='app.editClass(${JSON.stringify(c).replace(/'/g, "&#39;")})' title="Edit" aria-label="Edit class">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="btn-icon btn-action" onclick="app.confirmDelete('class', '${c.id}', '${this.escapeHtml(c.name)}')" title="Delete" aria-label="Delete class" style="color: var(--danger);">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } else {
            tbody.innerHTML = `<tr><td colspan="3">
                <div class="empty-state" style="padding: var(--space-10) var(--space-6);">
                    <div class="empty-state-icon"><i class="fa-solid fa-school"></i></div>
                    <h3>No classes found</h3>
                    <p>Create your first class to get started.</p>
                    <button class="btn-primary btn-sm" onclick="app.showModal('class-modal')"><i class="fa-solid fa-plus"></i> Create Class</button>
                </div>
            </td></tr>`;
        }

        this.renderPagination('classes', filtered.length, totalPages);
    },

    async loadTeacherOptions() {
        const teachers = await this.apiCall('/teachers');
        const select = document.getElementById('class-teacher');
        select.innerHTML = '<option value="">Select a Teacher</option>';
        if (teachers) {
            teachers.forEach(t => {
                const option = document.createElement('option');
                option.value = t.id;
                option.innerText = t.name;
                select.appendChild(option);
            });
        }
    },

    async saveClass(e) {
        e.preventDefault();
        if (this._submitting.class) return;
        this._submitting.class = true;

        const btn = document.getElementById('class-submit-btn');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

        const id = document.getElementById('class-id').value;
        const classroom = {
            name: document.getElementById('class-name').value,
            teacher_id: document.getElementById('class-teacher').value
        };

        let res;
        if (id) {
            res = await this.apiCall(`/classes/${id}`, 'PUT', classroom);
        } else {
            res = await this.apiCall('/classes', 'POST', classroom);
        }

        if (res && !res.error && !res.message?.includes('already exists') && !res.message?.includes('failed') && !res.message?.includes('denied')) {
            this.showNotification(`Class ${id ? 'updated' : 'created'} successfully`);
            this.closeModal('class-modal');
            this.loadClasses();
        } else {
            this.showNotification(res?.message || res?.error || 'Failed to save class', true);
        }

        btn.disabled = false;
        btn.innerHTML = originalText;
        this._submitting.class = false;
    },

    async editClass(classroom) {
        document.getElementById('class-modal-title').innerText = 'Edit Class';
        document.getElementById('class-id').value = classroom.id;
        document.getElementById('class-name').value = classroom.name;
        await this.loadTeacherOptions();
        const teacherId = classroom.teacher_id ? (classroom.teacher_id._id || classroom.teacher_id) : '';
        document.getElementById('class-teacher').value = teacherId;
        this.showModal('class-modal', true);
    },

    async deleteClass(id) {
        const res = await this.apiCall(`/classes/${id}`, 'DELETE');
        if (res && res.deleted) {
            this.showNotification('Class deleted');
            this.loadClasses();
        }
    },

    /* =========================================================
       ATTENDANCE
       ========================================================= */
    async loadAttendance() {
        const tbody = document.querySelector('#attendance-table tbody');
        tbody.innerHTML = Array(5).fill('<tr>' + Array(5).fill('<td><div class="skeleton skeleton-row"></div></td>').join('') + '</tr>').join('');

        const date = document.getElementById('attendance-date').value;
        const attendance = await this.apiCall(`/attendance?date=${date}`);
        // Filter out API metadata key (_status) before caching
        this._attendance = (attendance && Array.isArray(attendance))
            ? attendance.map(s => { const r = {...s}; delete r._status; return r; })
            : [];
        tbody.innerHTML = '';

        if (this._attendance.length > 0) {
            let present = 0, absent = 0, notMarked = 0;

            this._attendance.forEach(student => {
                if (student.status === 'Present') present++;
                else if (student.status === 'Absent') absent++;
                else notMarked++;

                const statusHtml = student.status
                    ? `<span class="badge ${student.status === 'Present' ? 'badge-success' : 'badge-danger'}">${student.status}</span>`
                    : '<span class="badge badge-neutral">Not Marked</span>';

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><span class="badge badge-neutral">${this.escapeHtml(student.id_number)}</span></td>
                    <td>${this.escapeHtml(student.full_name)}</td>
                    <td>${this.escapeHtml(student.class_name || 'Unassigned')}</td>
                    <td id="status-${student.id}">${statusHtml}</td>
                    <td>
                        <button class="att-btn att-btn-present" onclick="app.markAttendance('${student.id}', 'Present')">
                            <i class="fa-solid fa-check"></i> Present
                        </button>
                        <button class="att-btn att-btn-absent" onclick="app.markAttendance('${student.id}', 'Absent')">
                            <i class="fa-solid fa-xmark"></i> Absent
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });

            // Update summary
            const summary = document.getElementById('attendance-summary');
            if (summary) {
                summary.innerHTML = `
                    <span class="badge badge-success" style="margin-right:4px">Present: ${present}</span>
                    <span class="badge badge-danger" style="margin-right:4px">Absent: ${absent}</span>
                    <span class="badge badge-neutral">Not Marked: ${notMarked}</span>
                `;
            }
        } else {
            tbody.innerHTML = `<tr><td colspan="5">
                <div class="empty-state" style="padding: var(--space-10) var(--space-6);">
                    <div class="empty-state-icon"><i class="fa-solid fa-clipboard-check"></i></div>
                    <h3>No students to mark</h3>
                    <p>Add students to the system first, then come back to record attendance.</p>
                    <button class="btn-primary btn-sm" onclick="app.navigateTo('students-view')"><i class="fa-solid fa-user-plus"></i> Add Students</button>
                </div>
            </td></tr>`;
        }
    },

    async markAttendance(student_id, status) {
        const date = document.getElementById('attendance-date').value;
        if (!date) {
            this.showNotification('Please select a date first', true);
            return;
        }

        // Try to create a new attendance record (POST)
        const body = { student_id, status, date };
        const res = await this.apiCall('/attendance', 'POST', body);

        if (!res) {
            this.showNotification('Network error — please try again', true);
            return;
        }

        if (res.inserted) {
            // Successfully created new record
            this._updateAttendanceCell(student_id, status);
            this.showNotification(`Marked ${status}`);
            this.updateAttendanceSummary();
            return;
        }

        if (res._status === 409) {
            // Record already exists — find the existing record and update it via PUT
            const existing = this._attendance.find(a => a.id === student_id);
            if (existing && existing.att_id) {
                const putRes = await this.apiCall(`/attendance/${existing.att_id}`, 'PUT', { status });
                if (putRes && putRes.updated) {
                    this._updateAttendanceCell(student_id, status);
                    // Update local cache
                    existing.status = status;
                    this.showNotification(`Updated to ${status}`);
                    this.updateAttendanceSummary();
                } else {
                    this.showNotification(putRes?.message || 'Failed to update attendance', true);
                }
            } else {
                // No local att_id cached — reload the table to get the current state
                this.showNotification('Already recorded — reloading attendance data', false);
                await this.loadAttendance();
            }
            return;
        }

        if (res._status === 403) {
            this.showNotification('Access denied: only admin and teacher can record attendance', true);
            return;
        }

        // Any other error
        this.showNotification(res?.message || res?.error || 'Failed to record attendance', true);
    },

    _updateAttendanceCell(student_id, status) {
        const cell = document.getElementById(`status-${student_id}`);
        if (cell) {
            cell.innerHTML = `<span class="badge ${status === 'Present' ? 'badge-success' : 'badge-danger'}">${status}</span>`;
        }
    },

    updateAttendanceSummary() {
        // Recalculate from DOM
        const rows = document.querySelectorAll('#attendance-table tbody tr');
        let present = 0, absent = 0, notMarked = 0;
        rows.forEach(row => {
            const badge = row.querySelector('.badge-success, .badge-danger, .badge-neutral');
            if (!badge) return;
            if (badge.classList.contains('badge-success')) present++;
            else if (badge.classList.contains('badge-danger')) absent++;
            else notMarked++;
        });

        const summary = document.getElementById('attendance-summary');
        if (summary) {
            summary.innerHTML = `
                <span class="badge badge-success" style="margin-right:4px">Present: ${present}</span>
                <span class="badge badge-danger" style="margin-right:4px">Absent: ${absent}</span>
                <span class="badge badge-neutral">Not Marked: ${notMarked}</span>
            `;
        }
    },

    /* =========================================================
       TABLE FILTER & PAGINATION
       ========================================================= */
    filterTable(type) {
        this._pagination[type].page = 1;
        if (type === 'students') this.renderStudents();
        else if (type === 'teachers') this.renderTeachers();
        else if (type === 'classes') this.renderClasses();
    },

    renderPagination(type, totalItems, totalPages) {
        const container = document.getElementById(`${type}-pagination`);
        if (!container) return;

        if (totalPages <= 1) {
            container.innerHTML = `<div class="pagination-info">${totalItems} total</div><div></div>`;
            return;
        }

        const pag = this._pagination[type];
        const startItem = (pag.page - 1) * pag.perPage + 1;
        const endItem = Math.min(pag.page * pag.perPage, totalItems);

        let pagesHtml = '';
        const maxVisible = 5;
        let startPage = Math.max(1, pag.page - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage < maxVisible - 1) {
            startPage = Math.max(1, endPage - maxVisible + 1);
        }

        for (let i = startPage; i <= endPage; i++) {
            pagesHtml += `<button class="pagination-btn ${i === pag.page ? 'active' : ''}" onclick="app.goToPage('${type}', ${i})">${i}</button>`;
        }

        container.innerHTML = `
            <div class="pagination-info">Showing ${startItem}–${endItem} of ${totalItems}</div>
            <div class="pagination-controls">
                <button class="pagination-btn" onclick="app.goToPage('${type}', ${pag.page - 1})" ${pag.page <= 1 ? 'disabled' : ''}>
                    <i class="fa-solid fa-chevron-left"></i>
                </button>
                ${pagesHtml}
                <button class="pagination-btn" onclick="app.goToPage('${type}', ${pag.page + 1})" ${pag.page >= totalPages ? 'disabled' : ''}>
                    <i class="fa-solid fa-chevron-right"></i>
                </button>
            </div>
        `;
    },

    goToPage(type, page) {
        this._pagination[type].page = page;
        if (type === 'students') this.renderStudents();
        else if (type === 'teachers') this.renderTeachers();
        else if (type === 'classes') this.renderClasses();
        else if (type === 'users') this.filterUsers();
    },

    /* =========================================================
       GLOBAL SEARCH
       ========================================================= */
    async handleGlobalSearch() {
        const query = this.globalSearchInput?.value?.trim();
        if (!query || query.length < 2) {
            this.searchResults.classList.remove('active');
            return;
        }

        // Search against local cached data first
        const results = [];
        const q = query.toLowerCase();

        // Search students
        this._students.forEach(s => {
            if (s.full_name?.toLowerCase().includes(q) || s.id_number?.toLowerCase().includes(q)) {
                results.push({ type: 'student', icon: 'fa-user-graduate', label: s.full_name, meta: s.class_name || 'Student', view: 'students-view' });
            }
        });

        // Search teachers
        this._teachers.forEach(t => {
            if (t.name?.toLowerCase().includes(q) || t.subject?.toLowerCase().includes(q)) {
                results.push({ type: 'teacher', icon: 'fa-chalkboard-user', label: t.name, meta: t.subject || 'Teacher', view: 'teachers-view' });
            }
        });

        // Search classes
        this._classes.forEach(c => {
            if (c.name?.toLowerCase().includes(q)) {
                results.push({ type: 'class', icon: 'fa-school', label: c.name, meta: c.teacher_name || 'Class', view: 'classes-view' });
            }
        });

        // If no local results, try API search
        if (results.length === 0) {
            const apiResults = await this.apiCall(`/search?q=${encodeURIComponent(query)}`);
            if (apiResults) {
                (apiResults.students || []).forEach(s => {
                    results.push({ type: 'student', icon: 'fa-user-graduate', label: s.full_name, meta: s.class_name || 'Student', view: 'students-view' });
                });
                (apiResults.teachers || []).forEach(t => {
                    results.push({ type: 'teacher', icon: 'fa-chalkboard-user', label: t.name, meta: t.subject || 'Teacher', view: 'teachers-view' });
                });
                (apiResults.classes || []).forEach(c => {
                    results.push({ type: 'class', icon: 'fa-school', label: c.name, meta: 'Class', view: 'classes-view' });
                });
            }
        }

        // Render results
        if (results.length > 0) {
            const grouped = {};
            results.slice(0, 15).forEach(r => {
                if (!grouped[r.type]) grouped[r.type] = [];
                grouped[r.type].push(r);
            });

            const typeLabels = { student: 'Students', teacher: 'Teachers', class: 'Classes' };
            let html = '';
            for (const [type, items] of Object.entries(grouped)) {
                html += `<div class="search-results-group">
                    <div class="search-results-group-title">${typeLabels[type] || type}</div>
                    ${items.map(item => `
                        <div class="search-result-item" onclick="app.navigateTo('${item.view}'); app.searchResults.classList.remove('active'); app.globalSearchInput.value = '';">
                            <i class="fa-solid ${item.icon}"></i>
                            <span class="result-label">${this.escapeHtml(item.label)}</span>
                            <span class="result-meta">${this.escapeHtml(item.meta)}</span>
                        </div>
                    `).join('')}
                </div>`;
            }
            this.searchResults.innerHTML = html;
        } else {
            this.searchResults.innerHTML = '<div class="search-no-results"><i class="fa-solid fa-search" style="margin-right:8px;"></i>No results found</div>';
        }
        this.searchResults.classList.add('active');
    },

    /* =========================================================
       CONFIRMATION DIALOG
       ========================================================= */
    confirmDelete(type, id, name) {
        document.getElementById('confirm-title').textContent = `Delete ${type}?`;
        document.getElementById('confirm-message').textContent = `Are you sure you want to delete "${name}"? This action cannot be undone.`;
        document.getElementById('confirm-modal').classList.remove('hidden');

        this._confirmCallback = () => {
            if (type === 'student') this.deleteStudent(id);
            else if (type === 'teacher') this.deleteTeacher(id);
            else if (type === 'class') this.deleteClass(id);
        };
    },

    executeConfirm() {
        if (this._confirmCallback) {
            this._confirmCallback();
            this._confirmCallback = null;
        }
        document.getElementById('confirm-modal').classList.add('hidden');
    },

    cancelConfirm() {
        this._confirmCallback = null;
        document.getElementById('confirm-modal').classList.add('hidden');
    },

    /* =========================================================
       MODALS
       ========================================================= */
    showModal(id, skipReset = false) {
        if (!skipReset) {
            if (id === 'student-modal') {
                this.studentForm.reset();
                document.getElementById('student-id').value = '';
                document.getElementById('student-modal-title').innerText = 'Add New Student';
                this.loadClassOptionsForStudent();
            } else if (id === 'teacher-modal') {
                this.teacherForm.reset();
                document.getElementById('teacher-id').value = '';
                document.getElementById('teacher-modal-title').innerText = 'Add New Teacher';
            } else if (id === 'class-modal') {
                this.classForm.reset();
                document.getElementById('class-id').value = '';
                document.getElementById('class-modal-title').innerText = 'Create Class';
                this.loadTeacherOptions();
            } else if (id === 'academic-year-modal') {
                document.getElementById('academic-year-form').reset();
                document.getElementById('academic-year-id').value = '';
                document.getElementById('academic-year-modal-title').innerText = 'Add Academic Year';
            } else if (id === 'term-modal') {
                document.getElementById('term-form').reset();
                document.getElementById('term-id').value = '';
                document.getElementById('term-modal-title').innerText = 'Add Term';
                this.loadAcademicYearOptions('term-academic-year', null);
            } else if (id === 'subject-modal') {
                document.getElementById('subject-form').reset();
                document.getElementById('subject-id').value = '';
                document.getElementById('subject-modal-title').innerText = 'Add Subject';
            } else if (id === 'class-subject-modal') {
                document.getElementById('class-subject-form').reset();
                document.getElementById('class-subject-id').value = '';
                document.getElementById('class-subject-modal-title').innerText = 'Assign Subject to Class';
                this.loadCSModalOptions(null, null, null, null);
            } else if (id === 'exam-modal') {
                document.getElementById('exam-form').reset();
                document.getElementById('exam-id').value = '';
                document.getElementById('exam-modal-title').innerText = 'Add Exam';
                this.loadExamModalOptions(null, null, null, null);
            } else if (id === 'mark-modal') {
                document.getElementById('mark-form').reset();
                document.getElementById('mark-id').value = '';
                document.getElementById('mark-modal-title').innerText = 'Add Mark';
                document.getElementById('mark-total').value = '';
                this.loadMarkModalOptions(null, null);
            } else if (id === 'timetable-modal') {
                document.getElementById('timetable-form').reset();
                document.getElementById('timetable-slot-id').value = '';
                document.getElementById('timetable-modal-title').innerText = 'Add Timetable Slot';
                const conflictAlert = document.getElementById('timetable-conflict-alert');
                if (conflictAlert) conflictAlert.classList.add('hidden');
            } else if (id === 'notice-modal') {
                document.getElementById('notice-form').reset();
                document.getElementById('notice-id').value = '';
                document.getElementById('notice-modal-title').innerText = 'Publish Notice';
            }
        }
        document.getElementById(id).classList.remove('hidden');
    },

    closeModal(id) {
        document.getElementById(id).classList.add('hidden');
    },

    /* =========================================================
       NOTIFICATIONS
       ========================================================= */
    showNotification(msg, isError = false) {
        this.notificationMsg.innerText = msg;
        this.notification.classList.remove('error');
        if (isError) {
            this.notification.classList.add('error');
            if (this.notificationIcon) this.notificationIcon.className = 'fa-solid fa-circle-exclamation';
        } else {
            if (this.notificationIcon) this.notificationIcon.className = 'fa-solid fa-check-circle';
        }

        // Reset animation
        this.notification.classList.remove('show');
        void this.notification.offsetHeight; // force reflow
        this.notification.classList.add('show');

        clearTimeout(this._notifTimeout);
        this._notifTimeout = setTimeout(() => {
            this.notification.classList.remove('show');
        }, 3500);
    },

    /* =========================================================
       UTILITIES
       ========================================================= */
    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    },

    debounce(fn, delay) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    },

    /* =========================================================
       ACADEMIC FOUNDATION — P2 #1
       ========================================================= */

    // ----------------------------------------------------------------
    // ACADEMIC YEARS
    // ----------------------------------------------------------------
    async loadAcademicYears() {
        const tbody = document.getElementById('academic-years-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="5" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';
        try {
            const status = document.getElementById('academic-years-filter-status')?.value || '';
            const url = `${API_URL}/academic-years${status ? `?status=${encodeURIComponent(status)}` : ''}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error(await res.text());
            const years = await res.json();
            if (!years.length) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No academic years found.</td></tr>';
                return;
            }
            tbody.innerHTML = years.map(y => `
                <tr>
                    <td>${this.escapeHtml(y.name)}</td>
                    <td>${y.start_date ? y.start_date.slice(0, 10) : '—'}</td>
                    <td>${y.end_date ? y.end_date.slice(0, 10) : '—'}</td>
                    <td><span class="badge badge-${y.status === 'active' ? 'success' : 'secondary'}">${this.escapeHtml(y.status)}</span></td>
                    <td class="action-btns">
                        <button class="btn-icon edit" title="Edit" onclick="app.editAcademicYear('${y._id || y.id}')"><i class="fa-solid fa-pencil"></i></button>
                        <button class="btn-icon delete" title="Delete" onclick="app.deleteAcademicYear('${y._id || y.id}', '${this.escapeHtml(y.name)}')"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="5" class="error-cell"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}</td></tr>`;
        }
    },

    async editAcademicYear(id) {
        try {
            const res = await fetch(`${API_URL}/academic-years/${id}`, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error('Failed to load academic year');
            const y = await res.json();
            document.getElementById('academic-year-id').value = y._id || y.id;
            document.getElementById('academic-year-name').value = y.name;
            document.getElementById('academic-year-start').value = y.start_date ? y.start_date.slice(0, 10) : '';
            document.getElementById('academic-year-end').value = y.end_date ? y.end_date.slice(0, 10) : '';
            document.getElementById('academic-year-status').value = y.status;
            document.getElementById('academic-year-modal-title').innerText = 'Edit Academic Year';
            document.getElementById('academic-year-modal').classList.remove('hidden');
        } catch (err) {
            this.showNotification(err.message, true);
        }
    },

    deleteAcademicYear(id, name) {
        this.showConfirm(`Delete academic year "${name}"?`, 'This cannot be undone.', async () => {
            try {
                const res = await fetch(`${API_URL}/academic-years/${id}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${this.token}` }
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Delete failed');
                this.showNotification('Academic year deleted.');
                this.loadAcademicYears();
            } catch (err) {
                this.showNotification(err.message, true);
            }
        });
    },

    async saveAcademicYear(e) {
        e.preventDefault();
        if (this._submitting['academic-year']) return;
        this._submitting['academic-year'] = true;
        const btn = document.getElementById('academic-year-submit-btn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
        try {
            const id = document.getElementById('academic-year-id').value;
            const body = {
                name: document.getElementById('academic-year-name').value.trim(),
                start_date: document.getElementById('academic-year-start').value,
                end_date: document.getElementById('academic-year-end').value,
                status: document.getElementById('academic-year-status').value
            };
            const url = id ? `${API_URL}/academic-years/${id}` : `${API_URL}/academic-years`;
            const method = id ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Save failed');
            this.showNotification(id ? 'Academic year updated.' : 'Academic year created.');
            this.closeModal('academic-year-modal');
            this.loadAcademicYears();
        } catch (err) {
            this.showNotification(err.message, true);
        } finally {
            btn.innerHTML = orig;
            btn.disabled = false;
            this._submitting['academic-year'] = false;
        }
    },

    // ----------------------------------------------------------------
    // TERMS
    // ----------------------------------------------------------------
    async loadTerms() {
        const tbody = document.getElementById('terms-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="6" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';
        try {
            const yearId = document.getElementById('terms-filter-year')?.value || '';
            const status = document.getElementById('terms-filter-status')?.value || '';
            const params = new URLSearchParams();
            if (yearId) params.append('academic_year_id', yearId);
            if (status) params.append('status', status);
            const url = `${API_URL}/terms${params.toString() ? '?' + params.toString() : ''}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error(await res.text());
            const terms = await res.json();
            if (!terms.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No terms found.</td></tr>';
                return;
            }
            tbody.innerHTML = terms.map(t => `
                <tr>
                    <td>${this.escapeHtml(t.name)}</td>
                    <td>${this.escapeHtml(t.academic_year_name || '—')}</td>
                    <td>${t.start_date ? t.start_date.slice(0, 10) : '—'}</td>
                    <td>${t.end_date ? t.end_date.slice(0, 10) : '—'}</td>
                    <td><span class="badge badge-${t.status === 'active' ? 'success' : 'secondary'}">${this.escapeHtml(t.status)}</span></td>
                    <td class="action-btns">
                        <button class="btn-icon edit" title="Edit" onclick="app.editTerm('${t._id || t.id}')"><i class="fa-solid fa-pencil"></i></button>
                        <button class="btn-icon delete" title="Delete" onclick="app.deleteTerm('${t._id || t.id}', '${this.escapeHtml(t.name)}')"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="error-cell"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}</td></tr>`;
        }
    },

    async loadAcademicYearOptions(selectId, selectedId) {
        try {
            const res = await fetch(`${API_URL}/academic-years`, { headers: { Authorization: `Bearer ${this.token}` } });
            const years = await res.json();
            const sel = document.getElementById(selectId);
            if (!sel) return;
            const firstOpt = sel.options[0]?.value === '' ? sel.options[0].outerHTML : '<option value="">Select Academic Year</option>';
            sel.innerHTML = firstOpt + years.map(y =>
                `<option value="${y._id || y.id}" ${(y._id || y.id) === selectedId ? 'selected' : ''}>${this.escapeHtml(y.name)}</option>`
            ).join('');
        } catch (_) {}
    },

    async populateTermsYearFilter() {
        try {
            const res = await fetch(`${API_URL}/academic-years`, { headers: { Authorization: `Bearer ${this.token}` } });
            const years = await res.json();
            const sel = document.getElementById('terms-filter-year');
            if (!sel) return;
            sel.innerHTML = '<option value="">All Academic Years</option>' + years.map(y =>
                `<option value="${y._id || y.id}">${this.escapeHtml(y.name)}</option>`
            ).join('');
        } catch (_) {}
    },

    async editTerm(id) {
        try {
            const res = await fetch(`${API_URL}/terms/${id}`, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error('Failed to load term');
            const t = await res.json();
            await this.loadAcademicYearOptions('term-academic-year', (t.academic_year_id?._id || t.academic_year_id)?.toString());
            document.getElementById('term-id').value = t._id || t.id;
            document.getElementById('term-name').value = t.name;
            document.getElementById('term-start').value = t.start_date ? t.start_date.slice(0, 10) : '';
            document.getElementById('term-end').value = t.end_date ? t.end_date.slice(0, 10) : '';
            document.getElementById('term-status').value = t.status;
            document.getElementById('term-modal-title').innerText = 'Edit Term';
            document.getElementById('term-modal').classList.remove('hidden');
        } catch (err) {
            this.showNotification(err.message, true);
        }
    },

    deleteTerm(id, name) {
        this.showConfirm(`Delete term "${name}"?`, 'This cannot be undone.', async () => {
            try {
                const res = await fetch(`${API_URL}/terms/${id}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${this.token}` }
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Delete failed');
                this.showNotification('Term deleted.');
                this.loadTerms();
            } catch (err) {
                this.showNotification(err.message, true);
            }
        });
    },

    async saveTerm(e) {
        e.preventDefault();
        if (this._submitting['term']) return;
        this._submitting['term'] = true;
        const btn = document.getElementById('term-submit-btn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
        try {
            const id = document.getElementById('term-id').value;
            const body = {
                name: document.getElementById('term-name').value.trim(),
                academic_year_id: document.getElementById('term-academic-year').value,
                start_date: document.getElementById('term-start').value,
                end_date: document.getElementById('term-end').value,
                status: document.getElementById('term-status').value
            };
            const url = id ? `${API_URL}/terms/${id}` : `${API_URL}/terms`;
            const method = id ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Save failed');
            this.showNotification(id ? 'Term updated.' : 'Term created.');
            this.closeModal('term-modal');
            this.loadTerms();
        } catch (err) {
            this.showNotification(err.message, true);
        } finally {
            btn.innerHTML = orig;
            btn.disabled = false;
            this._submitting['term'] = false;
        }
    },

    // ----------------------------------------------------------------
    // SUBJECTS
    // ----------------------------------------------------------------
    async loadSubjects() {
        const tbody = document.getElementById('subjects-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="4" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';
        try {
            const status = document.getElementById('subjects-filter-status')?.value || '';
            const url = `${API_URL}/subjects${status ? `?status=${encodeURIComponent(status)}` : ''}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error(await res.text());
            const subjects = await res.json();
            if (!subjects.length) {
                tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">No subjects found.</td></tr>';
                return;
            }
            tbody.innerHTML = subjects.map(s => `
                <tr>
                    <td>${this.escapeHtml(s.name)}</td>
                    <td>${this.escapeHtml(s.code || '—')}</td>
                    <td><span class="badge badge-${s.status === 'active' ? 'success' : 'secondary'}">${this.escapeHtml(s.status)}</span></td>
                    <td class="action-btns">
                        <button class="btn-icon edit" title="Edit" onclick="app.editSubject('${s._id || s.id}')"><i class="fa-solid fa-pencil"></i></button>
                        <button class="btn-icon delete" title="Delete" onclick="app.deleteSubject('${s._id || s.id}', '${this.escapeHtml(s.name)}')"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="4" class="error-cell"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}</td></tr>`;
        }
    },

    async editSubject(id) {
        try {
            const res = await fetch(`${API_URL}/subjects/${id}`, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error('Failed to load subject');
            const s = await res.json();
            document.getElementById('subject-id').value = s._id || s.id;
            document.getElementById('subject-name').value = s.name;
            document.getElementById('subject-code').value = s.code || '';
            document.getElementById('subject-status').value = s.status;
            document.getElementById('subject-modal-title').innerText = 'Edit Subject';
            document.getElementById('subject-modal').classList.remove('hidden');
        } catch (err) {
            this.showNotification(err.message, true);
        }
    },

    deleteSubject(id, name) {
        this.showConfirm(`Delete subject "${name}"?`, 'This cannot be undone.', async () => {
            try {
                const res = await fetch(`${API_URL}/subjects/${id}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${this.token}` }
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Delete failed');
                this.showNotification('Subject deleted.');
                this.loadSubjects();
            } catch (err) {
                this.showNotification(err.message, true);
            }
        });
    },

    async saveSubject(e) {
        e.preventDefault();
        if (this._submitting['subject']) return;
        this._submitting['subject'] = true;
        const btn = document.getElementById('subject-submit-btn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
        try {
            const id = document.getElementById('subject-id').value;
            const body = {
                name: document.getElementById('subject-name').value.trim(),
                code: document.getElementById('subject-code').value.trim(),
                status: document.getElementById('subject-status').value
            };
            const url = id ? `${API_URL}/subjects/${id}` : `${API_URL}/subjects`;
            const method = id ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Save failed');
            this.showNotification(id ? 'Subject updated.' : 'Subject created.');
            this.closeModal('subject-modal');
            this.loadSubjects();
        } catch (err) {
            this.showNotification(err.message, true);
        } finally {
            btn.innerHTML = orig;
            btn.disabled = false;
            this._submitting['subject'] = false;
        }
    },

    // ----------------------------------------------------------------
    // CLASS SUBJECTS
    // ----------------------------------------------------------------
    async loadClassSubjects() {
        const tbody = document.getElementById('class-subjects-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="7" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';
        try {
            const yearId = document.getElementById('cs-filter-year')?.value || '';
            const classId = document.getElementById('cs-filter-class')?.value || '';
            const params = new URLSearchParams();
            if (yearId) params.append('academic_year_id', yearId);
            if (classId) params.append('class_id', classId);
            const url = `${API_URL}/class-subjects${params.toString() ? '?' + params.toString() : ''}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error(await res.text());
            const assignments = await res.json();
            if (!assignments.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No class-subject assignments found.</td></tr>';
                return;
            }
            tbody.innerHTML = assignments.map(cs => `
                <tr>
                    <td>${this.escapeHtml(cs.class_name || '—')}</td>
                    <td>${this.escapeHtml(cs.subject_name || '—')}</td>
                    <td>${this.escapeHtml(cs.subject_code || '—')}</td>
                    <td>${this.escapeHtml(cs.academic_year_name || '—')}</td>
                    <td>${this.escapeHtml(cs.teacher_name || '—')}</td>
                    <td><span class="badge badge-${cs.status === 'active' ? 'success' : 'secondary'}">${this.escapeHtml(cs.status)}</span></td>
                    <td class="action-btns">
                        <button class="btn-icon edit" title="Edit" onclick="app.editClassSubject('${cs._id || cs.id}')"><i class="fa-solid fa-pencil"></i></button>
                        <button class="btn-icon delete" title="Delete" onclick="app.deleteClassSubject('${cs._id || cs.id}')"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="7" class="error-cell"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}</td></tr>`;
        }
    },

    async populateCSFilters() {
        // academic year filter
        try {
            const res = await fetch(`${API_URL}/academic-years`, { headers: { Authorization: `Bearer ${this.token}` } });
            const years = await res.json();
            const sel = document.getElementById('cs-filter-year');
            if (sel) {
                sel.innerHTML = '<option value="">All Academic Years</option>' + years.map(y =>
                    `<option value="${y._id || y.id}">${this.escapeHtml(y.name)}</option>`).join('');
            }
        } catch (_) {}
        // class filter
        try {
            const res = await fetch(`${API_URL}/classes`, { headers: { Authorization: `Bearer ${this.token}` } });
            const classes = await res.json();
            const sel = document.getElementById('cs-filter-class');
            if (sel) {
                sel.innerHTML = '<option value="">All Classes</option>' + classes.map(c =>
                    `<option value="${c._id || c.id}">${this.escapeHtml(c.name)}</option>`).join('');
            }
        } catch (_) {}
    },

    async loadCSModalOptions(selectedAY, selectedClass, selectedSubject, selectedTeacher) {
        await Promise.all([
            this.loadAcademicYearOptions('cs-academic-year', selectedAY),
            (async () => {
                try {
                    const res = await fetch(`${API_URL}/classes`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const classes = await res.json();
                    const sel = document.getElementById('cs-class');
                    if (sel) sel.innerHTML = '<option value="">Select a Class</option>' + classes.map(c =>
                        `<option value="${c._id || c.id}" ${(c._id || c.id) === selectedClass ? 'selected' : ''}>${this.escapeHtml(c.name)}</option>`).join('');
                } catch (_) {}
            })(),
            (async () => {
                try {
                    const res = await fetch(`${API_URL}/subjects`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const subjects = await res.json();
                    const sel = document.getElementById('cs-subject');
                    if (sel) sel.innerHTML = '<option value="">Select a Subject</option>' + subjects.map(s =>
                        `<option value="${s._id || s.id}" ${(s._id || s.id) === selectedSubject ? 'selected' : ''}>${this.escapeHtml(s.name)}</option>`).join('');
                } catch (_) {}
            })(),
            (async () => {
                try {
                    const res = await fetch(`${API_URL}/teachers`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const teachers = await res.json();
                    const sel = document.getElementById('cs-teacher');
                    if (sel) sel.innerHTML = '<option value="">No Teacher Assigned</option>' + teachers.map(t =>
                        `<option value="${t._id || t.id}" ${(t._id || t.id) === selectedTeacher ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('');
                } catch (_) {}
            })()
        ]);
    },

    async editClassSubject(id) {
        try {
            const res = await fetch(`${API_URL}/class-subjects/${id}`, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error('Failed to load assignment');
            const cs = await res.json();
            const ayId = (cs.academic_year_id?._id || cs.academic_year_id)?.toString();
            const classId = (cs.class_id?._id || cs.class_id)?.toString();
            const subjectId = (cs.subject_id?._id || cs.subject_id)?.toString();
            const teacherId = (cs.teacher_id?._id || cs.teacher_id)?.toString();
            await this.loadCSModalOptions(ayId, classId, subjectId, teacherId);
            document.getElementById('class-subject-id').value = cs._id || cs.id;
            document.getElementById('cs-status').value = cs.status;
            document.getElementById('class-subject-modal-title').innerText = 'Edit Assignment';
            document.getElementById('class-subject-modal').classList.remove('hidden');
        } catch (err) {
            this.showNotification(err.message, true);
        }
    },

    deleteClassSubject(id) {
        this.showConfirm('Delete this assignment?', 'This cannot be undone.', async () => {
            try {
                const res = await fetch(`${API_URL}/class-subjects/${id}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${this.token}` }
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Delete failed');
                this.showNotification('Assignment deleted.');
                this.loadClassSubjects();
            } catch (err) {
                this.showNotification(err.message, true);
            }
        });
    },

    async saveClassSubject(e) {
        e.preventDefault();
        if (this._submitting['class-subject']) return;
        this._submitting['class-subject'] = true;
        const btn = document.getElementById('class-subject-submit-btn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
        try {
            const id = document.getElementById('class-subject-id').value;
            const body = {
                class_id: document.getElementById('cs-class').value,
                subject_id: document.getElementById('cs-subject').value,
                academic_year_id: document.getElementById('cs-academic-year').value,
                teacher_id: document.getElementById('cs-teacher').value || null,
                status: document.getElementById('cs-status').value
            };
            const url = id ? `${API_URL}/class-subjects/${id}` : `${API_URL}/class-subjects`;
            const method = id ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Save failed');
            this.showNotification(id ? 'Assignment updated.' : 'Assignment created.');
            this.closeModal('class-subject-modal');
            this.loadClassSubjects();
        } catch (err) {
            this.showNotification(err.message, true);
        } finally {
            btn.innerHTML = orig;
            btn.disabled = false;
            this._submitting['class-subject'] = false;
        }
    },

    // ----------------------------------------------------------------
    // EXAMS (P2 #2)
    // ----------------------------------------------------------------
    async loadExams() {
        const tbody = document.getElementById('exams-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="10" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';
        try {
            const params = new URLSearchParams();
            const yearId = document.getElementById('exams-filter-year')?.value;
            const termId = document.getElementById('exams-filter-term')?.value;
            const classId = document.getElementById('exams-filter-class')?.value;
            const subjectId = document.getElementById('exams-filter-subject')?.value;
            const type = document.getElementById('exams-filter-type')?.value;
            const status = document.getElementById('exams-filter-status')?.value;

            if (yearId) params.append('academic_year_id', yearId);
            if (termId) params.append('term_id', termId);
            if (classId) params.append('class_id', classId);
            if (subjectId) params.append('subject_id', subjectId);
            if (type) params.append('type', type);
            if (status) params.append('status', status);

            const url = `${API_URL}/exams${params.toString() ? '?' + params.toString() : ''}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error(await res.text());
            const exams = await res.json();

            if (!exams.length) {
                tbody.innerHTML = '<tr><td colspan="10" class="empty-cell">No exams found.</td></tr>';
                return;
            }

            tbody.innerHTML = exams.map(e => `
                <tr>
                    <td><strong>${this.escapeHtml(e.name)}</strong></td>
                    <td><span class="badge badge-neutral">${this.escapeHtml(e.type)}</span></td>
                    <td>${this.escapeHtml(e.academic_year_name || '—')}</td>
                    <td>${this.escapeHtml(e.term_name || '—')}</td>
                    <td>${this.escapeHtml(e.class_name || '—')}</td>
                    <td>${this.escapeHtml(e.subject_name || '—')} ${e.subject_code ? `<small class="text-muted">(${this.escapeHtml(e.subject_code)})</small>` : ''}</td>
                    <td>${e.exam_date ? e.exam_date.slice(0, 10) : '—'}</td>
                    <td><strong>${e.total_marks}</strong></td>
                    <td><span class="badge badge-${e.status === 'active' ? 'success' : 'secondary'}">${this.escapeHtml(e.status)}</span></td>
                    <td class="action-btns">
                        <button class="btn-icon edit" title="Edit" onclick="app.editExam('${e._id || e.id}')"><i class="fa-solid fa-pencil"></i></button>
                        <button class="btn-icon delete" title="Delete" onclick="app.deleteExam('${e._id || e.id}', '${this.escapeHtml(e.name)}')"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="10" class="error-cell"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}</td></tr>`;
        }
    },

    async populateExamFilters() {
        // 1. Populate Academic Years
        try {
            const res = await fetch(`${API_URL}/academic-years`, { headers: { Authorization: `Bearer ${this.token}` } });
            const years = await res.json();
            const sel = document.getElementById('exams-filter-year');
            if (sel) {
                sel.innerHTML = '<option value="">All Academic Years</option>' + years.map(y =>
                    `<option value="${y._id || y.id}">${this.escapeHtml(y.name)}</option>`).join('');
            }
        } catch (_) {}

        // 2. Populate Classes
        try {
            const res = await fetch(`${API_URL}/classes`, { headers: { Authorization: `Bearer ${this.token}` } });
            const classes = await res.json();
            const sel = document.getElementById('exams-filter-class');
            if (sel) {
                sel.innerHTML = '<option value="">All Classes</option>' + classes.map(c =>
                    `<option value="${c._id || c.id}">${this.escapeHtml(c.name)}</option>`).join('');
            }
        } catch (_) {}

        // 3. Populate Subjects initially
        try {
            const res = await fetch(`${API_URL}/subjects`, { headers: { Authorization: `Bearer ${this.token}` } });
            const subs = await res.json();
            const sel = document.getElementById('exams-filter-subject');
            if (sel) {
                sel.innerHTML = '<option value="">All Subjects</option>' + subs.map(s =>
                    `<option value="${s._id || s.id}">${this.escapeHtml(s.name)} (${this.escapeHtml(s.code)})</option>`).join('');
            }
        } catch (_) {}
    },

    async onExamFilterAYChange() {
        const ayId = document.getElementById('exams-filter-year')?.value;
        const termSel = document.getElementById('exams-filter-term');
        if (termSel) {
            if (!ayId) {
                termSel.innerHTML = '<option value="">All Terms</option>';
            } else {
                try {
                    const res = await fetch(`${API_URL}/terms?academic_year_id=${ayId}`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const terms = await res.json();
                    termSel.innerHTML = '<option value="">All Terms</option>' + terms.map(t =>
                        `<option value="${t._id || t.id}">${this.escapeHtml(t.name)}</option>`).join('');
                } catch (_) {}
            }
        }
        this.loadExams();
    },

    async onExamFilterClassChange() {
        const classId = document.getElementById('exams-filter-class')?.value;
        const ayId = document.getElementById('exams-filter-year')?.value;
        const subSel = document.getElementById('exams-filter-subject');
        if (subSel) {
            if (classId && ayId) {
                try {
                    const res = await fetch(`${API_URL}/class-subjects?class_id=${classId}&academic_year_id=${ayId}`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const csList = await res.json();
                    subSel.innerHTML = '<option value="">All Subjects</option>' + csList.map(cs =>
                        `<option value="${cs.subject_id?._id || cs.subject_id}">${this.escapeHtml(cs.subject_name || 'Subject')} (${this.escapeHtml(cs.subject_code || '')})</option>`).join('');
                } catch (_) {}
            } else {
                try {
                    const res = await fetch(`${API_URL}/subjects`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const subs = await res.json();
                    subSel.innerHTML = '<option value="">All Subjects</option>' + subs.map(s =>
                        `<option value="${s._id || s.id}">${this.escapeHtml(s.name)} (${this.escapeHtml(s.code)})</option>`).join('');
                } catch (_) {}
            }
        }
        this.loadExams();
    },

    async loadExamModalOptions(selectedAY, selectedTerm, selectedClass, selectedSubject) {
        // Load Academic Years
        try {
            const res = await fetch(`${API_URL}/academic-years`, { headers: { Authorization: `Bearer ${this.token}` } });
            const years = await res.json();
            const sel = document.getElementById('exam-academic-year');
            if (sel) {
                sel.innerHTML = '<option value="">Select Academic Year</option>' + years.map(y =>
                    `<option value="${y._id || y.id}" ${(y._id || y.id) === selectedAY ? 'selected' : ''}>${this.escapeHtml(y.name)}</option>`).join('');
            }
        } catch (_) {}

        // Load Classes
        try {
            const res = await fetch(`${API_URL}/classes`, { headers: { Authorization: `Bearer ${this.token}` } });
            const classes = await res.json();
            const sel = document.getElementById('exam-class');
            if (sel) {
                sel.innerHTML = '<option value="">Select Class</option>' + classes.map(c =>
                    `<option value="${c._id || c.id}" ${(c._id || c.id) === selectedClass ? 'selected' : ''}>${this.escapeHtml(c.name)}</option>`).join('');
            }
        } catch (_) {}

        // If AY is already selected, populate Terms
        if (selectedAY) {
            await this.updateExamModalTerms(selectedAY, selectedTerm);
        } else {
            const termSel = document.getElementById('exam-term');
            if (termSel) termSel.innerHTML = '<option value="">Select Term</option>';
        }

        // If Class and AY are selected, populate Subjects
        if (selectedClass && selectedAY) {
            await this.updateExamModalSubjects(selectedClass, selectedAY, selectedSubject);
        } else {
            const subSel = document.getElementById('exam-subject');
            if (subSel) subSel.innerHTML = '<option value="">Select Subject</option>';
        }
    },

    async updateExamModalTerms(ayId, selectedTerm = null) {
        const sel = document.getElementById('exam-term');
        if (!sel) return;
        if (!ayId) {
            sel.innerHTML = '<option value="">Select Term</option>';
            return;
        }
        try {
            const res = await fetch(`${API_URL}/terms?academic_year_id=${ayId}`, { headers: { Authorization: `Bearer ${this.token}` } });
            const terms = await res.json();
            sel.innerHTML = '<option value="">Select Term</option>' + terms.map(t =>
                `<option value="${t._id || t.id}" ${(t._id || t.id) === selectedTerm ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('');
        } catch (_) {
            sel.innerHTML = '<option value="">Select Term</option>';
        }
    },

    async updateExamModalSubjects(classId, ayId, selectedSubject = null) {
        const sel = document.getElementById('exam-subject');
        if (!sel) return;
        if (!classId || !ayId) {
            sel.innerHTML = '<option value="">Select Subject</option>';
            return;
        }
        try {
            const res = await fetch(`${API_URL}/class-subjects?class_id=${classId}&academic_year_id=${ayId}`, { headers: { Authorization: `Bearer ${this.token}` } });
            const csList = await res.json();
            if (!csList.length) {
                sel.innerHTML = '<option value="">No subjects assigned to this class</option>';
                return;
            }
            sel.innerHTML = '<option value="">Select Subject</option>' + csList.map(cs => {
                const subId = (cs.subject_id?._id || cs.subject_id)?.toString();
                const subName = cs.subject_name || cs.subject_id?.name || 'Subject';
                const subCode = cs.subject_code || cs.subject_id?.code || '';
                return `<option value="${subId}" ${subId === selectedSubject ? 'selected' : ''}>${this.escapeHtml(subName)} ${subCode ? `(${this.escapeHtml(subCode)})` : ''}</option>`;
            }).join('');
        } catch (_) {
            sel.innerHTML = '<option value="">Select Subject</option>';
        }
    },

    async onExamAYChange() {
        const ayId = document.getElementById('exam-academic-year')?.value;
        await this.updateExamModalTerms(ayId, null);
        const classId = document.getElementById('exam-class')?.value;
        if (classId) {
            await this.updateExamModalSubjects(classId, ayId, null);
        }
    },

    async onExamClassChange() {
        const classId = document.getElementById('exam-class')?.value;
        const ayId = document.getElementById('exam-academic-year')?.value;
        if (ayId) {
            await this.updateExamModalSubjects(classId, ayId, null);
        }
    },

    async editExam(id) {
        try {
            const res = await fetch(`${API_URL}/exams/${id}`, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error('Failed to load exam details');
            const e = await res.json();

            const ayId = (e.academic_year_id?._id || e.academic_year_id)?.toString();
            const termId = (e.term_id?._id || e.term_id)?.toString();
            const classId = (e.class_id?._id || e.class_id)?.toString();
            const subId = (e.subject_id?._id || e.subject_id)?.toString();

            await this.loadExamModalOptions(ayId, termId, classId, subId);

            document.getElementById('exam-id').value = e._id || e.id;
            document.getElementById('exam-name').value = e.name;
            document.getElementById('exam-type').value = e.type;
            document.getElementById('exam-date').value = e.exam_date ? e.exam_date.slice(0, 10) : '';
            document.getElementById('exam-total-marks').value = e.total_marks;
            document.getElementById('exam-status').value = e.status;
            document.getElementById('exam-modal-title').innerText = 'Edit Exam';
            document.getElementById('exam-modal').classList.remove('hidden');
        } catch (err) {
            this.showNotification(err.message, true);
        }
    },

    deleteExam(id, name) {
        this.showConfirm(`Delete exam "${name}"?`, 'This action cannot be undone.', async () => {
            try {
                const res = await fetch(`${API_URL}/exams/${id}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${this.token}` }
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Delete failed');
                this.showNotification('Exam deleted.');
                this.loadExams();
            } catch (err) {
                this.showNotification(err.message, true);
            }
        });
    },

    async saveExam(e) {
        e.preventDefault();
        if (this._submitting['exam']) return;
        this._submitting['exam'] = true;
        const btn = document.getElementById('exam-submit-btn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
        try {
            const id = document.getElementById('exam-id').value;
            const body = {
                name: document.getElementById('exam-name').value.trim(),
                type: document.getElementById('exam-type').value,
                academic_year_id: document.getElementById('exam-academic-year').value,
                term_id: document.getElementById('exam-term').value,
                class_id: document.getElementById('exam-class').value,
                subject_id: document.getElementById('exam-subject').value,
                exam_date: document.getElementById('exam-date').value,
                total_marks: Number(document.getElementById('exam-total-marks').value),
                status: document.getElementById('exam-status').value
            };
            const url = id ? `${API_URL}/exams/${id}` : `${API_URL}/exams`;
            const method = id ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Save failed');
            this.showNotification(id ? 'Exam updated.' : 'Exam created.');
            this.closeModal('exam-modal');
            this.loadExams();
        } catch (err) {
            this.showNotification(err.message, true);
        } finally {
            btn.innerHTML = orig;
            btn.disabled = false;
            this._submitting['exam'] = false;
        }
    },

    // ----------------------------------------------------------------
    // MARKS (P2 #3)
    // ----------------------------------------------------------------
    async loadMarks() {
        const tbody = document.getElementById('marks-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="8" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading...</td></tr>';
        try {
            const params = new URLSearchParams();
            const examId = document.getElementById('marks-filter-exam')?.value;
            const studentId = document.getElementById('marks-filter-student')?.value;

            if (examId) params.append('exam_id', examId);
            if (studentId) params.append('student_id', studentId);

            const url = `${API_URL}/marks${params.toString() ? '?' + params.toString() : ''}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error(await res.text());
            const marks = await res.json();

            if (!marks.length) {
                tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No marks found.</td></tr>';
                return;
            }

            tbody.innerHTML = marks.map(m => {
                const pct = m.exam_total_marks ? ((m.marks_obtained / m.exam_total_marks) * 100).toFixed(1) : '—';
                const pctClass = pct !== '—' ? (parseFloat(pct) >= 50 ? 'badge-success' : 'badge-danger') : 'badge-neutral';
                return `
                <tr>
                    <td><strong>${this.escapeHtml(m.student_name || '—')}</strong></td>
                    <td>${this.escapeHtml(m.student_id_number || '—')}</td>
                    <td>${this.escapeHtml(m.exam_name || '—')}</td>
                    <td>${this.escapeHtml(m.subject_name || '—')} ${m.subject_code ? `<small class="text-muted">(${this.escapeHtml(m.subject_code)})</small>` : ''}</td>
                    <td><strong>${m.marks_obtained}</strong> / ${m.exam_total_marks || '—'}</td>
                    <td><span class="badge ${pctClass}">${pct}%</span></td>
                    <td>${this.escapeHtml(m.remarks || '—')}</td>
                    <td class="action-btns">
                        <button class="btn-icon edit" title="Edit" onclick="app.editMark('${m._id || m.id}')"><i class="fa-solid fa-pencil"></i></button>
                        <button class="btn-icon delete" title="Delete" onclick="app.deleteMark('${m._id || m.id}', '${this.escapeHtml(m.student_name || 'Student')}')"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`;
            }).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="8" class="error-cell"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}</td></tr>`;
        }
    },

    async populateMarkFilters() {
        // Populate Exams filter
        try {
            const res = await fetch(`${API_URL}/exams`, { headers: { Authorization: `Bearer ${this.token}` } });
            const exams = await res.json();
            const sel = document.getElementById('marks-filter-exam');
            if (sel) {
                sel.innerHTML = '<option value="">All Exams</option>' + exams.map(e =>
                    `<option value="${e._id || e.id}">${this.escapeHtml(e.name)} (${this.escapeHtml(e.class_name || '')} - ${this.escapeHtml(e.subject_name || '')})</option>`).join('');
            }
        } catch (_) {}

        // Populate Students filter
        try {
            const res = await fetch(`${API_URL}/students`, { headers: { Authorization: `Bearer ${this.token}` } });
            const students = await res.json();
            const sel = document.getElementById('marks-filter-student');
            if (sel) {
                sel.innerHTML = '<option value="">All Students</option>' + students.map(s =>
                    `<option value="${s._id || s.id}">${this.escapeHtml(s.full_name)} (${this.escapeHtml(s.id_number || '')})</option>`).join('');
            }
        } catch (_) {}
    },

    async loadMarkModalOptions(selectedExam, selectedStudent) {
        // Load Exams
        try {
            const res = await fetch(`${API_URL}/exams`, { headers: { Authorization: `Bearer ${this.token}` } });
            const exams = await res.json();
            const sel = document.getElementById('mark-exam');
            if (sel) {
                sel.innerHTML = '<option value="">Select Exam</option>' + exams.map(e =>
                    `<option value="${e._id || e.id}" data-total="${e.total_marks}" ${(e._id || e.id) === selectedExam ? 'selected' : ''}>${this.escapeHtml(e.name)} (${this.escapeHtml(e.class_name || '')} - ${this.escapeHtml(e.subject_name || '')})</option>`).join('');
            }
            // Set total marks display if exam selected
            if (selectedExam && sel) {
                const opt = sel.querySelector(`option[value="${selectedExam}"]`);
                if (opt) document.getElementById('mark-total').value = opt.getAttribute('data-total') || '';
            }
        } catch (_) {}

        // Load Students
        try {
            const res = await fetch(`${API_URL}/students`, { headers: { Authorization: `Bearer ${this.token}` } });
            const students = await res.json();
            const sel = document.getElementById('mark-student');
            if (sel) {
                sel.innerHTML = '<option value="">Select Student</option>' + students.map(s =>
                    `<option value="${s._id || s.id}" ${(s._id || s.id) === selectedStudent ? 'selected' : ''}>${this.escapeHtml(s.full_name)} (${this.escapeHtml(s.id_number || '')})</option>`).join('');
            }
        } catch (_) {}
    },

    onMarkExamChange() {
        const sel = document.getElementById('mark-exam');
        const totalInput = document.getElementById('mark-total');
        if (sel && totalInput) {
            const opt = sel.selectedOptions[0];
            totalInput.value = opt ? (opt.getAttribute('data-total') || '') : '';
        }
    },

    async editMark(id) {
        try {
            const res = await fetch(`${API_URL}/marks/${id}`, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error('Failed to load mark details');
            const m = await res.json();

            const examId = (m.exam_id?._id || m.exam_id)?.toString();
            const studentId = (m.student_id?._id || m.student_id)?.toString();

            await this.loadMarkModalOptions(examId, studentId);

            document.getElementById('mark-id').value = m._id || m.id;
            document.getElementById('mark-obtained').value = m.marks_obtained;
            document.getElementById('mark-remarks').value = m.remarks || '';
            document.getElementById('mark-modal-title').innerText = 'Edit Mark';
            document.getElementById('mark-modal').classList.remove('hidden');
        } catch (err) {
            this.showNotification(err.message, true);
        }
    },

    deleteMark(id, name) {
        this.showConfirm(`Delete marks for "${name}"?`, 'This action cannot be undone.', async () => {
            try {
                const res = await fetch(`${API_URL}/marks/${id}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${this.token}` }
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Delete failed');
                this.showNotification('Mark deleted.');
                this.loadMarks();
            } catch (err) {
                this.showNotification(err.message, true);
            }
        });
    },

    async saveMark(e) {
        e.preventDefault();
        if (this._submitting['mark']) return;
        this._submitting['mark'] = true;
        const btn = document.getElementById('mark-submit-btn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
        try {
            const id = document.getElementById('mark-id').value;
            const body = {
                exam_id: document.getElementById('mark-exam').value,
                student_id: document.getElementById('mark-student').value,
                marks_obtained: Number(document.getElementById('mark-obtained').value),
                remarks: document.getElementById('mark-remarks').value.trim()
            };
            const url = id ? `${API_URL}/marks/${id}` : `${API_URL}/marks`;
            const method = id ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Save failed');
            this.showNotification(id ? 'Mark updated.' : 'Mark created.');
            this.closeModal('mark-modal');
            this.loadMarks();
        } catch (err) {
            this.showNotification(err.message, true);
        } finally {
            btn.innerHTML = orig;
            btn.disabled = false;
            this._submitting['mark'] = false;
        }
    },

    // ----------------------------------------------------------------
    // RESULTS (P2 #4)
    // ----------------------------------------------------------------
    _resultsMode: 'table', // 'table' or 'term'

    toggleResultsMode() {
        this._resultsMode = this._resultsMode === 'table' ? 'term' : 'table';
        const btn = document.getElementById('results-view-mode-btn');
        const tblContainer = document.getElementById('results-table-container');
        const termContainer = document.getElementById('results-term-container');

        if (this._resultsMode === 'term') {
            if (btn) btn.innerHTML = '<i class="fa-solid fa-table-list"></i> <span id="results-mode-label">Exam Table View</span>';
            if (tblContainer) tblContainer.classList.add('hidden');
            if (termContainer) termContainer.classList.remove('hidden');
            this.loadTermReport();
        } else {
            if (btn) btn.innerHTML = '<i class="fa-solid fa-graduation-cap"></i> <span id="results-mode-label">Term Report</span>';
            if (tblContainer) tblContainer.classList.remove('hidden');
            if (termContainer) termContainer.classList.add('hidden');
            this.loadResults();
        }
    },

    async populateResultFilters() {
        // Populate Students
        try {
            const res = await fetch(`${API_URL}/students`, { headers: { Authorization: `Bearer ${this.token}` } });
            const students = await res.json();
            const sel = document.getElementById('results-filter-student');
            if (sel) {
                sel.innerHTML = '<option value="">All Students</option>' + students.map(s =>
                    `<option value="${s._id || s.id}">${this.escapeHtml(s.full_name)} (${this.escapeHtml(s.id_number || '')})</option>`).join('');
            }
        } catch (_) {}

        // Populate Academic Years
        try {
            const res = await fetch(`${API_URL}/academic-years`, { headers: { Authorization: `Bearer ${this.token}` } });
            const years = await res.json();
            const sel = document.getElementById('results-filter-year');
            if (sel) {
                sel.innerHTML = '<option value="">All Academic Years</option>' + years.map(y =>
                    `<option value="${y._id || y.id}">${this.escapeHtml(y.name)}</option>`).join('');
            }
        } catch (_) {}

        // Populate Classes
        try {
            const res = await fetch(`${API_URL}/classes`, { headers: { Authorization: `Bearer ${this.token}` } });
            const classes = await res.json();
            const sel = document.getElementById('results-filter-class');
            if (sel) {
                sel.innerHTML = '<option value="">All Classes</option>' + classes.map(c =>
                    `<option value="${c._id || c.id}">${this.escapeHtml(c.name)}</option>`).join('');
            }
        } catch (_) {}

        // Populate Subjects
        try {
            const res = await fetch(`${API_URL}/subjects`, { headers: { Authorization: `Bearer ${this.token}` } });
            const subjects = await res.json();
            const sel = document.getElementById('results-filter-subject');
            if (sel) {
                sel.innerHTML = '<option value="">All Subjects</option>' + subjects.map(s =>
                    `<option value="${s._id || s.id}">${this.escapeHtml(s.name)} (${this.escapeHtml(s.code)})</option>`).join('');
            }
        } catch (_) {}

        // Populate Exams
        try {
            const res = await fetch(`${API_URL}/exams`, { headers: { Authorization: `Bearer ${this.token}` } });
            const exams = await res.json();
            const sel = document.getElementById('results-filter-exam');
            if (sel) {
                sel.innerHTML = '<option value="">All Exams</option>' + exams.map(e =>
                    `<option value="${e._id || e.id}">${this.escapeHtml(e.name)}</option>`).join('');
            }
        } catch (_) {}
    },

    async onResultAYChange() {
        const ayId = document.getElementById('results-filter-year')?.value;
        const termSel = document.getElementById('results-filter-term');
        if (termSel) {
            if (!ayId) {
                termSel.innerHTML = '<option value="">All Terms</option>';
            } else {
                try {
                    const res = await fetch(`${API_URL}/terms?academic_year_id=${ayId}`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const terms = await res.json();
                    termSel.innerHTML = '<option value="">All Terms</option>' + terms.map(t =>
                        `<option value="${t._id || t.id}">${this.escapeHtml(t.name)}</option>`).join('');
                } catch (_) {
                    termSel.innerHTML = '<option value="">All Terms</option>';
                }
            }
        }
        this.onResultFilterChange();
    },

    async onResultClassChange() {
        const classId = document.getElementById('results-filter-class')?.value;
        const ayId = document.getElementById('results-filter-year')?.value;
        const subSel = document.getElementById('results-filter-subject');
        if (subSel) {
            if (classId && ayId) {
                try {
                    const res = await fetch(`${API_URL}/class-subjects?class_id=${classId}&academic_year_id=${ayId}`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const csList = await res.json();
                    subSel.innerHTML = '<option value="">All Subjects</option>' + csList.map(cs =>
                        `<option value="${cs.subject_id?._id || cs.subject_id}">${this.escapeHtml(cs.subject_name || 'Subject')}</option>`).join('');
                } catch (_) {}
            } else {
                try {
                    const res = await fetch(`${API_URL}/subjects`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const subjects = await res.json();
                    subSel.innerHTML = '<option value="">All Subjects</option>' + subjects.map(s =>
                        `<option value="${s._id || s.id}">${this.escapeHtml(s.name)} (${this.escapeHtml(s.code)})</option>`).join('');
                } catch (_) {}
            }
        }
        this.onResultFilterChange();
    },

    onResultFilterChange() {
        if (this._resultsMode === 'term') {
            this.loadTermReport();
        } else {
            this.loadResults();
        }
    },

    getGradeBadgeClass(grade) {
        if (grade === 'A+' || grade === 'A') return 'badge-success';
        if (grade === 'B' || grade === 'C') return 'badge-info';
        if (grade === 'D') return 'badge-warning';
        if (grade === 'F') return 'badge-danger';
        return 'badge-neutral';
    },

    async loadResults() {
        const tbody = document.getElementById('results-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="8" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading results...</td></tr>';

        try {
            const params = new URLSearchParams();
            const studentId = document.getElementById('results-filter-student')?.value;
            const ayId = document.getElementById('results-filter-year')?.value;
            const termId = document.getElementById('results-filter-term')?.value;
            const classId = document.getElementById('results-filter-class')?.value;
            const subjectId = document.getElementById('results-filter-subject')?.value;
            const examId = document.getElementById('results-filter-exam')?.value;

            if (studentId) params.append('student_id', studentId);
            if (ayId) params.append('academic_year_id', ayId);
            if (termId) params.append('term_id', termId);
            if (classId) params.append('class_id', classId);
            if (subjectId) params.append('subject_id', subjectId);
            if (examId) params.append('exam_id', examId);

            const url = `${API_URL}/results${params.toString() ? '?' + params.toString() : ''}`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
            if (!res.ok) throw new Error(await res.text());
            const results = await res.json();

            if (!results.length) {
                tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">No results found for selected filters.</td></tr>';
                return;
            }

            tbody.innerHTML = results.map(r => {
                const gradeBadge = this.getGradeBadgeClass(r.grade);
                const statusBadge = r.is_pass ? 'badge-success' : 'badge-danger';
                return `
                <tr>
                    <td><strong>${this.escapeHtml(r.student_name || '—')}</strong><br><small class="text-muted">${this.escapeHtml(r.student_id_number || '')}</small></td>
                    <td>${this.escapeHtml(r.subject_name || '—')} ${r.subject_code ? `<small class="text-muted">(${this.escapeHtml(r.subject_code)})</small>` : ''}</td>
                    <td>${this.escapeHtml(r.exam_name || '—')}<br><small class="text-muted">${this.escapeHtml(r.exam_type || '')}</small></td>
                    <td><strong>${r.marks_obtained}</strong></td>
                    <td>${r.total_marks}</td>
                    <td><strong>${r.percentage.toFixed(2)}%</strong></td>
                    <td><span class="badge ${gradeBadge}">${r.grade}</span></td>
                    <td><span class="badge ${statusBadge}">${r.status}</span></td>
                </tr>`;
            }).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="8" class="error-cell"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}</td></tr>`;
        }
    },

    async loadTermReport() {
        const studentId = document.getElementById('results-filter-student')?.value;
        const termId = document.getElementById('results-filter-term')?.value;
        const tbody = document.getElementById('results-term-tbody');
        if (!tbody) return;

        if (!studentId || !termId) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Please select both a student and a term from the filters above to display the Term Result Report.</td></tr>';
            const nameEl = document.getElementById('term-report-student-name');
            if (nameEl) nameEl.innerText = 'Select a Student & Term';
            const ayEl = document.getElementById('term-report-ay');
            if (ayEl) ayEl.innerText = '—';
            const termEl = document.getElementById('term-report-term');
            if (termEl) termEl.innerText = '—';
            const idEl = document.getElementById('term-report-id-number');
            if (idEl) idEl.innerText = '—';
            const clsEl = document.getElementById('term-report-class');
            if (clsEl) clsEl.innerText = '—';
            const mEl = document.getElementById('term-stat-marks');
            if (mEl) mEl.innerText = '0 / 0';
            const pEl = document.getElementById('term-stat-percentage');
            if (pEl) pEl.innerText = '0%';
            const psEl = document.getElementById('term-stat-passed');
            if (psEl) psEl.innerText = '0';
            const fEl = document.getElementById('term-stat-failed');
            if (fEl) fEl.innerText = '0';
            const sEl = document.getElementById('term-stat-status');
            if (sEl) sEl.innerText = '—';
            return;
        }

        tbody.innerHTML = '<tr><td colspan="6" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Calculating term results...</td></tr>';

        try {
            const res = await fetch(`${API_URL}/results/student/${studentId}/term/${termId}`, {
                headers: { Authorization: `Bearer ${this.token}` }
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message || 'Failed to calculate term results');
            }
            const data = await res.json();

            // Populate Report Header
            const nameEl = document.getElementById('term-report-student-name');
            if (nameEl) nameEl.innerText = data.student?.full_name || 'Student';
            const ayEl = document.getElementById('term-report-ay');
            if (ayEl) ayEl.innerText = data.academic_year?.name || '—';
            const termEl = document.getElementById('term-report-term');
            if (termEl) termEl.innerText = data.term?.name || '—';
            const idEl = document.getElementById('term-report-id-number');
            if (idEl) idEl.innerText = data.student?.id_number || '—';
            const clsEl = document.getElementById('term-report-class');
            if (clsEl) clsEl.innerText = data.student?.class_name || '—';

            // Populate Summary Cards
            const mEl = document.getElementById('term-stat-marks');
            if (mEl) mEl.innerText = `${data.total_obtained} / ${data.total_possible}`;
            const pEl = document.getElementById('term-stat-percentage');
            if (pEl) pEl.innerText = `${data.overall_percentage.toFixed(2)}%`;
            const psEl = document.getElementById('term-stat-passed');
            if (psEl) psEl.innerText = String(data.pass_count);
            const fEl = document.getElementById('term-stat-failed');
            if (fEl) fEl.innerText = String(data.fail_count);

            const statusEl = document.getElementById('term-stat-status');
            if (statusEl) {
                statusEl.innerText = data.overall_status;
                statusEl.className = `stat-value ${data.overall_status === 'Pass' ? 'text-success' : (data.overall_status === 'Fail' ? 'text-danger' : '')}`;
            }

            // Populate Subject Rows
            if (!data.subject_results || !data.subject_results.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No recorded exam marks for this student in the selected term.</td></tr>';
                return;
            }

            tbody.innerHTML = data.subject_results.map(s => {
                const gradeBadge = this.getGradeBadgeClass(s.grade);
                const statusBadge = s.is_pass ? 'badge-success' : 'badge-danger';
                return `
                <tr>
                    <td><strong>${this.escapeHtml(s.subject_name || '—')}</strong> ${s.subject_code ? `<small class="text-muted">(${this.escapeHtml(s.subject_code)})</small>` : ''}</td>
                    <td><strong>${s.total_obtained}</strong></td>
                    <td>${s.total_possible}</td>
                    <td><strong>${s.percentage.toFixed(2)}%</strong></td>
                    <td><span class="badge ${gradeBadge}">${s.grade}</span></td>
                    <td><span class="badge ${statusBadge}">${s.status}</span></td>
                </tr>`;
            }).join('');
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" class="error-cell"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}</td></tr>`;
        }
    },

    // ----------------------------------------------------------------
    // REPORTS MANAGEMENT (P2 #5)
    // ----------------------------------------------------------------
    async populateReportFilters() {
        // 1. Populate Academic Years
        try {
            const res = await fetch(`${API_URL}/academic-years`, { headers: { Authorization: `Bearer ${this.token}` } });
            const years = await res.json();
            const sel = document.getElementById('reports-filter-year');
            if (sel) {
                sel.innerHTML = '<option value="">All Academic Years</option>' + years.map(y =>
                    `<option value="${y._id || y.id}">${this.escapeHtml(y.name)}</option>`).join('');
            }
        } catch (_) {}

        // 2. Populate Terms
        try {
            const res = await fetch(`${API_URL}/terms`, { headers: { Authorization: `Bearer ${this.token}` } });
            const terms = await res.json();
            const sel = document.getElementById('reports-filter-term');
            if (sel) {
                sel.innerHTML = '<option value="">All Terms</option>' + terms.map(t =>
                    `<option value="${t._id || t.id}">${this.escapeHtml(t.name)}</option>`).join('');
            }
        } catch (_) {}

        // 3. Populate Classes
        try {
            const res = await fetch(`${API_URL}/classes`, { headers: { Authorization: `Bearer ${this.token}` } });
            const classes = await res.json();
            const sel = document.getElementById('reports-filter-class');
            if (sel) {
                sel.innerHTML = '<option value="">All Classes</option>' + classes.map(c =>
                    `<option value="${c._id || c.id}">${this.escapeHtml(c.name)}</option>`).join('');
            }
        } catch (_) {}

        // 4. Populate Students
        try {
            const res = await fetch(`${API_URL}/students`, { headers: { Authorization: `Bearer ${this.token}` } });
            const students = await res.json();
            const sel = document.getElementById('reports-filter-student');
            if (sel) {
                sel.innerHTML = '<option value="">Select Student</option>' + students.map(s =>
                    `<option value="${s._id || s.id}">${this.escapeHtml(s.full_name)} (${this.escapeHtml(s.id_number || '')})</option>`).join('');
            }
        } catch (_) {}

        // 5. Populate Subjects
        try {
            const res = await fetch(`${API_URL}/subjects`, { headers: { Authorization: `Bearer ${this.token}` } });
            const subjects = await res.json();
            const sel = document.getElementById('reports-filter-subject');
            if (sel) {
                sel.innerHTML = '<option value="">All Subjects</option>' + subjects.map(s =>
                    `<option value="${s._id || s.id}">${this.escapeHtml(s.name)} (${this.escapeHtml(s.code)})</option>`).join('');
            }
        } catch (_) {}

        // 6. Populate Exams
        try {
            const res = await fetch(`${API_URL}/exams`, { headers: { Authorization: `Bearer ${this.token}` } });
            const exams = await res.json();
            const sel = document.getElementById('reports-filter-exam');
            if (sel) {
                sel.innerHTML = '<option value="">Select Exam</option>' + exams.map(e =>
                    `<option value="${e._id || e.id}">${this.escapeHtml(e.name)}</option>`).join('');
            }
        } catch (_) {}
    },

    async onReportAYChange() {
        const ayId = document.getElementById('reports-filter-year')?.value;
        const termSel = document.getElementById('reports-filter-term');
        if (termSel) {
            if (!ayId) {
                try {
                    const res = await fetch(`${API_URL}/terms`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const terms = await res.json();
                    termSel.innerHTML = '<option value="">All Terms</option>' + terms.map(t =>
                        `<option value="${t._id || t.id}">${this.escapeHtml(t.name)}</option>`).join('');
                } catch (_) {}
            } else {
                try {
                    const res = await fetch(`${API_URL}/terms?academic_year_id=${ayId}`, { headers: { Authorization: `Bearer ${this.token}` } });
                    const terms = await res.json();
                    termSel.innerHTML = '<option value="">All Terms</option>' + terms.map(t =>
                        `<option value="${t._id || t.id}">${this.escapeHtml(t.name)}</option>`).join('');
                } catch (_) {}
            }
        }
    },

    async onReportClassChange() {
        const classId = document.getElementById('reports-filter-class')?.value;
        const studentSel = document.getElementById('reports-filter-student');
        if (studentSel) {
            try {
                let url = `${API_URL}/students`;
                if (classId) {
                    const classDoc = (await (await fetch(`${API_URL}/classes`, { headers: { Authorization: `Bearer ${this.token}` } })).json()).find(c => (c._id || c.id) === classId);
                    if (classDoc) {
                        url += `?class_name=${encodeURIComponent(classDoc.name)}`;
                    }
                }
                const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
                const students = await res.json();
                studentSel.innerHTML = '<option value="">Select Student</option>' + students.map(s =>
                    `<option value="${s._id || s.id}">${this.escapeHtml(s.full_name)} (${this.escapeHtml(s.id_number || '')})</option>`).join('');
            } catch (_) {}
        }
    },

    onReportTypeChange() {
        const type = document.getElementById('reports-type-select')?.value || 'student';
        const gYear = document.getElementById('reports-group-year');
        const gTerm = document.getElementById('reports-group-term');
        const gClass = document.getElementById('reports-group-class');
        const gStudent = document.getElementById('reports-group-student');
        const gSubject = document.getElementById('reports-group-subject');
        const gExam = document.getElementById('reports-group-exam');

        if (gYear) gYear.style.display = 'block';
        if (gTerm) gTerm.style.display = 'block';

        if (type === 'student') {
            if (gClass) gClass.style.display = 'block';
            if (gStudent) gStudent.style.display = 'block';
            if (gSubject) gSubject.style.display = 'none';
            if (gExam) gExam.style.display = 'none';
        } else if (type === 'class') {
            if (gClass) gClass.style.display = 'block';
            if (gStudent) gStudent.style.display = 'none';
            if (gSubject) gSubject.style.display = 'block';
            if (gExam) gExam.style.display = 'none';
        } else if (type === 'term') {
            if (gClass) gClass.style.display = 'block';
            if (gStudent) gStudent.style.display = 'none';
            if (gSubject) gSubject.style.display = 'none';
            if (gExam) gExam.style.display = 'none';
        } else if (type === 'exam') {
            if (gClass) gClass.style.display = 'none';
            if (gStudent) gStudent.style.display = 'none';
            if (gSubject) gSubject.style.display = 'none';
            if (gExam) gExam.style.display = 'block';
            if (gYear) gYear.style.display = 'none';
            if (gTerm) gTerm.style.display = 'none';
        }
    },

    resetReportFilters() {
        const typeSel = document.getElementById('reports-type-select');
        if (typeSel) typeSel.value = 'student';
        const ySel = document.getElementById('reports-filter-year');
        if (ySel) ySel.value = '';
        const tSel = document.getElementById('reports-filter-term');
        if (tSel) tSel.value = '';
        const cSel = document.getElementById('reports-filter-class');
        if (cSel) cSel.value = '';
        const sSel = document.getElementById('reports-filter-student');
        if (sSel) sSel.value = '';
        const subSel = document.getElementById('reports-filter-subject');
        if (subSel) subSel.value = '';
        const eSel = document.getElementById('reports-filter-exam');
        if (eSel) eSel.value = '';

        this.onReportTypeChange();

        const empty = document.getElementById('reports-empty-state');
        const loading = document.getElementById('reports-loading-state');
        const content = document.getElementById('reports-content-container');
        if (empty) empty.classList.remove('hidden');
        if (loading) loading.classList.add('hidden');
        if (content) {
            content.classList.add('hidden');
            content.innerHTML = '';
        }
    },

    async generateReport() {
        const type = document.getElementById('reports-type-select')?.value || 'student';
        const empty = document.getElementById('reports-empty-state');
        const loading = document.getElementById('reports-loading-state');
        const content = document.getElementById('reports-content-container');

        if (empty) empty.classList.add('hidden');
        if (loading) loading.classList.remove('hidden');
        if (content) {
            content.classList.add('hidden');
            content.innerHTML = '';
        }

        try {
            if (type === 'student') {
                const studentId = document.getElementById('reports-filter-student')?.value;
                if (!studentId) {
                    throw new Error('Please select a student to generate the student report.');
                }
                const ayId = document.getElementById('reports-filter-year')?.value;
                const termId = document.getElementById('reports-filter-term')?.value;

                let url = `${API_URL}/reports/student/${studentId}`;
                const q = [];
                if (ayId) q.push(`academic_year_id=${ayId}`);
                if (termId) q.push(`term_id=${termId}`);
                if (q.length) url += `?${q.join('&')}`;

                const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Failed to fetch student report');

                this.renderStudentReport(data);
            } else if (type === 'class') {
                const classId = document.getElementById('reports-filter-class')?.value;
                if (!classId) {
                    throw new Error('Please select a class to generate the class report.');
                }
                const ayId = document.getElementById('reports-filter-year')?.value;
                const termId = document.getElementById('reports-filter-term')?.value;
                const subId = document.getElementById('reports-filter-subject')?.value;

                let url = `${API_URL}/reports/class/${classId}`;
                const q = [];
                if (ayId) q.push(`academic_year_id=${ayId}`);
                if (termId) q.push(`term_id=${termId}`);
                if (subId) q.push(`subject_id=${subId}`);
                if (q.length) url += `?${q.join('&')}`;

                const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Failed to fetch class report');

                this.renderClassReport(data);
            } else if (type === 'term') {
                const termId = document.getElementById('reports-filter-term')?.value;
                if (!termId) {
                    throw new Error('Please select a term to generate the term report.');
                }
                const classId = document.getElementById('reports-filter-class')?.value;

                let url = `${API_URL}/reports/term/${termId}`;
                if (classId) url += `?class_id=${classId}`;

                const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Failed to fetch term report');

                this.renderTermReport(data);
            } else if (type === 'exam') {
                const examId = document.getElementById('reports-filter-exam')?.value;
                if (!examId) {
                    throw new Error('Please select an exam to generate the exam report.');
                }

                const res = await fetch(`${API_URL}/reports/exam/${examId}`, { headers: { Authorization: `Bearer ${this.token}` } });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Failed to fetch exam report');

                this.renderExamReport(data);
            }
        } catch (err) {
            if (content) {
                content.innerHTML = `<div class="error-cell" style="padding:var(--space-6);"><i class="fa-solid fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}</div>`;
                content.classList.remove('hidden');
            }
        } finally {
            if (loading) loading.classList.add('hidden');
        }
    },

    renderStudentReport(data) {
        const content = document.getElementById('reports-content-container');
        if (!content) return;

        const summary = data.summary || {};
        const student = data.student || {};
        const ay = data.academic_year?.name || '—';
        const term = data.term?.name || '—';

        const gradeBadge = this.getGradeBadgeClass(summary.overall_grade);
        const statusBadge = summary.overall_status === 'Pass' ? 'badge-success' : (summary.overall_status === 'Fail' ? 'badge-danger' : 'badge-neutral');

        let subjectsHtml = '';
        if (!data.subjects || !data.subjects.length) {
            subjectsHtml = '<tr><td colspan="6" class="empty-cell">No marks recorded for this student.</td></tr>';
        } else {
            subjectsHtml = data.subjects.map(s => {
                const subGradeBadge = this.getGradeBadgeClass(s.grade);
                const subStatusBadge = s.is_pass ? 'badge-success' : 'badge-danger';
                return `
                <tr>
                    <td><strong>${this.escapeHtml(s.subject_name)}</strong> ${s.subject_code ? `<small class="text-muted">(${this.escapeHtml(s.subject_code)})</small>` : ''}</td>
                    <td><strong>${s.marks_obtained}</strong></td>
                    <td>${s.total_marks}</td>
                    <td><strong>${s.percentage.toFixed(2)}%</strong></td>
                    <td><span class="badge ${subGradeBadge}">${s.grade}</span></td>
                    <td><span class="badge ${subStatusBadge}">${s.status}</span></td>
                </tr>`;
            }).join('');
        }

        content.innerHTML = `
            <div style="background:var(--bg-elevated);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:var(--space-5);margin-bottom:var(--space-4);">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:var(--space-3);border-bottom:1px solid var(--border-primary);padding-bottom:var(--space-3);margin-bottom:var(--space-3);">
                    <div>
                        <span style="font-size:var(--text-xs);font-weight:700;letter-spacing:1px;color:var(--text-muted);text-transform:uppercase;">Student Academic Report</span>
                        <h2 style="margin:4px 0 0 0;font-size:var(--text-xl);">${this.escapeHtml(student.full_name || '—')}</h2>
                    </div>
                    <div style="text-align:right;">
                        <span class="badge ${statusBadge}" style="font-size:var(--text-sm);padding:4px 10px;">${summary.overall_status || '—'}</span>
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:var(--space-3);font-size:var(--text-sm);color:var(--text-secondary);">
                    <div><strong>Student ID:</strong> ${this.escapeHtml(student.id_number || student.id || '—')}</div>
                    <div><strong>Class:</strong> ${this.escapeHtml(student.class_name || '—')}</div>
                    <div><strong>Academic Year:</strong> ${this.escapeHtml(ay)}</div>
                    <div><strong>Term:</strong> ${this.escapeHtml(term)}</div>
                </div>
            </div>

            <div class="stats-grid" style="margin-bottom:var(--space-5);">
                <div class="stat-card">
                    <div class="stat-icon bg-blue"><i class="fa-solid fa-calculator"></i></div>
                    <div class="stat-details">
                        <h3>Total Marks</h3>
                        <div class="stat-value">${summary.total_obtained || 0} / ${summary.total_possible || 0}</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-purple"><i class="fa-solid fa-percent"></i></div>
                    <div class="stat-details">
                        <h3>Percentage</h3>
                        <div class="stat-value">${(summary.overall_percentage || 0).toFixed(2)}%</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-neutral"><i class="fa-solid fa-award"></i></div>
                    <div class="stat-details">
                        <h3>Overall Grade</h3>
                        <div class="stat-value"><span class="badge ${gradeBadge}">${summary.overall_grade || 'N/A'}</span></div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-green"><i class="fa-solid fa-check-double"></i></div>
                    <div class="stat-details">
                        <h3>Passed Subjects</h3>
                        <div class="stat-value text-success">${summary.passed_subjects || 0}</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-orange"><i class="fa-solid fa-circle-xmark"></i></div>
                    <div class="stat-details">
                        <h3>Failed Subjects</h3>
                        <div class="stat-value ${summary.failed_subjects > 0 ? 'text-danger' : ''}">${summary.failed_subjects || 0}</div>
                    </div>
                </div>
            </div>

            <div class="table-wrapper">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Subject</th>
                            <th>Obtained</th>
                            <th>Total</th>
                            <th>%</th>
                            <th>Grade</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>${subjectsHtml}</tbody>
                </table>
            </div>
        `;
        content.classList.remove('hidden');
    },

    renderClassReport(data) {
        const content = document.getElementById('reports-content-container');
        if (!content) return;

        const summary = data.summary || {};
        const cls = data.class || {};
        const ay = data.academic_year?.name || 'All Academic Years';
        const term = data.term?.name || 'All Terms';

        let subHtml = '';
        if (!data.subject_performance || !data.subject_performance.length) {
            subHtml = '<tr><td colspan="7" class="empty-cell">No subject performance data available.</td></tr>';
        } else {
            subHtml = data.subject_performance.map(s => `
                <tr>
                    <td><strong>${this.escapeHtml(s.subject_name)}</strong> ${s.subject_code ? `<small class="text-muted">(${this.escapeHtml(s.subject_code)})</small>` : ''}</td>
                    <td>${s.total_obtained} / ${s.total_possible}</td>
                    <td><strong>${s.average_percentage.toFixed(2)}%</strong></td>
                    <td class="text-success"><strong>${s.pass_count}</strong></td>
                    <td class="${s.fail_count > 0 ? 'text-danger' : ''}"><strong>${s.fail_count}</strong></td>
                    <td>${s.highest_percentage.toFixed(2)}%</td>
                    <td>${s.lowest_percentage.toFixed(2)}%</td>
                </tr>
            `).join('');
        }

        let studentHtml = '';
        if (!data.student_performance || !data.student_performance.length) {
            studentHtml = '<tr><td colspan="7" class="empty-cell">No students enrolled or recorded with marks in this class.</td></tr>';
        } else {
            studentHtml = data.student_performance.map(st => {
                const gBadge = this.getGradeBadgeClass(st.grade);
                const sBadge = st.is_pass ? 'badge-success' : (st.status === 'No Marks' ? 'badge-neutral' : 'badge-danger');
                return `
                <tr>
                    <td><strong>${this.escapeHtml(st.full_name)}</strong></td>
                    <td>${this.escapeHtml(st.id_number || '—')}</td>
                    <td>${st.total_obtained}</td>
                    <td>${st.total_possible}</td>
                    <td><strong>${st.percentage.toFixed(2)}%</strong></td>
                    <td><span class="badge ${gBadge}">${st.grade}</span></td>
                    <td><span class="badge ${sBadge}">${st.status}</span></td>
                </tr>`;
            }).join('');
        }

        content.innerHTML = `
            <div style="background:var(--bg-elevated);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:var(--space-5);margin-bottom:var(--space-4);">
                <div style="border-bottom:1px solid var(--border-primary);padding-bottom:var(--space-3);margin-bottom:var(--space-3);">
                    <span style="font-size:var(--text-xs);font-weight:700;letter-spacing:1px;color:var(--text-muted);text-transform:uppercase;">Class Performance Report</span>
                    <h2 style="margin:4px 0 0 0;font-size:var(--text-xl);">Class: ${this.escapeHtml(cls.name || '—')}</h2>
                </div>
                <div style="display:flex;gap:var(--space-4);flex-wrap:wrap;font-size:var(--text-sm);color:var(--text-secondary);">
                    <span><strong>Academic Year:</strong> ${this.escapeHtml(ay)}</span>
                    <span><strong>Term:</strong> ${this.escapeHtml(term)}</span>
                </div>
            </div>

            <div class="stats-grid" style="margin-bottom:var(--space-5);">
                <div class="stat-card">
                    <div class="stat-icon bg-blue"><i class="fa-solid fa-users"></i></div>
                    <div class="stat-details">
                        <h3>Students (Total / Tested)</h3>
                        <div class="stat-value">${summary.total_students || 0} / ${summary.students_with_marks || 0}</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-purple"><i class="fa-solid fa-chart-line"></i></div>
                    <div class="stat-details">
                        <h3>Class Average</h3>
                        <div class="stat-value">${(summary.average_percentage || 0).toFixed(2)}%</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-green"><i class="fa-solid fa-arrow-trend-up"></i></div>
                    <div class="stat-details">
                        <h3>Highest / Lowest</h3>
                        <div class="stat-value" style="font-size:var(--text-base);">${(summary.highest_percentage || 0).toFixed(1)}% / ${(summary.lowest_percentage || 0).toFixed(1)}%</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-orange"><i class="fa-solid fa-user-check"></i></div>
                    <div class="stat-details">
                        <h3>Pass / Fail Count</h3>
                        <div class="stat-value"><span class="text-success">${summary.pass_count || 0}</span> / <span class="text-danger">${summary.fail_count || 0}</span></div>
                    </div>
                </div>
            </div>

            <h3 style="margin-bottom:var(--space-3);font-size:var(--text-base);">Subject Performance</h3>
            <div class="table-wrapper" style="margin-bottom:var(--space-5);">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Subject</th>
                            <th>Total Marks</th>
                            <th>Average %</th>
                            <th>Passed</th>
                            <th>Failed</th>
                            <th>Highest %</th>
                            <th>Lowest %</th>
                        </tr>
                    </thead>
                    <tbody>${subHtml}</tbody>
                </table>
            </div>

            <h3 style="margin-bottom:var(--space-3);font-size:var(--text-base);">Student Performance</h3>
            <div class="table-wrapper">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Student</th>
                            <th>ID Number</th>
                            <th>Obtained</th>
                            <th>Total</th>
                            <th>Percentage</th>
                            <th>Grade</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>${studentHtml}</tbody>
                </table>
            </div>
        `;
        content.classList.remove('hidden');
    },

    renderTermReport(data) {
        const content = document.getElementById('reports-content-container');
        if (!content) return;

        const summary = data.summary || {};
        const term = data.term || {};
        const ay = data.academic_year?.name || '—';
        const cls = data.class?.name ? `Class: ${data.class.name}` : 'All Classes';

        let classRows = '';
        if (!data.class_performance || !data.class_performance.length) {
            classRows = '<tr><td colspan="7" class="empty-cell">No class records for this term.</td></tr>';
        } else {
            classRows = data.class_performance.map(c => `
                <tr>
                    <td><strong>${this.escapeHtml(c.class_name)}</strong></td>
                    <td>${c.students_count}</td>
                    <td>${c.total_obtained} / ${c.total_possible}</td>
                    <td><strong>${c.average_percentage.toFixed(2)}%</strong></td>
                    <td class="text-success"><strong>${c.pass_count}</strong></td>
                    <td class="${c.fail_count > 0 ? 'text-danger' : ''}"><strong>${c.fail_count}</strong></td>
                </tr>
            `).join('');
        }

        let subjectRows = '';
        if (!data.subject_performance || !data.subject_performance.length) {
            subjectRows = '<tr><td colspan="6" class="empty-cell">No subject records for this term.</td></tr>';
        } else {
            subjectRows = data.subject_performance.map(s => `
                <tr>
                    <td><strong>${this.escapeHtml(s.subject_name)}</strong> ${s.subject_code ? `<small class="text-muted">(${this.escapeHtml(s.subject_code)})</small>` : ''}</td>
                    <td>${s.exams_count}</td>
                    <td>${s.total_obtained} / ${s.total_possible}</td>
                    <td><strong>${s.average_percentage.toFixed(2)}%</strong></td>
                    <td class="text-success"><strong>${s.pass_count}</strong></td>
                    <td class="${s.fail_count > 0 ? 'text-danger' : ''}"><strong>${s.fail_count}</strong></td>
                </tr>
            `).join('');
        }

        content.innerHTML = `
            <div style="background:var(--bg-elevated);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:var(--space-5);margin-bottom:var(--space-4);">
                <div style="border-bottom:1px solid var(--border-primary);padding-bottom:var(--space-3);margin-bottom:var(--space-3);">
                    <span style="font-size:var(--text-xs);font-weight:700;letter-spacing:1px;color:var(--text-muted);text-transform:uppercase;">Term Summary Report</span>
                    <h2 style="margin:4px 0 0 0;font-size:var(--text-xl);">Term: ${this.escapeHtml(term.name || '—')}</h2>
                </div>
                <div style="display:flex;gap:var(--space-4);flex-wrap:wrap;font-size:var(--text-sm);color:var(--text-secondary);">
                    <span><strong>Academic Year:</strong> ${this.escapeHtml(ay)}</span>
                    <span><strong>Scope:</strong> ${this.escapeHtml(cls)}</span>
                </div>
            </div>

            <div class="stats-grid" style="margin-bottom:var(--space-5);">
                <div class="stat-card">
                    <div class="stat-icon bg-blue"><i class="fa-solid fa-graduation-cap"></i></div>
                    <div class="stat-details">
                        <h3>Students Evaluated</h3>
                        <div class="stat-value">${summary.number_of_students || 0}</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-purple"><i class="fa-solid fa-book-open"></i></div>
                    <div class="stat-details">
                        <h3>Subjects / Exams</h3>
                        <div class="stat-value">${summary.number_of_subjects || 0} / ${summary.number_of_exams || 0}</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-green"><i class="fa-solid fa-chart-pie"></i></div>
                    <div class="stat-details">
                        <h3>Average Percentage</h3>
                        <div class="stat-value">${(summary.average_percentage || 0).toFixed(2)}%</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-orange"><i class="fa-solid fa-award"></i></div>
                    <div class="stat-details">
                        <h3>Pass / Fail Ratio</h3>
                        <div class="stat-value"><span class="text-success">${summary.pass_count || 0}</span> / <span class="text-danger">${summary.fail_count || 0}</span></div>
                    </div>
                </div>
            </div>

            <h3 style="margin-bottom:var(--space-3);font-size:var(--text-base);">Class Breakdown</h3>
            <div class="table-wrapper" style="margin-bottom:var(--space-5);">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Class</th>
                            <th>Students</th>
                            <th>Total Marks</th>
                            <th>Average %</th>
                            <th>Pass</th>
                            <th>Fail</th>
                        </tr>
                    </thead>
                    <tbody>${classRows}</tbody>
                </table>
            </div>

            <h3 style="margin-bottom:var(--space-3);font-size:var(--text-base);">Subject Breakdown</h3>
            <div class="table-wrapper">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Subject</th>
                            <th>Exams</th>
                            <th>Total Marks</th>
                            <th>Average %</th>
                            <th>Pass</th>
                            <th>Fail</th>
                        </tr>
                    </thead>
                    <tbody>${subjectRows}</tbody>
                </table>
            </div>
        `;
        content.classList.remove('hidden');
    },

    renderExamReport(data) {
        const content = document.getElementById('reports-content-container');
        if (!content) return;

        const perf = data.performance || {};
        const exam = data.exam || {};

        let studentRows = '';
        if (!data.students || !data.students.length) {
            studentRows = '<tr><td colspan="7" class="empty-cell">No student marks recorded for this exam.</td></tr>';
        } else {
            studentRows = data.students.map(st => {
                const gBadge = this.getGradeBadgeClass(st.grade);
                const sBadge = st.is_pass ? 'badge-success' : 'badge-danger';
                return `
                <tr>
                    <td><strong>${this.escapeHtml(st.student_name)}</strong></td>
                    <td>${this.escapeHtml(st.id_number || '—')}</td>
                    <td><strong>${st.marks_obtained}</strong></td>
                    <td>${st.total_marks}</td>
                    <td><strong>${st.percentage.toFixed(2)}%</strong></td>
                    <td><span class="badge ${gBadge}">${st.grade}</span></td>
                    <td><span class="badge ${sBadge}">${st.status}</span></td>
                </tr>`;
            }).join('');
        }

        content.innerHTML = `
            <div style="background:var(--bg-elevated);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:var(--space-5);margin-bottom:var(--space-4);">
                <div style="border-bottom:1px solid var(--border-primary);padding-bottom:var(--space-3);margin-bottom:var(--space-3);">
                    <span style="font-size:var(--text-xs);font-weight:700;letter-spacing:1px;color:var(--text-muted);text-transform:uppercase;">Exam Analysis Report</span>
                    <h2 style="margin:4px 0 0 0;font-size:var(--text-xl);">${this.escapeHtml(exam.name || '—')} <span class="badge badge-info" style="font-size:var(--text-xs);">${this.escapeHtml(exam.type || 'Exam')}</span></h2>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:var(--space-3);font-size:var(--text-sm);color:var(--text-secondary);">
                    <div><strong>Class:</strong> ${this.escapeHtml(exam.class?.name || '—')}</div>
                    <div><strong>Subject:</strong> ${this.escapeHtml(exam.subject?.name || '—')}</div>
                    <div><strong>Date:</strong> ${this.escapeHtml(exam.exam_date || '—')}</div>
                    <div><strong>Max Marks:</strong> ${exam.total_marks || '—'}</div>
                </div>
            </div>

            <div class="stats-grid" style="margin-bottom:var(--space-5);">
                <div class="stat-card">
                    <div class="stat-icon bg-blue"><i class="fa-solid fa-users"></i></div>
                    <div class="stat-details">
                        <h3>Students (Class / Marks)</h3>
                        <div class="stat-value">${perf.number_of_students || 0} / ${perf.number_with_marks || 0}</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-purple"><i class="fa-solid fa-calculator"></i></div>
                    <div class="stat-details">
                        <h3>Average (Score / %)</h3>
                        <div class="stat-value">${(perf.average_mark || 0).toFixed(1)} (${(perf.average_percentage || 0).toFixed(1)}%)</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-green"><i class="fa-solid fa-trophy"></i></div>
                    <div class="stat-details">
                        <h3>High / Low Score</h3>
                        <div class="stat-value">${perf.highest_mark || 0} / ${perf.lowest_mark || 0}</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon bg-orange"><i class="fa-solid fa-check"></i></div>
                    <div class="stat-details">
                        <h3>Pass / Fail Count</h3>
                        <div class="stat-value"><span class="text-success">${perf.pass_count || 0}</span> / <span class="text-danger">${perf.fail_count || 0}</span></div>
                    </div>
                </div>
            </div>

            <h3 style="margin-bottom:var(--space-3);font-size:var(--text-base);">Student Marks Roster</h3>
            <div class="table-wrapper">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Student</th>
                            <th>ID Number</th>
                            <th>Marks Obtained</th>
                            <th>Total Marks</th>
                            <th>Percentage</th>
                            <th>Grade</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>${studentRows}</tbody>
                </table>
            </div>
        `;
        content.classList.remove('hidden');
    },

    /* =========================================================
       USER MANAGEMENT (P2 #6)
       ========================================================= */
    async loadUsers() {
        const tbody = document.getElementById('users-tbody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="7" class="loading-cell"><i class="fa-solid fa-spinner fa-spin"></i> Loading users...</td></tr>';
        }
        try {
            const res = await fetch(`${API_URL}/users`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (res.status === 401) {
                this.logout();
                return;
            }
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                this.showNotification(errData.message || 'Failed to load users', true);
                if (tbody) {
                    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:var(--space-6);color:var(--text-danger);"><i class="fa-solid fa-circle-exclamation"></i> ${this.escapeHtml(errData.message || 'Access denied or failed to load users.')}</td></tr>`;
                }
                return;
            }
            const data = await res.json();
            this._users = Array.isArray(data) ? data : [];
            this.filterUsers();
        } catch (err) {
            this.showNotification('Network error loading users', true);
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:var(--space-6);color:var(--text-danger);"><i class="fa-solid fa-triangle-exclamation"></i> Network error loading users.</td></tr>';
            }
        }
    },

    filterUsers() {
        const searchInput = document.getElementById('users-search');
        const roleFilter = document.getElementById('users-filter-role');
        const statusFilter = document.getElementById('users-filter-status');
        const countEl = document.getElementById('users-count');

        const searchVal = searchInput ? searchInput.value.trim().toLowerCase() : '';
        const roleVal = roleFilter ? roleFilter.value : '';
        const statusVal = statusFilter ? statusFilter.value : '';

        let filtered = (this._users || []).filter(u => {
            if (roleVal && u.role !== roleVal) return false;
            const uStatus = u.status || 'active';
            if (statusVal && uStatus !== statusVal) return false;
            if (searchVal) {
                const usernameMatch = (u.username || '').toLowerCase().includes(searchVal);
                const emailMatch = (u.email || '').toLowerCase().includes(searchVal);
                return usernameMatch || emailMatch;
            }
            return true;
        });

        if (countEl) {
            countEl.textContent = `${filtered.length} user${filtered.length === 1 ? '' : 's'}`;
        }

        this.renderUsersTable(filtered);
    },

    renderUsersTable(users) {
        const tbody = document.getElementById('users-tbody');
        if (!tbody) return;

        if (!users || users.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7">
                        <div class="empty-state">
                            <i class="fa-solid fa-users-slash"></i>
                            <h3>No users found</h3>
                            <p>No user accounts match your selected criteria.</p>
                        </div>
                    </td>
                </tr>`;
            const pag = document.getElementById('users-pagination');
            if (pag) pag.innerHTML = '';
            return;
        }

        // Pagination
        const pagState = this._pagination.users || { page: 1, perPage: 10 };
        const totalPages = Math.max(1, Math.ceil(users.length / pagState.perPage));
        if (pagState.page > totalPages) pagState.page = totalPages;
        const start = (pagState.page - 1) * pagState.perPage;
        const pageUsers = users.slice(start, start + pagState.perPage);

        tbody.innerHTML = pageUsers.map(u => {
            const roleBadge = u.role === 'admin'
                ? '<span class="badge badge-danger">Administrator</span>'
                : u.role === 'teacher'
                    ? '<span class="badge badge-info">Teacher</span>'
                    : '<span class="badge badge-neutral">Student</span>';

            const uStatus = u.status || 'active';
            const statusBadge = uStatus === 'active'
                ? '<span class="badge badge-success">Active</span>'
                : '<span class="badge badge-danger">Inactive</span>';

            let linkedEntity = '<span class="text-muted">—</span>';
            if (u.role === 'student' && u.student_id) {
                const s = u.student_id;
                linkedEntity = `<span title="${this.escapeHtml(s.id_number || '')}"><i class="fa-solid fa-user-graduate" style="margin-right:4px;color:var(--primary-color);"></i>${this.escapeHtml(s.full_name || 'Student')} <small class="text-muted">(${this.escapeHtml(s.id_number || '—')})</small></span>`;
            } else if (u.role === 'teacher' && u.teacher_id) {
                const t = u.teacher_id;
                linkedEntity = `<span title="${this.escapeHtml(t.subject || '')}"><i class="fa-solid fa-chalkboard-user" style="margin-right:4px;color:var(--info-color);"></i>${this.escapeHtml(t.name || 'Teacher')} <small class="text-muted">(${this.escapeHtml(t.subject || '—')})</small></span>`;
            }

            const createdDate = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—';

            const statusToggleBtn = uStatus === 'active'
                ? `<button class="btn-icon text-warning" onclick="app.toggleUserStatus('${u.id}', '${uStatus}', '${this.escapeHtml(u.username)}')" title="Deactivate Account" aria-label="Deactivate Account"><i class="fa-solid fa-user-slash"></i></button>`
                : `<button class="btn-icon text-success" onclick="app.toggleUserStatus('${u.id}', '${uStatus}', '${this.escapeHtml(u.username)}')" title="Activate Account" aria-label="Activate Account"><i class="fa-solid fa-user-check"></i></button>`;

            return `
                <tr>
                    <td><strong>${this.escapeHtml(u.username || '')}</strong></td>
                    <td>${this.escapeHtml(u.email || '—')}</td>
                    <td>${roleBadge}</td>
                    <td>${linkedEntity}</td>
                    <td>${statusBadge}</td>
                    <td><small class="text-secondary">${this.escapeHtml(createdDate)}</small></td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn-icon" onclick="app.openUserModal('${u.id}')" title="Edit User" aria-label="Edit User">
                                <i class="fa-solid fa-pen-to-square"></i>
                            </button>
                            <button class="btn-icon" onclick="app.openResetPasswordModal('${u.id}', '${this.escapeHtml(u.username)}')" title="Reset Password" aria-label="Reset Password">
                                <i class="fa-solid fa-key"></i>
                            </button>
                            ${statusToggleBtn}
                        </div>
                    </td>
                </tr>`;
        }).join('');

        this.renderPagination('users', users.length, totalPages);
    },

    async openUserModal(userId = null) {
        const form = document.getElementById('user-form');
        const title = document.getElementById('user-modal-title');
        const idInput = document.getElementById('user-id');
        const usernameInput = document.getElementById('user-username');
        const emailInput = document.getElementById('user-email');
        const roleSelect = document.getElementById('user-role');
        const studentSelect = document.getElementById('user-student');
        const teacherSelect = document.getElementById('user-teacher');
        const passwordInput = document.getElementById('user-password');
        const passwordReq = document.getElementById('user-password-req');
        const passwordHint = document.getElementById('user-password-hint');
        const statusSelect = document.getElementById('user-status');

        if (form) form.reset();

        // Populate student and teacher select options
        await this.populateUserEntityOptions();

        if (userId) {
            // Edit mode
            title.textContent = 'Edit User';
            idInput.value = userId;
            const user = (this._users || []).find(u => u.id === userId);
            if (user) {
                usernameInput.value = user.username || '';
                emailInput.value = user.email || '';
                roleSelect.value = user.role || 'student';
                statusSelect.value = user.status || 'active';
                if (studentSelect && user.student_id) {
                    studentSelect.value = typeof user.student_id === 'object' ? user.student_id._id : user.student_id;
                }
                if (teacherSelect && user.teacher_id) {
                    teacherSelect.value = typeof user.teacher_id === 'object' ? user.teacher_id._id : user.teacher_id;
                }
            }
            if (passwordReq) passwordReq.style.display = 'none';
            if (passwordInput) {
                passwordInput.required = false;
                passwordInput.placeholder = 'Leave blank to preserve';
            }
            if (passwordHint) passwordHint.style.display = 'block';
        } else {
            // Create mode
            title.textContent = 'Add User';
            idInput.value = '';
            roleSelect.value = 'student';
            statusSelect.value = 'active';
            if (passwordReq) passwordReq.style.display = 'inline';
            if (passwordInput) {
                passwordInput.required = false;
                passwordInput.placeholder = 'Optional or min 6 characters';
            }
            if (passwordHint) passwordHint.style.display = 'none';
        }

        this.onUserRoleChange();
        this.showModal('user-modal');
    },

    onUserRoleChange() {
        const roleSelect = document.getElementById('user-role');
        const studentGroup = document.getElementById('user-student-group');
        const teacherGroup = document.getElementById('user-teacher-group');
        const role = roleSelect ? roleSelect.value : 'student';

        if (studentGroup) {
            if (role === 'student') studentGroup.classList.remove('hidden');
            else studentGroup.classList.add('hidden');
        }
        if (teacherGroup) {
            if (role === 'teacher') teacherGroup.classList.remove('hidden');
            else teacherGroup.classList.add('hidden');
        }
    },

    async populateUserEntityOptions() {
        const studentSelect = document.getElementById('user-student');
        const teacherSelect = document.getElementById('user-teacher');

        // Fetch students if not already cached
        try {
            if (!this._students || this._students.length === 0) {
                const sRes = await fetch(`${API_URL}/students`, {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                if (sRes.ok) this._students = await sRes.json();
            }
            if (studentSelect) {
                studentSelect.innerHTML = '<option value="">No Student Linked</option>' +
                    (this._students || []).map(s => `<option value="${s.id || s._id}">${this.escapeHtml(s.full_name)} (${this.escapeHtml(s.id_number || '—')})</option>`).join('');
            }
        } catch (e) {}

        // Fetch teachers if not already cached
        try {
            if (!this._teachers || this._teachers.length === 0) {
                const tRes = await fetch(`${API_URL}/teachers`, {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                if (tRes.ok) this._teachers = await tRes.json();
            }
            if (teacherSelect) {
                teacherSelect.innerHTML = '<option value="">No Teacher Linked</option>' +
                    (this._teachers || []).map(t => `<option value="${t.id || t._id}">${this.escapeHtml(t.name)} (${this.escapeHtml(t.subject || '—')})</option>`).join('');
            }
        } catch (e) {}
    },

    async saveUser(e) {
        e.preventDefault();
        if (this._submitting.user) return;

        const id = document.getElementById('user-id').value;
        const username = document.getElementById('user-username').value.trim();
        const email = document.getElementById('user-email').value.trim();
        const role = document.getElementById('user-role').value;
        const status = document.getElementById('user-status').value;
        const student_id = document.getElementById('user-student')?.value || null;
        const teacher_id = document.getElementById('user-teacher')?.value || null;
        const password = document.getElementById('user-password').value;

        if (!username) { this.showNotification('Username is required', true); return; }
        if (!email) { this.showNotification('Email is required', true); return; }
        if (password && password.length < 6) {
            this.showNotification('Password must be at least 6 characters long', true);
            return;
        }

        const payload = { username, email, role, status };
        if (password) payload.password = password;
        if (role === 'student') payload.student_id = student_id;
        else if (role === 'teacher') payload.teacher_id = teacher_id;

        const btn = document.getElementById('user-submit-btn');
        const origBtnText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        }
        this._submitting.user = true;

        try {
            const isEdit = !!id;
            const url = isEdit ? `${API_URL}/users/${id}` : `${API_URL}/users`;
            const method = isEdit ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                this.showNotification(isEdit ? 'User updated successfully' : 'User created successfully');
                this.closeModal('user-modal');
                await this.loadUsers();
            } else {
                this.showNotification(data.message || 'Failed to save user', true);
            }
        } catch (err) {
            this.showNotification('Network error saving user', true);
        } finally {
            this._submitting.user = false;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origBtnText;
            }
        }
    },

    openResetPasswordModal(userId, username) {
        document.getElementById('reset-user-id').value = userId;
        const displayEl = document.getElementById('reset-user-display-name');
        if (displayEl) displayEl.textContent = username;
        document.getElementById('reset-new-password').value = '';
        document.getElementById('reset-confirm-password').value = '';
        this.showModal('reset-password-modal');
    },

    async submitPasswordReset(e) {
        e.preventDefault();
        if (this._submitting.resetPassword) return;

        const id = document.getElementById('reset-user-id').value;
        const newPwd = document.getElementById('reset-new-password').value;
        const confirmPwd = document.getElementById('reset-confirm-password').value;

        if (!newPwd || newPwd.length < 6) {
            this.showNotification('Password must be at least 6 characters long', true);
            return;
        }
        if (newPwd !== confirmPwd) {
            this.showNotification('Passwords do not match', true);
            return;
        }

        const btn = document.getElementById('reset-password-submit-btn');
        const origBtnText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Resetting...';
        }
        this._submitting.resetPassword = true;

        try {
            const res = await fetch(`${API_URL}/users/${id}/reset-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ password: newPwd })
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                this.showNotification('Password reset successfully');
                this.closeModal('reset-password-modal');
            } else {
                this.showNotification(data.message || 'Failed to reset password', true);
            }
        } catch (err) {
            this.showNotification('Network error resetting password', true);
        } finally {
            this._submitting.resetPassword = false;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origBtnText;
            }
        }
    },

    /* =========================================================
       P3 MODULE 2: SCHOOL PROFILE & SETTINGS
       ========================================================= */
    async loadSettings() {
        try {
            const data = await this.apiCall('/settings');
            if (!data) {
                this.showNotification('Failed to load settings', true);
                return;
            }

            // Populate form fields
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.value = val || '';
            };
            setVal('setting-school-name', data.school_name);
            setVal('setting-motto', data.school_motto);
            setVal('setting-official-email', data.school_email);
            setVal('setting-phone', data.school_phone);
            setVal('setting-address', data.school_address);
            setVal('setting-logo-url', data.logo_url);
            setVal('setting-min-attendance', data.min_attendance_percent);

            // Populate AY dropdown
            const aySelect = document.getElementById('setting-default-ay');
            if (aySelect) {
                const ays = await this.apiCall('/academic-years');
                aySelect.innerHTML = '<option value="">Auto (Active Academic Year)</option>';
                if (Array.isArray(ays)) {
                    ays.forEach(ay => {
                        const opt = document.createElement('option');
                        opt.value = ay.id || ay._id;
                        opt.textContent = `${ay.name} (${ay.status})`;
                        aySelect.appendChild(opt);
                    });
                }
                if (data.default_academic_year_id) {
                    const ayId = typeof data.default_academic_year_id === 'object'
                        ? (data.default_academic_year_id._id || data.default_academic_year_id.id || '')
                        : data.default_academic_year_id;
                    aySelect.value = ayId.toString();
                }
            }

            // Update preview
            this.updateSchoolPreview();
        } catch (err) {
            this.showNotification('Error loading settings', true);
        }
    },

    async saveSettings(e) {
        e.preventDefault();
        if (this._submitting.settings) return;
        this._submitting.settings = true;

        const btn = document.getElementById('save-settings-btn');
        const origText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        }

        try {
            const body = {
                school_name: document.getElementById('setting-school-name')?.value?.trim() || '',
                school_motto: document.getElementById('setting-motto')?.value?.trim() || '',
                school_email: document.getElementById('setting-official-email')?.value?.trim() || '',
                school_phone: document.getElementById('setting-phone')?.value?.trim() || '',
                school_address: document.getElementById('setting-address')?.value?.trim() || '',
                logo_url: document.getElementById('setting-logo-url')?.value?.trim() || '',
            };

            const minAtt = document.getElementById('setting-min-attendance')?.value;
            if (minAtt !== '' && minAtt !== undefined) {
                body.min_attendance_percent = Number(minAtt);
            }

            const ayVal = document.getElementById('setting-default-ay')?.value;
            body.default_academic_year_id = ayVal || '';

            const res = await fetch(`${API_URL}/settings`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify(body)
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                this.showNotification('School settings saved successfully');
                this.updateSchoolPreview();
            } else {
                this.showNotification(data.message || 'Failed to save settings', true);
            }
        } catch (err) {
            this.showNotification('Network error saving settings', true);
        } finally {
            this._submitting.settings = false;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText;
            }
        }
    },

    updateSchoolPreview() {
        const nameEl = document.getElementById('preview-school-name');
        const mottoEl = document.getElementById('preview-motto');
        const emailEl = document.getElementById('preview-email-val');
        const phoneEl = document.getElementById('preview-phone-val');
        const addressEl = document.getElementById('preview-address-val');
        const logoIcon = document.getElementById('preview-logo-icon');
        const logoImg = document.getElementById('preview-logo-img');

        const name = document.getElementById('setting-school-name')?.value || 'DOOLAAL SCHOOL';
        const motto = document.getElementById('setting-motto')?.value || '';
        const email = document.getElementById('setting-official-email')?.value || 'info@doolaal.edu';
        const phone = document.getElementById('setting-phone')?.value || '+252 61 0000000';
        const address = document.getElementById('setting-address')?.value || 'Mogadishu, Somalia';
        const logoUrl = document.getElementById('setting-logo-url')?.value || '';

        if (nameEl) nameEl.textContent = name;
        if (mottoEl) mottoEl.textContent = motto || 'Knowledge, Integrity, Excellence';
        if (emailEl) emailEl.textContent = email;
        if (phoneEl) phoneEl.textContent = phone;
        if (addressEl) addressEl.textContent = address;

        if (logoUrl && logoImg && logoIcon) {
            logoImg.src = logoUrl;
            logoImg.style.display = 'block';
            logoIcon.style.display = 'none';
            logoImg.onerror = () => {
                logoImg.style.display = 'none';
                logoIcon.style.display = 'block';
            };
        } else if (logoImg && logoIcon) {
            logoImg.style.display = 'none';
            logoIcon.style.display = 'block';
        }
    },

    /* =========================================================
       P3 MODULE 3: TIMETABLE & CLASS SCHEDULE
       ========================================================= */
    async populateTimetableFilters() {
        try {
            const classes = await this.apiCall('/classes');
            const classFilter = document.getElementById('timetable-class-filter');
            if (classFilter && Array.isArray(classes)) {
                const currentVal = classFilter.value;
                classFilter.innerHTML = '<option value="">All Classes</option>';
                classes.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.id || c._id;
                    opt.textContent = c.name;
                    classFilter.appendChild(opt);
                });
                if (currentVal) classFilter.value = currentVal;
            }

            // Populate modal dropdowns for timetable form
            const slotClassSelect = document.getElementById('slot-class-id');
            if (slotClassSelect && Array.isArray(classes)) {
                slotClassSelect.innerHTML = '<option value="">Select Class</option>';
                classes.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.id || c._id;
                    opt.textContent = c.name;
                    slotClassSelect.appendChild(opt);
                });
            }

            const [subjects, teachers, academicYears] = await Promise.all([
                this.apiCall('/subjects'),
                this.apiCall('/teachers'),
                this.apiCall('/academic-years')
            ]);

            const slotSubjectSelect = document.getElementById('slot-subject-id');
            if (slotSubjectSelect && Array.isArray(subjects)) {
                slotSubjectSelect.innerHTML = '<option value="">Select Subject</option>';
                subjects.forEach(s => {
                    const opt = document.createElement('option');
                    opt.value = s.id || s._id;
                    opt.textContent = `${s.name}${s.code ? ' (' + s.code + ')' : ''}`;
                    slotSubjectSelect.appendChild(opt);
                });
            }

            const slotTeacherSelect = document.getElementById('slot-teacher-id');
            if (slotTeacherSelect && Array.isArray(teachers)) {
                slotTeacherSelect.innerHTML = '<option value="">Select Teacher</option>';
                teachers.forEach(t => {
                    const opt = document.createElement('option');
                    opt.value = t.id || t._id;
                    opt.textContent = `${t.name}${t.subject ? ' (' + t.subject + ')' : ''}`;
                    slotTeacherSelect.appendChild(opt);
                });
            }

            const slotAySelect = document.getElementById('slot-ay-id');
            if (slotAySelect && Array.isArray(academicYears)) {
                slotAySelect.innerHTML = '<option value="">Auto (Active Year)</option>';
                academicYears.forEach(ay => {
                    const opt = document.createElement('option');
                    opt.value = ay.id || ay._id;
                    opt.textContent = `${ay.name} (${ay.status})`;
                    slotAySelect.appendChild(opt);
                });
            }
        } catch (err) {
            console.error('Error populating timetable filters:', err);
        }
    },

    async loadTimetable() {
        const container = document.getElementById('timetable-container');
        if (!container) return;
        container.innerHTML = '<div style="text-align:center;padding:var(--space-6);"><i class="fa-solid fa-spinner fa-spin"></i> Loading timetable...</div>';

        try {
            let url = '/timetable?status=active';
            const classFilter = document.getElementById('timetable-class-filter')?.value;
            const dayFilter = document.getElementById('timetable-day-filter')?.value;
            if (classFilter) url += `&class_id=${classFilter}`;
            if (dayFilter) url += `&day_of_week=${dayFilter}`;

            const data = await this.apiCall(url);
            if (!data || !Array.isArray(data)) {
                container.innerHTML = `
                    <div class="empty-state">
                        <i class="fa-solid fa-calendar-xmark"></i>
                        <h3>Unable to load timetable</h3>
                        <p>Please try refreshing.</p>
                    </div>`;
                return;
            }

            if (data.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <i class="fa-solid fa-calendar-plus"></i>
                        <h3>No timetable slots found</h3>
                        <p>Add your first class schedule using the button above.</p>
                    </div>`;
                return;
            }

            // Group by day
            const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
            const grouped = {};
            data.forEach(slot => {
                const day = slot.day_of_week || 'Other';
                if (!grouped[day]) grouped[day] = [];
                grouped[day].push(slot);
            });

            const dayColors = {
                'Monday': '#6366f1', 'Tuesday': '#8b5cf6', 'Wednesday': '#ec4899',
                'Thursday': '#f97316', 'Friday': '#10b981', 'Saturday': '#06b6d4', 'Sunday': '#ef4444'
            };

            let html = '';
            dayOrder.forEach(day => {
                if (!grouped[day]) return;
                const slots = grouped[day].sort((a, b) => a.start_time.localeCompare(b.start_time));
                const dayColor = dayColors[day] || '#6b7280';

                html += `
                <div class="timetable-day-group" style="margin-bottom: var(--space-5);">
                    <div class="timetable-day-header" style="display:flex;align-items:center;gap:10px;margin-bottom:var(--space-3);">
                        <div style="width:4px;height:28px;border-radius:2px;background:${dayColor};"></div>
                        <h3 style="font-size:var(--text-md);font-weight:600;color:var(--text-primary);margin:0;">${day}</h3>
                        <span class="badge badge-neutral" style="font-size:var(--text-xs);">${slots.length} slot${slots.length > 1 ? 's' : ''}</span>
                    </div>
                    <div style="display:grid;gap:var(--space-3);grid-template-columns:repeat(auto-fill,minmax(280px,1fr));">`;

                slots.forEach(slot => {
                    const className = slot.class_id?.name || 'Unknown';
                    const subjectName = slot.subject_id?.name || 'Unknown';
                    const teacherName = slot.teacher_id?.name || 'Unknown';
                    const room = slot.room || slot.room_number || '';
                    const slotId = slot.id || slot._id;

                    html += `
                    <div class="timetable-slot-card section-card" style="padding:var(--space-4);position:relative;border-left:3px solid ${dayColor};">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:var(--space-2);">
                            <div>
                                <div style="font-weight:600;font-size:var(--text-sm);color:var(--text-primary);">${this.escapeHtml(subjectName)}</div>
                                <div style="font-size:var(--text-xs);color:var(--text-muted);margin-top:2px;">
                                    <i class="fa-solid fa-clock" style="margin-right:4px;"></i>${this.escapeHtml(slot.start_time)} – ${this.escapeHtml(slot.end_time)}
                                </div>
                            </div>
                            <div style="display:flex;gap:4px;">
                                <button class="btn-icon" onclick="app.showEditTimetableSlot('${slotId}')" title="Edit" style="font-size:var(--text-sm);color:var(--primary-color);"><i class="fa-solid fa-pen"></i></button>
                                <button class="btn-icon" onclick="app.deleteTimetableSlot('${slotId}', '${this.escapeHtml(subjectName)} (${day})')" title="Delete" style="font-size:var(--text-sm);color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>
                        <div style="font-size:var(--text-xs);color:var(--text-secondary);display:flex;flex-direction:column;gap:3px;">
                            <div><i class="fa-solid fa-school" style="width:16px;margin-right:4px;color:var(--primary-color);"></i>${this.escapeHtml(className)}</div>
                            <div><i class="fa-solid fa-chalkboard-user" style="width:16px;margin-right:4px;color:var(--info-color);"></i>${this.escapeHtml(teacherName)}</div>
                            ${room ? `<div><i class="fa-solid fa-door-open" style="width:16px;margin-right:4px;color:var(--text-muted);"></i>${this.escapeHtml(room)}</div>` : ''}
                        </div>
                    </div>`;
                });

                html += '</div></div>';
            });

            container.innerHTML = html;
        } catch (err) {
            container.innerHTML = '<div style="text-align:center;padding:var(--space-6);color:var(--danger);"><i class="fa-solid fa-triangle-exclamation"></i> Error loading timetable.</div>';
        }
    },

    async showEditTimetableSlot(slotId) {
        try {
            const slot = await this.apiCall(`/timetable/${slotId}`);
            if (!slot) {
                this.showNotification('Failed to load slot details', true);
                return;
            }

            document.getElementById('timetable-slot-id').value = slotId;
            document.getElementById('timetable-modal-title').textContent = 'Edit Timetable Slot';

            const setSelectVal = (id, val) => {
                const el = document.getElementById(id);
                if (el && val) {
                    const v = typeof val === 'object' ? (val._id || val.id || '') : val;
                    el.value = v.toString();
                }
            };

            setSelectVal('slot-class-id', slot.class_id);
            setSelectVal('slot-subject-id', slot.subject_id);
            setSelectVal('slot-teacher-id', slot.teacher_id);
            setSelectVal('slot-day-of-week', slot.day_of_week);
            setSelectVal('slot-ay-id', slot.academic_year_id);

            document.getElementById('slot-start-time').value = slot.start_time || '';
            document.getElementById('slot-end-time').value = slot.end_time || '';
            document.getElementById('slot-room-number').value = slot.room || slot.room_number || '';

            const conflictAlert = document.getElementById('timetable-conflict-alert');
            if (conflictAlert) conflictAlert.classList.add('hidden');

            this.showModal('timetable-modal', true);
        } catch (err) {
            this.showNotification('Error loading slot for editing', true);
        }
    },

    async saveTimetableSlot(e) {
        e.preventDefault();
        if (this._submitting.timetable) return;
        this._submitting.timetable = true;

        const btn = document.getElementById('timetable-submit-btn');
        const origText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        }

        const conflictAlert = document.getElementById('timetable-conflict-alert');
        if (conflictAlert) conflictAlert.classList.add('hidden');

        try {
            const slotId = document.getElementById('timetable-slot-id')?.value;
            const isEdit = !!slotId;

            const body = {
                class_id: document.getElementById('slot-class-id')?.value || '',
                subject_id: document.getElementById('slot-subject-id')?.value || '',
                teacher_id: document.getElementById('slot-teacher-id')?.value || '',
                day_of_week: document.getElementById('slot-day-of-week')?.value || '',
                start_time: document.getElementById('slot-start-time')?.value || '',
                end_time: document.getElementById('slot-end-time')?.value || '',
                room_number: document.getElementById('slot-room-number')?.value?.trim() || '',
            };

            const ayVal = document.getElementById('slot-ay-id')?.value;
            if (ayVal) body.academic_year_id = ayVal;

            const url = isEdit ? `${API_URL}/timetable/${slotId}` : `${API_URL}/timetable`;
            const method = isEdit ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify(body)
            });

            const data = await res.json().catch(() => ({}));

            if (res.status === 409) {
                // Conflict — show the clash alert
                if (conflictAlert) {
                    conflictAlert.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="margin-right:6px;"></i> <strong>Schedule Conflict:</strong> ${this.escapeHtml(data.message || 'A scheduling conflict was detected.')}`;
                    conflictAlert.classList.remove('hidden');
                }
                this.showNotification(data.message || 'Schedule conflict detected', true);
                return;
            }

            if (res.ok) {
                this.showNotification(isEdit ? 'Timetable slot updated' : 'Timetable slot created');
                this.closeModal('timetable-modal');
                document.getElementById('timetable-form')?.reset();
                document.getElementById('timetable-slot-id').value = '';
                document.getElementById('timetable-modal-title').textContent = 'Add Timetable Slot';
                await this.loadTimetable();
            } else {
                this.showNotification(data.message || 'Failed to save timetable slot', true);
            }
        } catch (err) {
            this.showNotification('Network error saving timetable slot', true);
        } finally {
            this._submitting.timetable = false;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText;
            }
        }
    },

    deleteTimetableSlot(slotId, slotName) {
        this.showConfirm(
            `Delete Timetable Slot`,
            `Are you sure you want to delete the schedule for "${slotName}"? This action cannot be undone.`,
            async () => {
                try {
                    const res = await fetch(`${API_URL}/timetable/${slotId}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${this.token}` }
                    });
                    const data = await res.json().catch(() => ({}));
                    if (res.ok) {
                        this.showNotification('Timetable slot deleted');
                        await this.loadTimetable();
                    } else {
                        this.showNotification(data.message || 'Failed to delete slot', true);
                    }
                } catch (err) {
                    this.showNotification('Network error deleting slot', true);
                }
            },
            'btn-danger',
            'Delete Slot'
        );
    },

    /* =========================================================
       P3 MODULE 4: NOTICE BOARD & ANNOUNCEMENTS
       ========================================================= */
    async loadNotices() {
        const container = document.getElementById('notices-container');
        if (!container) return;
        container.innerHTML = '<div style="text-align:center;padding:var(--space-6);"><i class="fa-solid fa-spinner fa-spin"></i> Loading notices...</div>';

        try {
            let url = '/notices?';
            const priorityFilter = document.getElementById('notices-priority-filter')?.value;
            const statusFilter = document.getElementById('notices-status-filter')?.value;
            if (priorityFilter) url += `priority=${priorityFilter}&`;
            if (statusFilter) url += `status=${statusFilter}&`;

            const data = await this.apiCall(url);
            if (!data || !Array.isArray(data)) {
                container.innerHTML = `
                    <div class="empty-state">
                        <i class="fa-solid fa-bullhorn"></i>
                        <h3>Unable to load notices</h3>
                        <p>Please try refreshing.</p>
                    </div>`;
                return;
            }

            if (data.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <i class="fa-solid fa-megaphone" style="font-size: 2.5rem;"></i>
                        <h3>No notices found</h3>
                        <p>There are no announcements matching your filters.</p>
                    </div>`;
                return;
            }

            let html = '<div style="display:grid;gap:var(--space-4);grid-template-columns:repeat(auto-fill,minmax(340px,1fr));">';

            data.forEach(notice => {
                const id = notice.id || notice._id;
                const isArchived = notice.is_archived || notice.status === 'archived';
                const isUrgent = notice.priority === 'urgent';
                const borderColor = isUrgent ? 'var(--danger)' : 'var(--primary-color)';
                const targetLabel = notice.target_role === 'all' ? 'Everyone' : notice.target_role === 'teacher' ? 'Teachers' : 'Students';
                const createdDate = notice.createdAt ? new Date(notice.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
                const expiresDate = notice.expires_at ? new Date(notice.expires_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null;

                html += `
                <div class="notice-card section-card" style="padding:var(--space-4);border-left:3px solid ${borderColor};${isArchived ? 'opacity:0.65;' : ''}">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:var(--space-3);">
                        <div style="flex:1;">
                            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
                                ${isUrgent ? '<span class="badge badge-danger" style="font-size:var(--text-xxs);">URGENT</span>' : ''}
                                ${isArchived ? '<span class="badge badge-neutral" style="font-size:var(--text-xxs);">ARCHIVED</span>' : '<span class="badge badge-success" style="font-size:var(--text-xxs);">ACTIVE</span>'}
                                <span class="badge badge-info" style="font-size:var(--text-xxs);">${this.escapeHtml(targetLabel)}</span>
                            </div>
                            <h4 style="font-size:var(--text-sm);font-weight:600;color:var(--text-primary);margin:0;line-height:1.4;">${this.escapeHtml(notice.title)}</h4>
                        </div>
                        <div style="display:flex;gap:4px;margin-left:8px;">
                            <button class="btn-icon" onclick="app.showEditNotice('${id}')" title="Edit" style="font-size:var(--text-sm);color:var(--primary-color);"><i class="fa-solid fa-pen"></i></button>
                            ${!isArchived ? `<button class="btn-icon" onclick="app.archiveNotice('${id}', '${this.escapeHtml(notice.title)}')" title="Archive" style="font-size:var(--text-sm);color:var(--text-warning);"><i class="fa-solid fa-box-archive"></i></button>` : ''}
                            <button class="btn-icon" onclick="app.deleteNotice('${id}', '${this.escapeHtml(notice.title)}')" title="Delete" style="font-size:var(--text-sm);color:var(--danger);"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                    <p style="font-size:var(--text-xs);color:var(--text-secondary);line-height:1.6;margin-bottom:var(--space-3);white-space:pre-wrap;word-break:break-word;">${this.escapeHtml(notice.content || '').substring(0, 300)}${(notice.content || '').length > 300 ? '...' : ''}</p>
                    <div style="font-size:var(--text-xxs);color:var(--text-muted);display:flex;gap:var(--space-3);flex-wrap:wrap;border-top:1px solid var(--border-primary);padding-top:var(--space-2);">
                        <span><i class="fa-solid fa-user" style="margin-right:4px;"></i>${this.escapeHtml(notice.author_name || 'Admin')}</span>
                        <span><i class="fa-regular fa-calendar" style="margin-right:4px;"></i>${createdDate}</span>
                        ${expiresDate ? `<span><i class="fa-solid fa-hourglass-end" style="margin-right:4px;"></i>Expires: ${expiresDate}</span>` : ''}
                    </div>
                </div>`;
            });

            html += '</div>';
            container.innerHTML = html;
        } catch (err) {
            container.innerHTML = '<div style="text-align:center;padding:var(--space-6);color:var(--danger);"><i class="fa-solid fa-triangle-exclamation"></i> Error loading notices.</div>';
        }
    },

    async showEditNotice(noticeId) {
        try {
            const notice = await this.apiCall(`/notices/${noticeId}`);
            if (!notice) {
                this.showNotification('Failed to load notice details', true);
                return;
            }

            document.getElementById('notice-id').value = noticeId;
            document.getElementById('notice-modal-title').textContent = 'Edit Notice';
            document.getElementById('notice-title').value = notice.title || '';
            document.getElementById('notice-content').value = notice.content || '';
            document.getElementById('notice-target-role').value = notice.target_role || 'all';
            document.getElementById('notice-priority').value = notice.priority || 'normal';

            const expiresInput = document.getElementById('notice-expires-at');
            if (expiresInput && notice.expires_at) {
                expiresInput.value = new Date(notice.expires_at).toISOString().split('T')[0];
            } else if (expiresInput) {
                expiresInput.value = '';
            }

            this.showModal('notice-modal', true);
        } catch (err) {
            this.showNotification('Error loading notice for editing', true);
        }
    },

    async saveNotice(e) {
        e.preventDefault();
        if (this._submitting.notice) return;
        this._submitting.notice = true;

        const btn = document.getElementById('notice-submit-btn');
        const origText = btn ? btn.innerHTML : '';
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Publishing...';
        }

        try {
            const noticeId = document.getElementById('notice-id')?.value;
            const isEdit = !!noticeId;

            const body = {
                title: document.getElementById('notice-title')?.value?.trim() || '',
                content: document.getElementById('notice-content')?.value?.trim() || '',
                target_role: document.getElementById('notice-target-role')?.value || 'all',
                priority: document.getElementById('notice-priority')?.value || 'normal',
            };

            const expiresVal = document.getElementById('notice-expires-at')?.value;
            if (expiresVal) body.expires_at = expiresVal;

            const url = isEdit ? `${API_URL}/notices/${noticeId}` : `${API_URL}/notices`;
            const method = isEdit ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify(body)
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                this.showNotification(isEdit ? 'Notice updated successfully' : 'Notice published successfully');
                this.closeModal('notice-modal');
                document.getElementById('notice-form')?.reset();
                document.getElementById('notice-id').value = '';
                document.getElementById('notice-modal-title').textContent = 'Publish Notice';
                await this.loadNotices();
            } else {
                this.showNotification(data.message || 'Failed to save notice', true);
            }
        } catch (err) {
            this.showNotification('Network error saving notice', true);
        } finally {
            this._submitting.notice = false;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origText;
            }
        }
    },

    archiveNotice(noticeId, title) {
        this.showConfirm(
            'Archive Notice',
            `Are you sure you want to archive "${title}"? It will be hidden from non-admin users.`,
            async () => {
                try {
                    const res = await fetch(`${API_URL}/notices/${noticeId}/archive`, {
                        method: 'PATCH',
                        headers: { 'Authorization': `Bearer ${this.token}` }
                    });
                    const data = await res.json().catch(() => ({}));
                    if (res.ok) {
                        this.showNotification('Notice archived');
                        await this.loadNotices();
                    } else {
                        this.showNotification(data.message || 'Failed to archive notice', true);
                    }
                } catch (err) {
                    this.showNotification('Network error archiving notice', true);
                }
            },
            'btn-primary',
            'Archive'
        );
    },

    deleteNotice(noticeId, title) {
        this.showConfirm(
            'Delete Notice',
            `Are you sure you want to permanently delete "${title}"? This cannot be undone.`,
            async () => {
                try {
                    const res = await fetch(`${API_URL}/notices/${noticeId}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${this.token}` }
                    });
                    const data = await res.json().catch(() => ({}));
                    if (res.ok) {
                        this.showNotification('Notice deleted');
                        await this.loadNotices();
                    } else {
                        this.showNotification(data.message || 'Failed to delete notice', true);
                    }
                } catch (err) {
                    this.showNotification('Network error deleting notice', true);
                }
            },
            'btn-danger',
            'Delete Notice'
        );
    },

    /* =========================================================
       P3: DASHBOARD NOTICES WIDGET
       ========================================================= */
    async loadDashboardNotices() {
        const container = document.getElementById('dashboard-notices-list');
        if (!container) return;

        try {
            const notices = await this.apiCall('/notices?status=active');
            if (!notices || !Array.isArray(notices) || notices.length === 0) {
                container.innerHTML = '<div style="font-size:var(--text-xs);color:var(--text-muted);padding:var(--space-3);text-align:center;">No active announcements</div>';
                return;
            }

            // Show up to 5 latest
            const recent = notices.slice(0, 5);
            container.innerHTML = recent.map(n => {
                const isUrgent = n.priority === 'urgent';
                const dateStr = n.createdAt ? new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                return `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--radius-sm);background:var(--bg-secondary);margin-bottom:6px;cursor:pointer;transition:background 0.15s;" onclick="app.navigateTo('notices-view')">
                    <i class="fa-solid fa-${isUrgent ? 'exclamation-circle' : 'bullhorn'}" style="color:${isUrgent ? 'var(--danger)' : 'var(--primary-color)'};font-size:var(--text-sm);flex-shrink:0;"></i>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:var(--text-xs);font-weight:500;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.escapeHtml(n.title)}</div>
                        <div style="font-size:var(--text-xxs);color:var(--text-muted);">${dateStr}</div>
                    </div>
                    ${isUrgent ? '<span class="badge badge-danger" style="font-size:9px;flex-shrink:0;">URGENT</span>' : ''}
                </div>`;
            }).join('');
        } catch (err) {
            container.innerHTML = '<div style="font-size:var(--text-xs);color:var(--text-muted);padding:var(--space-3);text-align:center;">Unable to load announcements</div>';
        }
    },

    toggleUserStatus(userId, currentStatus, username) {
        const nextStatus = currentStatus === 'active' ? 'inactive' : 'active';
        const actionWord = nextStatus === 'active' ? 'activate' : 'deactivate';

        this.showConfirm(
            `${actionWord.charAt(0).toUpperCase() + actionWord.slice(1)} User Account`,
            `Are you sure you want to ${actionWord} the account for "${username}"? ${nextStatus === 'inactive' ? 'The user will immediately be blocked from logging into the system.' : 'The user will be able to log in again.'}`,
            async () => {
                try {
                    const res = await fetch(`${API_URL}/users/${userId}/status`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.token}`
                        },
                        body: JSON.stringify({ status: nextStatus })
                    });
                    const data = await res.json().catch(() => ({}));
                    if (res.ok) {
                        this.showNotification(`Account ${nextStatus === 'active' ? 'activated' : 'deactivated'} successfully`);
                        await this.loadUsers();
                    } else {
                        this.showNotification(data.message || `Failed to ${actionWord} user`, true);
                    }
                } catch (err) {
                    this.showNotification(`Network error trying to ${actionWord} user`, true);
                }
            },
            nextStatus === 'inactive' ? 'btn-danger' : 'btn-primary',
            `${actionWord.charAt(0).toUpperCase() + actionWord.slice(1)} Account`
        );
    }
};

/* =========================================================
   BOOT
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('school_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    app.init();
});
