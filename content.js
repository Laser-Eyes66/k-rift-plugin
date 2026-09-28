const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 10;
const isIframe = (window !== window.top);

let pollTimer = null;
let pollAttempts = 0;
let bundleSent = false;
let currentLoadedCourseKey = null;
const processedEntries = new Set(); // Stores local cache

function isContextValid() {
    if (!chrome.runtime?.id) {
        if (pollTimer) clearInterval(pollTimer);
        return false;
    }
    return true;
}

function safeSendMessage(message, callback) {
    if (!isContextValid()) return;
    try {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                if (pollTimer) clearInterval(pollTimer);
                return;
            }
            if (callback) callback(response);
        });
    } catch (e) {
        if (pollTimer) clearInterval(pollTimer);
    }
}

async function safeGetStorage(keys, storageType = 'sync') {
    if (!isContextValid()) return null;
    try {
        const storageApi = storageType === 'local' ? chrome.storage.local : chrome.storage.sync;
        return await storageApi.get(keys);
    } catch (e) {
        if (pollTimer) clearInterval(pollTimer);
        return null;
    }
}

if (!isIframe) {
    function scanAndSendParentMetadata() {
        if (!isContextValid()) return;

        let rawCourseName = null;
        const contextElem = document.querySelector('[data-he-context]');
        if (contextElem) {
            try {
                const contextData = JSON.parse(contextElem.getAttribute('data-he-context'));
                if (contextData && contextData.orgUnitPath) rawCourseName = contextData.orgUnitPath;
            } catch (e) {}
        }

        if (rawCourseName) {
            safeSendMessage({ action: "storeMetadata", rawCourseName: rawCourseName });
        }
    }

    scanAndSendParentMetadata();
    const parentPoll = setInterval(() => {
        if (!isContextValid()) {
            clearInterval(parentPoll);
            return;
        }
        scanAndSendParentMetadata();
    }, POLL_INTERVAL_MS);

    setTimeout(() => clearInterval(parentPoll), 10000);
}

if (isIframe) {
    async function scanIframeForVideos() {
        if (!isContextValid() || bundleSent) return;

        pollAttempts++;

        const config = await safeGetStorage(['apiKey', 'partnerId'], 'sync');
        if (!config) return;

        if (!config.apiKey) {
            safeSendMessage({ action: "updateBadge", text: "KEY", color: "#EF4444" });
            if (pollTimer) clearInterval(pollTimer);
            return;
        }

        if (!window.location.hostname.toLowerCase().includes('kaltura.com')) return;

        safeSendMessage({ action: "getMetadata" }, async (parentMetadata) => {
            if (!parentMetadata || !parentMetadata.rawCourseName) {
                if (pollAttempts >= MAX_POLL_ATTEMPTS && pollTimer) clearInterval(pollTimer);
                return;
            }

            const courseKey = `cache_${parentMetadata.rawCourseName}`;

            // Load the course cache only once
            if (currentLoadedCourseKey !== courseKey) {
                const localData = await safeGetStorage([courseKey], 'local');
                if (localData && localData[courseKey]) {
                    localData[courseKey].forEach(id => processedEntries.add(id));
                }
                currentLoadedCourseKey = courseKey;
            }

            let detectedPartnerId = null;
            const detectedEntries = [];
            const urlPattern = /\/p\/(\d+)\/sp\/.*\/entry_id\/([^\/\?\&"']+)/i;

            const previewContainers = document.querySelectorAll('[data-testid="cuePointPreviewImageContainer"], [class*="timeline-preview__image-container"]');
            previewContainers.forEach(container => {
                const childDivs = container.querySelectorAll('div[style*="background-image"]');
                childDivs.forEach(div => {
                    const match = (div.getAttribute('style') || '').match(urlPattern);
                    if (match) {
                        detectedPartnerId = match[1];
                        if (!detectedEntries.includes(match[2])) detectedEntries.push(match[2]);
                    }
                });
            });

            if (detectedEntries.length === 0) {
                const styleDivs = document.querySelectorAll('div[style*="entry_id"]');
                styleDivs.forEach(div => {
                    const match = (div.getAttribute('style') || div.outerHTML).match(urlPattern);
                    if (match) {
                        detectedPartnerId = match[1];
                        if (!detectedEntries.includes(match[2])) detectedEntries.push(match[2]);
                    }
                });
            }

            if (detectedEntries.length === 0) {
                if (pollAttempts >= MAX_POLL_ATTEMPTS && pollTimer) clearInterval(pollTimer);
                return;
            }

            // Filter entries to bypass server if they are completely cached offline
            const uncachedEntries = detectedEntries.filter(id => !processedEntries.has(id));

            if (uncachedEntries.length === 0) {
                if (pollTimer) clearInterval(pollTimer);
                bundleSent = true;
                safeSendMessage({ action: "updateBadge", text: "DUP", color: "#808080" });
                return;
            }

            // At least one new entry exists, initiate server request
            if (pollTimer) clearInterval(pollTimer);
            bundleSent = true;

            if (!detectedPartnerId || detectedPartnerId === '*' || detectedPartnerId.trim() === '') return;

            // Loading badge active
            safeSendMessage({ action: "updateBadge", text: "...", color: "#F59E0B" });

            const payload = {
                version: chrome.runtime.getManifest().version,
                api_key: config.apiKey,
                entry_ids: detectedEntries, // The server handles duplicate checking for the bundle
                raw_course_name: parentMetadata.rawCourseName,
                partner_id: detectedPartnerId
            };

            safeSendMessage({
                action: "ingestVideoBundle",
                payload: payload
            }, (response) => {
                // If network request succeeded, merge new data into cache immediately
                if (response && response.data && response.data.cached_videos && isContextValid()) {
                    response.data.cached_videos.forEach(id => processedEntries.add(id));
                    try {
                        chrome.storage.local.set({ [courseKey]: response.data.cached_videos });
                    } catch (e) {}
                }
            });
        });
    }

    pollTimer = setInterval(scanIframeForVideos, POLL_INTERVAL_MS);
}