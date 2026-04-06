'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
const { AnthbotCloudApiClient } = require('./lib/anthbotApi');
const POLLING_INTERVAL = 60 * 1000; // Poll every 60 seconds
const CONNECTION_RETRY_INTERVAL = 30 * 1000; // Starting retry interval
const CONNECTION_RETRY_BACKOFF = 2; // Exponential backoff factor for connection retries
const CONNECTION_RETRY_MAX_INTERVAL = 30 * 60 * 1000; // Maximum retry interval

class Anthbot extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: 'anthbot',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.client = null;
        this.pollingInterval = null;
        this.retryTimer = null;
        this.currentRetryInterval = CONNECTION_RETRY_INTERVAL;
    }

    // Set/reset connection
    async setConnected(connected) {
        await this.setState('info.connection', connected, true);
        if (!connected && this.pollingInterval) {
            // We aren't connected any more, so stop polling (if we were)
            this.clearInterval(this.pollingInterval);
            this.pollingInterval = null;
            this.log.info('Disconnected');
        } else {
            this.log.info('Connected');
        }
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        await this.setConnected(false);

        // Verify we have credentials
        if (this.config.username == '' || this.config.password == '' || !this.config.regionCode) {
            this.log.error('Incomplete adapter configuration! Please check settings.');
            this.terminate();
        } else {
            this.loginAndStart();
        }
    }

    // Retry connection with backoff
    async retryConnection() {
        if (this.retryTimer) {
            this.clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        await this.setConnected(false);
        this.client = null;

        this.log.info(`Setting retry timer for ${this.currentRetryInterval / 1000}s`);
        this.retryTimer = this.setTimeout(() => {
            this.log.debug('Retry timer complete');
            this.retryTimer = null;
            this.loginAndStart();
        }, this.currentRetryInterval);

        // Backoff for next retry...
        this.currentRetryInterval *= CONNECTION_RETRY_BACKOFF;

        // ... but never exceed max retry interval
        if (this.currentRetryInterval > CONNECTION_RETRY_MAX_INTERVAL) {
            this.currentRetryInterval = CONNECTION_RETRY_MAX_INTERVAL;
        }
    }

    // Login & start processing
    async loginAndStart() {
        // Login
        this.client = new AnthbotCloudApiClient({ verboseLogger: this.log.debug });

        this.log.info('Connecting to Anthbot cloud...');
        try {
            await this.client.asyncLogin({
                username: this.config.username,
                password: this.config.password,
                areaCode: this.config.regionCode,
            });
        } catch (error) {
            this.log.error(`Failed to login to Anthbot cloud: ${error.message}`);
            await this.retryConnection();
            return;
        }

        this.log.debug('Login successful');

        this.log.debug('Searching for bound devices...');
        let devices = null;
        try {
            devices = await this.client.asyncGetBoundDevices();
        } catch (error) {
            this.log.error(`Failed to fetch bound devices: ${error.message}`);
            await this.retryConnection();
            return;
        }
        this.log.debug(`Found devices: ${JSON.stringify(devices)}`);

        if (devices.length === 0) {
            this.log.error('No bound devices found! Please check your Anthbot cloud account.');
            await this.retryConnection();
            return;
        }

        // Things look pretty good here, so reset the retry interval.
        this.currentRetryInterval = CONNECTION_RETRY_INTERVAL;

        // TODO: handle multiple devices (currently we just take the first one)
        const device = devices[0];
        this.log.info(`Connecting to ${device.alias} (${device.sn})`);
        await this.createShadowObjects(device);
        await this.pollDevice(device);
        this.pollingInterval = this.setInterval(async () => {
            this.pollDevice(device);
        }, POLLING_INTERVAL);
    }

    // Poll device
    async pollDevice(device) {
        try {
            const shadowState = await this.client.asyncGetShadowReportedState(device.sn);
            this.log.debug(`Device shadow reported state:\n${JSON.stringify(shadowState)}`);
            await this.setShadowState(device, shadowState);
        } catch (err) {
            this.log.error(`Failed to fetch shadow state for device ${device.sn}: ${err.message}`);
            // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
            this.retryConnection();
        }
    }

    // Create objects for device
    async createShadowObjects(device) {
        await this.setObjectNotExistsAsync(device.sn, {
            type: 'device',
            common: {
                name: device.alias,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${device.sn}.elec`, {
            type: 'state',
            common: {
                name: 'elec',
                type: 'number',
                unit: '%',
                desc: 'Battery level',
                role: 'level.battery',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${device.sn}.mode`, {
            type: 'state',
            common: {
                name: 'mode',
                type: 'string',
                role: 'text',
                desc: 'Current mode',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${device.sn}.mowing_area`, {
            type: 'state',
            common: {
                name: 'mowing_area',
                type: 'number',
                unit: 'm²',
                desc: 'Current mowing area',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${device.sn}.mowing_time`, {
            type: 'state',
            common: {
                name: 'mowing_time',
                type: 'number',
                unit: 's',
                role: 'time.span',
                desc: 'Current mowing time',
                read: true,
                write: false,
            },
            native: {},
        });
    }

    // Helper function to set shadow state values
    async setShadowState(device, shadowState) {
        if (shadowState.online.value) {
            this.setConnected(true);
        }

        this.setState(`${device.sn}.elec`, { val: shadowState.elec.value, ack: true });
        this.setState(`${device.sn}.mode`, { val: shadowState.mode.value, ack: true });
        this.setState(`${device.sn}.mowing_area`, { val: shadowState.mowing_area.value, ack: true });
        this.setState(`${device.sn}.mowing_time`, { val: shadowState.mowing_time.value, ack: true });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            // Setting connection false will clear the polling interval.
            this.setConnected(false).then(() => {
                callback();
            });
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new Anthbot(options);
} else {
    // otherwise start the instance directly
    new Anthbot();
}
