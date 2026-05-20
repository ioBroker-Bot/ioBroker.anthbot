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

        this.devices = [];
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
            // Don't actually terminate - when the adapter config is updated that will trigger a restart
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
            if (this.checkClient() && state.ack === false) {
                // This is a command from the user (e.g., from the UI or other adapter)
                // and should be processed by the adapter
                this.log.debug(`Command received for ${id}: ${JSON.stringify(state)}`);

                // By default, set ackState null so we won't ack this
                let ackState = null;
                // By default sync afer valid command
                let doSync = true;

                const idParts = id.split('.');

                const command = idParts.pop();

                // Remove 'command' string literal
                idParts.pop();

                const serialNumber = idParts.pop();
                if (!serialNumber) {
                    this.log.error(`No serial number found in command ${id}`);
                } else {
                    const device = this.devices.find(checkDevice => checkDevice.sn === serialNumber);

                    if (!serialNumber || !device) {
                        this.log.error(`Could not find device for command with serial number: ${serialNumber}`);
                    } else {
                        switch (command) {
                            case 'area_set': {
                                let customAreas;
                                if (typeof state?.val !== 'string') {
                                    this.log.error('Command custom_areas for ${serialNumber} is not a string');
                                } else {
                                    try {
                                        customAreas = JSON.parse(state.val);
                                    } catch (error) {
                                        this.log.error(`Failed to parse for ${id}: ${error.message}`);
                                    }
                                }

                                // Overlay elements from the state onto existing custom areas so user only has to set
                                // the items they are changing and rest will be preserved.

                                // Variable named to match asyncSendServiceCommand data
                                const custom_areas = this.validateCustomAreas(device, customAreas);

                                if (!custom_areas) {
                                    this.log.error(`Bad area data in ${id}`);
                                } else {
                                    // Write the given custom area data
                                    this.log.info(`${device.alias}: area_set ${JSON.stringify(customAreas)}`);
                                    await this.client.asyncSendServiceCommand(serialNumber, 'area_set', {
                                        custom_areas,
                                    });

                                    ackState = JSON.stringify(customAreas);
                                }

                                break;
                            }

                            case 'custom_area_mow_start': {
                                // Get/check command area_list
                                // This could be done in one shot, but get the state first for debug logging
                                const command_area_list_state = await this.getStateAsync(
                                    `${device.sn}.command.area_list`,
                                );
                                this.log.debug(
                                    `Current command.area_list state: ${JSON.stringify(command_area_list_state)}`,
                                );

                                let command_area_list;
                                if (typeof command_area_list_state?.val !== 'string') {
                                    this.log.error('Command area list for ${serialNumber} is not a string');
                                } else {
                                    try {
                                        command_area_list = JSON.parse(command_area_list_state.val);
                                    } catch (error) {
                                        this.log.error(
                                            `Failed to parse command area list for ${serialNumber}: ${error.message}`,
                                        );
                                    }
                                }

                                if (Array.isArray(command_area_list) && command_area_list.length > 0) {
                                    if (!this.isGoodCustomAreaList(device, command_area_list)) {
                                        this.log.error(
                                            'Cannot start custom_area_mow_start due to invalid command.area_list',
                                        );
                                    } else {
                                        this.log.info(
                                            `${device.alias}: custom_area_mow_start ${JSON.stringify(command_area_list)}`,
                                        );
                                        await this.client.asyncSendServiceCommand(
                                            serialNumber,
                                            'custom_area_mow_start',
                                            {
                                                id: command_area_list,
                                            },
                                        );
                                        ackState = true;
                                    }
                                }
                                break;
                            }

                            case 'area_list': {
                                let areaList;
                                // This will affect the next start command only.
                                if (typeof state?.val === 'string' && state.val !== '') {
                                    // Some kind of non-blank value given
                                    try {
                                        areaList = JSON.parse(state.val);
                                    } catch (error) {
                                        this.log.error(`Failed to parse area list for ${id}: ${error.message}`);
                                    }

                                    // Make sure all IDs in list are valid
                                    if (!this.isGoodCustomAreaList(device, areaList)) {
                                        // Set to null so we don't ack it
                                        areaList = null;
                                    }
                                } else {
                                    // No value given, so ack an empty list
                                    areaList = [];
                                }

                                // Ack only if we now have a list
                                if (Array.isArray(areaList)) {
                                    ackState = JSON.stringify(areaList);
                                    // We don't need to sync after this as no command was actually sent yet
                                    doSync = false;
                                }

                                break;
                            }

                            case 'mow_start':
                                // To start mowing have to put app_state first.
                                await this.client.asyncSendServiceCommand(serialNumber, 'app_state', 1);
                            // Purposfully fall through to send the actual command!

                            // Generic one-shot commands
                            /* falls through */
                            case 'charge_start':
                            case 'mow_pause':
                            case 'stop_all_tasks': {
                                this.log.info(`${device.alias}: ${command}`);
                                await this.client.asyncSendServiceCommand(serialNumber, command, 1);
                                ackState = true;
                                break;
                            }

                            default:
                                this.log.warn(`Unknown command: ${command}`);
                        }
                    }

                    // Ack command if verified valid above
                    if (ackState) {
                        await this.setState(id, ackState, true);

                        // Sync device if no explicitally set not to
                        if (doSync) {
                            this.syncDevice(device);
                        }
                    }
                }
            }
        } else {
            // The object was deleted or the state value has expired
            this.log.warn(`state ${id} deleted`);
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
            await this.client.asyncLogin(this.config.username, this.config.password, this.config.regionCode);
        } catch (error) {
            this.log.error(`Failed to login to Anthbot cloud: ${error.message}`);
            await this.retryConnection();
            return;
        }

        this.log.debug('Login successful');

        this.log.debug('Searching for bound devices...');
        this.devices = [];
        try {
            this.devices = await this.client.asyncGetBoundDevices();
        } catch (error) {
            this.log.error(`Failed to fetch bound devices: ${error.message}`);
            await this.retryConnection();
            return;
        }
        this.log.debug(`Found devices: ${JSON.stringify(this.devices)}`);

        if (this.devices.length === 0) {
            this.log.error('No bound devices found! Please check your Anthbot cloud account.');
            await this.retryConnection();
            return;
        }

        // Things look pretty good here, so reset the retry interval.
        this.currentRetryInterval = CONNECTION_RETRY_INTERVAL;

        // TODO: handle multiple devices (currently we just connect to the first one)
        const device = this.devices[0];
        this.log.info(`Connecting to ${device.alias} (${device.sn})`);
        await this.createDeviceObjects(device);
        this.subscribeToDevice(device);

        this.syncDevice(device);
    }

    async syncDevice(device) {
        if (this.checkClient()) {
            // Reset polling interval on sync
            this.clearPolling();

            await this.client.asyncSendServiceCommand(device.sn, 'get_all_props', 1);
            // Wait a second for their backend
            await new Promise(resolve => this.setTimeout(resolve, 1000, null));

            await this.pollDevice(device);
            this.pollingInterval = this.setInterval(async () => {
                this.pollDevice(device);
            }, POLLING_INTERVAL);
        }
    }

    clearPolling() {
        if (this.pollingInterval) {
            this.clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    /**
     * @returns {this is { client: { Object } }} this.client is an object
     */
    checkClient() {
        if (!this.client || typeof this.client !== 'object') {
            this.log.warn('No API client available!');
            this.retryConnection();
            return false;
        }
        return true;
    }

    // Poll device
    async pollDevice(device) {
        if (this.checkClient()) {
            let area_id;

            // Shadow state
            try {
                const shadowState = await this.client.asyncGetShadowReportedState(device.sn);
                this.log.debug(`Device shadow reported state:\n${JSON.stringify(shadowState)}`);
                await this.setShadowState(device, shadowState);
                area_id = shadowState.map.area_id;
            } catch (err) {
                this.log.error(`Failed to fetch shadow state for device ${device.sn}: ${err.message}`);
                // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
                this.retryConnection();
            }

            // Code list
            try {
                const codeList = await this.client.asyncGetCodeList(device.sn, 1, 20 /* TODO: make configurable? */);
                this.log.debug(`Device code list:\n${JSON.stringify(codeList)}`);
                await this.setCodeList(device, codeList);
            } catch (err) {
                this.log.error(`Failed to fetch code list for device ${device.sn}: ${err.message}`);
                // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
                this.retryConnection();
            }

            // Fetch map if changed
            if (area_id != device.area_id) {
                this.log.info(`Device map area_id change detected, fetching new map info`);

                const deviceMapFiles = await this.client.asyncGetDeviceMap(device.sn);

                const areaSetting = deviceMapFiles['area_setting.json'];
                this.log.debug(`area_setting.json: ${JSON.stringify(areaSetting)}`);

                const custom_areas = areaSetting?.content?.custom_areas;
                this.log.debug(`custom_areas: ${JSON.stringify(custom_areas)}`);

                // Stash custom_areas in the passed device
                device.customAreas = custom_areas;

                // And save the state
                this.setStateChanged(`${device.sn}.map.custom_areas.raw`, {
                    val: JSON.stringify(custom_areas),
                    ack: true,
                });

                // Save ridable areas state
                this.setStateChanged(`${device.sn}.map.ridable_areas.raw`, {
                    val: JSON.stringify(areaSetting?.content?.ridable_areas),
                    ack: true,
                });

                // TODO: plan is to create a channel for each area and store info for them indivicually.

                const timeSetting = deviceMapFiles['time_setting.json'];
                this.log.debug(`time_setting.json: ${JSON.stringify(timeSetting)}`);

                // And remember which area_id we loaded last
                device.area_id = area_id;
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

        const channels = [
            ['command', 'Commands'],
            ['map', 'Map info'],
            ['map.custom_areas', 'Custom areas, aka. Zones'],
            ['map.ridable_areas', 'Ridable areas, aka. Edges'],
        ];

        for (const channel of channels) {
            await this.setObjectNotExistsAsync(`${device.sn}.${channel[0]}`, {
                type: 'channel',
                common: {
                    name: channel[0],
                    desc: channel[1],
                },
                native: {},
            });
        }

        const readOnlyStates = [
            // Shadow properties
            ['active_area', 'array', 'info.ids', 'List of areas currently being mowed'],
            ['elec', 'number', 'level.battery', 'Battery level', '%'],
            ['mode', 'string', 'text', 'Current mode'],
            ['mowing_area', 'number', 'value', 'Current mowing area', 'm²'],
            ['mowing_time', 'number', 'time.span', 'Current mowing time', 's'],
            ['rtk_moved', 'boolean', 'sensor.motion', 'RTK movement detected'],
            ['rtk_state', 'boolean', 'sensor', 'RTK state'],

            // Code list (aka. messages)
            // Full list for 'power users'
            ['code_list', 'string', 'json', 'JSON object with last page of codes'],
            // Last code for simplcity
            ['last_code', 'number', 'value', 'Last code'],
            ['last_code_text', 'string', 'text', 'Last code text'],
            ['last_code_type', 'string', 'text', 'Last code type (e.g. event, error, etc.)'],

            // Maps
            ['map.area_id', 'string', 'text', 'ID of current map area'],
            ['map.map_area', 'number', 'value', 'Surface area of map', 'm²'],
            ['map.custom_areas.raw', 'string', 'json', 'JSON object with custom area (aka. zone) information'],
            ['map.ridable_areas.raw', 'string', 'json', 'JSON object with ridable area (aka. edge) information'],
        ];

        for (const state of readOnlyStates) {
            const common = {
                name: state[0],
                type: state[1],
                role: state[2],
                desc: state[3],
                read: true,
                write: false,
            };
            if (state[4]) {
                common.unit = state[4];
            }
            // @ts-expect-error as 'type' below as a plain string doesn't check against ioBroker.CommonType
            await this.setObjectNotExistsAsync(`${device.sn}.${state[0]}`, {
                type: 'state',
                common,
                native: {},
            });
        }

        const commandStates = [
            // Command buttons
            ['mow_start', 'boolean', 'button.start', 'Start global mowing'],
            ['stop_all_tasks', 'boolean', 'button.stop', 'Stop'],
            ['mow_pause', 'boolean', 'button.pause', 'Pause'],
            ['charge_start', 'boolean', 'button', 'Return home/start charging'],
            ['custom_area_mow_start', 'boolean', 'button.start', 'Start custom area (aka. zone) mowing'],

            // Area list for relevant commands
            [
                'area_list',
                'string',
                'info.ids',
                `Areas (aka. zones) for next command (array of IDs, e.g. '[101,120,132]')`,
            ],

            // For 'area_set'
            ['area_set', 'string', 'json', 'JSON object with custom area (aka. zone) information to write'],
        ];

        for (const state of commandStates) {
            const common = {
                name: state[0],
                type: state[1],
                role: state[2],
                desc: state[3],
                read: false,
                write: true,
            };
            // @ts-expect-error as 'type' below as a plain string doesn't check against ioBroker.CommonType
            await this.setObjectNotExistsAsync(`${device.sn}.command.${state[0]}`, {
                type: 'state',
                common,
                native: {},
            });
        }
    }

    // Helper function to set shadow state values
    setShadowState(device, shadowState) {
        if (shadowState.online.value) {
            this.setConnected(true);
        } else {
            this.setConnected(false);
        }

        this.setStateChanged(`${device.sn}.active_area`, {
            val: JSON.stringify(shadowState.active_area.id),
            ack: true,
        });
        this.setStateChanged(`${device.sn}.elec`, { val: shadowState.elec.value, ack: true });
        this.setStateChanged(`${device.sn}.mode`, { val: shadowState.mode.value, ack: true });
        this.setStateChanged(`${device.sn}.mowing_area`, { val: shadowState.mowing_area.value, ack: true });
        this.setStateChanged(`${device.sn}.mowing_time`, { val: shadowState.mowing_time.value, ack: true });
        this.setStateChanged(`${device.sn}.rtk_moved`, { val: shadowState.rtk.moved == 1, ack: true });
        this.setStateChanged(`${device.sn}.rtk_state`, { val: shadowState.rtk.state == 1, ack: true });

        this.setStateChanged(`${device.sn}.map.area_id`, { val: shadowState.map.area_id, ack: true });
        this.setStateChanged(`${device.sn}.map.map_area`, { val: shadowState.map.map_area, ack: true });
    }

    setCodeList(device, codeList) {
        this.setStateChanged(`${device.sn}.code_list`, { val: JSON.stringify(codeList), ack: true });

        const lastCode = codeList[0];
        this.setStateChanged(`${device.sn}.last_code`, { val: lastCode.code, ack: true });
        this.setStateChanged(`${device.sn}.last_code_text`, { val: lastCode.event_message, ack: true });
        this.setStateChanged(`${device.sn}.last_code_type`, { val: lastCode.code_type, ack: true });
    }

    validateCustomAreas(device, customAreas) {
        const outputAreas = [];

        if (!Array.isArray(customAreas)) {
            this.log.error(`Invalid customAreas: not an array`);
        } else {
            for (const area of customAreas) {
                let outArea;

                const existingArea = device.customAreas.find(customArea => customArea.id === area.id);
                if (existingArea) {
                    this.log.debug(`Found existing area ${area.id} for merge: ${JSON.stringify(existingArea)}`);
                    outArea = { ...existingArea, ...area };
                    this.log.debug(`After merge ${area.id} is: ${JSON.stringify(outArea)}`);
                } else {
                    outArea = area;
                }

                // Assume area is good
                let isGood = true;
                if (typeof outArea.id !== 'number' || typeof outArea.name !== 'string') {
                    // Must have ID & name (I'm guessing)
                    this.log.error('Invalid custom area: id or name are bad/missing');
                    isGood = false;
                } else if (!Array.isArray(outArea.vertexs) || outArea.vertexs.length != 4) {
                    // vertexs must be an array of 4 co-ordinates or the Anthbot app will crash!
                    this.log.error('Invalid custom area: vertexs is not an array of 4 items');
                    isGood = false;
                } else {
                    let goodVertexs = 0;
                    for (const vertex of outArea.vertexs) {
                        if (
                            !Array.isArray(vertex) ||
                            vertex.length != 2 ||
                            typeof vertex[0] !== 'number' ||
                            typeof vertex[1] !== 'number'
                        ) {
                            this.log.error('Invalid custom area: vertex is not a co-ordinate');
                            break;
                        } else {
                            goodVertexs++;
                        }
                    }
                    if (goodVertexs != 4) {
                        isGood = false;
                    }
                }

                if (!isGood) {
                    // Something wrong with this area so return nothing
                    return;
                }
                outputAreas.push(outArea);
            }
        }

        return outputAreas;
    }

    isGoodCustomAreaList(device, customAreaList) {
        // List to check must be an array
        if (!Array.isArray(customAreaList)) {
            this.log.error(`Invalid custom area list: not an array`);
            return false;
        }

        // If we don't even have custom areas for our device any list is bad
        if (!device.customAreas) {
            this.log.error('Invalid custom area list: device has no custom area info');
            return false;
        }

        // Each area in array must be a known custom area ID
        checkCustomArea: for (const customArea of customAreaList) {
            for (const deviceCustomArea of device.customAreas) {
                if (deviceCustomArea.id === customArea) {
                    continue checkCustomArea;
                }
            }
            // If we didn't continue, then we didn't find the area ID in our info list, so it's not good
            this.log.error(`Invalid custom area list: ${customArea} not found in device info`);
            return false;
        }

        return true;
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
