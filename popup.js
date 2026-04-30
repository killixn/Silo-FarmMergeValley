// Elements
const btnInit = document.getElementById('btn-init');
const btnInject = document.getElementById('btn-inject');
const initStatus = document.getElementById('init-status');
const injectFb = document.getElementById('inject-feedback');
const amountInput = document.getElementById('amount');
const amountError = document.getElementById('amount-error');
const resourceSel = document.getElementById('resource');
const logBox = document.getElementById('log-box');
const btnClearLogs = document.getElementById('btn-clear-logs');

// Tab switching
document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) {
            t.classList.remove('active');
        });
        document.querySelectorAll('.tab-content').forEach(function (c) {
            c.classList.remove('active');
        });

        tab.classList.add('active');

        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
});

// Inline status helpers
function setInitStatus(kind, text) {
    if (!kind) {
        initStatus.className = 'inline-status';
        initStatus.innerHTML = '';
        return;
    }

    initStatus.className = 'inline-status show ' + kind;
    initStatus.innerHTML = '<span class="dot"></span><span>' + text + '</span>';
}

function setInjectFeedback(kind, text) {
    if (!kind) {
        injectFb.className = 'inject-feedback';
        injectFb.innerHTML = '';
        return;
    }

    injectFb.className = 'inject-feedback show ' + kind;
    injectFb.innerHTML = '<span class="dot"></span><span>' + text + '</span>';

    clearTimeout(injectFb._t);

    injectFb._t = setTimeout(function () {
        setInjectFeedback(null);
    }, 5000);
}

// Amount validation
function validateAmount() {
    var raw = amountInput.value.trim();
    var n = Number(raw);

    // Must be a integer within range
    if (raw === '' || !Number.isInteger(n) || n < -9999 || n > 9999) {
        amountInput.classList.add('invalid');
        amountError.textContent = 'Enter a whole number between -9999 and 9999.';
        amountError.classList.add('show');
        return false;
    }

    amountInput.classList.remove('invalid');
    amountError.classList.remove('show');
    amountError.textContent = '';
    return true;
}

amountInput.addEventListener('input', function () {
    // Strip any non-digit characters in real time
    var cleaned = amountInput.value.replace(/[^0-9]/g, '');
    if (cleaned !== amountInput.value) amountInput.value = cleaned;

    validateAmount();
});

amountInput.addEventListener('blur', validateAmount);

// Prevent non-numeric keys
amountInput.addEventListener('keydown', function (e) {
    var allowed = [
        'Backspace',
        'Delete',
        'Tab',
        'Escape',
        'Enter',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
    ];
    if (allowed.includes(e.key)) {
        if (e.key === 'Enter') triggerInject();
        return;
    }

    if (!/^[0-9]$/.test(e.key)) e.preventDefault();
});

// Quick amount buttons
document.querySelectorAll('.quick-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
        amountInput.value = btn.dataset.val;
        amountInput.classList.remove('invalid');
        amountError.classList.remove('show');
        amountError.textContent = '';
    });
});

// Log helpers
function addLog(text, kind) {
    kind = kind || 'info';

    var placeholder = logBox.querySelector('.log-placeholder');
    if (placeholder) placeholder.remove();

    var now = new Date();
    var ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(function (n) {
            return String(n).padStart(2, '0');
        })
        .join(':');
    var entry = document.createElement('div');

    entry.className = 'log-entry ' + kind;
    entry.innerHTML =
        '<span class="log-time">' +
        ts +
        '</span>' +
        '<span class="log-msg">' +
        escapeHtml(text) +
        '</span>';

    logBox.appendChild(entry);
    logBox.scrollTop = logBox.scrollHeight;
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

btnClearLogs.addEventListener('click', function () {
    logBox.innerHTML = '<span class="log-placeholder">No logs yet...</span>';
});

// Init
btnInit.addEventListener('click', function () {
    btnInit.disabled = true;
    btnInject.disabled = true;

    setInitStatus('pending', 'Initializing...');
    addLog('Starting initialization...', 'info');

    chrome.runtime.sendMessage({ type: 'INIT' }, function (res) {
        if (!res || !res.ok) {
            var reason = res && res.reason ? res.reason : 'Unknown error.';

            setInitStatus('error', reason);
            addLog('Error: ' + reason, 'error');

            btnInit.disabled = false;
        }
    });
});

// Inject
function triggerInject() {
    if (btnInject.disabled) return;

    if (!validateAmount()) return;

    var resource = resourceSel.value;
    var amount = parseInt(amountInput.value, 10);

    btnInject.disabled = true;
    btnInject.textContent = 'Injecting...';

    setInjectFeedback(null);

    chrome.runtime.sendMessage(
        { type: 'INJECT', payload: { resource: resource, amount: amount } },
        function (res) {
            btnInject.disabled = false;
            btnInject.textContent = 'Inject';

            if (res && res.ok) {
                var label = resourceSel.options[resourceSel.selectedIndex].text;
                setInjectFeedback('success', amount + 'x ' + label + ' added to inventory.');
                addLog('Injected ' + amount + 'x ' + resource + '.', 'success');
            } else {
                var reason = res && res.reason ? res.reason : 'Unknown error.';
                setInjectFeedback('error', reason);
                addLog('Inject failed: ' + reason, 'error');
            }
        }
    );
}

btnInject.addEventListener('click', triggerInject);

// Background messages
chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'LOG') {
        addLog(msg.payload.text, msg.payload.kind);
    } else if (msg.type === 'INIT_DONE') {
        setInitStatus('success', 'Ready to inject.');
        addLog('Initialization complete.', 'success');

        btnInit.disabled = false;
        btnInject.disabled = false;
    } else if (msg.type === 'INIT_FAIL') {
        var reason = msg.payload || 'Unknown error.';

        setInitStatus('error', reason);
        addLog('Initialization failed: ' + reason, 'error');

        btnInit.disabled = false;
    } else if (msg.type === 'DETACHED') {
        setInitStatus('error', 'Debugger detached. Please re-initialize.');
        addLog('Debugger detached.', 'warn');

        btnInit.disabled = false;
        btnInject.disabled = true;
    }
});

// Restore state on open
chrome.runtime.sendMessage({ type: 'GET_STATE' }, function (s) {
    if (!s) return;

    if (s.worldServicesReady) {
        setInitStatus('success', 'Ready to inject.');
        addLog('Active session restored.', 'success');
        btnInject.disabled = false;
    } else if (s.debuggerAttached) {
        setInitStatus('pending', 'Initializing...');
        btnInit.disabled = true;
    }
});
