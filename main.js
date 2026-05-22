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

                // By default, leave ackState undefined so we won't ack this
                let ackState;
                // By default sync afer valid command
                let doSync = true;

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
                                    this.log.info(
                                        `${device.alias}: custom_area_mow_start ${JSON.stringify(goodAreaList)}`,
                                    );
                                    await this.client.asyncSendServiceCommand(serialNumber, 'custom_area_mow_start', {
                                        id: goodAreaList,
                                    });
                                    ackState = true;
                                }
                                break;
                            }

                            case 'ridable_mow_start': {
                                const goodAreaList = await this.isGoodAreaList(device, device.ridableAreas);
                                if (goodAreaList) {
                                    this.log.info(`${device.alias}: ridable_mow_start ${JSON.stringify(goodAreaList)}`);
                                    await this.client.asyncSendServiceCommand(serialNumber, 'ridable_mow_start', {
                                        id: goodAreaList,
                                    });
                                    ackState = true;
                                }
                                break;
                            }

                            case 'area_list': {
                                // We never need to sync after this as no command will be sent
                                doSync = false;

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

                            case 'alt_mow_head': {
                                // By default we don't need to sync after this
                                doSync = false;

                                let altMowHeadList;
                                if (typeof state?.val === 'string' && state.val !== '') {
                                    // Some kind of non-blank value given
                                    altMowHeadList = this.parseJsonList(state.val);

                                    // Make sure this is a list of numbers between 0 & 180
                                    if (
                                        !altMowHeadList ||
                                        !Array.isArray(altMowHeadList) ||
                                        !altMowHeadList.every(
                                            altMowHead => Number(altMowHead) >= 0 && Number(altMowHead) <= 180,
                                        )
                                    ) {
                                        // Set to null so we don't ack it
                                        this.log.error(`Invalid mow head list in ${id}`);
                                        altMowHeadList = null;
                                    }
                                } else {
                                    // No value given, so ack an empty list
                                    altMowHeadList = [];
                                }

                                // Ack only if we now have a list
                                if (Array.isArray(altMowHeadList)) {
                                    ackState = JSON.stringify(altMowHeadList);

                                    if (altMowHeadList.length > 0) {
                                        // Make sure current mow_head is in this list, if not - set it ready for next task
                                        const currentMowHead = device.customAreas.find(
                                            area => area.id == customAreaId,
                                        )?.mow_head;
                                        if (!altMowHeadList.includes(currentMowHead)) {
                                            // Current mow head is not in the new list, so set it to first entry
                                            this.log.debug(
                                                `Current mow head ${currentMowHead} is not in alt list, setting to first entry ${altMowHeadList[0]}`,
                                            );
                                            if (
                                                await this.doAreaSet(device, [
                                                    { mow_head: altMowHeadList[0], id: customAreaId },
                                                ])
                                            ) {
                                                // We changed the current mow_head so sync needed
                                                doSync = true;
                                            } else {
                                                this.log.error(`Failed to set first mow head entry for ${id}`);
                                                ackState = undefined;
                                            }
                                        }
                                    }
                                }

                                break;
                            }

                            case 'mow_head_random': {
                                if (state?.val) {
                                    // Turned on, so randomise mow_head for this custom area
                                    if (await this.doAreaSet(device, [this.randomMowHeadAreaCommand(customAreaId)])) {
                                        // Area randmised successfully, ack 'On' value
                                        ackState = true;
                                    }
                                } else {
                                    // Just ack 'Off' value
                                    ackState = false;
                                    // We don't need to sync when turning off
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
                    if (typeof ackState != 'undefined') {
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

    async doAreaSet(device, customAreas) {
        // Assume failure until verified and sent
        let success = false;

        if (this.checkClient()) {
            // Overlay elements from the state onto existing custom areas so user only has to set
            // the items they are changing and rest will be preserved.

            // Variable named to match asyncSendServiceCommand data
            const custom_areas = this.validateCustomAreas(device, customAreas);

            if (!custom_areas) {
                this.log.error(`Bad area data: ${customAreas}`);
            } else {
                // Write the given custom area data
                this.log.info(`${device.alias}: area_set ${JSON.stringify(customAreas)}`);
                await this.client.asyncSendServiceCommand(device.sn, 'area_set', {
                    custom_areas,
                });
                success = true;
            }
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
        // Don't sync right now if we are in the middle of polling
        if (device.inPoll) {
            device.syncReq = true;
        } else if (this.checkClient()) {
            // We're doing a sync, so reset required flag

            device.syncReq = false;

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
            // Set device flag showing we are already in the middle of a poll so any syncDevice calls are processed after
            device.inPoll = true;

            // Shadow state
            // Define here so we can use the Map area ID below to check for changes
            let shadowState;
            try {
                shadowState = await this.client.asyncGetShadowReportedState(device.sn);
                this.log.debug(`Device shadow reported state:\n${JSON.stringify(shadowState)}`);
                await this.setShadowState(device, shadowState);
            } catch (err) {
                this.log.error(`Failed to fetch shadow state for device ${device.sn}: ${err.message}`);
                // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
                this.retryConnection();
            }

            // Code list
            // Define here so we can use later to find task start/end times
            let codeList;
            try {
                codeList = await this.client.asyncGetCodeList(device.sn, 1, 20 /* TODO: make configurable? */);
                this.log.debug(`Device code list:\n${JSON.stringify(codeList)}`);
                await this.setCodeList(device, codeList);
            } catch (err) {
                this.log.error(`Failed to fetch code list for device ${device.sn}: ${err.message}`);
                // TODO: If something goes wrong here, might not be serious, maybe don't do a full reconnect?
                this.retryConnection();
            }

            await this.checkMapUpdates(this.client, device, shadowState.map.area_id);

            await this.checkZoneMowing(device, shadowState, codeList);

            // TODO: Add something here if we are going to control scheduling

            device.inPoll = false;
        }

        // If this poll actually generated a sync request do it now we've finished
        if (device.syncReq) {
            this.syncDevice(device);
        }
    }

    async checkMapUpdates(client, device, areaId) {
        const mapAreaIdStateId = `${device.sn}.map.area_id`;
        if (areaId != (await this.getStateAsync(mapAreaIdStateId))?.val) {
            // areaId does not match from time of last fetch so we need to update map
            this.log.info(`Device map area_id change detected, fetching new map info`);

            const deviceMapFiles = await client.asyncGetDeviceMap(device.sn);

            const areaSetting = deviceMapFiles['area_setting.json'];
            this.log.debug(`area_setting.json: ${JSON.stringify(areaSetting)}`);

            // Custom Areas (aka. zones)
            device.customAreas = areaSetting?.content?.custom_areas;
            this.log.debug(`custom_areas: ${JSON.stringify(device.customAreas)}`);

            this.setStateChanged(`${device.sn}.map.custom_areas.raw`, {
                val: JSON.stringify(device.customAreas),
                ack: true,
            });

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
                    ['estimated_elapsed_time', 'number', 'time.span', 'Estimated elapsed time to mow this area', 's'],
                    //TODO: estimated battery required?
                ];
                await this.createStatesFromList(customAreaChannelStateId, readOnlyStates);

                const commandStates = [
                    // Command buttons
                    ['custom_area_mow_start', 'boolean', 'button.start', 'Start a task mowing this single area'],

                    // Set mow_head (cutting direction) randomly
                    ['mow_head_random', 'boolean', 'switch.enable', 'Set mow_head (cutting direction) randomly'],

                    // List of alternating mow_head (aka. cutting direction) angles.
                    // If set the adapter will move to the next angle in the list when mowing of
                    // the given zone completes successfully.
                    [
                        'alt_mow_head',
                        'string',
                        'list',
                        `Alternates for mow_head (cutting direction) setting (array of angles, e.g. '[0, 90, 120]')`,
                    ],

                    // TODO: 'smart scheduling' switch & other possibilities
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

            const timeSetting = deviceMapFiles['time_setting.json'];
            this.log.debug(`time_setting.json: ${JSON.stringify(timeSetting)}`);

            // Only save the area_id after map load to use for check detection - it must have changed
            this.setState(mapAreaIdStateId, { val: areaId, ack: true });
        } else {
            // Map is unchanged
            // If we have just started though, customAreas & ridableAreas won't be set so load them from saved states
            if (!device.areasLoaded) {
                device.customAreas = this.parseJsonList(
                    (await this.getStateAsync(`${device.sn}.map.custom_areas.raw`))?.val,
                );
                this.log.debug(`Loaded customAreas from state: ${JSON.stringify(device.customAreas)}`);

                device.ridableAreas = this.parseJsonList(
                    (await this.getStateAsync(`${device.sn}.map.ridable_areas.raw`))?.val,
                );
                this.log.debug(`Loaded ridableAreas from state: ${JSON.stringify(device.ridableAreas)}`);

                device.areasLoaded = true;
            }
        }
    }

    async checkZoneMowing(device, shadowState, codeList) {
        // Figure out if device has just started/finished a custom area task & set states accordingly
        if (
            Array.isArray(codeList) &&
            !device.isZoneMowing &&
            shadowState.mode.value == 'zonemowing' &&
            Array.isArray(shadowState.active_area.id)
        ) {
            // Currently mowing at least one zone
            device.isZoneMowing = true;

            // Go find the last "The robot is going to the designated area to mow" code (#1018) to get timestamp
            const startCode = codeList.find(code => code.code === 1018);
            if (!startCode) {
                this.log.warn('Could not find start code while zone mowing');
            } else {
                this.log.debug(`startCode for zone mowing: ${JSON.stringify(startCode)}`);
                // Add 'Z' because the time is UTC
                const startTime = Date.parse(`${startCode.create_time}Z`);

                // Set start time for each active area
                for (const activeAreaId of shadowState.active_area.id) {
                    await this.setStateChanged(`${device.sn}.map.custom_areas.${activeAreaId}.last_start`, {
                        val: startTime,
                        ack: true,
                    });
                }
            }
        } else if (Array.isArray(codeList) && device.isZoneMowing && Array.isArray(shadowState.active_area.id)) {
            // If we can find a "Task finished" code (#1014) before (which is chronologically after)
            // the previous start code (#1018) then we're done
            const startIndex = codeList.findIndex(code => code.code === 1018);
            const endIndex = codeList.findIndex(code => code.code === 1014);
            if (endIndex >= 0 && (endIndex < startIndex || startIndex === -1)) {
                this.log.debug('Zone mowing end code found');

                // Add 'Z' because the time is UTC
                const endTime = Date.parse(`${codeList[endIndex].create_time}Z`);

                // Set finish time for each active area
                for (const activeAreaId of shadowState.active_area.id) {
                    await this.setStateChanged(`${device.sn}.map.custom_areas.${activeAreaId}.last_finish`, {
                        val: endTime,
                        ack: true,
                    });
                }

                this.checkCustomAreaAlternates(device, shadowState.active_area.id);

                // If this was a single zone, we can set the estimated time to complete
                if (shadowState.active_area.id.length == 1) {
                    // TODO: make sure there were no errors between start and end codes
                    // TODO: make sure battery was close to full when starting
                    // TODO: possibly throw this number away when area vertexes change
                    const singleAreaId = shadowState.active_area.id[0];
                    const startTime = (
                        await this.getStateAsync(`${device.sn}.map.custom_areas.${singleAreaId}.last_start`)
                    )?.val;
                    if (!startTime || !(Number(startTime) > 0)) {
                        this.log.warn(`Single area ID ${singleAreaId} has no start time`);
                    } else {
                        await this.setStateChanged(
                            `${device.sn}.map.custom_areas.${singleAreaId}.estimated_elapsed_time`,
                            {
                                val: (endTime - Number(startTime)) / 1000,
                                ack: true,
                            },
                        );
                    }
                }

                device.isZoneMowing = false;
            } else if (!['zonemowing', 'backtodock', 'charge'].includes(shadowState.mode.value)) {
                // Not zonemowing (or charging part way through) but didn't find a "Task finished" code
                this.log.warn('zonemowing looks done but no "Task finished" code found');
                device.isZoneMowing = false;
            }
        }
    }

    async checkCustomAreaAlternates(device, customAreaIds) {
        // Build an array of commands for area_set
        const areaSetCommand = [];

        for (const customAreaId of customAreaIds) {
            const mowHeadRandomEnabled = this.parseJsonList(
                (await this.getStateAsync(`${device.sn}.map.custom_areas.${customAreaId}.mow_head_random`))?.val,
            );
            if (mowHeadRandomEnabled) {
                areaSetCommand.push(this.randomMowHeadAreaCommand(customAreaId));
            } else {
                const altMowHead = this.parseJsonList(
                    (await this.getStateAsync(`${device.sn}.map.custom_areas.${customAreaId}.alt_mow_head`))?.val,
                );
                // The check is for > 0, not > 1 because that way if there's a single alternate
                // that doesn't match current value it will get set.
                if (Array.isArray(altMowHead) && altMowHead.length > 0) {
                    const existingArea = device.customAreas.find(customArea => customArea.id == customAreaId);
                    if (!existingArea) {
                        this.log.error(`Could not find custom area ID ${customAreaId} when checking alternates`);
                    } else {
                        let setIndex = altMowHead.findIndex(angle => angle == existingArea.mow_head) + 1;
                        if (setIndex > altMowHead.length) {
                            // Wrap around to the first alternate
                            setIndex = 0;
                        }
                        areaSetCommand.push({ mow_head: altMowHead[setIndex], id: customAreaId });
                    }
                }
            }
        }

        if (areaSetCommand.length > 0) {
            if (await this.doAreaSet(device, areaSetCommand)) {
                this.syncDevice(device);
            }
        }
    }

    /**
     * Create multiple read onlystate objects from a list of their parameters
     *
     * @param {string} prefix State ID prefix
     * @param {array} stateList Array of state parameters
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
     * @param {array} commandStates Array of state parameters
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

        // map.area_id is set only after map is load
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

    /**
     * Parses a JSON string into an array
     *
     * @param {StateValue | string | undefined} jsonString String to parse
     * @returns {array | undefined} Parsed array if valid, otherwise undefined
     */

    parseJsonList(jsonString) {
        let out;
        if (typeof jsonString !== 'string') {
            this.log.error('JSON to parse is not a string');
        } else {
            try {
                out = JSON.parse(jsonString);
            } catch (error) {
                this.log.error(`Failed to parse JSON list: ${error.message}`);
            }
        }

        // List to check must be an array
        if (!Array.isArray(out)) {
            this.log.error(`Invalid JSON list: not an array`);
            out = undefined;
        }

        // List to check must have at least one item
        if (out && out.length < 1) {
            this.log.error(`Invalid JSON list: array is empty`);
            out = undefined;
        }

        return out;
    }

    /**
     *
     * @param {object} device Device object for the check or specific list
     * @param {array} checkAreas Array of valid area objects to check against
     * @param {array | undefined} passedToCheck Optional list to check instead of fetching from command state
     * @returns {Promise<array | false>} List if good, false if not
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
