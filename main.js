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
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.client = null;
        this.pollingInterval = null;
        this.retryTimer = null;
        this.currentRetryInterval = CONNECTION_RETRY_INTERVAL;
    }

    // Set/reset connection
    async setConnected(connected) {
        await this.setState('info.connection', connected, true);
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

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - State ID
     * @param {ioBroker.State | null | undefined} state - State object
     */
    async onStateChange(id, state) {
        if (state) {
            if (state.ack === false) {
                // This is a command from the user (e.g., from the UI or other adapter)
                // and should be processed by the adapter
                this.log.debug(`User command received for ${id}: ${state.val}`);

                if (!this.client) {
                    this.log.warn('No API client!');
                } else {
                    const idParts = id.split('.');
                    const command = idParts.pop();
                    idParts.pop(); // Remove 'command' part
                    const serialNumber = idParts.pop();

                    switch (command) {
                        case 'start':
                            await this.client.asyncSendServiceCommand(serialNumber, 'app_state', 1);
                            await this.client.asyncSendServiceCommand(serialNumber, 'mow_start', 1);
                            break;
                        case 'stop':
                            await this.client.asyncSendServiceCommand(serialNumber, 'stop_all_tasks', 1);
                            break;
                        case 'home':
                            await this.client.asyncSendServiceCommand(serialNumber, 'charge_start', 1);
                            break;
                        default:
                            this.log.warn(`Unknown command: ${command}`);
                    }
                }
            }
        } else {
            // The object was deleted or the state value has expired
            this.log.info(`state ${id} deleted`);
        }
    }

    // Retry connection with backoff
    async retryConnection() {
        if (this.retryTimer) {
            this.clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.clearPolling();
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
        this.device = devices[0];
        this.log.info(`Connecting to ${this.device.alias} (${this.device.sn})`);
        await this.createDeviceObjects(this.device);
        this.subscribeToDevice(this.device);
        await this.pollDevice(this.device);
        this.pollingInterval = this.setInterval(async () => {
            this.pollDevice(this.device);
        }, POLLING_INTERVAL);
    }

    clearPolling() {
        if (this.pollingInterval) {
            this.clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    // Poll device
    async pollDevice(device) {
        if (!this.client) {
            this.log.warn('No API client available for poll!');
            this.retryConnection();
        } else {
            try {
                const shadowState = await this.client.asyncGetShadowReportedState(device.sn);
                this.log.debug(`Device shadow reported state:\n${JSON.stringify(shadowState)}`);
                await this.setShadowState(device, shadowState);
            } catch (err) {
                this.log.error(`Failed to fetch shadow state for device ${device.sn}: ${err.message}`);
                // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
                this.retryConnection();
            }

            try {
                const codeList = await this.client.asyncGetCodeList(device.sn);
                this.log.debug(`Device code list:\n${JSON.stringify(codeList)}`);
                await this.setCodeList(device, codeList);
            } catch (err) {
                this.log.error(`Failed to fetch code list for device ${device.sn}: ${err.message}`);
                // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
                this.retryConnection();
            }
        }
    }

    // Create objects for device
    async createDeviceObjects(device) {
        await this.setObjectNotExistsAsync(device.sn, {
            type: 'device',
            common: {
                name: device.alias,
            },
            native: {},
        });

        // Shadow properties...
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

        await this.setObjectNotExistsAsync(`${device.sn}.rtk_moved`, {
            type: 'state',
            common: {
                name: 'rtk_moved',
                type: 'boolean',
                role: 'sensor.motion',
                desc: 'RTK movement detected',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${device.sn}.rtk_state`, {
            type: 'state',
            common: {
                name: 'rtk_state',
                type: 'boolean',
                role: 'sensor',
                desc: 'RTK state',
                read: true,
                write: false,
            },
            native: {},
        });

        // Code list (aka. messages)
        await this.setObjectNotExistsAsync(`${device.sn}.last_code`, {
            type: 'state',
            common: {
                name: 'last_code',
                type: 'number',
                desc: 'Last code',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${device.sn}.last_code_text`, {
            type: 'state',
            common: {
                name: 'last_code_text',
                type: 'string',
                role: 'text',
                desc: 'Last code text',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${device.sn}.last_code_type`, {
            type: 'state',
            common: {
                name: 'last_code_type',
                type: 'string',
                role: 'text',
                desc: 'Last code type (e.g. event, error, etc.)',
                read: true,
                write: false,
            },
            native: {},
        });

        // Command buttons
        await this.setObjectNotExistsAsync(`${device.sn}.command.start`, {
            type: 'state',
            common: {
                name: 'start',
                type: 'boolean',
                role: 'button.start',
                desc: 'Start',
                read: false,
                write: true,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${device.sn}.command.stop`, {
            type: 'state',
            common: {
                name: 'stop',
                type: 'boolean',
                role: 'button.stop',
                desc: 'Stop',
                read: false,
                write: true,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${device.sn}.command.home`, {
            type: 'state',
            common: {
                name: 'home',
                type: 'boolean',
                role: 'button',
                desc: 'Return home/start charging',
                read: false,
                write: true,
            },
            native: {},
        });
    }

    // Helper function to set shadow state values
    async setShadowState(device, shadowState) {
        if (shadowState.online.value) {
            this.setConnected(true);
        } else {
            this.setConnected(false);
        }

        this.setStateChanged(`${device.sn}.elec`, { val: shadowState.elec.value, ack: true });
        this.setStateChanged(`${device.sn}.mode`, { val: shadowState.mode.value, ack: true });
        this.setStateChanged(`${device.sn}.mowing_area`, { val: shadowState.mowing_area.value, ack: true });
        this.setStateChanged(`${device.sn}.mowing_time`, { val: shadowState.mowing_time.value, ack: true });
        this.setStateChanged(`${device.sn}.rtk_moved`, { val: shadowState.rtk.moved == 1, ack: true });
        this.setStateChanged(`${device.sn}.rtk_state`, { val: shadowState.rtk.state == 1, ack: true });
    }

    async setCodeList(device, codeList) {
        const lastCode = codeList[0];
        this.setStateChanged(`${device.sn}.last_code`, { val: lastCode.code, ack: true });
        this.setStateChanged(`${device.sn}.last_code_text`, { val: lastCode.event_message, ack: true });
        this.setStateChanged(`${device.sn}.last_code_type`, { val: lastCode.code_type, ack: true });
    }

    subscribeToDevice(device) {
        this.log.debug(`Subscribing to command states for ${device.sn}`);
        this.subscribeStates(`${device.sn}.command.*`);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            this.unsubscribeStates('*');
            this.clearPolling();
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
