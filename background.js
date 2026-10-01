const tabMetadataStore = {};
const tabMessages = {};
const badgeTimers = {}; // Tracks timeouts for auto-clearing badges
importScripts('config.js');
chrome.runtime.onInstalled.addListener(async () => {
    const { apiKey, disableBadges } = await chrome.storage.sync.get(['apiKey', 'disableBadges']);
    if (!apiKey && !disableBadges) {
        chrome.action.setBadgeText({ text: "KEY" });
        chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        delete tabMetadataStore[tabId];
        delete tabMessages[tabId];

        const { apiKey, disableBadges } = await chrome.storage.sync.get(['apiKey', 'disableBadges']);
        if (!apiKey && !disableBadges) {
            chrome.action.setBadgeText({ tabId, text: "KEY" });
            chrome.action.setBadgeBackgroundColor({ tabId, color: "#EF4444" });
        } else if (!disableBadges) {
            chrome.action.setBadgeText({ tabId, text: "" });
        }
    }
});

async function updateTabBadge(tabId, text, color) {
    const { disableBadges } = await chrome.storage.sync.get(['disableBadges']);
    if (disableBadges) {
        if (tabId) chrome.action.setBadgeText({ tabId, text: "" });
        return;
    }

    if (tabId && text && color) {
        chrome.action.setBadgeText({ tabId, text });
        chrome.action.setBadgeBackgroundColor({ tabId, color });

        if (badgeTimers[tabId]) clearTimeout(badgeTimers[tabId]);

        // Do not auto-clear permanent warning states or loading indicators
        if (text !== "KEY" && text !== "ERR" && text !== "UPDT" && text !== "TOK" && text !== "...") {
            badgeTimers[tabId] = setTimeout(() => {
                chrome.action.setBadgeText({ tabId, text: "" });
            }, 5000);
        }
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const tabId = sender.tab ? sender.tab.id : null;

    if (request.action === "getTabMessage") {
        sendResponse(tabMessages[request.tabId] || null);
        return true;
    }

    if (request.action === "storeMetadata" && tabId) {
        tabMetadataStore[tabId] = {
            rawCourseName: request.rawCourseName
        };
        sendResponse({ status: "ok" });
        return true;
    }

    if (request.action === "getMetadata" && tabId) {
        const metadata = tabMetadataStore[tabId] || { rawCourseName: null };
        sendResponse(metadata);
        return true;
    }

    if (request.action === "updateBadge" && tabId) {
        updateTabBadge(tabId, request.text, request.color);
        return true;
    }

    if (request.action === "ingestVideoBundle" && tabId) {
        const { payload } = request;
        if (payload.simulate_update) {
            const mockData = {
                status: 'upgrade_required',
                color: '#FF0000',
                shortname: 'UPDT',
                message: 'You need to update. <a href="https://krift.4eng.org/contribute/?update" target="_blank" style="color: white; text-decoration: underline;">Download the update here.</a>'
            };

            updateTabBadge(tabId, mockData.shortname, mockData.color);
            tabMessages[tabId] = { message: mockData.message, color: mockData.color };
            sendResponse({ status: "success", data: mockData });
            return true;
        }
        if (payload.simulate_tok_error) {
            const mockData = {
                status: 'error',
                color: '#EF4444',
                shortname: 'TOK',
                message: 'Unable to extract Kaltura session token from the page.'
            };

            updateTabBadge(tabId, mockData.shortname, mockData.color);
            tabMessages[tabId] = { message: mockData.message, color: mockData.color };
            sendResponse({ status: "success", data: mockData });
            return true;
        }
        fetch(`${SERVER_URL}/api/ingest-video-bundle/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(async res => {
                const text = await res.text();
                let data;
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    throw new Error("Server returned an invalid, non-JSON response");
                }
                if (data.shortname === 'AUTH') {
                    await chrome.storage.sync.remove(['apiKey']);
                    await chrome.storage.local.clear();
                    updateTabBadge(tabId, "KEY", "#EF4444");
                    tabMessages[tabId] = { message: "API key invalid or revoked.", color: "#EF4444" };
                    throw new Error("Krift API key invalid or revoked.");
                }

                return data;
            })
            .then(async data => {
                if (data.status === 'upgrade_required') {
                    await chrome.storage.local.set({ updateRequired: true });
                }

                if (data.shortname && data.color) {
                    updateTabBadge(tabId, data.shortname, data.color);
                }

                if (data.message) {
                    tabMessages[tabId] = { message: data.message, color: data.color };
                }

                sendResponse({ status: "success", data: data });
            })
            .catch(err => {
                if (!err.message.includes("Krift API key")) {
                    console.error('[Krift] Server Ingest Error:', err);
                    updateTabBadge(tabId, "ERR", "#EF4444");
                    tabMessages[tabId] = { message: "A network or parsing error occurred.", color: "#EF4444" };
                }
                sendResponse({ status: "error", error: err.message });
            });

        return true;
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    delete tabMetadataStore[tabId];
    delete tabMessages[tabId];
    if (badgeTimers[tabId]) clearTimeout(badgeTimers[tabId]);
});