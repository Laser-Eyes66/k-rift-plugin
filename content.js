const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 10; // sometimes the page loads slow or the iframe loads way after. Maybe this is too generous?
const isIframe = (window !== window.top);

let pollTimer = null;
let pollAttempts = 0;
let bundleSent = false;
let currentLoadedCourseKey = null;
const processedEntries = new Set();

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

const sendIngestRequest = (payload) => new Promise(resolve => {
    safeSendMessage({ action: "ingestVideoBundle", payload }, resolve);
});

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
                if (contextData && contextData.orgUnitPath) {
                    // strip trailing slashes and pop the last chunk in the rare case the course path has periods
                    rawCourseName = contextData.orgUnitPath.replace(/\/+$/, '').split('/').pop();
                }
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
        if (!config || !config.apiKey) {
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

            if (currentLoadedCourseKey !== courseKey) {
                const localData = await safeGetStorage([courseKey], 'local');
                if (localData && localData[courseKey]) {
                    localData[courseKey].forEach(id => processedEntries.add(id));
                }
                currentLoadedCourseKey = courseKey;
            }

            const urlPattern = /\/p\/(\d+)\/sp\/.*\/entry_id\/([^\/\?\&"']+)/i;
            const discoveredBundles = [];

            // --- METHOD 1: V7 Kaltura ---
            const previewContainers = document.querySelectorAll('[data-testid="cuePointPreviewImageContainer"], [class*="timeline-preview__image-container"]');

            previewContainers.forEach(container => {
                const childDivs = container.querySelectorAll('div[style*="background-image"]');
                let pId = null;
                const entries = new Set();
                // all the ids are just bunched together, I have never seen it but I suspect the newer Kaltura
                // supports more than 2 streams in one lecture
                childDivs.forEach(div => {
                    const match = (div.getAttribute('style') || '').match(urlPattern);
                    if (match) {
                        pId = match[1];
                        entries.add(match[2]);
                    }
                });

                if (entries.size > 0 && pId) {
                    discoveredBundles.push({
                        partner_id: pId,
                        entry_ids: entries
                    });
                }
            });

            // --- METHOD 2: LEGACY Kaltura --- idk why it's so messy or why any professor still uses it
            const videoHolders = document.querySelectorAll('div.videoHolder');

            videoHolders.forEach(holder => {
                const entries = new Set();
                let pId = null;

                const videos = holder.querySelectorAll('video');
                videos.forEach(video => {
                    // Extract primary ID from explicit attributes
                    const kEntryId = video.getAttribute('kentryid');
                    const kPartnerId = video.getAttribute('kpartnerid');

                    if (kEntryId) {
                        entries.add(kEntryId);
                        if (kPartnerId) pId = pId || kPartnerId;
                    }

                    // Extract secondary ID from poster URL
                    const poster = video.getAttribute('poster') || '';
                    const match = poster.match(urlPattern);
                    if (match) {
                        pId = pId || match[1];
                        entries.add(match[2]);
                    }
                });

                if (entries.size > 0 && pId) {
                    discoveredBundles.push({
                        partner_id: pId,
                        entry_ids: entries
                    });
                }
            });

            if (discoveredBundles.length === 0) {
                if (pollAttempts >= MAX_POLL_ATTEMPTS && pollTimer) clearInterval(pollTimer);
                return;
            }

            // --- EXTRACT KALTURA SESSION TOKEN (KS) ---
            // Sorry guys, I didn't want to collect any personal tokens, but they blocked anonymous get requests on 9/30/3026
            // This is sent to the server so it can make some api calls then its deleted. It only exists in ram and is never logged
            // It's also a temp token so it expires anyway. To be clear, this is not a brightspace token. Its a Kaltura API token
            let ksToken = null;
            const scripts = document.querySelectorAll('#mediaContainer #wrapper.video #player script#playerScript');
            for (const script of scripts) {
                if (script.id === 'playerScript' || script.textContent.includes('"ks"')) {
                    const match = script.textContent.match(/"ks"\s*:\s*"([^"]+)"/);
                    if (match && match[1]) {
                        ksToken = match[1];
                        break;
                    }
                }
            }

            if (!ksToken) {
                if (pollTimer) clearInterval(pollTimer);
                bundleSent = true;

                // Triggers a mock response from background.js to set the TOK badge and popup message
                safeSendMessage({
                    action: "ingestVideoBundle",
                    payload: {
                        version: chrome.runtime.getManifest().version,
                        simulate_tok_error: true
                    }
                });
                return;
            }
            // --- FILTER & PREPARE PAYLOADS ---
            const payloadsToSend = [];
            for (const bundle of discoveredBundles) {
                const uncachedEntries = Array.from(bundle.entry_ids).filter(id => !processedEntries.has(id));

                if (uncachedEntries.length > 0) {
                    payloadsToSend.push({
                        version: chrome.runtime.getManifest().version,
                        api_key: config.apiKey,
                        entry_ids: Array.from(bundle.entry_ids),
                        raw_course_name: parentMetadata.rawCourseName,
                        partner_id: bundle.partner_id,
                        ks_token: ksToken // never saved on server
                    });
                }
            }

            // If everything was already cached locally, just show DUP and exit.
            if (payloadsToSend.length === 0) {
                if (pollTimer) clearInterval(pollTimer);
                bundleSent = true;
                safeSendMessage({ action: "updateBadge", text: "DUP", color: "#ffc107" });
                return;
            }

            // check for cached update to prevent spam
            const localStatus = await safeGetStorage(['updateRequired'], 'local');
            if (localStatus && localStatus.updateRequired) {
                if (pollTimer) clearInterval(pollTimer);
                bundleSent = true;
                safeSendMessage({ action: "updateBadge", text: "UPDT", color: "#FF0000" });

                safeSendMessage({
                    action: "ingestVideoBundle",
                    payload: {
                        version: chrome.runtime.getManifest().version,
                        simulate_update: true
                    }
                });
                return;
            }

            if (pollTimer) clearInterval(pollTimer);
            bundleSent = true;

            // --- SEND SEQUENTIALLY ---
            for (let i = 0; i < payloadsToSend.length; i++) {
                safeSendMessage({ action: "updateBadge", text: "...", color: "#F59E0B" });

                const response = await sendIngestRequest(payloadsToSend[i]);

                if (response && response.data && response.data.cached_videos && isContextValid()) {
                    response.data.cached_videos.forEach(id => processedEntries.add(id));
                    try {
                        chrome.storage.local.set({ [courseKey]: Array.from(processedEntries) });
                    } catch (e) {}
                }
            }
        });
    }

    pollTimer = setInterval(scanIframeForVideos, POLL_INTERVAL_MS);
}