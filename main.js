import { generatePDF, generateFilename, downloadPDF, importReportFromPDF } from './lib/pdf.js';
import { APP_VERSION } from './config/version.js';

// ========================================
// Constants
// ========================================

const TOTAL_STEPS = 5;
const STORAGE_KEY = 'chf-recruitment-data';
const SHARED_SCHOOL_KEY = 'chf-school-info';

const VENUE_OPTIONS = [
  { value: 'telephone', label: 'Telephone' },
  { value: 'email', label: 'Email' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'inPerson', label: 'In Person' },
  { value: 'letter', label: 'Letter' },
  { value: 'other', label: 'Other' }
];

// A single interview is held one way, so the venue is a choice rather than a list.
const INTERVIEW_VENUE_OPTIONS = [
  { value: 'inPerson', label: 'In person' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'telephone', label: 'Telephone' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'other', label: 'Other' }
];

// Blank interview lines offered up front, to signal that one interview is not enough.
const DEFAULT_INTERVIEW_ROWS = 4;

// Minimum length for free-text answers that must describe what actually happened.
const MIN_NARRATIVE_CHARS = 25;
// Minimum total time a candidate must be interviewed for, across all sessions.
const MIN_INTERVIEW_MINUTES = 60;
// Answers used to avoid filling in a field. These are rejected on required fields.
const PLACEHOLDER_ANSWER_RE = /^(n[\/.\s]?a[.]?|na|none|nil|no|tbd|unknown|not applicable|[-–—.*_?]+)$/i;

// ========================================
// Application State
// ========================================

function _emptyReference() {
  return {
    name: '', title: '', email: '',
    interviewMinutes: '', interviewDate: '', interviewTime: '',
    interviewPlace: '', interviewCountry: '',
    communicationVenues: [], communicationOther: '',
    feedback: ''
  };
}

function _emptyInterview() {
  return {
    interviewerName: '', interviewerTitle: '',
    date: '', time: '', minutes: '',
    venue: '', venueOther: '', place: '', country: ''
  };
}

function _emptyTeacher() {
  return {
    firstName: '', lastName: '', email: '',
    citizenshipCountry: '',
    interviews: [],
    recruitmentMethod: '', candidateAssessment: '',
    teachingSampleProvided: '', teachingSampleTypes: [],
    teachingSampleMinutes: '', teachingSampleAlternative: '',
    references: [_emptyReference(), _emptyReference()],
    isNativeEnglishSpeaker: false,
    nativeTestedEnglish: false,
    englishTestMinutes: ''
  };
}

/** Parses legacy free-text durations ("30 min", "1 hour 15 minutes") into minutes. */
function _parseMinutes(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  const str = String(value ?? '').trim();
  if (!str) return '';

  const hourMatch = str.match(/(\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hour|hours)\b/i);
  const minMatch = str.match(/(\d+(?:[.,]\d+)?)\s*(m|min|mins|minute|minutes)\b/i);
  const num = (m) => (m ? parseFloat(m[1].replace(',', '.')) : 0);

  if (hourMatch || minMatch) return Math.round(num(hourMatch) * 60 + num(minMatch));

  const plain = str.match(/\d+(?:[.,]\d+)?/);
  return plain ? Math.round(parseFloat(plain[0].replace(',', '.'))) : '';
}

/**
 * Rebuilds the interview list from the single interview block used before
 * interviews became repeatable. Any extra interviewers recorded back then
 * become their own lines, which the school must then complete.
 */
function _interviewsFromLegacy(t) {
  const rows = [];
  const venues = t?.communicationVenues || [];
  const known = venues.find(v => INTERVIEW_VENUE_OPTIONS.some(o => o.value === v));
  const venue = known || (venues.length > 0 ? 'other' : '');
  const minutes = t?.interviewTotalMinutes || _parseMinutes(t?.interviewLength);

  if (t?.interviewDate || minutes || t?.interviewPlace || venue) {
    rows.push({
      ..._emptyInterview(),
      date: t.interviewDate || '',
      minutes: minutes || '',
      venue,
      venueOther: venue === 'other'
        ? (t.communicationOther || venues.map(v => VENUE_OPTIONS.find(o => o.value === v)?.label || v).join(', '))
        : '',
      place: venue === 'inPerson' ? (t.interviewPlace || '') : ''
    });
  }

  for (const iv of (t?.additionalInterviewers || [])) {
    rows.push({ ..._emptyInterview(), interviewerName: iv.name || '', interviewerTitle: iv.title || '' });
  }

  return rows;
}

/** Upgrades a teacher saved by an older version to the current shape. */
function _migrateTeacher(t) {
  const teacher = { ..._emptyTeacher(), ...(t || {}) };

  teacher.citizenshipCountry = teacher.citizenshipCountry || t?.interviewCountry || '';

  teacher.interviews = Array.isArray(t?.interviews) && t.interviews.length > 0
    ? t.interviews.map(iv => ({ ..._emptyInterview(), ...iv }))
    : _interviewsFromLegacy(t);

  for (const key of ['interviewDate', 'interviewPlace', 'interviewCountry', 'interviewTotalMinutes',
    'interviewLength', 'communicationVenues', 'communicationOther', 'additionalInterviewers']) {
    delete teacher[key];
  }

  teacher.teachingSampleTypes = teacher.teachingSampleTypes || [];

  teacher.references = [0, 1].map(i => {
    const saved = t?.references?.[i] || {};
    const ref = { ..._emptyReference(), ...saved };
    if (!ref.interviewMinutes && saved.interviewLength) {
      ref.interviewMinutes = _parseMinutes(saved.interviewLength);
    }
    delete ref.interviewLength;
    ref.communicationVenues = ref.communicationVenues || [];
    return ref;
  });

  return teacher;
}

const report = {
  date: '',
  schoolName: '',
  schoolContactFirstName: '',
  schoolContactLastName: '',
  schoolContactEmail: '',
  teachers: [],
  certification: { required: false, link: '', costToTeacher: '' },
  signature: { imageDataUrl: null, signerName: '', signerTitle: '' }
};

let currentStep = 1;
let editingTeacherIndex = -1; // -1 = adding new, >=0 = editing existing
let wasAddingNew = false; // tracks whether current form session started as "Add" vs "Edit"

// ========================================
// Persistent Storage
// ========================================

function _saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(report));
    localStorage.setItem(SHARED_SCHOOL_KEY, JSON.stringify({
      schoolName: report.schoolName,
      contactFirstName: report.schoolContactFirstName,
      contactLastName: report.schoolContactLastName,
      contactEmail: report.schoolContactEmail
    }));
  } catch {}
}

function _loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.schoolName) return false;

    report.date = saved.date || report.date;
    report.schoolName = saved.schoolName || '';
    report.schoolContactFirstName = saved.schoolContactFirstName || '';
    report.schoolContactLastName = saved.schoolContactLastName || '';
    report.schoolContactEmail = saved.schoolContactEmail || '';
    report.teachers = (saved.teachers || []).map(_migrateTeacher);
    report.certification = saved.certification || { link: '', costToTeacher: '' };
    report.signature = saved.signature || { imageDataUrl: null, signerName: '', signerTitle: '' };
    return true;
  } catch {
    return false;
  }
}

function _clearStorage() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

function _hasStoredData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    return !!(saved && saved.schoolName);
  } catch {
    return false;
  }
}

// ========================================
// Landing Screen
// ========================================

function initLanding() {
  document.getElementById('continueBtn').addEventListener('click', _continueExisting);
  document.getElementById('startNewBtn').addEventListener('click', _confirmStartNew);
  document.getElementById('importPdfInput').addEventListener('change', _handleImport);

  if (_hasStoredData()) {
    _showLanding(true);
  } else {
    _showLanding(false);
  }
}

function _showLanding(hasData) {
  if (hasData) {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      _showLanding(false);
      return;
    }
    if (!saved || !saved.schoolName) { _showLanding(false); return; }

    document.getElementById('landingSchoolName').textContent = saved.schoolName;
    const teacherCount = (saved.teachers || []).length;
    document.getElementById('landingInfo').textContent =
      `${teacherCount} teacher${teacherCount !== 1 ? 's' : ''} in this report`;
    document.getElementById('continueBtn').style.display = '';
    document.getElementById('startNewBtn').textContent = 'Start New Report';
  } else {
    document.getElementById('landingSchoolName').textContent = 'Recruiting Report';
    document.getElementById('landingInfo').textContent = 'No saved report found.';
    document.getElementById('continueBtn').style.display = 'none';
    document.getElementById('startNewBtn').textContent = 'Start New Report';
  }

  document.getElementById('landingScreen').style.display = 'flex';
  document.getElementById('wizardProgress').style.display = 'none';
  document.getElementById('wizardContent').style.display = 'none';
  document.getElementById('wizardNavigation').style.display = 'none';
}

function _continueExisting() {
  _loadFromStorage();
  _restoreAllFields();
  _showWizard();
}

function _confirmStartNew() {
  if (_hasStoredData()) {
    if (!confirm('This will delete all saved data for the current report. Are you sure?')) return;
    _clearStorage();
  }
  _startFresh();
}

async function _handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  const errorEl = document.getElementById('importError');
  errorEl.textContent = '';

  try {
    const data = await importReportFromPDF(file);
    if (!data) {
      errorEl.textContent = 'Could not read report data from this PDF. Only PDFs generated by this app can be imported.';
      return;
    }

    if (_hasStoredData()) {
      if (!confirm('Importing will replace all current data. Continue?')) return;
    }

    report.date = data.date || new Date().toISOString().split('T')[0];
    report.schoolName = data.schoolName || '';
    report.schoolContactFirstName = data.schoolContactFirstName || '';
    report.schoolContactLastName = data.schoolContactLastName || '';
    report.schoolContactEmail = data.schoolContactEmail || '';
    report.teachers = (data.teachers || []).map(_migrateTeacher);
    report.certification = data.certification || { link: '', costToTeacher: '' };
    report.signature = { imageDataUrl: null, signerName: '', signerTitle: '' };

    _saveToStorage();
    _restoreAllFields();
    _showWizard();
  } catch (err) {
    errorEl.textContent = 'Failed to read PDF file. Please try again.';
    console.error('PDF import failed:', err);
  }

  e.target.value = '';
}

function _startFresh() {
  report.schoolName = '';
  report.schoolContactFirstName = '';
  report.schoolContactLastName = '';
  report.schoolContactEmail = '';
  report.teachers = [];
  report.certification = { link: '', costToTeacher: '' };
  report.signature = { imageDataUrl: null, signerName: '', signerTitle: '' };
  report.date = new Date().toISOString().split('T')[0];

  // Pre-fill school info from shared storage if available
  try {
    const shared = JSON.parse(localStorage.getItem(SHARED_SCHOOL_KEY));
    if (shared && shared.schoolName) {
      report.schoolName = shared.schoolName;
      report.schoolContactFirstName = shared.contactFirstName || '';
      report.schoolContactLastName = shared.contactLastName || '';
      report.schoolContactEmail = shared.contactEmail || '';
    }
  } catch {}

  _restoreAllFields();
  _showWizard();
}

function _showWizard() {
  document.getElementById('landingScreen').style.display = 'none';
  document.getElementById('wizardProgress').style.display = '';
  document.getElementById('wizardContent').style.display = '';
  document.getElementById('wizardNavigation').style.display = '';
  currentStep = 1;
  updateWizardUI();
  updateHeaderDisplay();
}

function _restoreAllFields() {
  document.getElementById('schoolName').value = report.schoolName;
  document.getElementById('contactFirstName').value = report.schoolContactFirstName;
  document.getElementById('contactLastName').value = report.schoolContactLastName;
  document.getElementById('contactEmail').value = report.schoolContactEmail;
  document.getElementById('certToggle').checked = report.certification.required;
  document.getElementById('certFields').style.display = report.certification.required ? 'block' : 'none';
  document.getElementById('certToggleLabel').textContent = report.certification.required ? 'Yes' : 'No';
  document.getElementById('certLink').value = report.certification.link;
  document.getElementById('certCost').value = report.certification.costToTeacher;
  document.getElementById('signerName').value = report.signature.signerName;
  document.getElementById('signerTitle').value = report.signature.signerTitle;
  if (report.signature.imageDataUrl) restoreSignatureCanvas(report.signature.imageDataUrl);
  updateHeaderDisplay();
}

// ========================================
// Initialization
// ========================================

document.addEventListener('DOMContentLoaded', () => {
  initNavigationButtons();
  initSchoolNameListener();
  initVenueCheckboxes();
  initTeachingSample();
  initCharCounters();
  initToggles();
  initSignatureCanvas();
  initTeacherButtons();

  document.getElementById('generatePdfBtn').addEventListener('click', generateReport);

  report.date = new Date().toISOString().split('T')[0];
  document.getElementById('appVersion').textContent = `v${APP_VERSION}`;

  initLanding();
  const _autoSave = () => {
    if (document.getElementById('wizardContent').style.display === 'none') return;
    _syncCurrentStep();
    _saveToStorage();
  };
  setInterval(_autoSave, 30000);
  window.addEventListener('beforeunload', _autoSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _autoSave();
  });
});

// ========================================
// Header Display
// ========================================

function updateHeaderDisplay() {
  document.getElementById('schoolNameHeader').textContent = report.schoolName || '';
  document.getElementById('dateDisplay').textContent = report.date || '';
}

function initSchoolNameListener() {
  document.getElementById('schoolName').addEventListener('input', (e) => {
    report.schoolName = e.target.value.trim();
    updateHeaderDisplay();
  });
}

// ========================================
// Form Sync Helpers
// ========================================

function _syncSchoolFromForm() {
  report.schoolName = document.getElementById('schoolName').value.trim();
  report.schoolContactFirstName = document.getElementById('contactFirstName').value.trim();
  report.schoolContactLastName = document.getElementById('contactLastName').value.trim();
  report.schoolContactEmail = document.getElementById('contactEmail').value.trim();
}

function _syncSharedFromForm() {
  report.certification.required = document.getElementById('certToggle').checked;
  report.certification.link = document.getElementById('certLink').value.trim();
  report.certification.costToTeacher = document.getElementById('certCost').value.trim();
}

// ========================================
// Teacher Table / Form Toggle
// ========================================

function initTeacherButtons() {
  document.getElementById('addTeacherBtn').addEventListener('click', () => openTeacherForm(-1));
  document.getElementById('saveTeacherBtn').addEventListener('click', saveTeacher);
  document.getElementById('cancelTeacherBtn').addEventListener('click', closeTeacherForm);
  document.getElementById('backToListBtn').addEventListener('click', closeTeacherForm);
  document.getElementById('addInterviewBtn').addEventListener('click', _addInterview);
}

// ========================================
// Interviews
// ========================================

let _currentInterviews = [];

function _interviewMinutesTotal(interviews) {
  return (interviews || []).reduce((sum, iv) => {
    const minutes = Number(iv.minutes);
    return sum + (Number.isFinite(minutes) && minutes > 0 ? minutes : 0);
  }, 0);
}

/** True once anything has been entered on a line, so blank spares stay optional. */
function _interviewHasData(iv) {
  return Boolean(iv.interviewerName || iv.interviewerTitle || iv.date || iv.time ||
    String(iv.minutes ?? '').trim() || iv.venue || iv.venueOther || iv.place || iv.country);
}

function _updateInterviewTotal() {
  const el = document.getElementById('interviewTotal');
  if (!el) return;
  const total = _interviewMinutesTotal(_currentInterviews);
  const short = total < MIN_INTERVIEW_MINUTES;
  el.textContent = total === 0
    ? ''
    : `Total interview time: ${total} minutes${short ? ` — ${MIN_INTERVIEW_MINUTES - total} minutes short of the ${MIN_INTERVIEW_MINUTES} minute minimum.` : '.'}`;
  el.classList.toggle('interview-total-short', short);
}

function _renderInterviews() {
  const container = document.getElementById('interviewsContainer');
  container.innerHTML = '';
  _currentInterviews.forEach((iv, i) => container.appendChild(_buildInterviewRow(iv, i)));
  _updateInterviewTotal();
}

function _buildInterviewRow(iv, i) {
  const row = document.createElement('div');
  row.className = 'interview-row';

  const venueChoices = INTERVIEW_VENUE_OPTIONS.map(o => `
    <label class="checkbox-item"><input type="radio" name="ivVenue${i}" value="${o.value}"${iv.venue === o.value ? ' checked' : ''}> ${o.label}</label>
  `).join('');

  row.innerHTML = `
    <div class="interview-row-header">
      <span class="interview-number">Interview ${i + 1}</span>
      <button type="button" class="btn-icon-only btn-remove-interview" title="Remove this interview">✕</button>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Name of school staff interviewer <span class="required">*</span></label><input type="text" class="iv-name" placeholder="Full name" value="${escapeHtml(iv.interviewerName)}"></div>
      <div class="form-group"><label>Their position at the school</label><input type="text" class="iv-title" placeholder="e.g., Principal" value="${escapeHtml(iv.interviewerTitle)}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Date <span class="required">*</span></label><input type="date" class="iv-date" value="${escapeHtml(iv.date)}"></div>
      <div class="form-group"><label>Time of day <span class="required">*</span></label><input type="time" class="iv-time" value="${escapeHtml(iv.time)}"></div>
      <div class="form-group"><label>Length (minutes) <span class="required">*</span></label><input type="number" min="0" step="5" class="iv-minutes" placeholder="e.g., 45" value="${escapeHtml(iv.minutes)}"></div>
    </div>
    <label class="venue-label">Venue where the teacher was interviewed <span class="required">*</span></label>
    <div class="checkbox-group iv-venue-group">${venueChoices}</div>
    <div class="conditional-fields iv-inperson-fields" style="display: ${iv.venue === 'inPerson' ? 'block' : 'none'};">
      <div class="form-row">
        <div class="form-group"><label>Where? <span class="required">*</span></label><input type="text" class="iv-place" list="placeList" placeholder="e.g., our school, a teacher fair in Madrid" value="${escapeHtml(iv.place)}"></div>
        <div class="form-group"><label>In which country? <span class="required">*</span></label><input type="text" class="iv-country" list="countryList" placeholder="e.g., Spain" value="${escapeHtml(iv.country)}"></div>
      </div>
    </div>
    <div class="conditional-fields iv-other-fields" style="display: ${iv.venue === 'other' ? 'block' : 'none'};">
      <div class="form-group"><label>How was this interview held? <span class="required">*</span></label><input type="text" class="iv-other" placeholder="Describe how you spoke to the teacher" value="${escapeHtml(iv.venueOther)}"></div>
    </div>
    <span class="field-error" id="interview${i}Error"></span>
  `;

  const bind = (selector, key, onChange) => {
    row.querySelector(selector).addEventListener('input', (e) => {
      _currentInterviews[i][key] = e.target.value.trim();
      if (onChange) onChange();
    });
  };
  bind('.iv-name', 'interviewerName');
  bind('.iv-title', 'interviewerTitle');
  bind('.iv-date', 'date');
  bind('.iv-time', 'time');
  bind('.iv-minutes', 'minutes', _updateInterviewTotal);
  bind('.iv-place', 'place');
  bind('.iv-country', 'country');
  bind('.iv-other', 'venueOther');

  row.querySelector('.iv-venue-group').addEventListener('change', (e) => {
    _currentInterviews[i].venue = e.target.value;
    row.querySelector('.iv-inperson-fields').style.display = e.target.value === 'inPerson' ? 'block' : 'none';
    row.querySelector('.iv-other-fields').style.display = e.target.value === 'other' ? 'block' : 'none';
  });

  row.querySelector('.btn-remove-interview').addEventListener('click', () => {
    _currentInterviews.splice(i, 1);
    if (_currentInterviews.length === 0) _currentInterviews.push(_emptyInterview());
    _renderInterviews();
  });

  return row;
}

function _addInterview() {
  _currentInterviews.push(_emptyInterview());
  _renderInterviews();
}

function _showTableView() {
  document.getElementById('teacherTableView').style.display = 'block';
  document.getElementById('teacherFormView').style.display = 'none';
  renderTeacherTable();
  _updateWizardNav(true);
}

function _showFormView() {
  document.getElementById('teacherTableView').style.display = 'none';
  document.getElementById('teacherFormView').style.display = 'block';
  _updateWizardNav(false);
}

function _updateWizardNav(showNav) {
  document.getElementById('prevBtn').style.display = showNav ? '' : 'none';
  document.getElementById('nextBtn').style.display = showNav ? '' : 'none';
}

function openTeacherForm(index) {
  editingTeacherIndex = index;
  wasAddingNew = (index === -1);

  if (index === -1) {
    document.getElementById('teacherFormTitle').textContent = 'Add Teacher';
    const t = _emptyTeacher();
    // Pre-populate from last teacher
    if (report.teachers.length > 0) {
      const prev = report.teachers[report.teachers.length - 1];
      t.citizenshipCountry = prev.citizenshipCountry || '';
      for (let r = 0; r < 2; r++) {
        if (!prev.references || !prev.references[r]) continue;
        t.references[r].interviewPlace = prev.references[r].interviewPlace;
        t.references[r].interviewCountry = prev.references[r].interviewCountry;
        t.references[r].communicationVenues = [...(prev.references[r].communicationVenues || [])];
        t.references[r].communicationOther = prev.references[r].communicationOther;
      }
      t.englishTestMinutes = prev.englishTestMinutes;
    }
    _loadTeacherIntoForm(t);
  } else {
    document.getElementById('teacherFormTitle').textContent = `Edit Teacher #${index + 1}`;
    _loadTeacherIntoForm(report.teachers[index]);
  }

  _showFormView();
  document.getElementById('teacherFormView').scrollIntoView({ behavior: 'smooth' });
}

function saveTeacher() {
  const t = _readTeacherFromForm();
  if (!_validateTeacherForm(t)) return;

  if (editingTeacherIndex === -1) {
    report.teachers.push(t);
  } else {
    report.teachers[editingTeacherIndex] = t;
  }

  wasAddingNew = false;
  _saveToStorage();
  closeTeacherForm();
}

function closeTeacherForm() {
  if (wasAddingNew && editingTeacherIndex >= 0) {
    report.teachers.splice(editingTeacherIndex, 1);
  }
  editingTeacherIndex = -1;
  wasAddingNew = false;
  _saveToStorage();
  _showTableView();
}

function deleteTeacher(index) {
  if (!confirm('Delete this teacher? This cannot be undone.')) return;
  report.teachers.splice(index, 1);
  _saveToStorage();
  renderTeacherTable();
}

// ========================================
// Teacher Table Rendering
// ========================================

function renderTeacherTable() {
  const container = document.getElementById('teacherTableContainer');

  if (report.teachers.length === 0) {
    container.innerHTML = '<p class="empty-state">No teachers added yet. Click "+ Add Teacher" to begin.</p>';
    return;
  }

  const rows = report.teachers.map((t, i) => {
    const incomplete = Object.keys(_collectTeacherIssues(t)).length > 0;
    return `
    <tr>
      <td>${escapeHtml(t.firstName)} ${escapeHtml(t.lastName)}${incomplete ? ' <span class="teacher-incomplete" title="Required information is missing">⚠ Incomplete</span>' : ''}</td>
      <td>${escapeHtml(t.email)}</td>
      <td>${escapeHtml(_firstInterviewDate(t))}</td>
      <td>${escapeHtml(_interviewSummary(t))}</td>
      <td class="table-actions">
        <button type="button" class="btn-secondary btn-sm" data-edit="${i}">Edit</button>
        <button type="button" class="btn-icon-only btn-remove-teacher" data-delete="${i}" title="Delete">✕</button>
      </td>
    </tr>
  `;
  }).join('');

  container.innerHTML = `
    <div class="review-table-wrapper">
      <table class="review-table teacher-mgmt-table">
        <thead><tr><th>Name</th><th>Email</th><th>First Interview</th><th>Interviews</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => openTeacherForm(parseInt(btn.dataset.edit)));
  });
  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteTeacher(parseInt(btn.dataset.delete)));
  });
}

// ========================================
// Teacher Form <-> Object
// ========================================

function _loadTeacherIntoForm(t) {
  document.getElementById('teacherFirstName').value = t.firstName;
  document.getElementById('teacherLastName').value = t.lastName;
  document.getElementById('teacherEmail').value = t.email;
  document.getElementById('citizenshipCountry').value = t.citizenshipCountry || '';
  document.getElementById('recruitmentMethod').value = t.recruitmentMethod || '';
  document.getElementById('candidateAssessment').value = t.candidateAssessment || '';

  _currentInterviews = (t.interviews || []).map(iv => ({ ..._emptyInterview(), ...iv }));
  while (_currentInterviews.length < DEFAULT_INTERVIEW_ROWS) _currentInterviews.push(_emptyInterview());
  _renderInterviews();

  const sample = t.teachingSampleProvided || '';
  document.querySelectorAll('#teachingSampleProvided input[type="radio"]').forEach(radio => {
    radio.checked = radio.value === sample;
  });
  _setCheckboxGroup('teachingSampleTypes', t.teachingSampleTypes || []);
  document.getElementById('teachingSampleMinutes').value = t.teachingSampleMinutes || '';
  document.getElementById('teachingSampleAlternative').value = t.teachingSampleAlternative || '';
  _updateTeachingSampleVisibility();

  for (let r = 0; r < 2; r++) {
    const ref = t.references[r];
    const p = `ref${r + 1}`;
    document.getElementById(`${p}Name`).value = ref.name;
    document.getElementById(`${p}Title`).value = ref.title;
    document.getElementById(`${p}Email`).value = ref.email;
    document.getElementById(`${p}Date`).value = ref.interviewDate;
    document.getElementById(`${p}Time`).value = ref.interviewTime || '';
    document.getElementById(`${p}Minutes`).value = ref.interviewMinutes;
    document.getElementById(`${p}Place`).value = ref.interviewPlace;
    document.getElementById(`${p}Country`).value = ref.interviewCountry;
    document.getElementById(`${p}Feedback`).value = ref.feedback || '';
    _setCheckboxGroup(`${p}Venues`, ref.communicationVenues);
    document.getElementById(`${p}OtherVenue`).value = ref.communicationOther;
    document.getElementById(`${p}OtherField`).style.display =
      ref.communicationVenues.includes('other') ? 'block' : 'none';
  }

  document.getElementById('nativeEnglishToggle').checked = t.isNativeEnglishSpeaker;
  _updateToggleState('nativeEnglishToggle', 'nativeEnglishLabel');
  _updateNonNativeVisibility();
  document.getElementById('nativeTestedToggle').checked = t.nativeTestedEnglish;
  _updateToggleState('nativeTestedToggle', 'nativeTestedLabel');
  document.getElementById('englishTestMinutes').value = t.englishTestMinutes;

  // Clear errors
  document.querySelectorAll('#teacherFormView .field-error').forEach(el => { el.textContent = ''; });
  _refreshCharCounters();
}

function _readTeacherFromForm() {
  const t = _emptyTeacher();
  t.firstName = document.getElementById('teacherFirstName').value.trim();
  t.lastName = document.getElementById('teacherLastName').value.trim();
  t.email = document.getElementById('teacherEmail').value.trim();
  t.citizenshipCountry = document.getElementById('citizenshipCountry').value.trim();
  t.recruitmentMethod = document.getElementById('recruitmentMethod').value.trim();
  t.candidateAssessment = document.getElementById('candidateAssessment').value.trim();
  t.interviews = _currentInterviews.map(iv => ({ ...iv }));
  t.teachingSampleProvided =
    document.querySelector('#teachingSampleProvided input[type="radio"]:checked')?.value || '';
  t.teachingSampleTypes = _getCheckboxGroup('teachingSampleTypes');
  t.teachingSampleMinutes = document.getElementById('teachingSampleMinutes').value.trim();
  t.teachingSampleAlternative = document.getElementById('teachingSampleAlternative').value.trim();

  for (let r = 0; r < 2; r++) {
    const ref = t.references[r];
    const p = `ref${r + 1}`;
    ref.name = document.getElementById(`${p}Name`).value.trim();
    ref.title = document.getElementById(`${p}Title`).value.trim();
    ref.email = document.getElementById(`${p}Email`).value.trim();
    ref.interviewDate = document.getElementById(`${p}Date`).value.trim();
    ref.interviewTime = document.getElementById(`${p}Time`).value.trim();
    ref.interviewMinutes = document.getElementById(`${p}Minutes`).value.trim();
    ref.interviewPlace = document.getElementById(`${p}Place`).value.trim();
    ref.interviewCountry = document.getElementById(`${p}Country`).value.trim();
    ref.feedback = document.getElementById(`${p}Feedback`).value.trim();
    ref.communicationVenues = _getCheckboxGroup(`${p}Venues`);
    ref.communicationOther = document.getElementById(`${p}OtherVenue`).value.trim();
  }

  t.isNativeEnglishSpeaker = document.getElementById('nativeEnglishToggle').checked;
  t.nativeTestedEnglish = document.getElementById('nativeTestedToggle').checked;
  t.englishTestMinutes = document.getElementById('englishTestMinutes').value;
  return t;
}

// ========================================
// Checkbox Groups
// ========================================

function _getCheckboxGroup(containerId) {
  return Array.from(document.getElementById(containerId).querySelectorAll('input[type="checkbox"]:checked'))
    .map(cb => cb.value);
}

function _setCheckboxGroup(containerId, values) {
  document.getElementById(containerId).querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = values.includes(cb.value);
  });
}

// ========================================
// Character Counters
// ========================================

function _updateCharCounter(textarea) {
  const counter = document.querySelector(`.char-counter[data-counter-for="${textarea.id}"]`);
  if (!counter) return;
  const min = parseInt(textarea.dataset.minChars, 10) || 0;
  const length = textarea.value.trim().length;
  const meetsMin = length >= min;
  counter.textContent = meetsMin ? `${length} characters` : `${length} / ${min} characters minimum`;
  counter.classList.toggle('char-counter-short', !meetsMin);
}

function _refreshCharCounters() {
  document.querySelectorAll('textarea[data-min-chars]').forEach(_updateCharCounter);
}

function initCharCounters() {
  document.querySelectorAll('textarea[data-min-chars]').forEach(textarea => {
    textarea.addEventListener('input', () => _updateCharCounter(textarea));
  });
  _refreshCharCounters();
}

function initVenueCheckboxes() {
  for (const groupId of ['ref1Venues', 'ref2Venues']) {
    const otherFieldId = groupId.replace('Venues', 'OtherField');
    document.getElementById(groupId).addEventListener('change', (e) => {
      if (e.target.value === 'other') {
        document.getElementById(otherFieldId).style.display = e.target.checked ? 'block' : 'none';
      }
    });
  }
}

/** Shows the follow-up questions that match the teaching sample answer. */
function _updateTeachingSampleVisibility() {
  const answer = document.querySelector('#teachingSampleProvided input[type="radio"]:checked')?.value || '';
  document.getElementById('teachingSampleYesFields').style.display = answer === 'yes' ? 'block' : 'none';
  document.getElementById('teachingSampleNoFields').style.display = answer === 'no' ? 'block' : 'none';

  const types = _getCheckboxGroup('teachingSampleTypes');
  document.getElementById('teachingSampleMinutesField').style.display =
    answer === 'yes' && _sampleNeedsDuration(types) ? 'block' : 'none';
}

/** A lesson plan has no duration; a video or an observed class does. */
function _sampleNeedsDuration(types) {
  return (types || []).some(type => type === 'video' || type === 'observation');
}

function initTeachingSample() {
  document.getElementById('teachingSampleProvided')
    .addEventListener('change', _updateTeachingSampleVisibility);
  document.getElementById('teachingSampleTypes')
    .addEventListener('change', _updateTeachingSampleVisibility);
}

// ========================================
// Toggle Switches
// ========================================

function _updateToggleState(checkboxId, labelId) {
  document.getElementById(labelId).textContent =
    document.getElementById(checkboxId).checked ? 'Yes' : 'No';
}

function _updateNonNativeVisibility() {
  document.getElementById('nonNativeFields').style.display =
    document.getElementById('nativeEnglishToggle').checked ? 'none' : 'block';
}

function initToggles() {
  document.getElementById('nativeEnglishToggle').addEventListener('change', () => {
    _updateToggleState('nativeEnglishToggle', 'nativeEnglishLabel');
    _updateNonNativeVisibility();
  });
  document.getElementById('nativeTestedToggle').addEventListener('change', () => {
    _updateToggleState('nativeTestedToggle', 'nativeTestedLabel');
  });
  document.getElementById('certToggle').addEventListener('change', () => {
    const checked = document.getElementById('certToggle').checked;
    document.getElementById('certToggleLabel').textContent = checked ? 'Yes' : 'No';
    document.getElementById('certFields').style.display = checked ? 'block' : 'none';
  });
}

// ========================================
// Signature Canvas
// ========================================

let isDrawing = false;
let signatureCtx = null;

function initSignatureCanvas() {
  const canvas = document.getElementById('signatureCanvas');
  signatureCtx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width || 500;
  canvas.height = 200;
  signatureCtx.lineWidth = 2;
  signatureCtx.lineCap = 'round';
  signatureCtx.strokeStyle = '#000';

  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('mouseleave', stopDrawing);
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); startDrawing(e.touches[0]); });
  canvas.addEventListener('touchmove', (e) => { e.preventDefault(); draw(e.touches[0]); });
  canvas.addEventListener('touchend', stopDrawing);

  document.getElementById('clearSignatureBtn').addEventListener('click', clearSignature);
}

function _getCanvasCoords(e) {
  const canvas = document.getElementById('signatureCanvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function startDrawing(e) { isDrawing = true; const { x, y } = _getCanvasCoords(e); signatureCtx.beginPath(); signatureCtx.moveTo(x, y); }
function draw(e) { if (!isDrawing) return; const { x, y } = _getCanvasCoords(e); signatureCtx.lineTo(x, y); signatureCtx.stroke(); }
function stopDrawing() { isDrawing = false; }

function clearSignature() {
  const canvas = document.getElementById('signatureCanvas');
  signatureCtx.clearRect(0, 0, canvas.width, canvas.height);
  report.signature.imageDataUrl = null;
}

function _isCanvasBlank() {
  const canvas = document.getElementById('signatureCanvas');
  const blank = document.createElement('canvas');
  blank.width = canvas.width;
  blank.height = canvas.height;
  return canvas.toDataURL() === blank.toDataURL();
}

function _captureSignature() {
  report.signature.imageDataUrl = _isCanvasBlank()
    ? null
    : document.getElementById('signatureCanvas').toDataURL('image/png');
}

function restoreSignatureCanvas(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const canvas = document.getElementById('signatureCanvas');
    signatureCtx.clearRect(0, 0, canvas.width, canvas.height);
    signatureCtx.drawImage(img, 0, 0);
  };
  img.src = dataUrl;
}

// ========================================
// Wizard Navigation
// ========================================

function initNavigationButtons() {
  document.getElementById('prevBtn').addEventListener('click', goToPreviousStep);
  document.getElementById('nextBtn').addEventListener('click', goToNextStep);
  updateNavigationButtons();
}

function _syncCurrentStep() {
  if (currentStep === 1) _syncSchoolFromForm();
  if (currentStep === 2 && _isTeacherFormOpen()) {
    _saveTeacherFormToEditing();
  }
  if (currentStep === 3) _syncSharedFromForm();
  if (currentStep === 4) {
    _captureSignature();
    report.signature.signerName = document.getElementById('signerName').value.trim();
    report.signature.signerTitle = document.getElementById('signerTitle').value.trim();
  }
}

function _isTeacherFormOpen() {
  return document.getElementById('teacherFormView').style.display !== 'none';
}

function _saveTeacherFormToEditing() {
  const t = _readTeacherFromForm();
  if (editingTeacherIndex === -1) {
    if (t.firstName || t.lastName || t.email) {
      report.teachers.push(t);
      editingTeacherIndex = report.teachers.length - 1;
    }
  } else {
    report.teachers[editingTeacherIndex] = t;
  }
}

function goToPreviousStep() {
  if (currentStep > 1) {
    _syncCurrentStep();
    _saveToStorage();
    currentStep--;
    updateWizardUI();
  }
}

function goToNextStep() {
  _syncCurrentStep();
  if (!validateCurrentStep()) return;
  _saveToStorage();

  if (currentStep < TOTAL_STEPS) {
    currentStep++;
    updateWizardUI();
    if (currentStep === TOTAL_STEPS) renderReview();
  }
}

function updateWizardUI() {
  document.querySelectorAll('.wizard-step').forEach((step, i) => {
    step.classList.toggle('active', i + 1 === currentStep);
  });
  document.querySelectorAll('.progress-step').forEach((step, i) => {
    const n = i + 1;
    step.classList.remove('active', 'completed');
    if (n === currentStep) step.classList.add('active');
    else if (n < currentStep) step.classList.add('completed');
  });
  updateNavigationButtons();
  if (currentStep === 2) {
    _showTableView();
  }
}

function updateNavigationButtons() {
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  prevBtn.style.visibility = currentStep > 1 ? 'visible' : 'hidden';
  if (currentStep === TOTAL_STEPS) {
    nextBtn.style.visibility = 'hidden';
  } else {
    nextBtn.style.visibility = 'visible';
    nextBtn.textContent = currentStep === TOTAL_STEPS - 1 ? 'Review →' : 'Next →';
  }
}

// ========================================
// Validation
// ========================================

function validateCurrentStep() {
  switch (currentStep) {
    case 1: {
      _syncSchoolFromForm();
      return _validateSchool();
    }
    case 2: return _validateTeacherList();
    case 3: {
      _syncSharedFromForm();
      return _validateServices();
    }
    case 4: {
      _captureSignature();
      report.signature.signerName = document.getElementById('signerName').value.trim();
      report.signature.signerTitle = document.getElementById('signerTitle').value.trim();
      return _validateSignature();
    }
    default: return true;
  }
}

function _validateSchool() {
  let valid = true;
  if (!report.schoolName) { showError('schoolNameError', 'Required.'); valid = false; } else clearError('schoolNameError');
  if (!report.schoolContactFirstName) { showError('contactFirstNameError', 'Required.'); valid = false; } else clearError('contactFirstNameError');
  if (!report.schoolContactLastName) { showError('contactLastNameError', 'Required.'); valid = false; } else clearError('contactLastNameError');
  if (!report.schoolContactEmail) { showError('contactEmailError', 'Required.'); valid = false; } else clearError('contactEmailError');
  return valid;
}

function _isPlaceholderAnswer(text) {
  return PLACEHOLDER_ANSWER_RE.test(String(text ?? '').trim());
}

function _requiredTextIssue(text) {
  const value = String(text ?? '').trim();
  if (!value) return 'Required.';
  if (_isPlaceholderAnswer(value)) return 'Please answer this question.';
  return null;
}

function _narrativeIssue(text) {
  const value = String(text ?? '').trim();
  const basic = _requiredTextIssue(value);
  if (basic) return basic;
  if (value.length < MIN_NARRATIVE_CHARS) {
    return `Please describe this in at least ${MIN_NARRATIVE_CHARS} characters (currently ${value.length}).`;
  }
  return null;
}

function _minutesIssue(value) {
  if (String(value ?? '').trim() === '') return 'Required.';
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Enter the number of minutes.';
  return null;
}

function _listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Returns a message describing what is missing from a reference, or null if complete. */
function _referenceIssue(ref, position) {
  const missing = [];
  if (_requiredTextIssue(ref.name)) missing.push('name');
  if (_requiredTextIssue(ref.title)) missing.push('position title');
  if (_requiredTextIssue(ref.email)) missing.push('email');
  if (!ref.interviewDate) missing.push('date you spoke to them');
  if (!ref.interviewTime) missing.push('time of day');
  if (_minutesIssue(ref.interviewMinutes)) missing.push('length of the reference check');
  if (_requiredTextIssue(ref.interviewPlace)) missing.push('place of interview');
  if ((ref.communicationVenues || []).length === 0) missing.push('communication venue');

  if (missing.length > 0) {
    return `Reference #${position}: please provide the ${_listJoin(missing)}. Every reference must be fully documented.`;
  }

  if ((ref.communicationVenues || []).includes('other')) {
    const other = String(ref.communicationOther ?? '').trim();
    if (_requiredTextIssue(other)) {
      return `Reference #${position}: describe the other venue you used to reach them.`;
    }
    if (other.length < MIN_NARRATIVE_CHARS) {
      return `Reference #${position}: describe the other venue in at least ${MIN_NARRATIVE_CHARS} characters (currently ${other.length}).`;
    }
  }

  const feedbackIssue = _narrativeIssue(ref.feedback);
  if (feedbackIssue) return `Reference #${position}: ${feedbackIssue} Summarize what you asked and what you were told.`;

  return null;
}

/** Adds an error for every incomplete interview line, plus the 60 minute total. */
function _collectInterviewIssues(t, issues) {
  const interviews = t.interviews || [];
  const used = interviews
    .map((iv, index) => ({ iv, index }))
    .filter(({ iv }) => _interviewHasData(iv));

  if (used.length === 0) {
    issues.interviewsError =
      'Record every interview you held with this teacher: who took part, when, for how long and where.';
    return;
  }

  for (const { iv, index } of used) {
    const missing = [];
    if (_requiredTextIssue(iv.interviewerName)) missing.push('name of the school staff interviewer');
    if (!iv.date) missing.push('date');
    if (!iv.time) missing.push('time of day');
    if (_minutesIssue(iv.minutes)) missing.push('length in minutes');
    if (!iv.venue) missing.push('venue');
    if (iv.venue === 'inPerson') {
      if (_requiredTextIssue(iv.place)) missing.push('place where it was held');
      if (_requiredTextIssue(iv.country)) missing.push('country');
    }
    if (iv.venue === 'other' && _requiredTextIssue(iv.venueOther)) missing.push('description of how it was held');

    if (missing.length > 0) {
      issues[`interview${index}Error`] = `Please give the ${_listJoin(missing)}.`;
    }
  }

  const total = _interviewMinutesTotal(interviews);
  if (total < MIN_INTERVIEW_MINUTES) {
    issues.interviewsError =
      `The interviews add up to ${total} minutes. They must total at least ${MIN_INTERVIEW_MINUTES} minutes, ` +
      'and every member of school staff who interviewed the teacher must be listed with the time they spent.';
  }
}

/** Adds errors for the teaching sample question and whichever follow-up applies. */
function _collectTeachingSampleIssues(t, issues) {
  if (t.teachingSampleProvided !== 'yes' && t.teachingSampleProvided !== 'no') {
    issues.teachingSampleProvidedError = 'Please answer this question.';
    return;
  }

  if (t.teachingSampleProvided === 'yes') {
    const types = t.teachingSampleTypes || [];
    if (types.length === 0) {
      issues.teachingSampleTypesError = 'Select what the teacher provided.';
      return;
    }
    if (_sampleNeedsDuration(types)) {
      const minutesIssue = _minutesIssue(t.teachingSampleMinutes);
      if (minutesIssue) issues.teachingSampleMinutesError = minutesIssue;
    }
    return;
  }

  const alternativeIssue = _narrativeIssue(t.teachingSampleAlternative);
  if (alternativeIssue) issues.teachingSampleAlternativeError = alternativeIssue;
}

/**
 * Collects every validation problem for a teacher as a map of error element id
 * to message. An empty object means the teacher is fully documented.
 */
function _collectTeacherIssues(t) {
  const issues = {};

  const simpleFields = [
    ['teacherFirstNameError', t.firstName],
    ['teacherLastNameError', t.lastName],
    ['teacherEmailError', t.email],
    ['citizenshipCountryError', t.citizenshipCountry]
  ];
  for (const [errorId, value] of simpleFields) {
    const issue = _requiredTextIssue(value);
    if (issue) issues[errorId] = issue;
  }

  _collectInterviewIssues(t, issues);
  _collectTeachingSampleIssues(t, issues);

  const recruitmentIssue = _narrativeIssue(t.recruitmentMethod);
  if (recruitmentIssue) issues.recruitmentMethodError = recruitmentIssue;

  const assessmentIssue = _narrativeIssue(t.candidateAssessment);
  if (assessmentIssue) issues.candidateAssessmentError = assessmentIssue;

  t.references.forEach((ref, i) => {
    const issue = _referenceIssue(ref, i + 1);
    if (issue) issues[`ref${i + 1}Error`] = issue;
  });

  if (issues.ref1Error || issues.ref2Error) {
    issues.referencesError = 'Both prior employer references must be checked and fully documented.';
  }

  return issues;
}

function _teacherLabel(t, index) {
  const name = `${t.firstName || ''} ${t.lastName || ''}`.trim();
  return name ? `#${index + 1} (${name})` : `#${index + 1}`;
}

function _validateTeacherList() {
  if (report.teachers.length === 0) {
    showError('teacherTableError', 'You must add at least one teacher.');
    return false;
  }

  const incomplete = report.teachers
    .map((t, i) => (Object.keys(_collectTeacherIssues(t)).length > 0 ? _teacherLabel(t, i) : null))
    .filter(Boolean);

  if (incomplete.length > 0) {
    showError('teacherTableError',
      `Teacher ${_listJoin(incomplete)} ${incomplete.length === 1 ? 'is' : 'are'} incomplete. Open ${incomplete.length === 1 ? 'it' : 'them'} and fill in every required field before continuing.`);
    renderTeacherTable();
    return false;
  }

  clearError('teacherTableError');
  return true;
}

function _validateTeacherForm(t) {
  const issues = _collectTeacherIssues(t);

  document.querySelectorAll('#teacherFormView .field-error').forEach(el => { el.textContent = ''; });
  for (const [errorId, message] of Object.entries(issues)) showError(errorId, message);

  const firstError = document.querySelector('#teacherFormView .field-error:not(:empty)');
  if (firstError) firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return Object.keys(issues).length === 0;
}

function _validateServices() {
  let valid = true;
  if (report.certification.required) {
    if (!report.certification.link) { showError('certLinkError', 'Required.'); valid = false; } else clearError('certLinkError');
    if (!report.certification.costToTeacher) { showError('certCostError', 'Required.'); valid = false; } else clearError('certCostError');
  }
  return valid;
}

function _validateSignature() {
  let valid = true;
  if (!report.signature.imageDataUrl) { showError('signatureError', 'Signature is required.'); valid = false; } else clearError('signatureError');
  if (!report.signature.signerName) { showError('signerNameError', 'Required.'); valid = false; } else clearError('signerNameError');
  if (!report.signature.signerTitle) { showError('signerTitleError', 'Required.'); valid = false; } else clearError('signerTitleError');
  return valid;
}

// ========================================
// Review
// ========================================

function _venueLabels(venues, other) {
  const labels = venues.filter(v => v !== 'other').map(v => VENUE_OPTIONS.find(o => o.value === v)?.label || v);
  if (venues.includes('other') && other) labels.push(other);
  return labels.join(', ');
}

function _placeCountry(place, country) {
  return [place, country].filter(Boolean).join(' – ');
}

/** Human-readable venue for one interview, including the in-person location. */
function _interviewVenueLabel(iv) {
  if (iv.venue === 'inPerson') {
    const where = _placeCountry(iv.place, iv.country);
    return where ? `In person – ${where}` : 'In person';
  }
  if (iv.venue === 'other') return iv.venueOther || 'Other';
  return INTERVIEW_VENUE_OPTIONS.find(o => o.value === iv.venue)?.label || '';
}

function _usedInterviews(t) {
  return (t.interviews || []).filter(_interviewHasData);
}

function _firstInterviewDate(t) {
  return _usedInterviews(t).map(iv => iv.date).filter(Boolean).sort()[0] || '';
}

function _interviewSummary(t) {
  const used = _usedInterviews(t);
  if (used.length === 0) return '';
  const total = _interviewMinutesTotal(used);
  return `${used.length} interview${used.length === 1 ? '' : 's'}, ${total} minutes total`;
}

function _teachingSampleSummary(t) {
  if (t.teachingSampleProvided === 'no') return 'No';
  if (t.teachingSampleProvided !== 'yes') return '';
  const labels = { video: 'sample teaching video', lessonPlan: 'lesson plan', observation: 'live class observed' };
  const provided = (t.teachingSampleTypes || []).map(type => labels[type] || type);
  const duration = _sampleNeedsDuration(t.teachingSampleTypes) && t.teachingSampleMinutes
    ? ` (${t.teachingSampleMinutes} minutes)`
    : '';
  return `Yes — ${provided.join(', ')}${duration}`;
}

function renderReview() {
  _syncSharedFromForm();
  _captureSignature();
  report.signature.signerName = document.getElementById('signerName').value.trim();
  report.signature.signerTitle = document.getElementById('signerTitle').value.trim();

  const container = document.getElementById('reviewContainer');

  const tableRows = report.teachers.map(t => `
    <tr>
      <td>${escapeHtml(t.firstName)} ${escapeHtml(t.lastName)}</td>
      <td>${escapeHtml(t.email)}</td>
      <td>${escapeHtml(_firstInterviewDate(t))}</td>
      <td>${escapeHtml(_interviewSummary(t))}</td>
    </tr>
  `).join('');

  const teacherSections = report.teachers.map((t, i) => {
    const refHtml = t.references.map((ref, ri) => `
      <h4 style="margin: 12px 0 8px; color: var(--color-primary-dark);">Reference #${ri + 1}</h4>
      <div class="review-field"><span class="review-label">Name</span><span class="review-value">${escapeHtml(ref.name)}${ref.title ? `, ${escapeHtml(ref.title)}` : ''}</span></div>
      <div class="review-field"><span class="review-label">Email</span><span class="review-value">${escapeHtml(ref.email)}</span></div>
      ${ref.interviewDate ? `<div class="review-field"><span class="review-label">Spoken To On</span><span class="review-value">${escapeHtml([ref.interviewDate, ref.interviewTime].filter(Boolean).join(' at '))}</span></div>` : ''}
      ${ref.interviewMinutes ? `<div class="review-field"><span class="review-label">Length</span><span class="review-value">${escapeHtml(String(ref.interviewMinutes))} minutes</span></div>` : ''}
      ${(ref.interviewPlace || ref.interviewCountry) ? `<div class="review-field"><span class="review-label">Place</span><span class="review-value">${escapeHtml(_placeCountry(ref.interviewPlace, ref.interviewCountry))}</span></div>` : ''}
      ${ref.communicationVenues.length ? `<div class="review-field"><span class="review-label">Communication</span><span class="review-value">${escapeHtml(_venueLabels(ref.communicationVenues, ref.communicationOther))}</span></div>` : ''}
      ${ref.feedback ? `<div class="review-field review-field-block"><span class="review-label">What they said</span><span class="review-value">${escapeHtml(ref.feedback)}</span></div>` : ''}
    `).join('');

    return `
      <div class="review-section">
        <h3>Teacher ${i + 1}: ${escapeHtml(t.firstName)} ${escapeHtml(t.lastName)}</h3>
        <div class="review-field"><span class="review-label">Email</span><span class="review-value">${escapeHtml(t.email)}</span></div>
        <div class="review-field"><span class="review-label">Citizenship</span><span class="review-value">${escapeHtml(t.citizenshipCountry)}</span></div>
        <h4 style="margin: 12px 0 8px; color: var(--color-primary-dark);">Interviews</h4>
        ${_usedInterviews(t).map((iv, n) => `
          <div class="review-field"><span class="review-label">Interview ${n + 1}</span><span class="review-value">${escapeHtml([iv.date, iv.time].filter(Boolean).join(' at '))}${iv.minutes ? ` — ${escapeHtml(iv.minutes)} minutes` : ''}</span></div>
          <div class="review-field"><span class="review-label">Interviewer</span><span class="review-value">${escapeHtml(iv.interviewerName)}${iv.interviewerTitle ? `, ${escapeHtml(iv.interviewerTitle)}` : ''}</span></div>
          <div class="review-field"><span class="review-label">Venue</span><span class="review-value">${escapeHtml(_interviewVenueLabel(iv))}</span></div>
        `).join('')}
        <div class="review-field"><span class="review-label">Total Interview Time</span><span class="review-value">${_interviewMinutesTotal(t.interviews)} minutes</span></div>
        <div class="review-field review-field-block"><span class="review-label">How recruited</span><span class="review-value">${escapeHtml(t.recruitmentMethod)}</span></div>
        <div class="review-field review-field-block"><span class="review-label">How evaluated</span><span class="review-value">${escapeHtml(t.candidateAssessment)}</span></div>
        <div class="review-field"><span class="review-label">Teaching sample</span><span class="review-value">${escapeHtml(_teachingSampleSummary(t))}</span></div>
        ${t.teachingSampleProvided === 'no' && t.teachingSampleAlternative ? `<div class="review-field review-field-block"><span class="review-label">Evaluated instead by</span><span class="review-value">${escapeHtml(t.teachingSampleAlternative)}</span></div>` : ''}
        ${refHtml}
        <h4 style="margin: 12px 0 8px; color: var(--color-primary-dark);">English Assessment</h4>
        <div class="review-field"><span class="review-label">Native speaker</span><span class="review-value">${t.isNativeEnglishSpeaker ? 'Yes' : 'No'}</span></div>
        ${!t.isNativeEnglishSpeaker ? `
          <div class="review-field"><span class="review-label">Tested by native speaker</span><span class="review-value">${t.nativeTestedEnglish ? 'Yes' : 'No'}</span></div>
          ${t.englishTestMinutes ? `<div class="review-field"><span class="review-label">Test duration</span><span class="review-value">${escapeHtml(t.englishTestMinutes)} minutes</span></div>` : ''}
        ` : ''}
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="review-section">
      <h3>School Information</h3>
      <div class="review-field"><span class="review-label">School</span><span class="review-value">${escapeHtml(report.schoolName)}</span></div>
      <div class="review-field"><span class="review-label">Contact</span><span class="review-value">${escapeHtml(report.schoolContactFirstName)} ${escapeHtml(report.schoolContactLastName)}</span></div>
      <div class="review-field"><span class="review-label">Email</span><span class="review-value">${escapeHtml(report.schoolContactEmail)}</span></div>
    </div>
    <div class="review-section">
      <h3>Teacher Summary</h3>
      <div class="review-table-wrapper">
        <table class="review-table"><thead><tr><th>Name</th><th>Email</th><th>First Interview</th><th>Interviews</th></tr></thead><tbody>${tableRows}</tbody></table>
      </div>
    </div>
    ${teacherSections}
    <div class="review-section">
      <h3>Certification</h3>
      <div class="review-field"><span class="review-label">Certification Required</span><span class="review-value">${report.certification.required ? 'Yes (public/charter)' : 'No (private/religious)'}</span></div>
      ${report.certification.required ? `
        <div class="review-field"><span class="review-label">Certification Link</span><span class="review-value">${escapeHtml(report.certification.link)}</span></div>
        <div class="review-field"><span class="review-label">Cost to Teacher</span><span class="review-value">${escapeHtml(report.certification.costToTeacher)}</span></div>
      ` : ''}
    </div>
    <div class="review-section">
      <h3>Signature</h3>
      ${report.signature.imageDataUrl ? `<img src="${report.signature.imageDataUrl}" alt="Signature" style="max-width: 300px; border: 1px solid var(--color-border); border-radius: 4px; margin-bottom: 8px;">` : '<p>No signature</p>'}
      <div class="review-field"><span class="review-label">Name</span><span class="review-value">${escapeHtml(report.signature.signerName)}</span></div>
      <div class="review-field"><span class="review-label">Title</span><span class="review-value">${escapeHtml(report.signature.signerTitle)}</span></div>
    </div>
  `;
}

// ========================================
// PDF Generation
// ========================================

async function generateReport() {
  const overlay = document.getElementById('generatingOverlay');
  const statusEl = document.getElementById('generatingStatus');
  overlay.style.display = 'flex';

  try {
    const pdfBytes = await generatePDF(report, (s) => { statusEl.textContent = s; });
    const filename = generateFilename(report.date, report.schoolName);

    statusEl.textContent = 'Downloading...';
    downloadPDF(pdfBytes, filename);

    statusEl.textContent = 'Complete!';
    setTimeout(() => { overlay.style.display = 'none'; }, 1000);
  } catch (error) {
    console.error('PDF generation failed:', error);
    overlay.style.display = 'none';
    _showErrorModal(error);
  }
}

function _showErrorModal(error) {
  const overlay = document.createElement('div');
  overlay.className = 'progress-overlay';
  overlay.style.display = 'flex';

  const modal = document.createElement('div');
  modal.className = 'progress-modal error-modal';
  modal.innerHTML = `
    <p class="error-modal-title">Failed to generate PDF</p>
    <p class="error-modal-message">${escapeHtml(error.message)}</p>
    <p class="error-modal-hint">Please download the debug file and share it so we can investigate.</p>
    <div class="error-modal-actions">
      <button type="button" class="btn-primary btn-download-debug">Download Debug Info</button>
      <button type="button" class="btn-secondary btn-close-error">Close</button>
    </div>
  `;
  modal.querySelector('.btn-download-debug').addEventListener('click', () => {
    const debugData = {
      appVersion: APP_VERSION, form: 'recruitment-report',
      timestamp: new Date().toISOString(), userAgent: navigator.userAgent,
      error: { message: error.message, stack: error.stack },
      report: JSON.parse(JSON.stringify(report))
    };
    const blob = new Blob([JSON.stringify(debugData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `debug_recruitment_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  modal.querySelector('.btn-close-error').addEventListener('click', () => overlay.remove());
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ========================================
// Utilities
// ========================================

function showError(id, msg) { const el = document.getElementById(id); if (el) el.textContent = msg; }
function clearError(id) { const el = document.getElementById(id); if (el) el.textContent = ''; }

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
