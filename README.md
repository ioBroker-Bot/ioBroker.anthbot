![Logo](admin/anthbot.png)

# ioBroker.anthbot

[![NPM version](https://img.shields.io/npm/v/iobroker.anthbot.svg)](https://www.npmjs.com/package/iobroker.anthbot)
[![Downloads](https://img.shields.io/npm/dm/iobroker.anthbot.svg)](https://www.npmjs.com/package/iobroker.anthbot)
![Number of Installations](https://iobroker.live/badges/anthbot-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/anthbot-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.anthbot.png?downloads=true)](https://nodei.co/npm/iobroker.anthbot/)

**Tests:** ![Test and Release](https://github.com/iobroker-community-adapters/ioBroker.anthbot/workflows/Test%20and%20Release/badge.svg)

## anthbot adapter for ioBroker

Connect with Anthbot devices such as their robot mowers.

### Global monitoring

Battery level is reported in the `elec` state.

View a device's status in the `mode` state (charging, mowing, standby, etc).

The last status message & it's severity (event, error, etc) are shown in the `last_code`, `last_code_text` and `last_code_type` states. For users looking for more history, the `code_list` state holds a JSON array with the a larger number of messages.

The rest of the states should be self explanatory.

### Global commands

Under the `command` folder:

`stop_all_tasks` equates to hiting 'Stop' in the Anthbot app.

`charge_start` equates to the 'Recharge' icon in the Anthbot app.

`mow_start` equates to start when in 'Full maps' mode.

`custom_area_mow_start` equates to custom area (aka 'Zones') mode. For this to work a valid list of area IDs must already be set in the `area_list` state. Area IDs are not the same as names the Anthbot app shows. Valid area IDs can be found as channel IDs under the `map.custom_areas...` folder. A channel ID exists for each area, see below for details of states within.

Ie. to start mowing one or more zones:

- Set the `area_list` state to an array of IDs. Eg: `[102, 117]`
- Trigger the `custom_area_mow_start` state.

The adapter will attempt to determine when zone mowing is in progress and make a note in the relevant `map.custom_areas...` channel of start and finish times to understand how often zones are being cut.

`ridable_mow_start` equates to edge mowing mode. As with `custom_area_mow_start`, set the `area_list` with a valid list of ridable areas (aka. edge) IDs. Valid ridable area IDs can be found in the `map.ridable_areas.raw` state.

### Custom Area (aka. zone) monitoring & control

Under each `map.custom_areas...` channel:

#### Monitoring

`last_start`, `last_finish`, `estimated_elapsed_time` are provided to help scheduling. These states are set when mowing tasks involving the relevant custom area start and finish.

Note that `estimated_elapsed_time` can only be calculated when a task with a single custom area is completeled. If a task involving multiple areas is started they will all get the same start & finish time and no estimate of elapsed time will be made.

#### Commands

`custom_area_mow_start` button can be used as a shortcut to trigger mowing of just this single area.

`mow_head_random` switch, when enabled, randomises the `mow_head` (aka. cutting angle) for this area. It is randomised each time this switch is turned on, and each time a mowing task for this area is finished successfully.

`alt_mow_head` is an array of `mow_head` angles to cycle through each time a mowing task for this area is finished successfully. When the list is set, if the current `mow_head` for this area is not in the list, it will be set to the first entry. To disable this feature set a blank array (`[]`) or empty string.

Note that `mow_head_random` takes priority over `alt_mow_head`.

### Map & area (aka. zone) editing

With `area_set` it is possible to edit one or more areas. Take the JSON representation from a desired entry from the `map.custom_areas.raw_list`, modify it as required and save this the `area_set` state as a JSON array.

Note that when using `area_set` it is not necessary to define all parameters and only those provided will be changed. Eg: `[{"mow_head":10,"id":117}]` will change the angle of mowing in area 117 to 10 degrees and leave the other parameters as is.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.0.6 (2026-05-22)

- (raintonr) Improved map change detection
- (raintonr) Added custom_area channels, monitoring & control

### 0.0.5 (2026-05-20)

- (raintonr) Added brief usage tips in readme
- (raintonr) Added active_area, code_list & map states and ridable_mow_start command

### 0.0.4 (2026-05-18)

- (copilot) Adapter requires node.js >= 22 now
- (copilot) Adapter requires admin >= 7.7.22 now
- (raintonr) Handle temporary IoT access tokens (#9)

### 0.0.3 (2026-04-25)

- (raintonr) adapter checker issues

### 0.0.2 (2026-04-25)

- (raintonr) initial release

[Older changelogs can be found here](CHANGELOG_OLD.md)

## License

MIT License

Copyright (c) 2026 iobroker-community-adapters <iobroker-community-adapters@gmx.de>  
Copyright (c) 2026 Robin Rainton <robin@rainton.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
