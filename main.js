'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Our custom modules
const { AnthbotCloudApiClient } = require('./lib/anthbotApi');
const SunCalc = require('suncalc3');

// TODO: Constants that should maybe be configurable?
const SCHEDULE_MS_WAIT_AFTER_DAWN = 3 * 60 * 60 * 1000; // 3 hours after dawn
const SCHEDULE_MS_REQUIRED_FOR_UNKNOWN_CUSTOM_AREA = 4 * 60 * 60 * 1000; // Require at least 4 hours
const POLLING_INTERVAL = 60 * 1000; // Poll every 60 seconds
const CLOUD_SYNC_DELAY = 2000; // 2s
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
        // Not connected by default
        await this.setConnected(false);

        // Load system.config as lat/lon are required for dawn/dusk calculation
        this.sysConfig = await this.getForeignObjectAsync('system.config');

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

                // By default, leave ackState undefined so we won't ack this
                let ackState;

                const idParts = id.split('.');

                const command = idParts.pop();

                // Next level is either 'command' string literal or a custom area ID
                const customAreaId = Number(idParts.pop());

                let serialNumber;
                if (!customAreaId) {
                    // Must be a global command
                    serialNumber = idParts.pop();
                    this.log.debug(`Global command ${command} for ${serialNumber}`);
                } else {
                    // Must be a custom area command
                    idParts.pop(); // Remove 'custom_areas' level
                    idParts.pop(); // Remove 'map' level
                    serialNumber = idParts.pop();
                    this.log.debug(`Custom area command ${command} for ${serialNumber}/${customAreaId}`);
                }

                if (!serialNumber) {
                    this.log.error(`No serial number found in command ${id}`);
                } else {
                    const device = this.devices.find(checkDevice => checkDevice.sn === serialNumber);

                    if (!device) {
                        this.log.error(`Could not find device for command with serial number: ${serialNumber}`);
                    } else {
                        switch (command) {
                            // Global commands

                            case 'mow_start':
                                // To start mowing have to put app_state first.
                                await this.client?.asyncSendServiceCommand(serialNumber, 'app_state', 1);
                            // Purposfully fall through to send the actual command!

                            // Generic one-shot commands
                            /* falls through */
                            case 'charge_start':
                            case 'mow_pause':
                            case 'stop_all_tasks': {
                                this.log.info(`${device.alias}: ${command}`);
                                await this.doDeviceCommand(device, command, 1);
                                ackState = true;
                                break;
                            }

                            case 'area_list': {
                                let areaList;
                                // This will affect the next start command only.
                                if (typeof state?.val === 'string' && state.val !== '') {
                                    // Some kind of non-blank value given
                                    areaList = this.parseJsonList(state.val);

                                    // Make sure this is a list & is of valid custom or ridable area IDs
                                    if (
                                        !areaList ||
                                        !Array.isArray(areaList) ||
                                        !(
                                            (await this.isGoodAreaList(device, device.customAreas, areaList)) ||
                                            (await this.isGoodAreaList(device, device.ridableAreas, areaList))
                                        )
                                    ) {
                                        // Set to undefined so we don't ack it
                                        this.log.error(`Invalid area list in ${id}`);
                                        areaList = undefined;
                                    }
                                } else {
                                    // No value given, so ack an empty list
                                    areaList = [];
                                }

                                // Ack only if we now have a list
                                if (Array.isArray(areaList)) {
                                    ackState = JSON.stringify(areaList);
                                }

                                break;
                            }

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

                                if (await this.doAreaSet(device, customAreas)) {
                                    ackState = JSON.stringify(customAreas);
                                }

                                break;
                            }

                            // Can be global or for custom area

                            case 'custom_area_mow_start': {
                                // If customAreaId is valid then this is for specific area - pass that to isGoodAreaList
                                // otherwise ommit that and the device's area_list will be used.
                                const goodAreaList = await this.isGoodAreaList(
                                    device,
                                    device.customAreas,
                                    customAreaId ? [customAreaId] : undefined,
                                );

                                if (!goodAreaList) {
                                    this.log.error(`Derived invalid area list for command ${id}`);
                                } else {
                                    await this.doCustomAreaMowStart(device, goodAreaList);
                                    ackState = true;
                                }
                                break;
                            }

                            case 'ridable_mow_start': {
                                const goodAreaList = await this.isGoodAreaList(device, device.ridableAreas);
                                if (goodAreaList) {
                                    this.log.info(`${device.alias}: ridable_mow_start ${JSON.stringify(goodAreaList)}`);
                                    await this.doDeviceCommand(device, 'ridable_mow_start', { id: goodAreaList });
                                    ackState = true;
                                }
                                break;
                            }

                            // Commands for custom area only

                            case 'mow_head_alts': {
                                let mowHeadAlts;
                                if (typeof state?.val === 'string' && state.val !== '') {
                                    // Some kind of non-blank value given
                                    mowHeadAlts = this.parseJsonList(state.val);

                                    // Make sure this is a list of numbers between 0 & 180
                                    if (
                                        !mowHeadAlts ||
                                        !Array.isArray(mowHeadAlts) ||
                                        !mowHeadAlts.every(
                                            mowHeadAlts => Number(mowHeadAlts) >= 0 && Number(mowHeadAlts) <= 180,
                                        )
                                    ) {
                                        // Set to null so we don't ack it
                                        this.log.error(`Invalid mow head list in ${id}`);
                                        mowHeadAlts = null;
                                    }
                                } else {
                                    // No value given, so ack an empty list
                                    mowHeadAlts = [];
                                }

                                // Ack only if we now have a list
                                if (Array.isArray(mowHeadAlts)) {
                                    if (mowHeadAlts.length > 0) {
                                        // Make sure current mow_head is in this list, if not - set it ready for next task
                                        const currentMowHead = device.customAreas.find(
                                            area => area.id == customAreaId,
                                        )?.mow_head;
                                        if (!mowHeadAlts.includes(currentMowHead)) {
                                            // Current mow head is not in the new list, so set it to first entry
                                            this.log.debug(
                                                `Current mow head ${currentMowHead} is not in alt list, setting to first entry ${mowHeadAlts[0]}`,
                                            );
                                            await this.doAreaSet(device, [
                                                { mow_head: mowHeadAlts[0], id: customAreaId },
                                            ]);
                                        }
                                    }

                                    // Set in our device cache, which will also ack the state
                                    await this.setDeviceCustomAreaProperty(device, customAreaId, { mowHeadAlts });
                                }

                                break;
                            }

                            case 'mow_head_random': {
                                // Force boolean
                                const mowHeadRandom = state?.val ? true : false;
                                // Set in our device cache, which will also ack the state
                                await this.setDeviceCustomAreaProperty(device, customAreaId, { mowHeadRandom });

                                if (mowHeadRandom) {
                                    // Is now turned on, so randomise mow_head for this custom area
                                    await this.doAreaSet(device, [this.randomMowHeadAreaCommand(customAreaId)]);
                                }

                                break;
                            }

                            case 'schedule_enabled': {
                                // Force boolean
                                const scheduleEnabled = state?.val ? true : false;
                                // Set in our device cache, which will also ack the state
                                await this.setDeviceCustomAreaProperty(device, customAreaId, { scheduleEnabled });

                                break;
                            }

                            case 'schedule_priority': {
                                const schedulePriority = Number(state.val);

                                // This state must be a number > 0
                                if (schedulePriority > 0) {
                                    // Set in our device cache, which will also ack the state
                                    await this.setDeviceCustomAreaProperty(device, customAreaId, { schedulePriority });
                                } else {
                                    this.log.error(`Invalid schedule priority in ${id}: ${state.val}`);
                                }
                                break;
                            }

                            case 'schedule_days_since_last': {
                                const scheduleDaysSinceLast = Number(state.val);

                                // This state must be a number >= 0
                                if (scheduleDaysSinceLast >= 0) {
                                    // Set in our device cache, which will also ack the state
                                    await this.setDeviceCustomAreaProperty(device, customAreaId, {
                                        scheduleDaysSinceLast,
                                    });
                                } else {
                                    this.log.error(`Invalid schedule days since last in ${id}: ${state.val}`);
                                }
                                break;
                            }

                            default:
                                this.log.warn(`Unknown command: ${command}`);
                        }
                    }

                    // Ack command if verified valid above
                    if (typeof ackState != 'undefined') {
                        await this.setState(id, ackState, true);
                    }
                }
            }
        } else {
            // The object was deleted or the state value has expired
            this.log.warn(`state ${id} deleted`);
        }
    }

    async doDeviceCommand(device, command, args) {
        this.log.info(`${device.alias}: ${command}} ${JSON.stringify(args)}`);
        await this.client?.asyncSendServiceCommand(device.sn, command, args);
        await this.syncDevice(device);
    }

    async doCustomAreaMowStart(device, id) {
        await this.doDeviceCommand(device, 'custom_area_mow_start', { id });
    }

    async doAreaSet(device, customAreas) {
        // Assume failure until verified and sent
        let success = false;

        // Overlay elements from the state onto existing custom areas so user only has to set
        // the items they are changing and rest will be preserved.

        // Variable named to match asyncSendServiceCommand data
        const custom_areas = this.validateCustomAreas(device, customAreas);

        if (!custom_areas) {
            this.log.error(`Bad area data: ${customAreas}`);
        } else {
            // Write the given custom area data
            this.log.info(`${device.alias}: area_set ${JSON.stringify(customAreas)}`);
            await this.doDeviceCommand(device, 'area_set', { custom_areas });
            success = true;
        }
        return success;
    }

    randomMowHeadAreaCommand(customAreaId) {
        const randomAngle = Math.floor(Math.random() * 180);
        this.log.debug(`New random mow_head for ${customAreaId}: ${randomAngle}`);
        return { mow_head: randomAngle, id: customAreaId };
    }

    // Retry connection with backoff
    async retryConnection() {
        if (this.retryTimer) {
            this.log.warn(`Connection retry timer is already running, will wait for that`);
        } else {
            this.client = null;
            this.clearPolling();
            await this.setConnected(false);

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

        await this.syncDevice(device);
    }

    async syncDevice(device) {
        // Don't sync right now if we are in the middle of polling
        if (device.inPoll) {
            device.syncReq = true;
        } else if (this.checkClient()) {
            // We're doing a sync, so reset required flag
            device.syncReq = false;

            // Reset polling interval on sync
            this.clearPolling();

            await this.client?.asyncSendServiceCommand(device.sn, 'get_all_props', 1);
            // Wait a moment for their backend
            await new Promise(resolve => this.setTimeout(resolve, CLOUD_SYNC_DELAY, null));

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
     * @returns {boolean} Does this.client appear to be a valid API client?
     */
    checkClient() {
        if (!this.client || typeof this.client !== 'object') {
            this.log.warn('No API client available!');
            return false;
        }
        return true;
    }

    // Poll device
    async pollDevice(device) {
        // Assume success
        let success = true;

        if (this.checkClient()) {
            // Set device flag showing we are already in the middle of a poll so any syncDevice calls are processed after
            device.inPoll = true;

            // Shadow state
            try {
                device.shadowState = await this.client?.asyncGetShadowReportedState(device.sn);
                this.log.debug(`Device shadow reported state:\n${JSON.stringify(device.shadowState)}`);
                await this.setShadowState(device);
            } catch (err) {
                this.log.error(`Failed to fetch shadow state for device ${device.sn}: ${err.message}`);
                // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
                success = false;
            }

            // Code list
            try {
                device.codeList = await this.client?.asyncGetCodeList(device.sn, 1, 20 /* TODO: make configurable? */);
                this.log.debug(`Device code list:\n${JSON.stringify(device.codeList)}`);
                await this.setCodeList(device);
            } catch (err) {
                this.log.error(`Failed to fetch code list for device ${device.sn}: ${err.message}`);
                // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
                success = false;
            }

            await this.checkMapUpdates(device);

            await this.checkCustomAreaMowing(device);

            await this.checkCustomAreaSchedule(device);

            device.inPoll = false;

            // If this poll actually generated a sync request do it now we've finished
            if (device.syncReq) {
                await this.syncDevice(device);
            }
        }

        // If something went wrong, reconnect
        if (!success) {
            await this.retryConnection();
        }
    }

    /**
     *
     * @param {object} device A valid device object
     */
    async checkMapUpdates(device) {
        const mapAreaIdStateId = `${device.sn}.map.area_id`;
        if (
            !device.mapLoaded /* Force load at startup */ ||
            device.shadowState.map.area_id != (await this.getStateAsync(mapAreaIdStateId))?.val
        ) {
            // areaId does not match from time of last fetch so we need to update map
            this.log.info(
                `${!device.mapLoaded ? 'Startup' : 'Device map area_id change detected'}, fetching new map info`,
            );

            const deviceMapFiles = await this.client?.asyncGetDeviceMap(device.sn);

            const areaSetting = deviceMapFiles?.['area_setting.json'];
            this.log.debug(`area_setting.json: ${JSON.stringify(areaSetting)}`);

            // Custom Areas (aka. zones)
            device.customAreas = areaSetting?.content?.custom_areas;
            this.setStateChanged(`${device.sn}.map.custom_areas.raw`, {
                val: JSON.stringify(device.customAreas),
                ack: true,
            });
            await this.populateDeviceFromStates(device);
            this.log.debug(`custom_areas (after state population): ${JSON.stringify(device.customAreas)}`);

            // Ridable Areas (aka. edges)
            device.ridableAreas = areaSetting?.content?.ridable_areas;
            this.log.debug(`ridable_areas: ${JSON.stringify(device.ridableAreas)}`);

            this.setStateChanged(`${device.sn}.map.ridable_areas.raw`, {
                val: JSON.stringify(device.ridableAreas),
                ack: true,
            });

            for (const customArea of device.customAreas) {
                // Use setObject here so if the name changes online it gets updated in IoB
                const customAreaChannelStateId = `${device.sn}.map.custom_areas.${customArea.id}`;
                await this.setObject(customAreaChannelStateId, {
                    type: 'channel',
                    common: {
                        name: customArea.name,
                    },
                    native: {},
                });

                const readOnlyStates = [
                    ['last_start', 'number', 'value.time', 'Start time of last job including this area'],
                    ['last_finish', 'number', 'value.time', 'End time of last job including this area'],
                    ['estimated_elapsed_time', 'number', 'time.span', 'Elapsed time to mow this area', 's'],
                    ['estimated_elec', 'number', 'value.battery', 'Elec (battery) used mowingthis area', '%'],
                ];
                await this.createStatesFromList(customAreaChannelStateId, readOnlyStates);

                const commandStates = [
                    // Command buttons
                    ['custom_area_mow_start', 'boolean', 'button.start', 'Start a task mowing this single area'],

                    // Set mow_head (cutting direction) randomly
                    ['mow_head_random', 'boolean', 'switch.enable', 'Set mow_head (cutting direction) randomly'],

                    // List of alternating mow_head (aka. cutting direction) angles.
                    // If set the adapter will move to the next angle in the list when mowing of
                    // the given custom area completes successfully.
                    [
                        'mow_head_alts',
                        'string',
                        'list',
                        `Alternates for mow_head (cutting direction) setting (array of angles, e.g. '[0, 90, 120]')`,
                    ],

                    // Scheduling
                    ['schedule_enabled', 'boolean', 'switch.enable', 'Enable adapter scheduling for this area'],
                    ['schedule_priority', 'number', 'level', 'Priority (lowest number is handled first)'],
                    [
                        'schedule_days_since_last',
                        'number',
                        'time.span',
                        'Number of days between mowing (0 = cut every day)',
                    ],
                ];
                await this.createCommandStatesFromList(customAreaChannelStateId, commandStates);
            }

            // Go find all the custom area channels that aren't in the current list and delete them
            const existingChannels = await this.getChannelsOfAsync(`${device.sn}`);
            this.log.debug(`Existing custom area channels: ${JSON.stringify(existingChannels)}`);
            for (const existingChannel of existingChannels) {
                const channelId = existingChannel._id.split('.').pop();
                if (!device.customAreas.find(area => area.id == channelId)) {
                    this.log.debug(
                        `Deleting custom area channel ${existingChannel._id} as it's no longer in the map info`,
                    );
                    await this.delObjectAsync(existingChannel._id, { recursive: true });
                }
            }

            const timeSetting = deviceMapFiles?.['time_setting.json'];
            this.log.debug(`time_setting.json: ${JSON.stringify(timeSetting)}`);

            // Only save the area_id after map load to use for check detection - it must have changed
            this.setState(mapAreaIdStateId, { val: device.shadowState.map.area_id, ack: true });
            device.mapLoaded = true;
        }
    }

    // This is a bit ugly, but we have chosen to use the Anthbot naming convention
    // which is underscores in state IDs. To mix conventions in state IDs would be
    // even worse for the user so keep lower camelCase in the code and underscores
    // in state IDs.
    //
    // Use camelCase <-> underscore_case conversion between state IDs & properties.

    camelToUnderscoreCase(key) {
        return key.replace(/([A-Z])/g, '_$1').toLowerCase();
    }

    underscoreToCamelCase(key) {
        return key.replace(/_([a-z])/g, function f(char) {
            return char[1].toUpperCase();
        });
    }

    /**
     * populateCustomAreasFromStates - Load states for custom areas on a device after new map load.
     * This is mainly so we don't have to repeated load them when checking schedule.
     *
     * @param {object} device Device object to populate
     */
    async populateDeviceFromStates(device) {
        // TODO: can't get getStatesOfAsync to filter for each customArea so fetch them all & filter ourselves
        const deviceStates = await this.getStatesOfAsync(device.sn);
        this.log.debug(`deviceStates for ${device.sn}: ${JSON.stringify(deviceStates)}`);

        for (const customArea of device.customAreas) {
            const customAreaStates = deviceStates.filter(state => {
                const idParts = state._id.split('.');
                idParts.pop(); // Remove ID
                return idParts.pop() == customArea.id;
            });
            this.log.debug(
                `customAreaStates for ${device.sn}.map.custom_areas.${customArea.id}: ${JSON.stringify(customAreaStates)}`,
            );

            for (const state of customAreaStates) {
                const stateId = state._id.split('.').pop();
                const propertyName = this.underscoreToCamelCase(stateId);
                if (stateId && propertyName) {
                    // Populate in the passed in device object
                    if (state.common.role == 'list') {
                        customArea[propertyName] = this.parseJsonList(
                            (await this.getStateAsync(state._id))?.val,
                            false /* Don't hardfail (get empty list on failure) */,
                        );
                    } else {
                        customArea[propertyName] = (await this.getStateAsync(state._id))?.val;
                    }
                    this.log.debug(`loadded ${propertyName} : ${customArea[propertyName]}`);
                }
            }
        }
    }

    /**
     * Set a custom area property in the local device customAreas cache while saving to the
     * relevant state. Kindof the reverse of populateDeviceFromStates.
     *
     * @param {object} device Device to set
     * @param {number} customAreaId Custom area ID
     * @param {object} propertyObject { key: value } object to set. Like this to get input variable name
     */
    async setDeviceCustomAreaProperty(device, customAreaId, propertyObject) {
        const customArea = device.customAreas.find(checkArea => checkArea.id == customAreaId);
        if (!customArea) {
            this.log.error(`Unknown custom area ID: ${customAreaId}`);
        } else {
            const propertyName = Object.keys(propertyObject)[0];
            const stateId = this.camelToUnderscoreCase(propertyName);
            const val = propertyObject[propertyName];
            await this.setStateChanged(`${device.sn}.map.custom_areas.${customAreaId}.${stateId}`, {
                val: typeof val == 'object' ? JSON.stringify(val) : val,
                ack: true,
            });
            customArea[propertyName] = val;
        }
    }

    async checkCustomAreaMowing(device) {
        // Figure out if device has just started/finished a custom area task & set states accordingly
        if (
            Array.isArray(device.codeList) &&
            !device.isCustomAreaMowing &&
            device.shadowState.mode.value == 'zonemowing' &&
            Array.isArray(device.shadowState.active_area.id)
        ) {
            // Currently mowing at least one custom area
            device.isCustomAreaMowing = true;

            // Go find the last "The robot is going to the designated area to mow" code (#1018) to get timestamp
            const startCode = device.codeList.find(code => code.code === 1018);
            if (!startCode) {
                this.log.warn('Could not find start code while custom area mowing');
            } else {
                this.log.debug(`startCode for custom area mowing: ${JSON.stringify(startCode)}`);
                // Add 'Z' because the time is UTC
                const lastStart = Date.parse(`${startCode.create_time}Z`);

                // Set start time for each active area
                for (const activeAreaId of device.shadowState.active_area.id) {
                    await this.setDeviceCustomAreaProperty(device, activeAreaId, { lastStart });
                }

                // If start time is close (within 2 * polling interval) track battery for estimate
                if (Date.now() - lastStart < POLLING_INTERVAL * 2 * 1000) {
                    // Keep count of how much 'elec' changes during this task.
                    // Not ideal, but as we poll regularly probably easier than taking
                    // a start and end value and trying to account for charging, etc.
                    device.customAreaMowingElec = 0;
                    device.lastElec = device.shadowState.elec.value;

                    this.log.debug(`Caught custom area mowing task in time to monitor elec: ${device.lastElec}`);
                } else {
                    // We have noticed this start event too late
                    this.log.warn(
                        `Caught custom area mowing task too late to monitor elec: ${JSON.stringify(device.shadowState.active_area.id)}`,
                    );
                    device.customAreaMowingElec = undefined;
                }
            }
        } else if (
            Array.isArray(device.codeList) &&
            device.isCustomAreaMowing &&
            Array.isArray(device.shadowState.active_area.id)
        ) {
            // If we can find a "Task finished" code (#1014) before (which is chronologically after)
            // the previous start code (#1018) then we're done
            const startIndex = device.codeList.findIndex(code => code.code === 1018);
            const endIndex = device.codeList.findIndex(code => code.code === 1014);
            if (endIndex >= 0 && (endIndex < startIndex || startIndex === -1)) {
                this.log.debug('Custom area mowing end code found');

                // Add 'Z' because the time is UTC
                const lastFinish = Date.parse(`${device.codeList[endIndex].create_time}Z`);

                // Set finish time for each active area
                for (const activeAreaId of device.shadowState.active_area.id) {
                    await this.setDeviceCustomAreaProperty(device, activeAreaId, { lastFinish });
                }

                // If this was a single custom area, we can set the estimated time to complete
                if (device.shadowState.active_area.id.length == 1) {
                    // TODO: make sure there were no errors between start and end codes
                    // TODO: make sure battery was close to full when starting
                    // TODO: possibly throw this number away when area vertexes change
                    const singleAreaId = device.shadowState.active_area.id[0];
                    const singleArea = device.customAreas.find(customArea => customArea.id == singleAreaId);
                    if (!singleArea) {
                        this.log.error(`Could not find custom area ID ${singleAreaId} when checking alternates`);
                    } else {
                        const startTime = singleArea.lastStart;
                        if (!startTime || !(Number(startTime) > 0)) {
                            this.log.warn(`Single area ID ${singleAreaId} has no start time`);
                        } else {
                            const estimatedElapsedTime = (lastFinish - Number(startTime)) / 1000;
                            await this.setDeviceCustomAreaProperty(device, singleAreaId, { estimatedElapsedTime });
                        }

                        if (typeof device.customAreaMowingElec == 'number') {
                            // We have been tracking elec (battery) usage so record that
                            const estimatedElec = device.customAreaMowingElec;
                            await this.setDeviceCustomAreaProperty(device, singleAreaId, { estimatedElec });
                        }
                    }
                }

                await this.checkCustomAreaAlternates(device);

                device.isCustomAreaMowing = false;
            } else if (!['zonemowing', 'backtodock', 'charge'].includes(device.shadowState.mode.value)) {
                // Not custom area mowing (or charging part way through) but didn't find a "Task finished" code
                this.log.warn('Custom area mowing looks done but no "Task finished" code found');
                device.isCustomAreaMowing = false;
            } else if (
                typeof device.customAreaMowingElec == 'number' &&
                device.lastElec > device.shadowState.elec.value
            ) {
                // Device is still custom area mowing and has a reduced 'elec' (battery) level
                device.customAreaMowingElec += device.lastElec - device.shadowState.elec.value;
                device.lastElec = device.shadowState.elec.value;
                this.log.debug(`Custom area mowing task has now consumed ${device.customAreaMowingElec} elec`);
            }
        }
    }

    async checkCustomAreaAlternates(device) {
        // Build an array of commands for area_set
        const areaSetCommand = [];

        const activeCustomAreas = device.customAreas.filter(customArea => {
            return device.shadowState.active_area.id.includes(customArea.id);
        });

        this.log.debug(`activeCustomAreas: ${JSON.stringify(activeCustomAreas)}`);

        for (const customArea of activeCustomAreas) {
            if (customArea.mowHeadRandom) {
                this.log.debug(`Randomising mow head for ${customArea.id}`);
                areaSetCommand.push(this.randomMowHeadAreaCommand(customArea.id));
            } else {
                const mowHeadAlts = customArea.mowHeadAlts;
                // The check is for > 0, not > 1 because that way if there's a single alternate
                // that doesn't match current value it will get set.
                if (Array.isArray(mowHeadAlts) && mowHeadAlts.length > 0) {
                    this.log.debug(`Cycling to next mow head for ${customArea.id}`);
                    // Remember findIndex returns -1 on no match
                    let setIndex = mowHeadAlts.findIndex(angle => angle == customArea.mow_head) + 1;
                    if (setIndex > mowHeadAlts.length) {
                        // Wrap around to the first alternate
                        setIndex = 0;
                    }
                    areaSetCommand.push({ mow_head: mowHeadAlts[setIndex], id: customArea.id });
                }
            }
        }

        if (areaSetCommand.length > 0) {
            await this.doAreaSet(device, areaSetCommand);
        }
    }

    /**
     * Iterate through custom areas and commence custom area mowing task if applicable
     *
     * @param {object} device Device object to schedule
     */
    async checkCustomAreaSchedule(device) {
        if (
            device.shadowState.mode.value == 'charge' &&
            !device.isCustomAreaMowing &&
            // TODO: improve the battery state check?
            device.shadowState.elec.value > 95
        ) {
            // Device is available to start work
            this.log.debug(`checkCustomAreaSchedule... device available`);

            // Get dawn/dusk times to figure out if a task should start though
            const now = new Date();
            const suncalcTimes = SunCalc.getSunTimes(
                now,
                this.sysConfig?.common.latitude,
                this.sysConfig?.common.longitude,
            );

            if (
                now.getTime() > suncalcTimes.civilDawn.ts + SCHEDULE_MS_WAIT_AFTER_DAWN &&
                now.getTime() < suncalcTimes.civilDusk.ts
            ) {
                this.log.debug(`checkCustomAreaSchedule... time now is between dawn & dusk`);

                // Get the start of today in ms
                const today0000 = new Date(now);
                today0000.setHours(0, 0, 0, 0);

                let startAreaId;
                let startPriority;
                for (const customArea of device.customAreas) {
                    if (!startAreaId || !startPriority || customArea.schedulePriority < startPriority) {
                        // No area found yet, or this one has a better (lower) priority
                        if (
                            customArea.scheduleEnabled &&
                            Number(customArea.scheduleDaysSinceLast) >= 0 &&
                            customArea.lastFinish > 0 &&
                            !(Number(customArea.lastStart) > today0000.getTime())
                        ) {
                            // The area has schedule enabled and a valid lastFinish
                            this.log.debug(
                                `scheduleDaysSinceLast/lastStart/lastFinish for ${customArea.id}: ${customArea.scheduleDaysSinceLast}/${customArea.lastStart}/${customArea.lastFinish}`,
                            );

                            const lastFinishPlusDaysSinceMs =
                                customArea.lastFinish + customArea.scheduleDaysSinceLast * 24 * 60 * 60 * 1000;
                            this.log.debug(
                                `Last finish + offset for ${customArea.id}: ${lastFinishPlusDaysSinceMs} (? < ${today0000.getTime()})`,
                            );

                            if (lastFinishPlusDaysSinceMs < today0000.getTime()) {
                                this.log.debug(`Task required for area ID ${customArea.id}...`);
                                let msRequired = Number(customArea.estimatedElapsedTime);
                                if (!msRequired) {
                                    msRequired = SCHEDULE_MS_REQUIRED_FOR_UNKNOWN_CUSTOM_AREA;
                                    this.log.debug(
                                        `No estimate of elapsed time for area ID ${customArea.id}, defaulting to ${msRequired}`,
                                    );
                                }
                                if (now.getTime() + msRequired > suncalcTimes.civilDusk.ts) {
                                    this.log.debug(`Not enough time before dusk for area ID ${customArea.id}`);
                                } else {
                                    this.log.debug(`Schedule task for area ID ${customArea.id}`);
                                    startAreaId = customArea.id;
                                    startPriority = customArea.schedulePriority;
                                }
                            }
                        }
                    }
                }

                if (startAreaId) {
                    await this.doCustomAreaMowStart(device, [startAreaId]);
                }
            }
        }
    }

    /**
     * Create multiple read onlystate objects from a list of their parameters
     *
     * @param {string} prefix State ID prefix
     * @param {Array} stateList Array of state parameters
     */

    async createStatesFromList(prefix, stateList) {
        for (const state of stateList) {
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
            await this.setObjectNotExistsAsync(`${prefix}.${state[0]}`, {
                type: 'state',
                common,
                native: {},
            });
        }
    }

    /**
     * Create multiple command state objects from a list of their parameters
     *
     * @param {string} prefix State ID prefix
     * @param {Array} commandStates Array of state parameters
     */
    async createCommandStatesFromList(prefix, commandStates) {
        for (const state of commandStates) {
            const common = {
                name: state[0],
                type: state[1],
                role: state[2],
                desc: state[3],
                read: true,
                write: true,
            };
            await this.setObjectNotExistsAsync(`${prefix}.${state[0]}`, {
                type: 'state',
                common,
                native: {},
            });
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

        const folders = [
            ['command', 'Commands'],
            ['map', 'Map info'],
            ['map.custom_areas', 'Custom areas, aka. Zones'],
            ['map.ridable_areas', 'Ridable areas, aka. Edges'],
        ];

        for (const folder of folders) {
            await this.setObjectNotExistsAsync(`${device.sn}.${folder[0]}`, {
                type: 'folder',
                common: {
                    name: folder[0],
                    desc: folder[1],
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
        await this.createStatesFromList(device.sn, readOnlyStates);

        const commandStates = [
            // Command buttons
            ['mow_start', 'boolean', 'button.start', 'Start global mowing'],
            ['stop_all_tasks', 'boolean', 'button.stop', 'Stop'],
            ['mow_pause', 'boolean', 'button.pause', 'Pause'],
            ['charge_start', 'boolean', 'button', 'Return home/start charging'],
            ['custom_area_mow_start', 'boolean', 'button.start', 'Start custom area (aka. zone) mowing'],
            ['ridable_mow_start', 'boolean', 'button.start', 'Start ridable area (aka. edge) mowing'],

            // Area list for relevant commands
            ['area_list', 'string', 'info.ids', `Areas for next command (array of IDs, e.g. '[101,120,132]')`],

            // For 'area_set'
            ['area_set', 'string', 'json', 'JSON object with custom area (aka. zone) information to write'],
        ];
        await this.createCommandStatesFromList(`${device.sn}.command`, commandStates);
    }

    // Helper function to set shadow state values
    setShadowState(device) {
        if (device.shadowState.online.value) {
            this.setConnected(true);
        } else {
            this.setConnected(false);
        }

        this.setStateChanged(`${device.sn}.active_area`, {
            val: JSON.stringify(device.shadowState.active_area.id),
            ack: true,
        });
        this.setStateChanged(`${device.sn}.elec`, { val: device.shadowState.elec.value, ack: true });
        this.setStateChanged(`${device.sn}.mode`, { val: device.shadowState.mode.value, ack: true });
        this.setStateChanged(`${device.sn}.mowing_area`, { val: device.shadowState.mowing_area.value, ack: true });
        this.setStateChanged(`${device.sn}.mowing_time`, { val: device.shadowState.mowing_time.value, ack: true });
        this.setStateChanged(`${device.sn}.rtk_moved`, { val: device.shadowState.rtk.moved == 1, ack: true });
        this.setStateChanged(`${device.sn}.rtk_state`, { val: device.shadowState.rtk.state == 1, ack: true });

        // map.area_id is set only after map is load
        this.setStateChanged(`${device.sn}.map.map_area`, { val: device.shadowState.map.map_area, ack: true });
    }

    setCodeList(device) {
        this.setStateChanged(`${device.sn}.code_list`, { val: JSON.stringify(device.codeList), ack: true });

        const lastCode = device.codeList[0];
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

    /**
     * Parses a JSON string into an array
     *
     * @param {any} jsonString String to parse
     * @param {boolean} hardFail Return failure (undefined) on error, otherwise empty list
     * @returns {Array | undefined} Parsed array if valid, otherwise undefined
     */

    parseJsonList(jsonString, hardFail = true) {
        const logLevel = hardFail ? this.log.error : this.log.warn;

        const outOnFail = hardFail ? undefined : [];
        let out = outOnFail;

        if (typeof jsonString !== 'string') {
            logLevel(`JSON to parse is not a string: ${JSON.stringify(jsonString)}`);
        } else {
            try {
                out = JSON.parse(jsonString);
                if (!Array.isArray(out)) {
                    logLevel(`Invalid JSON list, not an array: ${JSON.stringify(jsonString)}`);
                    out = outOnFail;
                } else if (hardFail && out.length < 1) {
                    logLevel(`Invalid JSON list, array is empty: ${JSON.stringify(jsonString)}`);
                    out = outOnFail;
                }
            } catch (error) {
                logLevel(`Failed to parse JSON list (${JSON.stringify(jsonString)}): ${error.message}`);
            }
        }

        return out;
    }

    /**
     *
     * @param {object} device Device object for the check or specific list
     * @param {Array} checkAreas Array of valid area objects to check against
     * @param {Array | undefined} passedToCheck Optional list to check instead of fetching from command state
     * @returns {Promise<Array | false>} List if good, false if not
     */

    async isGoodAreaList(device, checkAreas, passedToCheck = undefined) {
        const listToCheck = passedToCheck
            ? passedToCheck
            : this.parseJsonList((await this.getStateAsync(`${device.sn}.command.area_list`))?.val);

        if (!listToCheck || !Array.isArray(listToCheck)) {
            this.log.error('Area list to check is not valid');
            return false;
        }

        // Each area in array must be a known custom area ID
        checkArea: for (const areaToCheck of listToCheck) {
            for (const checkArea of checkAreas) {
                if (checkArea.id === areaToCheck) {
                    continue checkArea;
                }
            }
            // If we didn't continue, then we didn't find the area ID in our info list, so it's not good
            this.log.warn(`Invalid custom area list: ${areaToCheck} not found in check list`);
            return false;
        }

        return listToCheck;
    }

    subscribeToDevice(device) {
        this.log.debug(`Subscribing to command states for ${device.sn}`);
        this.subscribeStates(`${device.sn}.command.*`);
        // TODO: be more selective about custom_areas?
        this.subscribeStates(`${device.sn}.map.custom_areas.*`);
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
