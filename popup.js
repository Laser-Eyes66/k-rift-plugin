const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

document.addEventListener('DOMContentLoaded', async () => {
    const config = await chrome.storage.sync.get(['apiKey', 'schoolDomain', 'partnerId', 'schoolName', 'disableBadges']);
    const status = document.getElementById('status');
    const msgDiv = document.getElementById('serverMsg');

    if (config.apiKey) document.getElementById('apiKey').value = config.apiKey;
    if (config.disableBadges !== undefined) {
        document.getElementById('disableBadges').checked = config.disableBadges;
    }

    if (!config.apiKey) {
        status.style.color = '#EF4444';
        status.innerText = 'No API key configured. Enter your key to begin.';

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
                chrome.action.setBadgeText({ tabId: tabs[0].id, text: "KEY" });
                chrome.action.setBadgeBackgroundColor({ tabId: tabs[0].id, color: "#EF4444" });
            }
        });
    } else if (config.schoolDomain && config.partnerId) {
        showSchoolInfo(config.schoolName, config.schoolDomain, config.partnerId);
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
            chrome.runtime.sendMessage({ action: "getTabMessage", tabId: tabs[0].id }, (res) => {
                if (res && res.message) {
                    msgDiv.style.display = 'block';
                    msgDiv.innerHTML = res.message;
                    if (res.color) msgDiv.style.borderColor = res.color;
                }
            });
        }
    });
});

document.getElementById('disableBadges').addEventListener('change', async (e) => {
    const disableBadges = e.target.checked;
    await chrome.storage.sync.set({ disableBadges });

    if (disableBadges) {
        chrome.action.setBadgeText({ text: "" });
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
                chrome.action.setBadgeText({ tabId: tabs[0].id, text: "" });
            }
        });
    }
});

function showSchoolInfo(name, domain, partner) {
    document.getElementById('dispSchool').innerText = name;
    document.getElementById('dispDomain').innerText = domain;
    document.getElementById('dispPartner').innerText = partner;
    document.getElementById('schoolInfo').style.display = 'block';
}

document.getElementById('verifyBtn').addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKey').value.trim();
    const status = document.getElementById('status');
    const btn = document.getElementById('verifyBtn');

    if (!uuidRegex.test(apiKey)) {
        status.style.color = '#EF4444';
        status.innerText = 'Invalid API Key format (must be UUID).';
        return;
    }

    btn.disabled = true;
    status.style.color = '#F3F4F6';
    status.innerText = 'Verifying...';
    document.getElementById('serverMsg').style.display = 'none';

    try {
        const response = await fetch(`${SERVER_URL}/api/verify-setup/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey })
        });

        const data = await response.json();

        if (response.ok) {
            await chrome.storage.sync.set({
                apiKey,
                schoolDomain: data.brightspace_domain,
                partnerId: data.partner_id,
                schoolName: data.school_name
            });

            if (data.prefilled_cache) {
                await chrome.storage.local.set(data.prefilled_cache);
            }

            showSchoolInfo(data.school_name, data.brightspace_domain, data.partner_id);

            const { disableBadges } = await chrome.storage.sync.get(['disableBadges']);
            if (!disableBadges) {
                chrome.action.setBadgeText({ text: "" });
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]?.id) {
                        chrome.action.setBadgeText({ tabId: tabs[0].id, text: "" });
                    }
                });
            }

            status.style.color = '#10B981';
            status.innerText = 'Connected! Cache Synced.';
        } else {
            status.style.color = '#EF4444';
            status.innerText = data.error || 'Server error occurred.';
            document.getElementById('schoolInfo').style.display = 'none';

            await chrome.storage.sync.remove(['apiKey']);
            await chrome.storage.local.clear();
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]?.id) {
                    chrome.action.setBadgeText({ tabId: tabs[0].id, text: "KEY" });
                    chrome.action.setBadgeBackgroundColor({ tabId: tabs[0].id, color: "#EF4444" });
                }
            });
        }
    } catch (err) {
        status.style.color = '#EF4444';
        status.innerText = 'Network error. Cannot reach server.';
        document.getElementById('schoolInfo').style.display = 'none';
    } finally {
        btn.disabled = false;
        setTimeout(() => { if (status.innerText.includes('Connected')) status.innerText = ''; }, 2500);
    }
});