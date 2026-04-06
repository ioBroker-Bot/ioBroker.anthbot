/**
 * API client for Anthbot Genie cloud polling
 * NodeJS port of the Python api.py module by @vincentjanv...
 * https://github.com/vincentjanv/anthbot_genie_ha
 * ... with a few addions/changes of course ;)
 */

const crypto = require('crypto');
const { URLSearchParams } = require('url');

// Constants
const DEFAULT_API_HOST = 'api.anthbot.com';
const DEFAULT_IOT_REGION = 'us-east-1';
const DEFAULT_IOT_ENDPOINT = 'a2bhy9nr7jkgaj-ats.iot.us-east-1.amazonaws.com';
const CN_NORTHWEST_IOT_ENDPOINT = 'a2iw0czxjowiip-ats.iot.cn-northwest-1.amazonaws.com.cn';

const AWS_ACCESS_KEY_DEFAULT = 'AKIAV2C4RVIAOLEXB545';
const AWS_SECRET_KEY_DEFAULT = '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';

const AWS_ACCESS_KEY_CN = 'AKIAWJ3KIT7IV6AHMJ5V';
const AWS_SECRET_KEY_CN = '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';

const AWS_ACCESS_KEY_CN_NORTHWEST = 'AKIAYVWVSSRF7W5YWI74';
const AWS_SECRET_KEY_CN_NORTHWEST = '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';

const REQUEST_TIMEOUT = 15000; // 15 seconds

// Shared methods
class AnthotCloudApi {
    /**
     * @param {{ verboseLogger?: ((message: string) => void) | null}} options
     */
    constructor({ verboseLogger = null }) {
        this.verboseLogger = verboseLogger;
    }

    async fetch(url, options = {}) {
        const controller = new AbortController();
        const timeout = REQUEST_TIMEOUT;
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        if (this.verboseLogger) {
            this.verboseLogger(`[VERBOSE] >>> ${options.method || 'GET'} ${url}`);
            if (options.headers) {
                this.verboseLogger(`[VERBOSE] Headers: ${JSON.stringify(options.headers, null, 2)}`);
            }
            if (options.body) {
                this.verboseLogger(`[VERBOSE] Body: ${options.body}`);
            }
        }

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });

            if (this.verboseLogger) {
                this.verboseLogger(`[VERBOSE] <<< ${response.status} ${response.statusText}`);
                this.verboseLogger(
                    `[VERBOSE] Response Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2)}`,
                );

                // Clone response to read body without consuming original
                const responseClone = response.clone();
                try {
                    const responseBody = await responseClone.text();
                    if (responseBody && this.verboseLogger) {
                        try {
                            const jsonBody = JSON.parse(responseBody);
                            this.verboseLogger(`[VERBOSE] Response Body: ${JSON.stringify(jsonBody, null, 2)}`);
                        } catch {
                            this.verboseLogger(`[VERBOSE] Response Body: ${responseBody}`);
                        }
                    }
                } catch (err) {
                    this.verboseLogger(`[VERBOSE] Could not read response body: ${err.message}`);
                }
            }

            return response;
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Client for Anthbot cloud account endpoints
 */
class AnthbotCloudApiClient {
    /** @param {{ verboseLogger?: ((message: string) => void) | null }} options */
    constructor({ verboseLogger = null }) {
        this.endpointHost = DEFAULT_API_HOST;
        this.authHeaders = {
            Accept: 'application/json, text/plain, */*',
            version: 'v2',
            language: 'en',
            'User-Agent': 'LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0',
        };
        this.bearerToken = null;
        this.verboseLogger = verboseLogger;
        this.fetch = new AnthotCloudApi({ verboseLogger }).fetch;
        this.shadowClient = null;
    }

    /**
     * Login and return bearer token
     */
    async asyncLogin({ username, password, areaCode }) {
        const url = `https://${this.endpointHost}/api/v1/login`;
        const headers = {
            Accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            version: 'v2',
            language: 'en',
            'User-Agent': 'LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0',
        };
        const body = { username, password, areaCode };

        const response = await this.fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (response.status !== 200) {
            throw new Error(`Login failed (${response.status})`);
        }

        let data;
        try {
            data = /** @type {{ code: number; data: { access_token: string } }} */ (await response.json());
        } catch {
            throw new Error('Invalid JSON response from login');
        }

        if (typeof data !== 'object' || data === null) {
            throw new Error('Invalid login payload type');
        }
        if (data.code !== 0) {
            throw new Error(`Login rejected: code=${JSON.stringify(data.code)}`);
        }

        const tokenData = data.data;
        if (typeof tokenData !== 'object' || tokenData === null) {
            throw new Error('Login payload missing data object');
        }

        const accessToken = tokenData.access_token;
        if (typeof accessToken !== 'string' || !accessToken) {
            throw new Error('Login payload missing access_token');
        }

        const bearerToken = `Bearer ${accessToken}`;
        this.bearerToken = bearerToken;
        this.authHeaders['Authorization'] = bearerToken;
        return bearerToken;
    }

    checkToken() {
        if (!this.bearerToken) {
            throw new Error('Bearer token not configured');
        }
    }

    /**
     * Fetch account-bound Anthbot devices
     */
    async asyncGetBoundDevices() {
        this.checkToken();

        const url = `https://${this.endpointHost}/api/v1/device/bind/list`;
        const response = await this.fetch(url, {
            method: 'GET',
            headers: this.authHeaders,
        });

        if (response.status !== 200) {
            throw new Error(`Request to ${url} failed, response ${response.status}`);
        }

        return /** @type {{ data:  {alias: string, sn: string}[] }} */ (await response.json()).data;
    }

    /**
     * Fetch latest messages
     * Returns only last message by default
     */
    async asyncGetCodeList(serialNumber, pageNum = 1, pageSize = 1) {
        this.checkToken();

        // TODO: allow language other than English?
        const url = `https://${this.endpointHost}/api/v1/device/v2/code/list?sn=${serialNumber}&pagenum=${pageNum}&pagesize=${pageSize}&language=English`;

        const response = await this.fetch(url, {
            method: 'GET',
            headers: this.authHeaders,
        });

        if (response.status !== 200) {
            throw new Error(`Request to ${url} failed, response ${response.status}`);
        }

        return /** @type {{ data: { data: unknown } }} */ (await response.json())?.data?.data;
    }

    /**
     * Fetch device cloud region metadata
     */
    async asyncGetDeviceRegion(serialNumber) {
        if (this.verboseLogger) {
            this.verboseLogger(`Cache miss - fetching device region for ${serialNumber}`);
        }

        this.checkToken();

        const url = `https://${this.endpointHost}/api/v1/device/v2/region`;
        const params = new URLSearchParams({ sn: serialNumber });
        const response = await this.fetch(`${url}?${params}`, {
            method: 'GET',
            headers: this.authHeaders,
        });

        if (response.status !== 200) {
            const body = await response.text();
            throw new Error(`Device region failed (${response.status}): ${body.slice(0, 300)}`);
        }

        let payload;
        try {
            payload = /** @type {{ code: number; data: {region_name: string; iot_endpoint: string } }} */ (
                await response.json()
            );
        } catch {
            throw new Error('Invalid JSON response from device region');
        }

        if (typeof payload !== 'object' || payload === null) {
            throw new Error('Invalid device region payload type');
        }
        if (payload.code !== 0) {
            throw new Error(`Device region returned code=${payload.code}`);
        }

        const data = payload.data;
        if (typeof data !== 'object' || data === null) {
            throw new Error('Device region payload missing data object');
        }

        const regionName = data.region_name;
        const iotEndpoint = data.iot_endpoint;
        if (typeof regionName !== 'string' || !regionName) {
            throw new Error('Device region missing region_name');
        }
        if (typeof iotEndpoint !== 'string' || !iotEndpoint) {
            throw new Error('Device region missing iot_endpoint');
        }

        const deviceRegion = { regionName, iotEndpoint };
        if (this.verboseLogger) {
            this.verboseLogger(`deviceRegion for ${serialNumber}: ${JSON.stringify(deviceRegion)}`);
        }
        return deviceRegion;
    }

    async asyncGetShadowReportedState(serialNumber) {
        if (!this.shadowClient) {
            // Get device region information
            const deviceRegion = await this.asyncGetDeviceRegion(serialNumber);

            // Create shadow client and fetch property state
            this.shadowClient = new AnthbotShadowApiClient({
                serialNumber: serialNumber,
                regionName: deviceRegion.regionName,
                iotEndpoint: deviceRegion.iotEndpoint,
                verboseLogger: this.verboseLogger,
            });
        }
        return await this.shadowClient.asyncGetShadowReportedState();
    }
}

/**
 * Client for Anthbot AWS IoT shadow endpoint
 */
class AnthbotShadowApiClient {
    /**
     * @param {{serialNumber: string, regionName?: string | null, iotEndpoint?: string | null, verboseLogger?: ((message: string) => void) | null}} options
     */
    constructor({ serialNumber, regionName = null, iotEndpoint = null, verboseLogger = null }) {
        this._serialNumber = serialNumber;
        this._regionName = typeof regionName === 'string' && regionName ? regionName : null;
        this._iotEndpoint = AnthbotShadowApiClient._normalizeEndpoint(iotEndpoint);
        this.verboseLogger = verboseLogger;
        this.fetch = new AnthotCloudApi({ verboseLogger }).fetch;

        const endpointRegion = AnthbotShadowApiClient._guessRegionFromEndpoint(this._iotEndpoint);
        if (this._regionName && endpointRegion && this._regionName !== endpointRegion) {
            if (this.verboseLogger) {
                this.verboseLogger(
                    `Anthbot region mismatch for ${serialNumber}: api region=${this._regionName} endpoint region=${endpointRegion} endpoint=${this._iotEndpoint}; endpoint region will be used for signing`,
                );
            }
        }
    }

    static _normalizeEndpoint(iotEndpoint) {
        if (typeof iotEndpoint !== 'string' || !iotEndpoint) {
            return DEFAULT_IOT_ENDPOINT;
        }
        let endpoint = iotEndpoint.trim();
        endpoint = endpoint.replace(/^https?:\/\//i, '');
        endpoint = endpoint.replace(/\/$/, '');
        return endpoint || DEFAULT_IOT_ENDPOINT;
    }

    static _guessRegionFromEndpoint(iotEndpoint) {
        if (!iotEndpoint.includes('.iot.')) {
            return null;
        }
        const rightSide = iotEndpoint.split('.iot.', 2)[1];
        const region = rightSide.split('.', 1)[0];
        return region || null;
    }

    static guessRegionFromEndpoint(iotEndpoint) {
        return AnthbotShadowApiClient._guessRegionFromEndpoint(iotEndpoint);
    }

    get serialNumber() {
        return this._serialNumber;
    }

    get iotEndpoint() {
        return this._iotEndpoint;
    }

    get signingRegion() {
        const endpointRegion = AnthbotShadowApiClient._guessRegionFromEndpoint(this._iotEndpoint);
        if (endpointRegion) {
            return endpointRegion;
        }
        return this._regionName || DEFAULT_IOT_REGION;
    }

    _accessKeyId() {
        if (this._iotEndpoint === CN_NORTHWEST_IOT_ENDPOINT) {
            return AWS_ACCESS_KEY_CN_NORTHWEST;
        }
        if (this.signingRegion.startsWith('cn')) {
            return AWS_ACCESS_KEY_CN;
        }
        return AWS_ACCESS_KEY_DEFAULT;
    }

    _secretAccessKey() {
        if (this._iotEndpoint === CN_NORTHWEST_IOT_ENDPOINT) {
            return AWS_SECRET_KEY_CN_NORTHWEST;
        }
        if (this.signingRegion.startsWith('cn')) {
            return AWS_SECRET_KEY_CN;
        }
        return AWS_SECRET_KEY_DEFAULT;
    }

    static _sign(key, msg) {
        if (typeof key === 'string') {
            key = Buffer.from(key, 'utf-8');
        }
        return crypto.createHmac('sha256', key).update(msg).digest();
    }

    _signingKey(dateStamp) {
        const service = 'iotdata';
        const kDate = AnthbotShadowApiClient._sign(`AWS4${this._secretAccessKey()}`, dateStamp);
        const kRegion = AnthbotShadowApiClient._sign(kDate, this.signingRegion);
        const kService = AnthbotShadowApiClient._sign(kRegion, service);
        return AnthbotShadowApiClient._sign(kService, 'aws4_request');
    }

    _buildAuthorization(amzDate, dateStamp, canonicalRequest) {
        const algorithm = 'AWS4-HMAC-SHA256';
        const signedHeaders = AnthbotShadowApiClient._signedHeadersFromRequest(canonicalRequest);
        const credentialScope = `${dateStamp}/${this.signingRegion}/iotdata/aws4_request`;
        const stringToSign =
            `${algorithm}\n` +
            `${amzDate}\n` +
            `${credentialScope}\n` +
            crypto.createHash('sha256').update(canonicalRequest).digest('hex');

        const signature = crypto.createHmac('sha256', this._signingKey(dateStamp)).update(stringToSign).digest('hex');

        return (
            `${algorithm} Credential=${this._accessKeyId()}/${credentialScope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`
        );
    }

    static _normalizeHeaderValue(value) {
        return value.trim().split(/\s+/).join(' ');
    }

    static _canonicalHeaders(headers) {
        const lowered = {};
        for (const [key, value] of Object.entries(headers)) {
            lowered[key.toLowerCase()] = AnthbotShadowApiClient._normalizeHeaderValue(value);
        }

        const orderedKeys = Object.keys(lowered).sort();
        let canonical = '';
        for (const key of orderedKeys) {
            canonical += `${key}:${lowered[key]}\n`;
        }

        const signedHeaders = orderedKeys.join(';');
        return [canonical, signedHeaders];
    }

    static _signedHeadersFromRequest(canonicalRequest) {
        const parts = canonicalRequest.split('\n');
        if (parts.length < 6) {
            return 'host;x-amz-content-sha256;x-amz-date';
        }
        return parts[parts.length - 2];
    }

    static _canonicalUriForSigv4(requestUri) {
        /**
         * Build SigV4 canonical URI.
         * AWS canonicalization requires encoding '%' as '%25', so an already
         * encoded request path (for example '/topics/%24aws%2F...') must be
         * double-encoded only for signing.
         */
        const encoded = [];
        const buffer = Buffer.from(requestUri, 'utf-8');

        for (const byte of buffer) {
            // 0-9: 0x30-0x39, A-Z: 0x41-0x5A, a-z: 0x61-0x7A, - . _ ~ /
            if (
                (byte >= 0x30 && byte <= 0x39) ||
                (byte >= 0x41 && byte <= 0x5a) ||
                (byte >= 0x61 && byte <= 0x7a) ||
                [45, 46, 95, 126, 47].includes(byte) // - . _ ~ /
            ) {
                encoded.push(String.fromCharCode(byte));
            } else {
                encoded.push(`%${byte.toString(16).toUpperCase().padStart(2, '0')}`);
            }
        }

        return encoded.join('');
    }

    async asyncGetShadowReportedState() {
        const requestUri = `/things/${this._encodePathComponent(this._serialNumber)}/shadow`;
        const canonicalUri = AnthbotShadowApiClient._canonicalUriForSigv4(requestUri);
        const canonicalQuery = `name=${this._encodePathComponent('property')}`;
        const payloadHash = crypto.createHash('sha256').update('').digest('hex');

        const now = new Date();
        const amzDate = now
            .toISOString()
            .replace(/[:-]/g, '')
            .replace(/\.\d{3}/, '');
        const dateStamp = amzDate.substring(0, 8);

        const signedHeaderValues = {
            host: this._iotEndpoint,
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
        };

        const [canonicalHeaders, signedHeaders] = AnthbotShadowApiClient._canonicalHeaders(signedHeaderValues);

        const canonicalRequest =
            `GET\n` +
            `${canonicalUri}\n` +
            `${canonicalQuery}\n` +
            `${canonicalHeaders}\n` +
            `${signedHeaders}\n` +
            `${payloadHash}`;

        const authorization = this._buildAuthorization(amzDate, dateStamp, canonicalRequest);

        const url = `https://${this._iotEndpoint}${requestUri}?${canonicalQuery}`;
        const headers = {
            Accept: '*/*',
            Host: this._iotEndpoint,
            'x-amz-date': amzDate,
            'x-amz-content-sha256': payloadHash,
            Authorization: authorization,
            'User-Agent': 'LdMower/1581 CFNetwork/3860.400.51 Darwin/25.3.0',
        };

        const response = await this.fetch(url, {
            method: 'GET',
            headers,
        });

        if (response.status !== 200) {
            const body = await response.text();
            throw new Error(`Shadow request failed (${response.status}): ${body.slice(0, 300)}`);
        }

        let payload;
        try {
            payload = /** @type {{ state: { reported: unknown } }} */ (await response.json());
        } catch {
            throw new Error('Invalid JSON response from shadow request');
        }

        if (typeof payload !== 'object' || payload === null) {
            throw new Error('Invalid response payload type');
        }

        const state = payload.state;
        const reported = typeof state === 'object' && state !== null ? state.reported : null;
        if (typeof reported !== 'object' || reported === null) {
            throw new Error('Missing state.reported in response');
        }

        return reported;
    }

    /**
     * Encode path component for AWS SigV4
     */
    _encodePathComponent(component) {
        return encodeURIComponent(component).replace(/[!'()*]/g, ch => {
            return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
        });
    }
}

// Exports
module.exports = {
    AnthbotCloudApiClient,
};
