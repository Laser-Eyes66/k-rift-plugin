const SERVER_URL = chrome.runtime.getManifest().server_url;
const tabMetadataStore = {};
const tabMessages = {};
const badgeTimers = {}; // Tracks timeouts for auto-clearing badges

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
        if (text !== "KEY" && text !== "ERR" && text !== "UPDT" && text !== "...") {
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

        fetch(`${SERVER_URL}/api/ingest-video-bundle/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(async res => {
                if (res.status === 401) {
                    await chrome.storage.sync.remove(['apiKey']);
                    await chrome.storage.local.clear();
                    updateTabBadge(tabId, "KEY", "#EF4444");
                    tabMessages[tabId] = { message: "API key invalid or revoked.", color: "#EF4444" };
                    throw new Error("API key invalid or revoked.");
                }
                return res.json();
            })
            .then(data => {
                if (data.shortname && data.color) {
                    updateTabBadge(tabId, data.shortname, data.color);
                }

                if (data.message) {
                    tabMessages[tabId] = { message: data.message, color: data.color };
                }

                sendResponse({ status: "success", data: data });
            })
            .catch(err => {
                if (!err.message.includes("API key")) {
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