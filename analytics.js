const loginPanel = document.querySelector('#login-panel');
const loginForm = document.querySelector('#login-form');
const passwordInput = document.querySelector('#password');
const dashboard = document.querySelector('#dashboard');
const rangeSelect = document.querySelector('#range');
const totals = document.querySelector('#totals');
const dailyRows = document.querySelector('#daily-rows');
const status = document.querySelector('#status');
const logoutButton = document.querySelector('#logout');
const numberFormat = new Intl.NumberFormat();
let summaryRequestGeneration = 0;

function setStatus(message) {
  status.textContent = message;
}

function metric(label, value) {
  const item = document.createElement('div');
  item.className = 'analytics-metric';
  const name = document.createElement('span');
  name.textContent = label;
  const amount = document.createElement('strong');
  amount.textContent = typeof value === 'number' ? numberFormat.format(value) : value;
  item.append(name, amount);
  return item;
}

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function showDashboard() {
  loginPanel.hidden = true;
  dashboard.hidden = false;
}

function showLogin() {
  dashboard.hidden = true;
  loginPanel.hidden = false;
}

async function loadSummary() {
  const requestGeneration = ++summaryRequestGeneration;
  setStatus('Loading usage summary…');
  try {
    const response = await fetch(`/api/usage-analytics/summary?days=${encodeURIComponent(rangeSelect.value)}`, {
      credentials: 'same-origin',
    });
    if (requestGeneration !== summaryRequestGeneration) return;
    if (response.status === 401) {
      showLogin();
      setStatus('Sign in to view usage analytics.');
      return;
    }
    if (!response.ok) throw new Error('Unable to load summary');
    const summary = await response.json();
    if (requestGeneration !== summaryRequestGeneration) return;
    const { totals: data, daily } = summary;
    totals.replaceChildren(
      metric('PDF imports', data.pdfImports),
      metric('Phone connected sessions', data.phoneConnectedSessions),
      metric('PDF and phone sessions', data.pdfAndPhoneSessions),
      metric('Phone navigation sessions', data.phoneNavigationSessions),
      metric('Completed presentations', data.completedPresentations),
      metric('Average presentation duration', formatDuration(data.averagePresentationSeconds)),
    );
    dailyRows.replaceChildren();
    for (const row of daily) {
      const tr = document.createElement('tr');
      const values = [row.date, row.pdf_imports, row.phone_connected_sessions, row.pdf_and_phone_sessions, row.phone_navigation_sessions, row.completed_presentations, formatDuration(row.presentation_seconds)];
      for (const [index, value] of values.entries()) {
        const cell = document.createElement(index === 0 ? 'th' : 'td');
        if (index === 0) cell.scope = 'row';
        cell.textContent = index === 0 ? value : numberFormat.format(value);
        if (index === 6) cell.textContent = formatDuration(row.presentation_seconds);
        tr.append(cell);
      }
      dailyRows.append(tr);
    }
    showDashboard();
    setStatus('Usage summary updated.');
  } catch {
    if (requestGeneration !== summaryRequestGeneration) return;
    setStatus('Could not load the usage summary. Try again.');
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus('Signing in…');
  try {
    const response = await fetch('/api/usage-analytics/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    if (!response.ok) throw new Error('Sign in failed');
    passwordInput.value = '';
    showDashboard();
    await loadSummary();
  } catch {
    setStatus('Sign in failed. Check the password and try again.');
  }
});

rangeSelect.addEventListener('change', loadSummary);
logoutButton.addEventListener('click', async () => {
  setStatus('Signing out…');
  try {
    const response = await fetch('/api/usage-analytics/logout', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error('Sign out failed');
    summaryRequestGeneration += 1;
    showLogin();
    setStatus('You are signed out.');
  } catch {
    setStatus('Could not sign out. Try again.');
  }
});

loadSummary();
