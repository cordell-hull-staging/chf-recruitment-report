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
  { value: 'inPerson', label: 'In Person' },
  { value: 'letter', label: 'Letter' },
  { value: 'other', label: 'Other' }
];

// ========================================
// Application State
// ========================================

function _emptyReference() {
  return {
    name: '', title: '', email: '',
    interviewLength: '', interviewDate: '', interviewPlace: '', interviewCountry: '',
    communicationVenues: [], communicationOther: ''
  };
}

function _emptyTeacher() {
  return {
    firstName: '', lastName: '', email: '',
    interviewDate: '', interviewPlace: '', interviewCountry: '', interviewLength: '',
    communicationVenues: [], communicationOther: '',
    additionalInterviewers: [],
    references: [_emptyReference(), _emptyReference()],
    isNativeEnglishSpeaker: false,
    nativeTestedEnglish: false,
    englishTestMinutes: ''
  };
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
    report.teachers = (saved.teachers || []).map(t => ({
      ..._emptyTeacher(),
      ...t,
      references: [
        { ..._emptyReference(), ...(t.references?.[0] || {}) },
        { ..._emptyReference(), ...(t.references?.[1] || {}) }
      ]
    }));
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
    report.teachers = data.teachers || [];
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
  document.getElementById('addInterviewerBtn').addEventListener('click', _addInterviewer);
}

// ========================================
// Additional Interviewers
// ========================================

let _currentInterviewers = [];

function _renderInterviewers() {
  const container = document.getElementById('interviewersContainer');
  container.innerHTML = '';
  _currentInterviewers.forEach((iv, i) => {
    const row = document.createElement('div');
    row.className = 'interviewer-row';
    row.innerHTML = `
      <div class="form-row">
        <div class="form-group"><input type="text" class="iv-name" placeholder="Full name" value="${escapeHtml(iv.name)}"></div>
        <div class="form-group"><input type="text" class="iv-title" placeholder="Position title" value="${escapeHtml(iv.title)}"></div>
      </div>
      <button type="button" class="btn-icon-only btn-remove-interviewer" title="Remove">✕</button>
    `;
    row.querySelector('.iv-name').addEventListener('input', (e) => { _currentInterviewers[i].name = e.target.value.trim(); });
    row.querySelector('.iv-title').addEventListener('input', (e) => { _currentInterviewers[i].title = e.target.value.trim(); });
    row.querySelector('.btn-remove-interviewer').addEventListener('click', () => {
      _currentInterviewers.splice(i, 1);
      _renderInterviewers();
    });
    container.appendChild(row);
  });
}

function _addInterviewer() {
  _currentInterviewers.push({ name: '', title: '' });
  _renderInterviewers();
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
      t.interviewPlace = prev.interviewPlace;
      t.interviewCountry = prev.interviewCountry;
      t.communicationVenues = [...prev.communicationVenues];
      t.communicationOther = prev.communicationOther;
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

  const rows = report.teachers.map((t, i) => `
    <tr>
      <td>${escapeHtml(t.firstName)} ${escapeHtml(t.lastName)}</td>
      <td>${escapeHtml(t.email)}</td>
      <td>${escapeHtml(t.interviewDate)}</td>
      <td>${escapeHtml([t.interviewPlace, t.interviewCountry].filter(Boolean).join(', '))}</td>
      <td class="table-actions">
        <button type="button" class="btn-secondary btn-sm" data-edit="${i}">Edit</button>
        <button type="button" class="btn-icon-only btn-remove-teacher" data-delete="${i}" title="Delete">✕</button>
      </td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div class="review-table-wrapper">
      <table class="review-table teacher-mgmt-table">
        <thead><tr><th>Name</th><th>Email</th><th>Interview</th><th>Place</th><th></th></tr></thead>
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
  document.getElementById('interviewDate').value = t.interviewDate;
  document.getElementById('interviewPlace').value = t.interviewPlace;
  document.getElementById('interviewCountry').value = t.interviewCountry;
  document.getElementById('interviewLength').value = t.interviewLength;

  _setCheckboxGroup('teacherVenues', t.communicationVenues);
  document.getElementById('teacherOtherVenue').value = t.communicationOther;
  document.getElementById('teacherOtherField').style.display =
    t.communicationVenues.includes('other') ? 'block' : 'none';

  _currentInterviewers = (t.additionalInterviewers || []).map(iv => ({ ...iv }));
  _renderInterviewers();

  for (let r = 0; r < 2; r++) {
    const ref = t.references[r];
    const p = `ref${r + 1}`;
    document.getElementById(`${p}Name`).value = ref.name;
    document.getElementById(`${p}Title`).value = ref.title;
    document.getElementById(`${p}Email`).value = ref.email;
    document.getElementById(`${p}Date`).value = ref.interviewDate;
    document.getElementById(`${p}Length`).value = ref.interviewLength;
    document.getElementById(`${p}Place`).value = ref.interviewPlace;
    document.getElementById(`${p}Country`).value = ref.interviewCountry;
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
}

function _readTeacherFromForm() {
  const t = _emptyTeacher();
  t.firstName = document.getElementById('teacherFirstName').value.trim();
  t.lastName = document.getElementById('teacherLastName').value.trim();
  t.email = document.getElementById('teacherEmail').value.trim();
  t.interviewDate = document.getElementById('interviewDate').value.trim();
  t.interviewPlace = document.getElementById('interviewPlace').value.trim();
  t.interviewCountry = document.getElementById('interviewCountry').value.trim();
  t.interviewLength = document.getElementById('interviewLength').value.trim();
  t.communicationVenues = _getCheckboxGroup('teacherVenues');
  t.communicationOther = document.getElementById('teacherOtherVenue').value.trim();
  t.additionalInterviewers = _currentInterviewers.filter(iv => iv.name);

  for (let r = 0; r < 2; r++) {
    const ref = t.references[r];
    const p = `ref${r + 1}`;
    ref.name = document.getElementById(`${p}Name`).value.trim();
    ref.title = document.getElementById(`${p}Title`).value.trim();
    ref.email = document.getElementById(`${p}Email`).value.trim();
    ref.interviewDate = document.getElementById(`${p}Date`).value.trim();
    ref.interviewLength = document.getElementById(`${p}Length`).value.trim();
    ref.interviewPlace = document.getElementById(`${p}Place`).value.trim();
    ref.interviewCountry = document.getElementById(`${p}Country`).value.trim();
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

function initVenueCheckboxes() {
  for (const groupId of ['teacherVenues', 'ref1Venues', 'ref2Venues']) {
    const otherFieldId = groupId.replace('Venues', 'OtherField');
    document.getElementById(groupId).addEventListener('change', (e) => {
      if (e.target.value === 'other') {
        document.getElementById(otherFieldId).style.display = e.target.checked ? 'block' : 'none';
      }
    });
  }
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

function _validateTeacherList() {
  if (report.teachers.length === 0) {
    showError('teacherTableError', 'You must add at least one teacher.');
    return false;
  }
  clearError('teacherTableError');
  return true;
}

function _validateTeacherForm(t) {
  let valid = true;
  if (!t.firstName) { showError('teacherFirstNameError', 'Required.'); valid = false; } else clearError('teacherFirstNameError');
  if (!t.lastName) { showError('teacherLastNameError', 'Required.'); valid = false; } else clearError('teacherLastNameError');
  if (!t.email) { showError('teacherEmailError', 'Required.'); valid = false; } else clearError('teacherEmailError');
  if (!t.interviewDate) { showError('interviewDateError', 'Required.'); valid = false; } else clearError('interviewDateError');
  if (!t.interviewLength) { showError('interviewLengthError', 'Required.'); valid = false; } else clearError('interviewLengthError');
  if (!t.interviewPlace) { showError('interviewPlaceError', 'Required.'); valid = false; } else clearError('interviewPlaceError');
  if (!t.interviewCountry) { showError('interviewCountryError', 'Required.'); valid = false; } else clearError('interviewCountryError');
  if (t.communicationVenues.length === 0) { showError('teacherVenuesError', 'Select at least one.'); valid = false; } else clearError('teacherVenuesError');

  let refsValid = true;
  for (const ref of t.references) {
    if (!ref.name || !ref.email) refsValid = false;
  }
  if (!refsValid) { showError('referencesError', 'Both references require a name and email.'); valid = false; }
  else clearError('referencesError');

  return valid;
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
      <td>${escapeHtml(t.interviewDate)}</td>
      <td>${escapeHtml(_placeCountry(t.interviewPlace, t.interviewCountry))}</td>
    </tr>
  `).join('');

  const teacherSections = report.teachers.map((t, i) => {
    const refHtml = t.references.map((ref, ri) => `
      <h4 style="margin: 12px 0 8px; color: var(--color-primary-dark);">Reference #${ri + 1}</h4>
      <div class="review-field"><span class="review-label">Name</span><span class="review-value">${escapeHtml(ref.name)}${ref.title ? `, ${escapeHtml(ref.title)}` : ''}</span></div>
      <div class="review-field"><span class="review-label">Email</span><span class="review-value">${escapeHtml(ref.email)}</span></div>
      ${ref.interviewDate ? `<div class="review-field"><span class="review-label">Interview Date</span><span class="review-value">${escapeHtml(ref.interviewDate)}</span></div>` : ''}
      ${ref.interviewLength ? `<div class="review-field"><span class="review-label">Interview Length</span><span class="review-value">${escapeHtml(ref.interviewLength)}</span></div>` : ''}
      ${(ref.interviewPlace || ref.interviewCountry) ? `<div class="review-field"><span class="review-label">Place</span><span class="review-value">${escapeHtml(_placeCountry(ref.interviewPlace, ref.interviewCountry))}</span></div>` : ''}
      ${ref.communicationVenues.length ? `<div class="review-field"><span class="review-label">Communication</span><span class="review-value">${escapeHtml(_venueLabels(ref.communicationVenues, ref.communicationOther))}</span></div>` : ''}
    `).join('');

    return `
      <div class="review-section">
        <h3>Teacher ${i + 1}: ${escapeHtml(t.firstName)} ${escapeHtml(t.lastName)}</h3>
        <div class="review-field"><span class="review-label">Email</span><span class="review-value">${escapeHtml(t.email)}</span></div>
        <div class="review-field"><span class="review-label">Interview Date</span><span class="review-value">${escapeHtml(t.interviewDate)}</span></div>
        <div class="review-field"><span class="review-label">Interview Length</span><span class="review-value">${escapeHtml(t.interviewLength)}</span></div>
        <div class="review-field"><span class="review-label">Place</span><span class="review-value">${escapeHtml(_placeCountry(t.interviewPlace, t.interviewCountry))}</span></div>
        <div class="review-field"><span class="review-label">Communication</span><span class="review-value">${escapeHtml(_venueLabels(t.communicationVenues, t.communicationOther))}</span></div>
        ${(t.additionalInterviewers || []).length > 0 ? `
          <h4 style="margin: 12px 0 8px; color: var(--color-primary-dark);">Additional School Interviewers</h4>
          ${t.additionalInterviewers.map(iv => `<div class="review-field"><span class="review-label">${escapeHtml(iv.name)}</span><span class="review-value">${escapeHtml(iv.title)}</span></div>`).join('')}
        ` : ''}
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
        <table class="review-table"><thead><tr><th>Name</th><th>Email</th><th>Interview</th><th>Place</th></tr></thead><tbody>${tableRows}</tbody></table>
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
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
