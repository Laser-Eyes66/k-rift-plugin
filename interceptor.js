// A patch for Kaltura V3 but might work on newer versions too.
(function() {
    const isTargetUrl = (url) => {
        if (!url) return false;
        return /cdnapisec\.kaltura\.com\/api_v\d/i.test(url) &&
            url.includes('service=multirequest');
    };

    const extractKsFromBody = (bodyStr) => {
        if (typeof bodyStr !== 'string') return null;
        const match = bodyStr.match(/(?:^|[&?])(?:\d+:)?ks=([^&]+)/);
        if (match && match[1]) {
            return decodeURIComponent(match[1]);
        }
        return null;
    };

    const originalOpen = window.XMLHttpRequest.prototype.open;
    const originalSend = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.open = function(method, url) {
        this._requestUrl = url;
        return originalOpen.apply(this, arguments);
    };

    window.XMLHttpRequest.prototype.send = function(body) {
        if (this._requestUrl && isTargetUrl(this._requestUrl) && body) {
            try {
                const ks = extractKsFromBody(body);
                if (ks) {
                    window.postMessage({ type: 'KRIFT_KS_TOKEN', ks: ks }, '*');
                }
            } catch (e) {}
        }
        return originalSend.apply(this, arguments);
    };

    const originalFetch = window.fetch;
    window.fetch = async function(resource, options) {
        const url = typeof resource === 'string'
            ? resource
            : (resource && resource.url ? resource.url : '');

        if (isTargetUrl(url) && options && options.body) {
            try {
                const ks = extractKsFromBody(options.body);
                if (ks) {
                    window.postMessage({ type: 'KRIFT_KS_TOKEN', ks: ks }, '*');
                }
            } catch (e) {}
        }
        return originalFetch.apply(this, arguments);
    };
})();